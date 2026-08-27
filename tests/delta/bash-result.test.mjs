/**
 * The forked bash result rendering.
 *
 * Two of the values it reproduces are not exported by pi (the 5-line preview
 * and the duration format), so this file pins them against pi's own bash
 * renderer: if an upgrade changes either, these assertions fail instead of the
 * rendering quietly drifting.
 *
 *   node tests/delta/bash-result.test.mjs
 */

import { assertions, loadExt, piEntry, piTuiEntry } from "../harness.mjs";
import { readFile } from "node:fs/promises";

const { ok, done } = assertions();
const { createBashResult, collapsedPreview, PREVIEW_LINES, formatDuration } = await loadExt("delta/bash-result.ts");
const { fill } = await loadExt("delta/ansi.ts");

const { truncateToVisualLines } = await import(`file://${await piEntry()}`);
const { visibleWidth } = await import(`file://${await piTuiEntry()}`);

/** Exactly the wrapper index.ts injects. */
const realWrap = (text, width) => truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width).visualLines;

/** Exactly the wrapper index.ts injects. */
const realFill = (text, width) => fill(text, width, visibleWidth);

/** Identity fill: no sentinel in these fixtures, so a no-op is exactly right. */
const noopFill = (text) => text;

const theme = { fg: (color, text) => `<${color}>${text}` };
const hintFor = (skipped) => `<hint:${skipped}>`;
const truncate = (text, maxLines) => {
	const lines = text.split("\n");
	return {
		visualLines: lines.slice(-maxLines),
		skippedCount: Math.max(0, lines.length - maxLines),
	};
};

/** The identity "wrap" the shape assertions below use: one line stays one line. */
const wrap = (text) => text.split("\n");

const build = ({ ready, ...overrides } = {}) => {
	const widths = [];
	const engine = {
		lookup: (_text, width) => {
			widths.push(width);
			return ready;
		},
		reset: () => {},
	};
	const component = createBashResult({
		engine,
		theme,
		fallback: (text) => `PI(${text})`,
		invalidate: () => {},
		truncate,
		expandHint: hintFor,
		fill: noopFill,
		wrap,
		...overrides,
	});
	return { component, widths };
};

// ---- collapsed and expanded

{
	const { component } = build({ ready: "1\n2\n3\n4\n5\n6\n7" });
	component.update({ body: "diff", warnings: [], expanded: false });
	const collapsed = component.render(80);
	ok("collapsed keeps PREVIEW_LINES lines", collapsed.filter((l) => /^\d$/.test(l)).length === 5, JSON.stringify(collapsed));
	ok("collapsed shows the expand hint", collapsed.includes("<hint:2>"), JSON.stringify(collapsed));
	ok("hint carries the skipped count", collapsed.includes("<hint:2>"));
	ok("collapsed keeps the last lines", collapsed.at(-1) === "7");

	component.update({ body: "diff", warnings: [], expanded: true });
	const expanded = component.render(80);
	ok("expanded shows every line", expanded.filter((l) => /^\d$/.test(l)).length === 7);
	ok("expanded has no hint", !expanded.some((l) => l.startsWith("<hint")));
}

// ---- short output needs no hint

{
	const { component } = build({ ready: "1\n2" });
	component.update({ body: "diff", warnings: [], expanded: false });
	ok("no hint when nothing was skipped", !component.render(80).some((l) => l.startsWith("<hint")));
}

// ---- fallback, warnings, timing

{
	const { component, widths } = build({ ready: undefined });
	component.update({
		body: "diff text",
		warnings: ["Full output: /tmp/x", "Truncated: showing 5 of 90 lines"],
		expanded: true,
		timing: { label: "Took", ms: 1234 },
	});
	const lines = component.render(100);
	// Exact ordered-line assertion: blank + body, blank + warning, blank + timing.
	// A missing blank line must fail this assertion.
	const expected = [
		"",
		"PI(diff text)",
		"",
		"<warning>[Full output: /tmp/x. Truncated: showing 5 of 90 lines]",
		"",
		"<muted>Took 1.2s",
	];
	ok("exact line sequence: blank+body, blank+warning, blank+timing", JSON.stringify(lines) === JSON.stringify(expected), JSON.stringify(lines));
	ok("engine asked at the render width", widths.at(-1) === 100);
}

// ---- warning and timing with no body

