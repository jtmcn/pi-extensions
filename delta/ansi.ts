/**
 * Strip the parts of delta's output that a TUI frame cannot tolerate.
 *
 * Erase-in-display (`\x1b[2J`, etc.) is dropped outright: inside pi's frame it
 * would erase whatever pi drew after us, and delta has no legitimate use for
 * clearing the whole screen from inside one diff. Carriage returns are the
 * same class of problem: they move the cursor somewhere pi's width accounting
 * does not model.
 *
 * Erase-in-line (`\x1b[0K`) is different: delta emits it at the end of almost
 * every content line, background colour still active, as how it extends that
 * background to the edge of the terminal — real delta, real width:
 *
 *   alpha\x1b[0m\x1b[48;2;40;59;77m\x1b[0K\x1b[0m
 *
 * Dropping it (the old behaviour) drops that fill along with the escape, so
 * the background stops where the text does and a themed diff reads as ragged
 * colour blocks instead of full-width rows. `sanitize()` instead swaps it for
 * `FILL_SENTINEL`, and `fill()` below expands that into the padding it stood
 * for once the render width is known.
 *
 * Colour, including 24-bit colour, and OSC 8 hyperlinks are left alone — they
 * are the reason delta is here at all.
 *
 * `plain()` is the opposite direction: text arriving *from* a tool result, on
 * its way to delta and to pi's fallback styling. pi's own `getTextOutput` is
 * `sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "")`, so a command that
 * colours its own output (`git -c color.ui=always diff`) or a CRLF repo would
 * otherwise put escapes pi never expects into the frame — and hand delta a diff
 * it cannot parse.
 */

