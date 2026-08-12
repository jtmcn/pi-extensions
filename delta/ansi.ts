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
 */

/** CSI erase-in-line / erase-in-display, with or without a parameter. */
const ERASE = /\x1b\[[0-2]?[KJ]/g;

export function sanitize(text: string): string {
	return text.replace(ERASE, "").replace(/\r/g, "");
}
