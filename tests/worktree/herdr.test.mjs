/**
 * Tests for reporting pi's branch to herdr (lib/herdr.ts).
 *
 *   cd tests && npm install && node worktree/herdr.test.mjs
 *
 * No subprocesses and no herdr: a fake runner records argv. The argv is
 * asserted as an ordered array on purpose — herdr 0.8.0 rejects `--source=pi`
 * and requires the positional first, so a "contains pi_branch" assertion would
 * pass against a command herdr refuses to run.
 */

import { assertions, fakeRunner, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createHerdrReporter, herdrTarget, HERDR_TIMEOUT_MS } = await loadExt("lib/herdr.ts");

const TARGET = { workspaceId: "wF", paneId: "wF:p1" };

/** Reports are fire-and-forget; give the microtasks a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A runner that records calls and answers each with a scripted result. */
function scriptedRunner(results = []) {
	const calls = [];
	let index = 0;
	return {
		calls,
		async exec(command, args, options = {}) {
			calls.push({ command, args, options });
			const result = results[Math.min(index++, results.length - 1)] ?? {};
			return { stdout: "", stderr: "", code: 0, killed: false, ...result };
		},
	};
}

// ============================================================ target from env

{
	ok("target: needs both ids", herdrTarget({ HERDR_WORKSPACE_ID: "wF" }) === undefined);
	ok("target: no herdr, no target", herdrTarget({}) === undefined);
	const target = herdrTarget({ HERDR_WORKSPACE_ID: "wF", HERDR_PANE_ID: "wF:p1" });
	ok("target: reads both ids", target?.workspaceId === "wF" && target?.paneId === "wF:p1");
}

// ==================================================================== argv

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("fix-parser");
	await settle();

	ok("argv: one call per surface", runner.calls.length === 2, JSON.stringify(runner.calls));
	ok("argv: runs herdr", runner.calls.every((call) => call.command === "herdr"));
	ok(
		"argv: workspace token, positional first",
		JSON.stringify(runner.calls[0]?.args) ===
			JSON.stringify([
				"workspace",
				"report-metadata",
				"wF",
				"--source",
				"pi",
				"--token",
				"pi_branch=fix-parser",
			]),
		JSON.stringify(runner.calls[0]?.args),
	);
	// The pane carries the token as well as the title, in the same command: the
	// Agents panel renders pane-reported values as `$pi_branch`, and its rows
	// cannot read the workspace token. Riding along on the existing call is why
	// showing the branch there costs no extra spawn.
	ok(
		"argv: pane title and token, positional first",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify([
				"pane",
				"report-metadata",
				"wF:p1",
				"--source",
				"pi",
				"--title",
				"π - fix-parser",
				"--token",
				"pi_branch=fix-parser",
			]),
		JSON.stringify(runner.calls[1]?.args),
	);
	ok("argv: still one call per surface", runner.calls.length === 2, `${runner.calls.length} calls`);
	ok("argv: passes a timeout", runner.calls[0]?.options.timeout === HERDR_TIMEOUT_MS);
}

// ========================================================== prefix stripping

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET, branchPrefix: "joel/" });
	reporter.report("joel/fix-parser");
	await settle();
	ok("prefix: the user's own prefix is dropped", runner.calls[0]?.args.includes("pi_branch=fix-parser"), JSON.stringify(runner.calls[0]?.args));
	ok("prefix: the title drops it too", runner.calls[1]?.args.includes("π - fix-parser"));
	ok("prefix: the pane token drops it too", runner.calls[1]?.args.includes("pi_branch=fix-parser"), JSON.stringify(runner.calls[1]?.args));
}

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET, branchPrefix: "joel/" });
	reporter.report("alice/hotfix");
	await settle();
	ok("prefix: someone else's branch is untouched", runner.calls[0]?.args.includes("pi_branch=alice/hotfix"), JSON.stringify(runner.calls[0]?.args));
}