/** CSI erase-in-line, with or without a parameter (`0K`/`1K`/`2K`/bare `K`). */
const ERASE_LINE = /\x1b\[[0-2]?K/g;
/** CSI erase-in-display, with or without a parameter. */
const ERASE_DISPLAY = /\x1b\[[0-2]?J/g;

/**
 * Stands in for an erase-in-line until `fill()` knows the render width and can
 * expand it into real padding. A Unicode Private Use Area code point — chosen
 * because PUA code points are never valid escape sequences, so a sentinel that
 * somehow survives unexpanded is inert rather than dangerous, and `fill()`
 * still strips it defensively.
 *
 * Trade-off: U+E000 is the first code point of the PUA, which is exactly where
 * Nerd Fonts and Powerline put their glyphs. A diff of a file that contains
 * such glyphs will have them stripped — by `sanitize()` before it inserts its
 * own sentinels, and by `plain()` on the bash fallback path. The loss is a
 * rare cosmetic one; the alternative (corrupted padding and dropped characters
 * everywhere a PUA glyph appears) is worse.
 */
export const FILL_SENTINEL = "\uE000";

export function sanitize(text: string): string {
	// Strip any pre-existing U+E000 (Nerd Fonts, Powerline glyphs) before
	// inserting our own sentinels, so fill() can never confuse content with a
	// real erase-in-line marker. See FILL_SENTINEL's comment for the trade-off.
	return text
		.replace(/\uE000/g, "")
		.replace(ERASE_LINE, FILL_SENTINEL)
		.replace(ERASE_DISPLAY, "")
		.replace(/\r/g, "");
}

/**
 * Expand `sanitize`'s erase-in-line sentinel into the padding it stands for.
 *
 * The pad target is not simply `width`: delta does not wrap its own output (a
 * pipe defeats its `--width`, verified against real 0.19.2), so a diff line
 * longer than `width` is wrapped by *this extension's* `wrap` step into
 * `ceil(visible / width)` rows — and a real terminal fills the last of those
 * rows too, same as every row before it. So this pads to that many multiples
 * of `width`, measured over the line with the sentinel already removed, and
 * lets the caller's existing wrap step slice the padded line into rows that
 * are each exactly `width` wide, background and all.
 *
 * `measure` is pi's ANSI-aware `visibleWidth`, passed in rather than imported
 * so this module stays free of a `pi` dependency (`sanitize`/`plain` above are
 * pure for the same reason).
 *
 * A no-op — modulo defensively removing any sentinel that survives — on text
 * with none, so callers can apply it unconditionally to both delta's output
 * and pi's own fallback text.
 */
export function fill(text: string, width: number, measure: (text: string) => number): string {
	return text
		.split("\n")
		.map((line) => fillLine(line, width, measure))
		.join("\n");
}

function fillLine(line: string, width: number, measure: (text: string) => number): string {
	if (!line.includes(FILL_SENTINEL)) return line;

	const stripped = line.split(FILL_SENTINEL).join("");
	const safeWidth = Math.max(1, Math.floor(width));
	const visible = measure(stripped);
	const rows = Math.max(1, Math.ceil(visible / safeWidth));
	const padding = " ".repeat(Math.max(0, rows * safeWidth - visible));

	// Only the first sentinel (there is normally exactly one, at end of line)
	// gets the padding; any further occurrence is removed rather than expanded,
	// so a line can never end up padded twice.
	let used = false;
	return line.replace(new RegExp(FILL_SENTINEL, "g"), () => {
		if (used) return "";
		used = true;
		return padding;
	});
}

/**
 * Restore pi's tool-box background after every SGR reset in `text`.
 *
 * pi wraps a rendered row in exactly one background span: `Box.applyBg` is
 * `bgFn(line + padding)`, and `bgFn` is `theme.bg(key, text)`, which is
 * `<ansi-prefix>${text}\x1b[49m` — the prefix set once at the very start of
 * the whole line, padding included. A terminal does not re-apply that prefix
 * on its own; it is sequential state. So any SGR reset *inside* our content —
 * and delta emits one at the end of every content line — cancels the box's
 * background for the remainder of the row, including pi's own trailing
 * padding: a themed diff shows the terminal's default background (the app
 * background) instead of pi's box colour, for every character after the
 * reset.
 *
 * The fix is not to remove those resets — delta needs `ESC[0m` to end its own
 * colouring before starting the next token — but to immediately follow every
 * one with `prefix`, so the box's background is re-established before
 * anything else is drawn. Three shapes, one rule:
 *
 *   - `ESC[0m` / bare `ESC[m` (full reset): kept, `prefix` appended after.
 *   - `ESC[49m` in isolation (reset background only, nothing else in the
 *     sequence): the sequence itself served no other purpose, so it is
 *     replaced outright by `prefix` rather than kept-then-followed.
 *   - Composite sequences whose parameters include `0` or `49` alongside
 *     other codes (`ESC[0;1m`, `ESC[39;49m`): kept in full — the other codes
 *     still apply — with `prefix` appended after.
 *
 * Parameters are walked rather than string-matched, because a 24-bit colour
 * parameter can itself contain the digits `0` or `49` as an RGB component
 * (`ESC[38;2;10;49;77m`) and `38;5;n` / `48;5;n` (256-colour) and `38;2;r;g;b`
 * / `48;2;r;g;b` (24-bit) introducers have to be consumed as one unit so their
 * component values are never mistaken for a bare reset code.
 *
 * `prefix` is a no-op function argument: an empty string (the `edit` row,
 * whose `renderShell: "self"` puts it in a plain `Container`, never a `Box` —
 * `ToolExecutionComponent.updateDisplay` only calls `setBgFn` `if
 * (renderContainer instanceof Box)`) makes this the identity function, text
 * untouched.
 *
 * Ordering: this runs on delta's raw output — already through `sanitize()` in
 * `run.ts`, so its erase-in-line is `FILL_SENTINEL`, not a live escape — and
 * has to run *before* `fill()` expands that sentinel into padding, so the
 * expanded padding sits between whatever background SGR precedes the
 * sentinel and this function's restored prefix, inheriting the right colour
 * either way. Concretely, delta's own per-content-line shape is
 * `content ESC[0m ESC[48;2;r;g;bm ESC[0K ESC[0m`; after `sanitize()` the
 * `ESC[0K` is `FILL_SENTINEL`, and this function's job is only the two
 * `ESC[0m`s around it — `fill()` still owns turning the sentinel into spaces.
 */
const SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;

/**
 * The SGR parameters of one sequence's body, with 256-colour and 24-bit colour
 * introducers (`38`/`48` followed by `5;n` or `2;r;g;b`) consumed as a single
 * opaque unit so a colour component is never read as a bare reset code. An
 * empty body (bare `ESC[m`) is `ESC[0m` by definition, per ECMA-48.
 */
function sgrParams(body: string): string[] {
	if (body === "") return ["0"];
	const tokens = body.split(";");
	const params: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (tok === "38" || tok === "48") {
			const mode = tokens[i + 1];
			if (mode === "5") {
				i += 3; // 38/48, 5, n
				continue;
			}
			if (mode === "2") {
				i += 5; // 38/48, 2, r, g, b
				continue;
			}
			// Unknown extended form (e.g. a colon-subparameter variant this parser
			// does not split on): consume just the introducer token defensively
			// rather than risk misreading whatever follows.
			i += 1;
			continue;
		}
		params.push(tok === "" ? "0" : tok);
		i += 1;
	}
	return params;
}

export function restoreBackground(text: string, prefix: string): string {
	if (!prefix) return text;
	return text.replace(SGR_SEQUENCE, (match, body: string) => {
		const params = sgrParams(body);
		if (params.length === 1 && params[0] === "49") return prefix;
		if (params.includes("0") || params.includes("49")) return match + prefix;
		return match;
	});
}

/**
 * Every escape sequence, as pi's `stripAnsi` matches them.
 *
 * A pinned copy of pi's regex (`utils/ansi.js`, derived from `ansi-regex`,
 * MIT-licensed): OSC sequences terminated by BEL/ST, plus CSI and friends.
 * pi does not export it, and matching fewer sequences than pi does is how an
 * escape reaches the frame.
 */
const TERMINATOR = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI = new RegExp(
	`(?:\\u001B\\][\\s\\S]*?${TERMINATOR})|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]`,
	"g",
);

/** A tool result's text as pi would style it: no escapes, no carriage returns. */
export function plain(text: string): string {
	// Strip any pre-existing U+E000 so fill() cannot mistake content glyphs for
	// real erase-in-line sentinels. See FILL_SENTINEL's comment for the trade-off.
	return text.replace(/\uE000/g, "").replace(ANSI, "").replace(/\r/g, "");
}
