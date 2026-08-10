import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { columnCount, layoutRows, truncate } = await loadExt("dashboard/layout.ts");

ok("three columns when wide", columnCount(120) === 3);
ok("three columns when wider", columnCount(200) === 3);
ok("two columns at 90", columnCount(90) === 2);
ok("two columns at 119", columnCount(119) === 2);
ok("one column below 90", columnCount(60) === 1);
ok("one column when absurdly narrow", columnCount(10) === 1);

ok("truncate leaves short values alone", truncate("abc", 10) === "abc");
ok("truncate marks elision", truncate("abcdefghij", 5) === "abcd…");
ok("truncate respects the max exactly", truncate("abcdefghij", 5).length === 5);
ok("truncate handles max of 1", truncate("abcdefghij", 1).length === 1);

const cells = [...Array(7).keys()].map((i) => ({ label: `skill-number-${i}`, bar: "▄" }));

const wide = layoutRows(cells, 120, 4);
ok("wide: three per row", wide[0].length === 3);
ok("wide: every cell placed", wide.flat().length === 7);
ok("wide: last row is short", wide.at(-1).length === 1);
ok("wide: reading order is left to right", wide[0][1].label.startsWith("skill-number-1"));

const narrow = layoutRows(cells, 60, 4);
ok("narrow: one per row", narrow.every((row) => row.length === 1));

// The invariant the old screen violated.
for (const [label, width] of [["120", 120], ["90", 90], ["60", 60], ["40", 40]]) {
	const rows = layoutRows(cells, width, 4);
	const longest = Math.max(
		...rows.map((row) => " ".repeat(4) + row.map((c) => `${c.label} ${c.bar}`).join("  ")).map((line) => line.length),
	);
	ok(`no line exceeds width ${label}`, longest <= width, `longest was ${longest}`);
}

// The sweep above uses 14-char labels ("skill-number-N") which are shorter
// than the minimum column width (34 chars at width 40). Those labels are
// padded but never truncated, so the gutter term in `available` is never
// load-bearing: the lines land ~100 chars wide regardless of whether the
// gutter is subtracted. The assertions pass even with the gutter deleted.
//
// These 57-char labels are always truncated to exactly `labelWidth`. A full
// multi-column row of them reaches the width boundary, so dropping the gutter
// term inflates every column by one character and pushes multi-column rows
// past the limit. The critical widths are 120 (3 cols) and 90 (2 cols);
// widths 60 and 40 use 1 column so gutter*(cols-1) = 0 either way.
const wideCells = [...Array(7).keys()].map((i) => ({
	label: `a-label-that-is-definitely-longer-than-any-column-width-${i}`,
	bar: "▄",
}));

for (const [wLabel, wWidth] of [["120 (wide labels)", 120], ["90 (wide labels)", 90], ["60 (wide labels)", 60], ["40 (wide labels)", 40]]) {
	const wRows = layoutRows(wideCells, wWidth, 4);
	const wLongest = Math.max(
		...wRows.map((row) => " ".repeat(4) + row.map((c) => `${c.label} ${c.bar}`).join("  ")).map((line) => line.length),
	);
	ok(`no line exceeds width ${wLabel}`, wLongest <= wWidth, `longest was ${wLongest}`);
}

// Long names must be truncated, not wrapped.
const long = [{ label: "a-very-long-skill-name-that-will-not-fit-anywhere", bar: "█" }];
const cramped = layoutRows(long, 40, 4);
ok("long names truncate", cramped[0][0].label.includes("…"));
ok("truncated line still fits", (" ".repeat(4) + `${cramped[0][0].label} ${cramped[0][0].bar}`).length <= 40);

ok("empty input yields no rows", layoutRows([], 120, 4).length === 0);

done();
