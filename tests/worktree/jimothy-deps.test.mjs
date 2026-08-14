/**
 * The Deps adapter that lets jimothy's model run subprocesses as pi's children.
 *
 * The model asks for a 15-minute install timeout, which is right for a launcher
 * sitting on a terminal it has already cleared and wrong for a slash command: a
 * session wedged for a quarter of an hour on a credential prompt is
 * unrecoverable, not slow. So the adapter clamps. It also has to tell a timeout
 * from an abort, which `pi.exec` reports identically as `killed`.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createDeps, INSTALL_TIMEOUT_CEILING_MS } = await loadExt("worktree/jimothy.ts");

/** A fake pi whose exec records its options and answers from a script. */
function fakeRunner(answer = () => ({ stdout: "out", stderr: "", code: 0, killed: false })) {
	const calls = [];
	return {
		calls,
		exec: async (command, args, options = {}) => {
			calls.push({ command, args, options });
			return answer(command, args, options);
		},
	};
}

// --- passthrough ---------------------------------------------------------
{
	const runner = fakeRunner();
	const deps = createDeps(runner);
	const result = await deps.run("git", ["status"], { cwd: "/tmp/x" });
	ok("passes the command through", runner.calls[0].command === "git");
	ok("passes the cwd through", runner.calls[0].options.cwd === "/tmp/x");
	ok("returns the model's RunResult shape", result.code === 0 && result.stdout === "out" && result.stderr === "");
	ok("does not claim a timeout when none happened", result.timedOut !== true);
}

// --- the clamp -----------------------------------------------------------
{
	const runner = fakeRunner();
	const deps = createDeps(runner);
	await deps.run("npm", ["install"], { cwd: "/tmp/x", timeoutMs: 15 * 60_000 });
	ok(
		"clamps the model's timeout to the adapter's ceiling",
		runner.calls[0].options.timeout === INSTALL_TIMEOUT_CEILING_MS,
	);
}
{
	const runner = fakeRunner();
	const deps = createDeps(runner);
	await deps.run("git", ["status"], { timeoutMs: 1_000 });
	ok("leaves a timeout below the ceiling alone", runner.calls[0].options.timeout === 1_000);
}
{
	const runner = fakeRunner();
	const deps = createDeps(runner);
	await deps.run("git", ["status"], {});
	ok("passes no timeout when the model asked for none", runner.calls[0].options.timeout === undefined);
}

// --- timeout versus abort ------------------------------------------------
{
	// pi reports both as `killed`, so the adapter must know which it caused.
	const runner = fakeRunner(() => ({ stdout: "", stderr: "", code: 1, killed: true }));
	const deps = createDeps(runner);
	const result = await deps.run("npm", ["install"], { timeoutMs: 5 });
	ok("reports a killed child with a timeout as timedOut", result.timedOut === true);
}
{
	const controller = new AbortController();
	controller.abort();
	const runner = fakeRunner(() => ({ stdout: "", stderr: "", code: 1, killed: true }));
	const deps = createDeps(runner, { signal: controller.signal });
	const result = await deps.run("npm", ["install"], { timeoutMs: 5 });
	ok("reports a killed child under an aborted signal as not timedOut", result.timedOut !== true);
}

// --- the session's signal ------------------------------------------------
{
	const controller = new AbortController();
	const runner = fakeRunner();
	const deps = createDeps(runner, { signal: controller.signal });
	await deps.run("git", ["status"], {});
	ok("passes the session's signal to pi", runner.calls[0].options.signal === controller.signal);
}

// --- env, which pi's exec has no way to pass through ---------------------
{
	// pi's ExecOptions has no env field, so silently dropping opts.env would
	// let a caller that depends on a custom environment run with the wrong
	// one and fail somewhere else entirely. The adapter refuses instead.
	const deps = createDeps(fakeRunner());
	let threw = false;
	try {
		await deps.run("git", ["status"], { env: { FOO: "bar" } });
	} catch {
		threw = true;
	}
	ok("run refuses rather than dropping env", threw);
}

// --- the parts the model needs but pi does not provide -------------------
{
	const deps = createDeps(fakeRunner());
	ok("now() returns a Date", deps.now() instanceof Date);
	ok("isPidAlive answers for this process", deps.isPidAlive(process.pid) === true);
	let threw = false;
	try {
		deps.spawn("pi", []);
	} catch {
		threw = true;
	}
	ok("spawn refuses rather than pretending", threw);
}

done();
