/**
 * Columns that never wrap.
 *
 * Pi's built-in skills listing is one comma-separated run that reflows across
 * five lines, which is exactly why it is unreadable. Everything here truncates
 * to fit instead.
 *
 * Plain strings only — no theme, no ANSI. Colors are zero-width escapes that
 * make width arithmetic lie, so `render.ts` applies them after layout.
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

export function columnCount(width: number): number {
	if (width >= 120) return 3;
	if (width >= 90) return 2;
	return 1;
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

	const columns = columnCount(width);
	const available = width - indent - GUTTER * (columns - 1);
	// At least one character of label, however cramped the terminal.
	const labelWidth = Math.max(1, Math.floor(available / columns) - BAR_SUFFIX);

	const rows: LaidOutCell[][] = [];
	for (let i = 0; i < cells.length; i += columns) {
		const row = cells.slice(i, i + columns).map((cell) => ({
			label: truncate(cell.label, labelWidth).padEnd(labelWidth),
			bar: cell.bar,
		}));
		// The final cell of a row carries no trailing padding: a padded last
		// column pushes the line past `width` for no visible gain.
		const last = row[row.length - 1];
		if (last) last.label = last.label.trimEnd();
		rows.push(row);
	}
	return rows;
}
