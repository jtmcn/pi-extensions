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
	ok(
		"argv: pane title, positional first",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify(["pane", "report-metadata", "wF:p1", "--source", "pi", "--title", "π - fix-parser"]),
		JSON.stringify(runner.calls[1]?.args),
	);
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
		"detached: clears the title",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify(["pane", "report-metadata", "wF:p1", "--source", "pi", "--clear-title"]),
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
