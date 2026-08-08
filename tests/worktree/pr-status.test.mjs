/**
 * Tests for the PR status orchestration in worktree/index.ts.
 *
 *   cd tests && npm install && node worktree/pr-status.test.mjs
 *
 * `pr.ts` and `gh.ts` are unit tested elsewhere; this file covers the wiring
 * between them, which is where every defect in the feature has been found: the
 * generation guard against session replacement, the single-flight refresh, the
 * in-session branch re-read and repaint, the error backoff, and the hasUI gate.
 *
 * The extension is driven through a fake `pi` whose `exec` runs real git in a
 * throwaway repo and intercepts `gh`, so the git half is real behaviour and the
 * network half is scripted.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;

/** Wait until `predicate` holds. Refreshes are fire-and-forget, so nothing to await. */
const until = async (predicate, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
};

const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const gitOk = { code: 0, stdout: "", stderr: "", killed: false };

/** A repo with one commit on `feature/one`. */
async function makeRepo() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-pr-status-")));
	await pexec("git", ["init", "-q", "-b", "feature/one"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

/**
 * Load the extension against a fake pi.
 *
 * `gh` is answered by the current script; everything else (git) really runs.
 * The fake pi mints a fresh context per session_start, as pi does — see
 * tests/fake-pi.mjs. That is what makes the generation-guard case below
 * observable at all.
 */
function harness(cwd, { hasUI = true, mode = "interactive" } = {}) {
	const ghCalls = [];
	let script = async () => ({ ...gitOk, stdout: "[]" });

	const h = createFakePi({
		cwd,
		hasUI,
		mode,
		exec: async (command, args, options) => {
			if (command !== "gh") return undefined;
			ghCalls.push(args);
			return await script(args, options);
		},
	});
	extension(h.pi);

	return {
		...h,
		ghCalls,
		setScript: (fn) => {
			script = fn;
		},
		/** gh calls that looked up a PR (rather than the repo name). */
		prCalls: () => ghCalls.filter((args) => args[0] === "pr"),
		last: () => h.statuses.at(-1),
	};
}

/** gh script: the repo name, then a PR payload per branch. */
const scripted = (nameWithOwner, byBranch) => async (args) => {
	if (args[0] === "repo") return { ...gitOk, stdout: JSON.stringify({ nameWithOwner }) };
	const branch = args[args.indexOf("--head") + 1];
	const answer = byBranch[branch];
	if (typeof answer === "function") return await answer();
	return { ...gitOk, stdout: JSON.stringify(answer ?? []) };
};

const openPr = (number) => [
	{
		number,
		state: "OPEN",
		isDraft: false,
		url: `https://github.com/joel/thing/pull/${number}`,
		statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
	},
];

// ============================================================== happy path

{
	const dir = await makeRepo();
	const h = harness(dir);
	h.setScript(scripted("joel/thing", { "feature/one": openPr(7) }));

	await h.fire("session_start");
	ok("paints the branch's PR", await until(() => /#7 open/.test(h.last() ?? "")), JSON.stringify(h.statuses));
	ok("includes the rollup glyph", /#7 open ✓/.test(h.last() ?? ""), h.last());
	ok("links to the Graphite page for this repo", (h.last() ?? "").includes("app.graphite.com/github/pr/joel/thing/7"), h.last());
	ok("looks the branch up by --head", h.prCalls()[0]?.join(" ").includes("--head feature/one"), JSON.stringify(h.prCalls()));

	// A fresh cache entry must not spawn gh again on every submitted message.
	const before = h.prCalls().length;
	await h.fire("input");
	await new Promise((resolve) => setTimeout(resolve, 100));
	ok("a fresh cache entry is not re-fetched", h.prCalls().length === before, `${before} -> ${h.prCalls().length}`);

	await h.fire("session_shutdown");
	ok("shutdown clears the segment", h.last() === undefined, JSON.stringify(h.statuses.at(-1)));

	await rm(dir, { recursive: true, force: true });
}

// ================================================================ hasUI gate

{
	const dir = await makeRepo();
	const h = harness(dir, { hasUI: false, mode: "print" });
	h.setScript(scripted("joel/thing", { "feature/one": openPr(7) }));

	await h.fire("session_start");
	await h.fire("input");
	await new Promise((resolve) => setTimeout(resolve, 150));
	ok("no footer means no gh at all", h.ghCalls.length === 0, JSON.stringify(h.ghCalls));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ========================================================= generation guard

{
	// A session can be replaced (`/new`, resume) mid-fetch — possibly into another
	// repo. The superseded fetch must not write nameWithOwner, or every later PR
	// would be linked to the wrong repository.
	const dir = await makeRepo();
	const h = harness(dir);

	const gate = deferred();
	let repoLookups = 0;
	h.setScript(async (args) => {
		if (args[0] === "repo") {
			repoLookups += 1;
			if (repoLookups === 1) {
				await gate.promise;
				return { ...gitOk, stdout: JSON.stringify({ nameWithOwner: "stale/repo" }) };
			}
			return { ...gitOk, stdout: JSON.stringify({ nameWithOwner: "fresh/repo" }) };
		}
		const branch = args[args.indexOf("--head") + 1];
		return { ...gitOk, stdout: JSON.stringify(branch === "feature/one" ? openPr(7) : []) };
	});

	await h.fire("session_start");
	ok("the first fetch reaches gh", await until(() => repoLookups === 1));

	// Replace the session while that lookup is still in flight, then let it land.
	const superseded = h.ctx();
	await h.fire("session_start");
	ok("the replacement session fetches again", await until(() => repoLookups === 2));
	// Snapshot before the stale fetch lands, or a paint through the stale ctx would
	// already be counted and the assertion below could never fail.
	const paintsAtReplacement = superseded.paints.length;
	gate.resolve();

	ok("the replacement paints", await until(() => /#7 open/.test(h.last() ?? "")), JSON.stringify(h.statuses));
	ok(
		"a superseded lookup cannot write nameWithOwner",
		h.statuses.every((status) => !(status ?? "").includes("stale/repo")),
		JSON.stringify(h.statuses),
	);
	// The replaced session's ctx is stale: pi throws if an extension touches one,
	// so a superseded fetch landing must not paint through it. This is what makes
	// disposing the previous session in session_start load-bearing rather than tidy.
	await new Promise((resolve) => setTimeout(resolve, 50));
	ok(
		"a superseded session never paints through its stale ctx",
		superseded.paints.length === paintsAtReplacement,
		`${superseded.paints.length} paints vs ${paintsAtReplacement} at replacement`,
	);
	ok(
		"the in-flight guard is not latched by the superseded fetch",
		h.prCalls().length >= 1,
		JSON.stringify(h.prCalls()),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ================================================ branch change and backoff

{
	// The branch can change inside a live session, and the footer must never keep
	// showing (and linking) the previous branch's PR — including while a gh outage
	// has the fetch itself backed off.
	const dir = await makeRepo();
	const h = harness(dir);
	h.setScript(
		scripted("joel/thing", {
			"feature/one": openPr(7),
			// The new branch's lookup fails, which starts the error backoff.
			"feature/two": async () => ({
				...gitOk,
				code: 1,
				stderr: "dial tcp: lookup api.github.com: no such host\n",
			}),
		}),
	);

	await h.fire("session_start");
	ok("branch one paints", await until(() => /#7 open/.test(h.last() ?? "")), JSON.stringify(h.statuses));

	await pexec("git", ["switch", "-q", "-c", "feature/two"], { cwd: dir });
	await h.fire("input");
	ok(
		"switching branches drops the previous branch's PR",
		await until(() => h.last() === undefined),
		JSON.stringify(h.statuses),
	);
	ok("the new branch was looked up", await until(() => h.prCalls().some((args) => args.includes("feature/two"))));

	// Back to the branch with a cached PR, while the backoff is still in force.
	const before = h.prCalls().length;
	await pexec("git", ["switch", "-q", "feature/one"], { cwd: dir });
	await h.fire("input");
	ok(
		"a backed-off refresh still re-reads the branch and repaints",
		await until(() => /#7 open/.test(h.last() ?? "")),
		JSON.stringify(h.statuses),
	);
	ok("and spawns no gh call while backed off", h.prCalls().length === before, `${before} -> ${h.prCalls().length}`);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// =========================================================== failed lookups

{
	// A failed lookup must not put a gh call (up to 10s each, serialized) in front
	// of every submitted message. Whether *this* failure is terminal is gh.ts's
	// call and is tested there; here it only has to stop hammering.
	const dir = await makeRepo();
	const h = harness(dir);
	h.setScript(async () => ({ ...gitOk, code: 1, stderr: "dial tcp: no such host\n" }));

	await h.fire("session_start");
	ok("the failure is discovered", await until(() => h.ghCalls.length === 1));
	await h.fire("input");
	await h.fire("input");
	await new Promise((resolve) => setTimeout(resolve, 150));
	ok("a failed lookup is not retried on every message", h.ghCalls.length === 1, JSON.stringify(h.ghCalls));
	ok("and nothing is painted", h.statuses.every((status) => status === undefined), JSON.stringify(h.statuses));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ============================================================ non-repo cwd

{
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-pr-status-bare-")));
	const h = harness(dir);
	h.setScript(scripted("joel/thing", {}));

	await h.fire("session_start");
	await new Promise((resolve) => setTimeout(resolve, 150));
	ok("outside a repo nothing is fetched", h.ghCalls.length === 0, JSON.stringify(h.ghCalls));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

done();
