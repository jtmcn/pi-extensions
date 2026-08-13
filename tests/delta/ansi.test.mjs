/**
 * Delta's output has to survive pi's frame. Everything stripped here is a
 * sequence that moves or erases, which pi's width accounting cannot see;
 * everything kept is colour, which is the entire point of the feature.
 *
 *   node tests/delta/ansi.test.mjs
 */

import { assertions, loadExt, piEntry, piTuiEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { sanitize, fill, FILL_SENTINEL, plain, restoreBackground } = await loadExt("delta/ansi.ts");
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
ok("tabs preserved", sanitize("a\tb") === "a\tb");

// ---- sanitize(): everything that is not colour is not trusted
//
// The allowlist matters more than the blocklist. `sanitize` used to strip two
// specific shapes (`[0-2]?K`, `[0-2]?J`) and pass everything else through, so
// any sequence outside those two patterns reached pi's frame intact: a cursor
// move pi's width accounting cannot see, or an erase pi has to repaint. Delta
// is not expected to emit these, but "the pager we shell out to only emits what
// we predicted" is not a property this module can enforce, and it is the only
// thing standing between delta's stdout and the frame.

ok(
	"erase-in-display with an out-of-range parameter is dropped (3J clears scrollback)",
	sanitize("a\x1b[3Jb") === "ab",
	JSON.stringify(sanitize("a\x1b[3Jb")),
);
ok(
	"multi-parameter erase-in-line still becomes the sentinel",
	sanitize("a\x1b[0;0Kb") === `a${FILL_SENTINEL}b`,
	JSON.stringify(sanitize("a\x1b[0;0Kb")),
);
ok(
	"8-bit CSI erase-in-line becomes the sentinel",
	sanitize("a\x9b0Kb") === `a${FILL_SENTINEL}b`,
	JSON.stringify(sanitize("a\x9b0Kb")),
);
ok(
	"8-bit CSI erase-in-display is dropped",
	sanitize("a\x9b2Jb") === "ab",
	JSON.stringify(sanitize("a\x9b2Jb")),
);
ok(
	"cursor movement is dropped",
	sanitize("a\x1b[999Db") === "ab",
	JSON.stringify(sanitize("a\x1b[999Db")),
);
ok(
	"cursor positioning is dropped",
	sanitize("a\x1b[10;20Hb") === "ab",
	JSON.stringify(sanitize("a\x1b[10;20Hb")),
);
ok(
	"scroll region is dropped",
	sanitize("a\x1b[1;5rb") === "ab",
	JSON.stringify(sanitize("a\x1b[1;5rb")),
);
ok(
	"private-mode set/reset (alternate screen) is dropped",
	sanitize("a\x1b[?1049hb") === "ab",
	JSON.stringify(sanitize("a\x1b[?1049hb")),
);
ok(
	"a non-CSI escape (RIS, full reset) is dropped",
	sanitize("a\x1bcb") === "ab",
	JSON.stringify(sanitize("a\x1bcb")),
);
ok(
	"a bare ESC with nothing after it is dropped",
	sanitize("a\x1b") === "a",
	JSON.stringify(sanitize("a\x1b")),
);
ok(
	"backspace is dropped (it moves the cursor pi cannot see)",
	sanitize("a\bb") === "ab",
	JSON.stringify(sanitize("a\bb")),
);
ok(
	"an OSC title change is dropped while OSC 8 hyperlinks survive",
	sanitize("a\x1b]0;title\x07b") === "ab",
	JSON.stringify(sanitize("a\x1b]0;title\x07b")),
);
ok(
	"an OSC 8 hyperlink terminated by ST (not BEL) is preserved",
	sanitize("\x1b]8;;http://x\x1b\\t\x1b]8;;\x1b\\") === "\x1b]8;;http://x\x1b\\t\x1b]8;;\x1b\\",
	JSON.stringify(sanitize("\x1b]8;;http://x\x1b\\t\x1b]8;;\x1b\\")),
);
ok(
	"an unterminated OSC does not swallow the rest of the line",
	!sanitize("a\x1b]8;;http://x").includes("\x1b"),
	JSON.stringify(sanitize("a\x1b]8;;http://x")),
);
ok(
	"a DCS string is dropped",
	sanitize("a\x1bPq#0;2;0;0;0\x1b\\b") === "ab",
	JSON.stringify(sanitize("a\x1bPq#0;2;0;0;0\x1b\\b")),
);
ok(
	"colour survives alongside a stripped movement sequence",
	sanitize("\x1b[31m\x1b[2Ared\x1b[0m") === "\x1b[31mred\x1b[0m",
	JSON.stringify(sanitize("\x1b[31m\x1b[2Ared\x1b[0m")),
);

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

// ---- restoreBackground(): re-establish pi's box background after every SGR
// reset in delta's own content, so a reset mid-line cannot cancel the single
// background span `Box.applyBg` wraps the whole row (content + padding) in.
// See the function's doc comment in delta/ansi.ts for the full mechanism.

const PREFIX = "\x1b[48;2;40;50;40m"; // stand-in for pi's toolSuccessBg prefix

ok(
	"a no-op when the prefix is empty (the edit row, which has no Box)",
	restoreBackground("alpha\x1b[0mbeta", "") === "alpha\x1b[0mbeta",
);

ok(
	"text with no resets is left untouched",
	restoreBackground("\x1b[38;2;10;20;30mplain\x1b[39m", PREFIX) === "\x1b[38;2;10;20;30mplain\x1b[39m",
	restoreBackground("\x1b[38;2;10;20;30mplain\x1b[39m", PREFIX),
);

ok(
	"ESC[0m: the reset is kept, and the prefix is appended right after it",
	restoreBackground("alpha\x1b[0mbeta", PREFIX) === `alpha\x1b[0m${PREFIX}beta`,
	restoreBackground("alpha\x1b[0mbeta", PREFIX),
);

ok(
	"bare ESC[m (implicit full reset) is treated the same as ESC[0m",
	restoreBackground("alpha\x1b[mbeta", PREFIX) === `alpha\x1b[m${PREFIX}beta`,
	restoreBackground("alpha\x1b[mbeta", PREFIX),
);

ok(
	"ESC[49m in isolation is replaced outright by the prefix: it served no other purpose",
	restoreBackground("alpha\x1b[49mbeta", PREFIX) === `alpha${PREFIX}beta`,
	restoreBackground("alpha\x1b[49mbeta", PREFIX),
);

ok(
	"composite ESC[0;1m (reset plus bold) keeps every code, prefix appended after",
	restoreBackground("alpha\x1b[0;1mbeta", PREFIX) === `alpha\x1b[0;1m${PREFIX}beta`,
	restoreBackground("alpha\x1b[0;1mbeta", PREFIX),
);

ok(
	"composite ESC[39;49m (fg default + bg default) keeps every code, prefix appended after",
	restoreBackground("alpha\x1b[39;49mbeta", PREFIX) === `alpha\x1b[39;49m${PREFIX}beta`,
	restoreBackground("alpha\x1b[39;49mbeta", PREFIX),
);

ok(
	"a 24-bit colour whose RGB component is literally 0 or 49 is not mistaken for a reset",
	restoreBackground("\x1b[38;2;10;49;0mtext\x1b[0m", PREFIX) === `\x1b[38;2;10;49;0mtext\x1b[0m${PREFIX}`,
	restoreBackground("\x1b[38;2;10;49;0mtext\x1b[0m", PREFIX),
);

ok(
	"a combined 24-bit bg+fg sequence (delta's real shape) is not mistaken for a reset",
	restoreBackground("\x1b[48;2;40;59;77;38;2;248;248;242mtext\x1b[0m", PREFIX) ===
		`\x1b[48;2;40;59;77;38;2;248;248;242mtext\x1b[0m${PREFIX}`,
	restoreBackground("\x1b[48;2;40;59;77;38;2;248;248;242mtext\x1b[0m", PREFIX),
);

ok(
	"256-colour bg/fg introducers (38/48;5;n) are not mistaken for a reset",
	restoreBackground("\x1b[48;5;196mtext\x1b[0m", PREFIX) === `\x1b[48;5;196mtext\x1b[0m${PREFIX}`,
	restoreBackground("\x1b[48;5;196mtext\x1b[0m", PREFIX),
);

ok(
	"a reset written with a leading zero (ESC[00m) is recognised as a reset",
	restoreBackground("alpha\x1b[00mbeta", PREFIX) === `alpha\x1b[00m${PREFIX}beta`,
	restoreBackground("alpha\x1b[00mbeta", PREFIX),
);

ok(
	"a padded background reset (ESC[049m) is recognised",
	restoreBackground("alpha\x1b[049mbeta", PREFIX) === `alpha${PREFIX}beta`,
	restoreBackground("alpha\x1b[049mbeta", PREFIX),
);

// A composite that resets *and then* sets a background has already put the
// background where it wants it; appending pi's prefix after that would paint
// over delta's own colour rather than restore pi's box.
ok(
	"a reset followed by a new background in the same sequence is left alone",
	restoreBackground("\x1b[0;48;2;1;2;3mtext", PREFIX) === "\x1b[0;48;2;1;2;3mtext",
	restoreBackground("\x1b[0;48;2;1;2;3mtext", PREFIX),
);
ok(
	"a reset followed by a 256-colour background in the same sequence is left alone",
	restoreBackground("\x1b[0;48;5;196mtext", PREFIX) === "\x1b[0;48;5;196mtext",
	restoreBackground("\x1b[0;48;5;196mtext", PREFIX),
);
ok(
	"a reset followed by a basic background in the same sequence is left alone",
	restoreBackground("\x1b[0;44mtext", PREFIX) === "\x1b[0;44mtext",
	restoreBackground("\x1b[0;44mtext", PREFIX),
);
ok(
	"a background set *before* a reset in the same sequence still restores",
	restoreBackground("\x1b[44;0mtext", PREFIX) === `\x1b[44;0m${PREFIX}text`,
	restoreBackground("\x1b[44;0mtext", PREFIX),
);

ok(
	"multiple resets on one line each get the prefix restored",
	restoreBackground("a\x1b[0mb\x1b[49mc\x1b[0md", PREFIX) === `a\x1b[0m${PREFIX}b${PREFIX}c\x1b[0m${PREFIX}d`,
	restoreBackground("a\x1b[0mb\x1b[49mc\x1b[0md", PREFIX),
);

{
	// The real delta line from the fill() tests above, run through
	// restoreBackground with pi's real prefix marker split out. Confirms the
	// exact interaction described in the doc comment: this runs before fill(),
	// so the (still-unexpanded) FILL_SENTINEL sits between delta's own
	// background and the restored prefix that follows delta's trailing reset.
	const restored = restoreBackground(sanitize(REAL_DELTA_LINE), PREFIX);
	ok(
		"the sentinel survives restoreBackground untouched, ready for fill()",
		restored.includes(FILL_SENTINEL),
		JSON.stringify(restored),
	);
	ok(
		"the trailing reset that would otherwise cancel the box background is followed by the prefix",
		restored.endsWith(`\x1b[0m${PREFIX}`),
		JSON.stringify(restored),
	);
}

done();
