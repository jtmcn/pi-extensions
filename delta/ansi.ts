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

/**
 * Every escape sequence and control character, matched in one pass so the
 * replacer below can decide per sequence.
 *
 * This is an allowlist by construction, and deliberately so: the previous
 * version stripped two specific shapes (`\x1b[[0-2]?K`, `\x1b[[0-2]?J`) and
 * passed everything else through, which meant anything outside those two
 * patterns reached the frame intact — `\x1b[3J`, a multi-parameter `\x1b[0;0K`,
 * an 8-bit `\x9b0K`, a cursor move, an alternate-screen switch. Delta is not
 * expected to emit any of them, but "the pager only emits what we predicted" is
 * not a property this module can enforce, and it is the last thing between
 * delta's stdout and pi's frame.
 *
 * Order matters: string sequences (OSC/DCS/APC/PM/SOS) come first so their
 * bodies are consumed whole rather than being partly matched as CSI, and the
 * unterminated forms are anchored to end-of-input so a truncated sequence can
 * never leak its introducer into the output.
 */
const STRING_TERMINATOR = "(?:\\u0007|\\u001B\\u005C|\\u009C|$)";
const SEQUENCE = new RegExp(
	[
		// OSC: ESC ] ... ST/BEL. Kept only when it is a hyperlink; see keep().
		`(?:\\u001B\\]|\\u009D)[\\s\\S]*?${STRING_TERMINATOR}`,
		// DCS / SOS / PM / APC: ESC P, ESC X, ESC ^, ESC _ and their 8-bit forms.
		// Spelled out rather than as a range: `[P-_]` also covers `[`, which would
		// make every CSI match here instead and swallow the rest of the input.
		`(?:\\u001B[PX^_]|[\\u0090\\u0098\\u009E\\u009F])[\\s\\S]*?${STRING_TERMINATOR}`,
		// CSI: introducer, parameter bytes, intermediate bytes, final byte. The
		// final byte is optional so a truncated CSI is consumed rather than left.
		"(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]?",
		// Any other escape (RIS `ESC c`, charset selection, ...) and a bare ESC.
		"\\u001B[\\s\\S]?",
		// Remaining C1 controls, and C0 controls other than newline and tab. This is
		// where carriage return is handled: it moves the cursor somewhere pi's width
		// accounting does not model.
		"[\\u0080-\\u009F]",
		"[\\u0000-\\u0008\\u000B-\\u001F\\u007F]",
	].join("|"),
	"g",
);

/** A single CSI sequence, split into parameters, intermediates and final byte. */
const CSI = /^(?:\u001B\[|\u009B)([0-?]*)([ -/]*)([@-~])$/;

/** OSC 8 is the hyperlink; every other OSC (window title, clipboard) is dropped. */
const OSC_HYPERLINK = /^(?:\u001B\]|\u009D)8;/;
const OSC_TERMINATED = /(?:\u0007|\u001B\u005C|\u009C)$/;

/**
 * What one matched sequence becomes: itself, the fill sentinel, or nothing.
 *
 * Colour (SGR) and OSC 8 hyperlinks are the only things kept — they are why
 * delta is here. An 8-bit CSI is normalised to its 7-bit form on the way
 * through, because `restoreBackground` below and pi's own width accounting both
 * pattern-match `\x1b[`, and a sequence that survives sanitising only to be
 * invisible to those is worse than one that never survived.
 */
function keep(sequence: string): string {
	const csi = CSI.exec(sequence);
	if (csi) {
		const [, params, intermediates, final] = csi;
		// A private-parameter or intermediate-byte sequence is not SGR even when it
		// ends in `m` (`\x1b[?1m`), so it does not get the colour exemption.
		if (final === "m" && !params.includes("?") && intermediates === "") return `\u001B[${params}m`;
		if (final === "K") return FILL_SENTINEL;
		return "";
	}
	if (OSC_HYPERLINK.test(sequence) && OSC_TERMINATED.test(sequence)) return sequence;
	return "";
}

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
	return text.replace(/\uE000/g, "").replace(SEQUENCE, keep);
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
		const tok = normalize(tokens[i]);
		if (tok === "38" || tok === "48") {
			// Collapsed to a marker rather than dropped: whether the sequence ends up
			// with a background set is what decides the restore below, so "an
			// extended background happened here, in this position" is load-bearing.
			const marker = tok === "48" ? EXTENDED_BG : EXTENDED_FG;
			const mode = normalize(tokens[i + 1] ?? "");
			if (mode === "5") {
				i += 3; // 38/48, 5, n
			} else if (mode === "2") {
				i += 5; // 38/48, 2, r, g, b
			} else {
				// Unknown extended form (e.g. a colon-subparameter variant this parser
				// does not split on): consume just the introducer token defensively
				// rather than risk misreading whatever follows.
				i += 1;
			}
			params.push(marker);
			continue;
		}
		params.push(tok);
		i += 1;
	}
	return params;
}

const EXTENDED_BG = "bg*";
const EXTENDED_FG = "fg*";

/**
 * One SGR parameter in canonical form.
 *
 * `ESC[00m` and `ESC[049m` are a reset and a background reset to every terminal
 * — leading zeros are padding, not a different code — so comparing the raw
 * token against `"0"` misses them and leaves pi's box background cancelled for
 * the rest of the row. An empty parameter is `0` by definition, per ECMA-48.
 * Anything non-numeric (a colon-subparameter form) is left alone rather than
 * coerced through `Number`, which would turn it into `NaN`.
 */
function normalize(token: string): string {
	if (token === "") return "0";
	if (!/^\d+$/.test(token)) return token;
	return String(Number(token));
}

/**
 * Whether the background is left at the terminal default once `params` have all
 * been applied, which is the only case where pi's prefix has to be restored.
 *
 * Order is what matters, not membership. `ESC[0;48;2;1;2;3m` contains a reset,
 * but it goes on to set a background in the same sequence: appending pi's
 * prefix after that would paint over the colour delta just asked for. The
 * mirror image, `ESC[44;0m`, sets a background and then resets it, and does
 * need the restore.
 */
function backgroundDefaultAfter(params: readonly string[]): boolean {
	let isDefault = false;
	for (const param of params) {
		if (param === "0" || param === "49") {
			isDefault = true;
			continue;
		}
		if (param === EXTENDED_BG) {
			isDefault = false;
			continue;
		}
		const code = Number(param);
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) isDefault = false;
	}
	return isDefault;
}

export function restoreBackground(text: string, prefix: string): string {
	if (!prefix) return text;
	return text.replace(SGR_SEQUENCE, (match, body: string) => {
		const params = sgrParams(body);
		if (!backgroundDefaultAfter(params)) return match;
		// A sequence that only reset the background served no other purpose, so it
		// is replaced outright rather than kept and followed.
		if (params.length === 1 && params[0] === "49") return prefix;
		return match + prefix;
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
