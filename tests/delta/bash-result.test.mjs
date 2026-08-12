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

import { assertions, loadExt, piEntry } from "../harness.mjs";
import { readFile } from "node:fs/promises";

const { ok, done } = assertions();
const { createBashResult, PREVIEW_LINES, formatDuration } = await loadExt("delta/bash-result.ts");

const theme = { fg: (color, text) => `<${color}>${text}` };
const hintFor = (skipped) => `<hint:${skipped}>`;
const truncate = (text, maxLines) => {
	const lines = text.split("\n");
	return {
		visualLines: lines.slice(-maxLines),
		skippedCount: Math.max(0, lines.length - maxLines),
	};
};

const build = ({ ready } = {}) => {
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
	ok("falls back to pi's styling", lines.some((l) => l.includes("PI(diff text)")), JSON.stringify(lines));
	ok(
		"warning line matches pi's format",
		lines.some((l) => l === "<warning>[Full output: /tmp/x. Truncated: showing 5 of 90 lines]"),
		JSON.stringify(lines),
	);
	ok("timing line present", lines.some((l) => l === "<muted>Took 1.2s"), JSON.stringify(lines));
	ok("engine asked at the render width", widths.at(-1) === 100);
}

// ---- empty output renders nothing but the extras

{
	const { component } = build({ ready: undefined });
	component.update({ body: "", warnings: [], expanded: false });
	ok("no body renders no lines", JSON.stringify(component.render(80)) === "[]");
}

// ---- the pinned copies

ok("formatDuration matches pi's format", formatDuration(1234) === "1.2s" && formatDuration(500) === "0.5s");

const source = await readFile((await piEntry()).replace(/index\.js$/, "core/tools/bash.js"), "utf-8");
ok(
	"PREVIEW_LINES still matches pi's BASH_PREVIEW_LINES",
	source.includes(`const BASH_PREVIEW_LINES = ${PREVIEW_LINES};`),
	"pi changed BASH_PREVIEW_LINES; update delta/bash-result.ts",
);
ok(
	"duration format still matches pi's formatDuration",
	source.includes("return `${(ms / 1000).toFixed(1)}s`;"),
	"pi changed formatDuration; update delta/bash-result.ts",
);

done();