{
	const { component } = build({ ready: undefined });
	component.update({
		body: "",
		warnings: ["Some warning"],
		expanded: false,
		timing: { label: "Elapsed", ms: 500 },
	});
	const lines = component.render(80);
	// No body block, but warning and timing still get their own blank-line spacers.
	const expected = ["", "<warning>[Some warning]", "", "<muted>Elapsed 0.5s"];
	ok("exact line sequence: blank+warning, blank+timing (no body)", JSON.stringify(lines) === JSON.stringify(expected), JSON.stringify(lines));
}

// ---- empty output renders nothing but the extras

{
	const { component } = build({ ready: undefined });
	component.update({ body: "", warnings: [], expanded: false });
	ok("no body renders no lines", JSON.stringify(component.render(80)) === "[]");
}

// ---- no emitted line may exceed the render width
//
// pi's renderer throws "Rendered line N exceeds terminal width" and stops the
// TUI; `Box.render` pads but never clips. Every line this component emits — the
// expanded body, the collapsed preview's hint, the warning, the timing — has to
// be wrapped to the width it was handed, not just the body pi's own
// `truncateToVisualLines` happens to wrap for us.

{
	const long = "x".repeat(200);
	const { component } = build({
		ready: `\x1b[32m+${long}\x1b[0m`,
		truncate: truncateToVisualLines,
		expandHint: (skipped) => `... (${skipped} earlier lines, ${"press ctrl+r ".repeat(4)}to expand)`,
		fill: realFill,
		wrap: realWrap,
		theme: { fg: (_color, text) => text },
	});

	component.update({
		body: "diff",
		warnings: [`Full output: /tmp/${"nested/".repeat(30)}out.txt`],
		expanded: true,
		timing: { label: "Took", ms: 1234 },
	});
	const expanded = component.render(60);
	ok(
		"expanded lines are wrapped to the render width",
		expanded.length > 0 && expanded.every((line) => visibleWidth(line) <= 60),
		JSON.stringify(expanded.map((line) => visibleWidth(line))),
	);

	component.update({ body: "diff", warnings: [], expanded: false });
	const collapsed = component.render(30);
	ok(
		"collapsed lines, hint included, are wrapped to the render width",
		collapsed.length > 0 && collapsed.every((line) => visibleWidth(line) <= 30),
		JSON.stringify(collapsed.map((line) => visibleWidth(line))),
	);
}

// ---- bgPrefix: restoreBackground runs on the engine's answer before fill()
//
// See delta/ansi.ts's `restoreBackground` doc comment and
// tests/delta/background-bleed.test.mjs for the full mechanism and the
// real-`ToolExecutionComponent` invariant this only has to wire correctly for.

{
	const PREFIX = "<BOXBG>";
	const { component } = build({ ready: `alpha\x1b[0mbeta`, fill: noopFill });
	component.update({ body: "diff", warnings: [], expanded: true, bgPrefix: PREFIX });
	const lines = component.render(80);
	ok(
		"the reset in the engine's answer is followed by bgPrefix",
		lines.some((l) => l.includes(`alpha\x1b[0m${PREFIX}beta`)),
		JSON.stringify(lines),
	);
}

{
	// No bgPrefix supplied (the field an older caller might omit, or the edit
	// row's empty prefix): restoreBackground is a no-op, exactly as if it were
	// never called.
	const { component } = build({ ready: `alpha\x1b[0mbeta`, fill: noopFill });
	component.update({ body: "diff", warnings: [], expanded: true, bgPrefix: "" });
	const lines = component.render(80);
	ok(
		"an empty bgPrefix leaves the engine's answer untouched",
		lines.some((l) => l === `alpha\x1b[0mbeta`),
		JSON.stringify(lines),
	);
}

// ---- the pinned copies

ok("formatDuration matches pi's format", formatDuration(1234) === "1.2s" && formatDuration(500) === "0.5s");

const source = await readFile((await piEntry()).replace(/index\.js$/, "core/tools/bash.js"), "utf-8");
ok(
	"PREVIEW_LINES still matches pi's BASH_PREVIEW_LINES",
	source.includes(`const BASH_PREVIEW_LINES = ${PREVIEW_LINES};`),
	"pi changed BASH_PREVIEW_LINES; update delta/bash-result.ts",
);
const fmtStart = source.indexOf("function formatDuration(");
const fmtBlock = source.slice(fmtStart, source.indexOf("\n}", fmtStart) + 2);
ok(
	"duration format still matches pi's formatDuration",
	fmtBlock.includes("return `${(ms / 1000).toFixed(1)}s`;"),
	"pi changed formatDuration; update delta/bash-result.ts",
);

