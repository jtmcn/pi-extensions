import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { columnCount, layoutRows, truncate, visibleWidth, truncateVisible } = await loadExt("dashboard/layout.ts");

const short = [...Array(9).keys()].map((i) => ({ label: `sk-${i}`, bar: "▄" }));           // 4 chars
const typical = [...Array(9).keys()].map((i) => ({ label: `skill-number-${i}`, bar: "▄" })); // 14 chars
const longish = [...Array(9).keys()].map((i) => ({ label: `${i}`.padEnd(35, "x"), bar: "▄" })); // 35 chars

// Column count follows the names, not the terminal alone.
ok("short names pack more columns than long ones", columnCount(short, 183, 4) > columnCount(longish, 183, 4));
ok("short at 183 hits the cap", columnCount(short, 183, 4) === 6);
ok("longish at 183 fits four", columnCount(longish, 183, 4) === 4);
ok("typical at 120 fits six", columnCount(typical, 120, 4) === 6);
ok("longish at 120 fits three", columnCount(longish, 120, 4) === 3);
ok("never exceeds MAX_COLUMNS", columnCount(short, 400, 4) === 6);
ok("one column when cramped", columnCount(longish, 40, 4) === 1);
ok("empty input still yields a column", columnCount([], 120, 4) === 1);

// The bug: a bar must sit one space after its label, not 45.
const rows = layoutRows(typical, 183, 4);
const gap = rows[0][0].label.length - "skill-number-0".length;
ok("label is not padded far beyond the longest name", gap === 0, `gap was ${gap}`);
ok("bar follows its own label", `${rows[0][0].label} ${rows[0][0].bar}`.endsWith("skill-number-0 ▄"));

// One pathological name must not starve the rest.
const long = [{ label: "x".repeat(120), bar: "█" }, ...typical];
const cappedRows = layoutRows(long, 183, 4);
ok("a very long name is capped, not honoured", cappedRows[0][0].label.length === 40);
ok("the long row still fits", (" ".repeat(4) + cappedRows[0].map((c) => `${c.label} ${c.bar}`).join("  ")).length <= 183);

// The width invariant, unchanged, at the widths that matter.
// The tightest case is longish at 40: one column, a 34-char label, exactly 40.
for (const width of [183, 120, 90, 60, 40]) {
	for (const cells of [short, typical, longish, long]) {
		const laid = layoutRows(cells, width, 4);
		const longest = Math.max(
			...laid.map((row) => " ".repeat(4) + row.map((c) => `${c.label} ${c.bar}`).join("  ")).map((l) => l.length),
		);
		ok(`no line exceeds ${width}`, longest <= width, `longest was ${longest}`);
	}
}

ok("truncate leaves short values alone", truncate("abc", 10) === "abc");
ok("truncate marks elision", truncate("abcdefghij", 5) === "abcd…");
ok("truncate respects the max exactly", truncate("abcdefghij", 5).length === 5);
ok("truncate handles max of 1", truncate("abcdefghij", 1).length === 1);

// Long names must be truncated, not wrapped.
const tooLong = [{ label: "a-very-long-skill-name-that-will-not-fit-anywhere", bar: "█" }];
const cramped = layoutRows(tooLong, 40, 4);
ok("long names truncate", cramped[0][0].label.includes("…"));
ok("truncated line still fits", (" ".repeat(4) + `${cramped[0][0].label} ${cramped[0][0].bar}`).length <= 40);

ok("empty input yields no rows", layoutRows([], 120, 4).length === 0);

// These 57-char labels are wider than MAX_LABEL (40), so they get capped.
// The gutter term in `available` keeps each column's arithmetic accurate even
// though the width invariant is also maintained by the labelWidthFor cap.
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

// ---------------------------------------------------------------- visibleWidth
//
// Mutation: replace visibleWidth body with `return line.length`. A line that
// contains ANSI escapes then returns a count inflated by the escape bytes, and
// the assertions below that involve escape-only strings fail.

ok("visibleWidth: plain string is its own length", visibleWidth("hello") === 5);
ok("visibleWidth: ANSI escape sequence is zero-width", visibleWidth("\x1b[1mhi\x1b[0m") === 2);
ok("visibleWidth: escape-only string is zero", visibleWidth("\x1b[2m\x1b[0m") === 0);
ok("visibleWidth: partial SGR (no m) is treated as plain text", visibleWidth("\x1b[1") > 0);
ok("visibleWidth: empty string is 0", visibleWidth("") === 0);

// -------------------------------------------------------- truncateVisible
//
// Mutations and what they break:
//   - Replace body with plain slice: escape bytes are counted as visible,
//     so a line is cut too early and the style-open reset is not appended.
//   - Drop `if (styleOpen) result += "\x1b[0m"`: an opened style bleeds into
//     the next line, which hasSeveredEscape tests detect.

const esc = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const hasSeveredEscape = (s) => stripAnsi(s).includes("\x1b");

// Plain string — fast path
ok("truncateVisible: plain short string is unchanged", truncateVisible("hello", 10) === "hello");
ok("truncateVisible: plain exact-fit is unchanged", truncateVisible("hello", 5) === "hello");
ok("truncateVisible: plain overlong is sliced", truncateVisible("hello world", 5) === "hello");
ok("truncateVisible: max=0 returns empty", truncateVisible("hello", 0) === "");

// ANSI path — escapes are zero-width
const colored = esc("2", "hello world");
ok("truncateVisible: ANSI string within max is unchanged", truncateVisible(colored, 20) === colored);
ok("truncateVisible: ANSI string is cut at visible columns",
	stripAnsi(truncateVisible(colored, 5)) === "hello");
ok("truncateVisible: cut falls on visible chars, not escape bytes",
	truncateVisible(colored, 5).length > 5); // escape bytes still present

// Style closing: a cut that leaves a style open must append a reset.
const openStyle = `\x1b[2mlong text here`; // opens dim, no close
const cutOpen = truncateVisible(openStyle, 4);
ok("truncateVisible: open style is closed after cut",
	cutOpen.endsWith("\x1b[0m"),
	JSON.stringify(cutOpen));
ok("truncateVisible: closed style has no severed escape", !hasSeveredEscape(cutOpen));

// Cut that falls exactly on an escape boundary (escape comes right before the cut point).
const atBoundary = `AB\x1b[2mCD`;
const cutBoundary = truncateVisible(atBoundary, 2); // cut after "AB", before the escape
ok("truncateVisible: cut at escape boundary has correct visible length",
	stripAnsi(cutBoundary) === "AB",
	JSON.stringify(cutBoundary));

done();
