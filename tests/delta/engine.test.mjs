/**
 * The engine is the only place that decides when delta runs. Each assertion
 * here corresponds to a way this can go wrong in a live session: a render loop
 * spawning a process per frame, a failure retried forever, a warning repeated
 * per diff, or a completed run painting through the ctx of a session that has
 * already been replaced.
 *
 *   node tests/delta/engine.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createEngine } = await loadExt("delta/engine.ts");
const { createCache } = await loadExt("delta/cache.ts");
const { DEFAULT_CONFIG } = await loadExt("delta/config.ts");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A runner whose answers and call log the test controls. */
const fakeRunner = ({ output = "DELTA", available = true } = {}) => {
	const calls = [];
	return {
		calls,
		available: async () => available,
		render: async (text, width) => {
			calls.push({ text, width });
			return typeof output === "function" ? output(text, width) : output;
		},
		reset: () => {},
	};
};

const build = (overrides = {}) => {
	const cache = createCache(8);
	const runner = overrides.runner ?? fakeRunner();
	const unavailable = [];
	const engine = createEngine({
		cache,
		runner,
		config: () => ({ ...DEFAULT_CONFIG, ...overrides.config }),
		version: () => overrides.version?.() ?? "v1",
		onUnavailable: () => unavailable.push(Date.now()),
	});
	return { engine, runner, cache, unavailable };
};

// ---- the basic two-phase lookup

{
	const { engine, runner } = build();
	const repaints = [];
	ok("first lookup is a miss", engine.lookup("patch", 80, () => repaints.push(1)) === undefined);
	await settle();
	ok("delta ran once", runner.calls.length === 1, String(runner.calls.length));
	ok("repaint requested", repaints.length === 1, String(repaints.length));
	ok("second lookup is a hit", engine.lookup("patch", 80, () => repaints.push(2)) === "DELTA");
	ok("a hit does not re-run delta", runner.calls.length === 1);
	ok("a hit does not repaint", repaints.length === 1);
}

// ---- one process per diff, however many repaints

{
	const { engine, runner } = build();
	for (let i = 0; i < 5; i++) engine.lookup("patch", 80, () => {});
	await settle();
	ok("repeated misses spawn one run", runner.calls.length === 1, String(runner.calls.length));
}

// ---- width and config are part of identity

{
	const { engine, runner } = build();
	engine.lookup("patch", 80, () => {});
	await settle();
	engine.lookup("patch", 120, () => {});
	await settle();
	ok("a new width re-runs delta", runner.calls.length === 2, String(runner.calls.length));
	ok("width is passed through", runner.calls[1].width === 120);
}

// ---- failures are remembered

{
	const { engine, runner } = build({ runner: fakeRunner({ output: () => undefined }) });
	const repaints = [];
	ok("failed lookup is a miss", engine.lookup("patch", 80, () => repaints.push(1)) === undefined);
	await settle();
	ok("failure does not repaint", repaints.length === 0, String(repaints.length));
	for (let i = 0; i < 3; i++) {
		ok(`failure stays a miss (${i})`, engine.lookup("patch", 80, () => {}) === undefined);
		await settle();
	}
	ok("failure is not retried", runner.calls.length === 1, String(runner.calls.length));
}

// ---- guards that never reach the runner

{
	const { engine, runner } = build({ config: { enabled: false } });
	engine.lookup("patch", 80, () => {});
	await settle();
	ok("disabled never runs delta", runner.calls.length === 0);
}

{
	const { engine, runner } = build({ config: { maxBytes: 8 } });
	engine.lookup("a much longer diff than eight bytes", 80, () => {});
	await settle();
	ok("oversized input never runs delta", runner.calls.length === 0);
}

{
	const { engine, runner } = build();
	engine.lookup("", 80, () => {});
	await settle();
	ok("empty input never runs delta", runner.calls.length === 0);
}

// ---- missing binary warns once per session

{
	const { engine, unavailable } = build({ runner: fakeRunner({ available: false }) });
	engine.lookup("one", 80, () => {});
	await settle();
	engine.lookup("two", 80, () => {});
	await settle();
	ok("unavailable warns once", unavailable.length === 1, String(unavailable.length));
	engine.reset();
	engine.lookup("three", 80, () => {});
	await settle();
	ok("a new session warns again", unavailable.length === 2, String(unavailable.length));
}

// ---- a superseded session must not be painted through
//
// This is the bug class the repo conventions exist for: `invalidate` belongs to
// a ctx that throws once its session is replaced.

{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const runner = {
		available: async () => true,
		render: async () => {
			await gate;
			return "DELTA";
		},
		reset: () => {},
	};
	const { engine } = build({ runner });
	let painted = 0;
	engine.lookup("patch", 80, () => {
		painted += 1;
		throw new Error("extension ctx is stale");
	});
	engine.reset(); // the session is replaced while delta is still running
	release();
	await settle();
	ok("stale session is not painted", painted === 0, String(painted));
}

// ---- a throwing invalidate must not escape

{
	const { engine } = build();
	engine.lookup("patch", 80, () => {
		throw new Error("extension ctx is stale");
	});
	let crashed = false;
	process.once("unhandledRejection", () => {
		crashed = true;
	});
	await settle();
	ok("a throwing repaint is swallowed", crashed === false);
}

done();