// ============================================================= detached HEAD

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report(undefined);
	await settle();
	ok(
		"detached: clears the token",
		JSON.stringify(runner.calls[0]?.args) ===
			JSON.stringify(["workspace", "report-metadata", "wF", "--source", "pi", "--clear-token", "pi_branch"]),
		JSON.stringify(runner.calls[0]?.args),
	);
	ok(
		"detached: clears the title and the pane token",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify([
				"pane",
				"report-metadata",
				"wF:p1",
				"--source",
				"pi",
				"--clear-title",
				"--clear-token",
				"pi_branch",
			]),
		JSON.stringify(runner.calls[1]?.args),
	);
}

// =================================================================== dedupe

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	reporter.report("main");
	reporter.report("main");
	await settle();
	ok("dedupe: an unchanged branch costs nothing", runner.calls.length === 2, `${runner.calls.length} calls`);

	reporter.report("other");
	await settle();
	ok("dedupe: a changed branch reports once", runner.calls.length === 4, `${runner.calls.length} calls`);
}

// Detached HEAD reports as undefined; a repeated undefined must also be deduped.
// Without this test, making send() skip last/sent updates for undefined passes
// the whole suite — but detached-HEAD sessions then fork two herdr processes on
// every 60s PR poll.
{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report(undefined);
	await settle();
	reporter.report(undefined);
	await settle();
	ok("dedupe: repeated detached-HEAD report costs nothing", runner.calls.length === 2, `${runner.calls.length} calls`);
}

// ======================================================== failure disables

{
	const runner = scriptedRunner([{ code: 1, stderr: "unknown workspace\n" }]);
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	const afterFailure = runner.calls.length;
	reporter.report("other");
	reporter.report("third");
	await settle();
	ok("failure: the reporter goes inert", runner.calls.length === afterFailure, `${runner.calls.length} vs ${afterFailure}`);
}

{
	const runner = { async exec() { throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }); } };
	const reporter = createHerdrReporter({ runner, target: TARGET });
	let threw = false;
	try {
		reporter.report("main");
		await settle();
	} catch {
		threw = true;
	}
	ok("failure: a missing herdr binary throws nothing", threw === false);
}

// ==================================================================== clear

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	await reporter.clear();
	ok("clear: issues both clears", runner.calls.length === 4, `${runner.calls.length} calls`);
	ok("clear: clears the token", runner.calls[2]?.args.includes("--clear-token") && runner.calls[2]?.args.includes("pi_branch"), JSON.stringify(runner.calls[2]?.args));
	ok("clear: clears the title", runner.calls[3]?.args.includes("--clear-title"), JSON.stringify(runner.calls[3]?.args));
}

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	await reporter.clear();
	ok("clear: nothing reported, nothing to clear", runner.calls.length === 0, JSON.stringify(runner.calls));
}

// ============================================================= clear: races

// report() in flight when clear() is called: clear must still land.
// Run against the unmodified clear() to confirm this fails, then apply the fix.
{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main"); // fire-and-forget — no settle
	await reporter.clear(); // clear races the in-flight report
	ok(
		"clear: in-flight report does not skip the clear",
		runner.calls.length === 4 &&
			runner.calls[0]?.args.some((a) => a.startsWith("pi_branch=")) &&
			runner.calls[2]?.args.includes("--clear-token") &&
			runner.calls[3]?.args.includes("--clear-title"),
		`${runner.calls.length} calls`,
	);
}

// workspace call succeeds but pane call fails (partial state on screen);
// clear() must still issue both clear commands.
{
	const runner = scriptedRunner([{ code: 0 }, { code: 1, stderr: "timeout" }]);
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	await reporter.clear();
	ok(
		"clear: partial send failure still clears",
		runner.calls.length >= 3 && runner.calls.some((c) => c.args.includes("--clear-token")),
		`${runner.calls.length} calls`,
	);
}

// =============================================== retirement mid-write

