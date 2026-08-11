/**
 * Columns that never wrap.
 *
 * Pi's built-in skills listing is one comma-separated run that reflows across
 * five lines, which is exactly why it is unreadable. Everything here truncates
 * to fit instead.
 *
 * ANSI SGR escapes are supported by `visibleWidth` and `truncateVisible`, which
 * strip or preserve them so that colors added by the theme do not make width
 * arithmetic lie.
 */

export interface Cell {
	label: string;
	bar: string;
}

export interface LaidOutCell {
	/** Padded and truncated to the column width. */
	label: string;
	bar: string;
}

/** Space between adjacent columns. */
const GUTTER = 2;
/** A label, a space, and a one-column bar. */
const BAR_SUFFIX = 2;
/** One pathological name must not starve every other column. */
const MAX_LABEL = 40;
/** A very wide terminal should not become a wall of narrow columns. */
const MAX_COLUMNS = 6;

/** Width of the longest label, capped so one outlier cannot starve the rest. */
function labelWidthFor(cells: readonly Cell[]): number {
	const longest = Math.max(...cells.map((cell) => cell.label.length));
	return Math.max(1, Math.min(longest, MAX_LABEL));
}

/**
 * How many columns fit.
 *
 * Derived from the names rather than from the terminal alone: dividing a wide
 * terminal into a fixed three columns padded every name to a third of the
 * screen, so a bar sat up to 45 spaces from the name it belonged to and read
 * as belonging to the next column.
 */
export function columnCount(cells: readonly Cell[], width: number, indent: number): number {
	if (cells.length === 0) return 1;
	const cellWidth = labelWidthFor(cells) + BAR_SUFFIX;
	const fit = Math.floor((width - indent + GUTTER) / (cellWidth + GUTTER));
	return Math.max(1, Math.min(MAX_COLUMNS, fit));
}

export function truncate(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "…";
	return `${value.slice(0, max - 1)}…`;
}

/** Strip ANSI SGR escape sequences to measure the visible column count. */
export function visibleWidth(line: string): number {
	return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate `line` to at most `max` visible columns, preserving ANSI SGR
 * escape sequences. If any style is left open after truncation, appends a
 * reset so subsequent lines are not contaminated.
 */
export function truncateVisible(line: string, max: number): string {
	if (max <= 0) return "";
	// Fast path: no escapes — behave like a plain slice.
	if (!line.includes("\x1b")) {
		return line.length <= max ? line : line.slice(0, max);
	}
	// Only walk the string if visible width actually exceeds max.
	if (visibleWidth(line) <= max) return line;

	let result = "";
	let visible = 0;
	let i = 0;
	let styleOpen = false;

	while (i < line.length && visible < max) {
		if (line[i] === "\x1b" && i + 1 < line.length && line[i + 1] === "[") {
			// Collect the complete SGR escape sequence.
			const start = i;
			i += 2;
			while (i < line.length && line[i] !== "m") i++;
			if (i < line.length) i++; // consume 'm'
			const esc = line.slice(start, i);
			result += esc;
			// A reset sequence closes all styles; anything else opens one.
			styleOpen = esc !== "\x1b[0m" && esc !== "\x1b[m";
		} else {
			result += line[i];
			visible++;
			i++;
		}
	}

	if (styleOpen) result += "\x1b[0m";
	return result;
}

export function layoutRows(cells: Cell[], width: number, indent: number): LaidOutCell[][] {
	if (cells.length === 0) return [];

	const columns = columnCount(cells, width, indent);
	// columnCount already sized the columns to fit; the only case it cannot
	// satisfy is its own clamp to a single column on a terminal too narrow for
	// even one name, so that is the only case left to cap.
	const labelWidth = Math.max(1, Math.min(labelWidthFor(cells), width - indent - BAR_SUFFIX));

	const rows: LaidOutCell[][] = [];
	for (let i = 0; i < cells.length; i += columns) {
		const row = cells.slice(i, i + columns).map((cell) => ({
			label: truncate(cell.label, labelWidth).padEnd(labelWidth),
			bar: cell.bar,
		}));
		rows.push(row);
	}
	return rows;
}
