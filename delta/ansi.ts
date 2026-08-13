/**
 * Strip the parts of delta's output that a TUI frame cannot tolerate.
 *
 * Delta extends a background colour to the end of a line with erase-in-line
 * (`\x1b[0K`). In a terminal that paints the rest of the row; inside pi's frame
 * it erases whatever pi drew after us. Carriage returns are the same class of
 * problem: they move the cursor somewhere pi's width accounting does not model.
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

/** CSI erase-in-line / erase-in-display, with or without a parameter. */
const ERASE = /\x1b\[[0-2]?[KJ]/g;

export function sanitize(text: string): string {
	return text.replace(ERASE, "").replace(/\r/g, "");
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