// ---- collapsed preview starts at a logical-line boundary
//
// Delta will not wrap its own output when stdout is a pipe (`--width` and
// `--wrap-max-lines` both defeated, verified against real 0.19.2), so this
// extension's own `wrap` turns one long diff line into several visual rows.
// The naive "last N visual rows" cut (pi's own `truncateToVisualLines`, no
// memory of logical-line starts) can land inside one of those continuations
// — the reported bug: a preview beginning mid-line, with no gutter, because
// the gutter was drawn on the row above the cut.
//
// `wrapMarked` fakes delta's non-wrapping behaviour under control: logical
// line "B" always wraps to 5 visual rows ("B0".."B4"), "HUGE" to 10 ("H0".."H9"),
// and everything else stays one row — enough to place the naive cut inside a
// wrapped line on purpose.
{
	const wrapMarked = (text) =>
		text.split("\n").flatMap((line) => {
			if (line === "B") return ["B0", "B1", "B2", "B3", "B4"];
			if (line === "HUGE") return Array.from({ length: 10 }, (_, i) => `H${i}`);
			return [line];
		});
	const truncateMarked = (text, maxLines) => {
		const all = wrapMarked(text);
		if (all.length <= maxLines) return { visualLines: all, skippedCount: 0 };
		return { visualLines: all.slice(-maxLines), skippedCount: all.length - maxLines };
	};

	// A: 1 row, B: 5 rows, C: 1 row -> naive last-5 cut lands on B's second row.
	const preview = collapsedPreview("A\nB\nC", 5, 80, wrapMarked, truncateMarked);
	ok(
		"drops forward to the next logical line's first row",
		JSON.stringify(preview.visualLines) === '["C"]',
		JSON.stringify(preview),
	);
	ok("skipped count matches what was actually dropped (all of A and B)", preview.skippedCount === 6, String(preview.skippedCount));

	// The naive cut already lands on a logical-line start: no adjustment needed.
	const aligned = collapsedPreview("A\nB\nC\nD\nE\nF", 3, 80, wrapMarked, truncateMarked);
	ok(
		"a cut that already starts a logical line is left alone",
		JSON.stringify(aligned.visualLines) === '["D","E","F"]',
		JSON.stringify(aligned),
	);

	// Degenerate case: the cut lands inside the very last logical line, which is
	// huge, and there is nothing after it to drop forward to. Keep the
	// continuation rather than showing an empty preview.
	const degenerate = collapsedPreview("HUGE", 5, 80, wrapMarked, truncateMarked);
	ok(
		"a single enormous logical line keeps its continuation instead of showing nothing",
		degenerate.visualLines.length === 5 && degenerate.visualLines[0] === "H5",
		JSON.stringify(degenerate),
	);

	// Nothing skipped: the whole naive result is returned untouched.
	const nothingSkipped = collapsedPreview("A\nB\nC", 100, 80, wrapMarked, truncateMarked);
	ok("nothing skipped needs no adjustment", nothingSkipped.skippedCount === 0);

	// ---- the same fix, wired through the real component
	{
		const { component } = build({
			ready: "A\nB\nC",
			wrap: wrapMarked,
			truncate: truncateMarked,
		});
		component.update({ body: "diff", warnings: [], expanded: false });
		const lines = component.render(80);
		ok("collapsed preview's first content row is a logical-line start", lines.includes("C"), JSON.stringify(lines));
		ok("no continuation row (B1..B4) leaks into the collapsed preview", !lines.some((l) => /^B[1-4]$/.test(l)), JSON.stringify(lines));
		ok("the hint reflects the actual dropped count, not the naive one", lines.includes("<hint:6>"), JSON.stringify(lines));
	}

	{
		const { component } = build({ ready: "HUGE", wrap: wrapMarked, truncate: truncateMarked });
		component.update({ body: "diff", warnings: [], expanded: false });
		const lines = component.render(80);
		ok(
			"the degenerate single-huge-line case still renders a non-empty preview",
			lines.some((l) => /^H\d$/.test(l)),
			JSON.stringify(lines),
		);
	}
}

done();
