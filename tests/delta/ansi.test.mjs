/**
 * Delta's output has to survive pi's frame. Everything stripped here is a
 * sequence that moves or erases, which pi's width accounting cannot see;
 * everything kept is colour, which is the entire point of the feature.
 *
 *   node tests/delta/ansi.test.mjs
 */

import { assertions, loadExt, piEntry, piTuiEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { sanitize, fill, FILL_SENTINEL, plain } = await loadExt("delta/ansi.ts");
const { visibleWidth } = await import(`file://${await piTuiEntry()}`);

// ---- sanitize(): erase-in-line becomes a sentinel, not nothing
//
// Delta uses erase-in-line to extend its background to the edge of the
// terminal (see the module doc comment for the real escape sequence). Dropping
// it outright — the old behaviour — drops that fill too; the sentinel lets
// `fill()` put the padding back once the render width is known.

ok(
	"erase-in-line with parameter becomes the sentinel",
	sanitize("a\x1b[0Kb") === `a${FILL_SENTINEL}b`,
	JSON.stringify(sanitize("a\x1b[0Kb")),
);
ok("bare erase-in-line becomes the sentinel", sanitize("a\x1b[Kb") === `a${FILL_SENTINEL}b`);
ok("erase-in-display is still dropped entirely", sanitize("a\x1b[2Jb") === "ab");
ok("carriage return stripped", sanitize("a\rb") === "ab");
ok("colour preserved", sanitize("\x1b[31mred\x1b[0m") === "\x1b[31mred\x1b[0m");
ok(
	"24-bit background preserved",
	sanitize("\x1b[48;2;63;45;61mx\x1b[0m") === "\x1b[48;2;63;45;61mx\x1b[0m",
);
ok(
	"OSC 8 hyperlink preserved",
	sanitize("\x1b]8;;file:///x\x07t\x1b]8;;\x07") === "\x1b]8;;file:///x\x07t\x1b]8;;\x07",
);
ok("newlines preserved", sanitize("a\nb") === "a\nb");

// ---- fill(): expand the sentinel into the padding it stands for
//
// Real delta 0.19.2 output (`delta --paging never --width 60`, `cat -v`), one
// content line: background set, content, reset, background re-established,
// erase-in-line, reset. The erase is always immediately after the background
// is re-set, which is why a terminal fills the rest of the row in that colour.
const REAL_DELTA_LINE =
	"\x1b[34m\x1b[38;2;243;139;168m    \x1b[34m\u22ee\x1b[38;2;166;227;161m  1 \x1b[34m\u2502\x1b[48;2;40;59;77;38;2;248;248;242malpha\x1b[0m\x1b[48;2;40;59;77m\x1b[0K\x1b[0m";

{
	const width = 60;
	const sanitized = sanitize(REAL_DELTA_LINE);
	ok("sanitized real delta line carries the sentinel", sanitized.includes(FILL_SENTINEL), JSON.stringify(sanitized));

	const filled = fill(sanitized, width, visibleWidth);
	ok("filled real delta line has no sentinel left", !filled.includes(FILL_SENTINEL), JSON.stringify(filled));
	ok(
		"filled real delta line is padded to exactly the render width",
		visibleWidth(filled) === width,
		String(visibleWidth(filled)),
	);
	// The background re-establishing SGR (`\x1b[48;2;40;59;77m`) must still
	// precede the padding: that is what makes a terminal paint the padding in
	// that colour instead of the default background.
	const bgIndex = filled.lastIndexOf("\x1b[48;2;40;59;77m");
	const resetIndex = filled.lastIndexOf("\x1b[0m");
	ok(
		"the background SGR precedes the padding, which precedes the final reset",
		bgIndex >= 0 && resetIndex > bgIndex && filled.slice(bgIndex, resetIndex).includes(" "),
		JSON.stringify(filled),
	);
}

{
	// A line longer than the width must pad to a multiple of the width, so every
	// row the existing wrap step slices out of it is full.
	const width = 20;
	const long = "x".repeat(45); // 3 rows of 20
	const sanitized = sanitize(`${long}\x1b[0K`);
	const filled = fill(sanitized, width, visibleWidth);
	ok(
		"a line longer than the width pads to a multiple of the width",
		visibleWidth(filled) % width === 0 && visibleWidth(filled) >= long.length,
		String(visibleWidth(filled)),
	);
	ok("padding to a multiple of the width leaves no sentinel", !filled.includes(FILL_SENTINEL));
}

ok(
	"a line with no erase sequence is untouched by fill",
	fill("plain diff line", 60, visibleWidth) === "plain diff line",
);

ok(
	"a stray sentinel that was never a real erase never survives fill",
	!fill(`a${FILL_SENTINEL}${FILL_SENTINEL}b`, 10, visibleWidth).includes(FILL_SENTINEL),
);

ok(
	"fill is applied per line: an earlier line's erase does not pad a later line",
	fill(`short${FILL_SENTINEL}\nlong line here`, 40, visibleWidth).split("\n")[1] === "long line here",
	JSON.stringify(fill(`short${FILL_SENTINEL}\nlong line here`, 40, visibleWidth)),
);

// ---- plain(): text coming *in* from a tool result
//
// This is pi's `getTextOutput` minus `sanitizeBinaryOutput`: pi strips every
// escape and every carriage return before styling bash output, so text that
// reaches delta (and pi's fallback styler) must be stripped the same way.

ok("colour is stripped from tool text", plain("\x1b[31m-a\x1b[0m") === "-a", JSON.stringify(plain("\x1b[31m-a\x1b[0m")));
ok("24-bit colour is stripped", plain("\x1b[48;2;63;45;61mx\x1b[0m") === "x");
ok("OSC 8 hyperlinks are stripped", plain("\x1b]8;;file:///x\x07t\x1b]8;;\x07") === "t", JSON.stringify(plain("\x1b]8;;file:///x\x07t\x1b]8;;\x07")));
ok("erase sequences are stripped", plain("a\x1b[0Kb") === "ab");
ok("carriage returns are stripped", plain("a\r\nb\r") === "a\nb");
ok("the diff text itself survives", plain("diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b") === "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b");
ok("text with no escapes is returned unchanged", plain("plain text") === "plain text");

// pi's stripAnsi is the reference: same input, same output.
const piStripAnsi = (await import(`file://${(await piEntry()).replace(/index\.js$/, "utils/ansi.js")}`)).stripAnsi;
for (const sample of [
	"\x1b[1mdiff --git a/f b/f\x1b[m",
	"\x1b[36m@@ -1 +1 @@\x1b[m",
	"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\",
	"\x1b[48;2;1;2;3mbg\x1b[0m",
	"no escapes at all",
]) {
	ok(`matches pi's stripAnsi: ${JSON.stringify(sample)}`, plain(sample) === piStripAnsi(sample).replace(/\r/g, ""));
}

// ---- sentinel collision: U+E000 in input content is stripped before fill() can expand it
//
// U+E000 is the first code point of the Unicode Private Use Area, exactly
// where Nerd Fonts and Powerline put their glyphs. A diff of a file that
// contains such glyphs would otherwise have them treated as fill sentinels:
// fill() would insert padding at each glyph's position, corrupting the output.
// The fix: sanitize() and plain() strip any pre-existing U+E000 before
// inserting (or returning text destined for) fill().

{
	// sanitize(): pre-existing U+E000 (e.g. a Nerd Font glyph in diff content)
	// must be stripped before the erase-in-line sentinel is inserted.
	const glyphLine = `alpha${FILL_SENTINEL}beta`; // U+E000 in content, no erase sequence

	const sanitized = sanitize(glyphLine);
	ok(
		"sanitize strips pre-existing U+E000 from content before inserting its own",
		!sanitized.includes(FILL_SENTINEL),
		JSON.stringify([...sanitized].map((c) => c.codePointAt(0).toString(16))),
	);
	const filled = fill(sanitized, 40, visibleWidth);
	ok(
		"fill on sanitized content-only U+E000 adds no extra padding (equals its input)",
		filled === sanitized,
		JSON.stringify(filled),
	);
}

{
	// plain(): same guarantee for tool-result text arriving on the bash fallback path.
	const glyphLine = `alpha${FILL_SENTINEL}beta`; // U+E000 in content

	const p = plain(glyphLine);
	ok(
		"plain strips pre-existing U+E000 from content",
		!p.includes(FILL_SENTINEL),
		JSON.stringify([...p].map((c) => c.codePointAt(0).toString(16))),
	);
	const filled = fill(p, 40, visibleWidth);
	ok(
		"fill on plain content-only U+E000 adds no extra padding (equals its input)",
		filled === p,
		JSON.stringify(filled),
	);
}

{
	// A real delta line (erase-in-line present) plus a stray U+E000 in its
	// content: the stray glyph must be stripped (gone), not expanded into
	// padding (which would displace the real erase-in-line's fill position).
	//
	// Pre-fix: sanitize() leaves the glyph as a sentinel; fill() then sees two
	// sentinels and inserts padding at the glyph's position — the bg SGR ends
	// up AFTER the spaces instead of before them, so the terminal paints them
	// in the default colour, not the diff's background colour.
	// Post-fix: the glyph is stripped first; one sentinel remains at the real
	// erase position; the output matches the same line without the glyph.
	//
	// Note: the width assertion also passes pre-fix (both produce a 20-wide
	// line). The equality assertion is what fails pre-fix.
	const bgSgr = "\x1b[48;2;40;59;77m";
	const width = 20;
	const lineWithGlyph = `alpha${FILL_SENTINEL}${bgSgr}\x1b[0K`;
	const lineWithout = `alpha${bgSgr}\x1b[0K`;

	const filledWith = fill(sanitize(lineWithGlyph), width, visibleWidth);
	const filledWithout = fill(sanitize(lineWithout), width, visibleWidth);
	ok(
		"real erase-in-line still pads to exactly the render width when content had a stray U+E000",
		visibleWidth(filledWith) === width,
		String(visibleWidth(filledWith)),
	);
	ok(
		"output with stray U+E000 equals the same line without it: glyph is gone, not expanded into misplaced padding",
		filledWith === filledWithout,
		JSON.stringify({ with: filledWith, without: filledWithout }),
	);
}

done();
