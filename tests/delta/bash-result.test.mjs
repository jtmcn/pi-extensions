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
const { createBashResult, PREVIEW_LINES, formatDuration } = await loadExt("delta/bash-result.ts");

const { truncateToVisualLines } = await import(`file://${await piEntry()}`);
const { visibleWidth } = await import(`file://${await piTuiEntry()}`);

/** Exactly the wrapper index.ts injects. */
const realWrap = (text, width) => truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width).visualLines;

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

done();