// A session replaced while a report is in flight must not finish it. The new
// session reports through the same workspace and pane ids with the same
// `--source pi`, so a late pane write from the old one is what ends up on screen.
{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const calls = [];
	let current = true;
	const runner = {
		async exec(_command, args) {
			calls.push(args);
			if (calls.length === 1) await gate; // wedge the workspace write
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const reporter = createHerdrReporter({ runner, target: TARGET, isCurrent: () => current });
	reporter.report("old");
	await settle();
	ok("retired: the workspace write is in flight", calls.length === 1, JSON.stringify(calls));

	// session_start: a newer reporter owns the ids now, and has already reported.
	current = false;
	reporter.dispose();
	release();
	await settle();
	ok("retired: no pane title is written after replacement", calls.length === 1, JSON.stringify(calls));
}

// The shutdown clear can lose its race with the next session: `/new` fires
// session_shutdown and then session_start, and index.ts's deadline abandons —
// but cannot cancel — a slow clear.
{
	const runner = fakeRunner();
	let current = true;
	const reporter = createHerdrReporter({ runner, target: TARGET, isCurrent: () => current });
	reporter.report("main");
	await settle();
	const before = runner.calls.length;
	current = false;
	await reporter.clear();
	ok(
		"clear: a superseded clear wipes nothing",
		runner.calls.length === before,
		`${runner.calls.length} vs ${before}`,
	);
}

{
	const calls = [];
	let current = true;
	const runner = {
		async exec(_command, args) {
			calls.push(args);
			// The next session starts while the first of the two clears is in flight.
			if (args.includes("--clear-token")) current = false;
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const reporter = createHerdrReporter({ runner, target: TARGET, isCurrent: () => current });
	reporter.report("main");
	await settle();
	await reporter.clear();
	ok(
		"clear: replacement between the two clears stops the second",
		calls.filter((args) => args.includes("--clear-title")).length === 0,
		JSON.stringify(calls),
	);
}

// =============================================== completion order across sessions

// The retired session's FIRST write cannot be cancelled — it is already spawned,
// so `isCurrent` cannot stop it. If herdr applies it after the new session's
// write, the workspace token is stale and stays stale: the new reporter dedupes
// on `last`, so it never re-reports the branch it already sent.
//
// Both reporters share one runner, as they do in production (`runner: pi`, one
// object per process, sessions come and go), which is what pairs them to the
// same queue. `completed` records COMPLETION order, not call order: the bug is
// invisible in argv recorded at call time.
{
	const completed = [];
	let releaseOld;
	const oldGate = new Promise((resolve) => {
		releaseOld = resolve;
	});
	const runner = {
		async exec(_command, args) {
			// The old session's workspace write finishes only after the new session
			// has reported.
			if (args[0] === "workspace" && args.includes("pi_branch=old")) await oldGate;
			completed.push(args);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	let generation = 0;
	const oldGeneration = ++generation;
	const retiring = createHerdrReporter({
		runner,
		target: TARGET,
		isCurrent: () => oldGeneration === generation,
	});
	retiring.report("old");
	await settle();

	// session_start: a new reporter owns the same ids and reports its own branch.
	const freshGeneration = ++generation;
	retiring.dispose();
	const fresh = createHerdrReporter({
		runner,
		target: TARGET,
		isCurrent: () => freshGeneration === generation,
	});
	fresh.report("new");
	await settle();

	releaseOld();
	await settle();
	const workspaceWrites = completed.filter((args) => args[0] === "workspace");
	ok(
		"order: the new session's workspace token lands last",
		workspaceWrites.at(-1)?.includes("pi_branch=new") === true,
		JSON.stringify(completed),
	);
	ok(
		"order: the retired session's write still happens, just first",
		workspaceWrites.length === 2 && workspaceWrites[0]?.includes("pi_branch=old") === true,
		JSON.stringify(completed),
	);
}

// A command that rejects must not take the queue down with it: the next session
// reports through the same runner, and its writes are chained behind that one.
{
	const calls = [];
	const runner = {
		async exec(_command, args) {
			calls.push(args);
			if (args.includes("pi_branch=boom")) throw new Error("spawn herdr ENOENT");
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const failing = createHerdrReporter({ runner, target: TARGET });
	failing.report("boom");
	await settle();
	const fresh = createHerdrReporter({ runner, target: TARGET });
	fresh.report("after");
	await settle();
	ok(
		"queue: a rejected command does not wedge the next session",
		calls.some((args) => args.includes("pi_branch=after")),
		JSON.stringify(calls),
	);
}

// ================================================================== dispose

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	const before = runner.calls.length;
	reporter.dispose();
	reporter.report("other");
	await settle();
	ok("dispose: a retired reporter is silent", runner.calls.length === before, `${runner.calls.length} vs ${before}`);
}

done();
