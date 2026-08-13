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
 * expand it into real padding. A Unicode Private Use Area code point: it will
 * not occur in real delta output, and is never itself a valid escape sequence,
 * so a sentinel that somehow survives unexpanded is inert rather than dangerous
 * — `fill()` still strips it defensively, but nothing upstream of that can
 * mistake it for a cursor or erase command.
 */
export const FILL_SENTINEL = "\uE000";

export function sanitize(text: string): string {
	return text.replace(ERASE_LINE, FILL_SENTINEL).replace(ERASE_DISPLAY, "").replace(/\r/g, "");
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
	return text.replace(ANSI, "").replace(/\r/g, "");
}
