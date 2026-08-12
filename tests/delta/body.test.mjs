/**
 * The diff body is what the user actually looks at. Two things matter: it never
 * shows nothing while delta is still thinking, and it asks the engine for the
 * width it was really given.
 *
 *   node tests/delta/body.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createDiffBody } = await loadExt("delta/body.ts");

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
});

body.set("PATCH", "DIFF");

ok("falls back before delta answers", JSON.stringify(body.render(80)) === '["","PI:DIFF"]', JSON.stringify(body.render(80)));
ok("asks for the width it was given", engine.widths.at(-1) === 80, String(engine.widths.at(-1)));

engine.ready("DELTA LINE 1\nDELTA LINE 2");
ok(
	"uses delta once available",
	JSON.stringify(body.render(80)) === '["","DELTA LINE 1","DELTA LINE 2"]',
	JSON.stringify(body.render(80)),
);

body.render(120);
ok("a resize asks at the new width", engine.widths.at(-1) === 120);

const noPatch = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {} });
noPatch.set(undefined, "DIFF");
ok("no patch still renders pi's diff", JSON.stringify(noPatch.render(80)) === '["","PI:DIFF"]');

const nothing = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {} });
nothing.set(undefined, undefined);
ok("nothing to show renders no lines", JSON.stringify(nothing.render(80)) === "[]");

ok("invalidate is callable", (() => { body.invalidate(); return true; })());

done();
