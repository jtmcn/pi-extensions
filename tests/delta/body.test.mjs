/**
 * The diff body is what the user actually looks at. Two things matter: it never
 * shows nothing while delta is still thinking, and it asks the engine for the
 * width it was really given.
 *
 *   node tests/delta/body.test.mjs
 */

import { assertions, loadExt, piEntry, piTuiEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { createDiffBody } = await loadExt("delta/body.ts");
const { fill, FILL_SENTINEL } = await loadExt("delta/ansi.ts");

const { truncateToVisualLines } = await import(`file://${await piEntry()}`);
const { visibleWidth } = await import(`file://${await piTuiEntry()}`);

/** Exactly the wrapper index.ts injects. */
const wrap = (text, width) => truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width).visualLines;

/** Exactly the wrapper index.ts injects. */
const fillWidth = (text, width) => fill(text, width, visibleWidth);

/** An engine whose answer the test flips, recording the widths it was asked for. */
const fakeEngine = () => {
	const widths = [];
	let answer;
	return {
		widths,
		ready: (text) => {
			answer = text;
		},
		lookup: (_text, width) => {
			widths.push(width);
			return answer;
		},
		reset: () => {},
	};
};

const engine = fakeEngine();
const body = createDiffBody({
	engine,
	fallback: (diff) => `PI:${diff}`,
	invalidate: () => {},
	fill: fillWidth,
	wrap,
});

body.set("PATCH", "DIFF");

// pi's wrapper pads every line out to the render width, exactly as it does for
// pi's own bash output, so the shape assertions compare trimmed lines.
const painted = (component, width) => component.render(width).map((line) => line.trimEnd());

ok("falls back before delta answers", JSON.stringify(painted(body, 80)) === '["","PI:DIFF"]', JSON.stringify(body.render(80)));
ok("asks for the width it was given", engine.widths.at(-1) === 80, String(engine.widths.at(-1)));
ok("lines are padded to the render width, as pi's own are", body.render(80).at(-1).length === 80, String(body.render(80).at(-1).length));

engine.ready("DELTA LINE 1\nDELTA LINE 2");
ok(
	"uses delta once available",
	JSON.stringify(painted(body, 80)) === '["","DELTA LINE 1","DELTA LINE 2"]',
	JSON.stringify(body.render(80)),
);

body.render(120);
ok("a resize asks at the new width", engine.widths.at(-1) === 120);

const noPatch = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {}, fill: fillWidth, wrap });
noPatch.set(undefined, "DIFF");
ok("no patch still renders pi's diff", JSON.stringify(painted(noPatch, 80)) === '["","PI:DIFF"]', JSON.stringify(noPatch.render(80)));

const nothing = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {}, fill: fillWidth, wrap });
nothing.set(undefined, undefined);
ok("nothing to show renders no lines", JSON.stringify(nothing.render(80)) === "[]");

// pi accepts duck-typed components, but only if they are the full duck: a
// component missing `invalidate` throws when pi rebuilds the row.
ok(
	"matches pi's duck-typed component shape",
	typeof body.render === "function" && typeof body.invalidate === "function",
);

// ---- no emitted line may exceed the render width
//
// pi's renderer treats an over-wide line as fatal: tui-main-screen.js throws
// "Rendered line N exceeds terminal width" and the TUI stops. `Box.render` only
// left-pads, it does not clip, so a component that hands back a raw
// `text.split("\n")` takes pi down the first time a diff line is longer than the
// terminal. Delta is *told* the width, but pi's own `renderDiff` fallback is not,
// so this fires with delta absent too.

{
	const long = "x".repeat(200);
	const wide = fakeEngine();
	const deltaBody = createDiffBody({ engine: wide, fallback: (diff) => diff, invalidate: () => {}, fill: fillWidth, wrap });
	deltaBody.set("PATCH", `-${long}\n+${long}`);

	const fallbackLines = deltaBody.render(60);
	ok(
		"fallback lines are wrapped to the render width",
		fallbackLines.length > 0 && fallbackLines.every((line) => visibleWidth(line) <= 60),
		JSON.stringify(fallbackLines.map((line) => visibleWidth(line))),
	);

	// Delta's own output is coloured, so the wrap has to be ANSI-aware.
	wide.ready(`\x1b[32m+${long}\x1b[0m`);
	const deltaLines = deltaBody.render(60);
	ok(
		"delta lines are wrapped to the render width",
		deltaLines.length > 0 && deltaLines.every((line) => visibleWidth(line) <= 60),
		JSON.stringify(deltaLines.map((line) => visibleWidth(line))),
	);
	// Wrapping, not truncating: pi wraps its own text, and half a diff line is
	// worse than a rewrapped one. (Each wrapped line re-opens the colour, and
	// pi's wrapper pads the last one, so compare on the plain text.)
	const plain = deltaLines.join("").replace(/\x1b\[[\d;]*m/g, "").trimEnd();
	ok("wrapping keeps the whole line", plain === `+${long}`, JSON.stringify(plain.length));
}

// ---- delta's background fill survives, instead of stopping where text does
//
// Real delta output ends a themed content line with erase-in-line to extend
// its background to the edge of the terminal (see delta/ansi.ts's doc
// comment for the real escape sequence). Before this fix, `sanitize` dropped
// that erase outright, so the rendered row's background stopped at the end of
// the text instead of filling the row — a themed diff read as ragged colour
// blocks floating inside pi's tool box.

{
	const engineWithSentinel = fakeEngine();
	const body = createDiffBody({ engine: engineWithSentinel, fallback: (diff) => diff, invalidate: () => {}, fill: fillWidth, wrap });
	body.set("PATCH", "DIFF");
	engineWithSentinel.ready(`\x1b[48;2;40;59;77malpha${FILL_SENTINEL}\x1b[0m`);

	const rendered = body.render(60);
	const contentLine = rendered.find((line) => line.includes("alpha"));
	ok("delta's line survives the render", contentLine !== undefined, JSON.stringify(rendered));
	ok("no sentinel escapes to the rendered frame", !rendered.some((line) => line.includes(FILL_SENTINEL)), JSON.stringify(rendered));
	ok(
		"the background-filled line is padded to exactly the render width",
		visibleWidth(contentLine) === 60,
		String(visibleWidth(contentLine)),
	);
}

done();
