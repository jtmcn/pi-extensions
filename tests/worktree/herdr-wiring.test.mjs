/**
 * Tests for the herdr wiring in worktree/index.ts.
 *
 *   cd tests && npm install && node worktree/herdr-wiring.test.mjs
 *
 * lib/herdr.ts is unit tested in herdr.test.mjs; what is wired here is when a
 * reporter exists at all — under herdr, with a UI — and that shutdown takes
 * what it reported back off screen. Real git in a throwaway repo, herdr
 * intercepted.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;

const gitOk = { code: 0, stdout: "", stderr: "", killed: false };

/** A repo with one commit, on `feature/one` unless told otherwise. */
async function makeRepo(branch = "feature/one") {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-")));
	await pexec("git", ["init", "-q", "-b", branch], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

/** Wait until `predicate` holds; reports are fire-and-forget. */
const until = async (predicate, timeoutMs = 5_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
};

function harness(cwd, { hasUI = true } = {}) {
	const herdrCalls = [];
	const h = createFakePi({
		cwd,
		hasUI,
		exec: async (command, args) => {
			// gh is not the subject here; answer it so no PR text is fetched.
			if (command === "gh") return { ...gitOk, stdout: "[]" };
			if (command !== "herdr") return undefined;
			herdrCalls.push(args);
			return gitOk;
		},
	});
	extension(h.pi);
	return { ...h, herdrCalls };
}

const repo = await makeRepo();
const saved = { ws: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID };

// ============================================ under herdr, the branch is sent

{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const h = harness(repo);
	await h.fire("session_start");
	const reported = await until(
		() =>
			h.herdrCalls.some((args) => args.includes("pi_branch=feature/one")) &&
			h.herdrCalls.some((args) => args[0] === "pane" && args.includes("π - feature/one")),
	);
	ok("wiring: the session's branch reaches herdr", reported, JSON.stringify(h.herdrCalls));
	ok(
		"wiring: the workspace id comes from the environment",
		h.herdrCalls[0]?.[2] === "wT",
		JSON.stringify(h.herdrCalls[0]),
	);
	ok(
		"wiring: the pane title is reported too",
		h.herdrCalls.some((args) => args[0] === "pane" && args.includes("π - feature/one")),
		JSON.stringify(h.herdrCalls),
	);

	const before = h.herdrCalls.length;
	await h.fire("session_shutdown", { reason: "quit" });
	ok(
		"wiring: shutdown clears the token",
		h.herdrCalls.slice(before).some((args) => args.includes("--clear-token")),
		JSON.stringify(h.herdrCalls.slice(before)),
	);
	ok(
		"wiring: shutdown clears the title",
		h.herdrCalls.slice(before).some((args) => args.includes("--clear-title")),
		JSON.stringify(h.herdrCalls.slice(before)),
	);
}

// ========================================= the prefix stripped is jimothy's

// The sidebar is 18–36 columns wide and `jimothy/` is on every branch jimothy
// makes, so it is stripped for display. It has to come from jimothy's config:
// this extension no longer has a `branchPrefix` of its own, and a reporter given
// `""` would put the whole `jimothy/spike` on screen.
{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const prefixed = await makeRepo("jimothy/spike");
	const h = harness(prefixed);
	await h.fire("session_start");
	const stripped = await until(() => h.herdrCalls.some((args) => args.includes("pi_branch=spike")));
	ok("wiring: jimothy's branchPrefix is stripped for the sidebar", stripped, JSON.stringify(h.herdrCalls));
	ok(
		"wiring: the prefixed branch is never reported",
		h.herdrCalls.every((args) => !args.includes("pi_branch=jimothy/spike")),
		JSON.stringify(h.herdrCalls),
	);
	await rm(prefixed, { recursive: true, force: true });
}

// ================================================= not under herdr, and no UI

{
	process.env.HERDR_WORKSPACE_ID = "";
	process.env.HERDR_PANE_ID = "";
	const h = harness(repo);
	await h.fire("session_start");
	await new Promise((resolve) => setTimeout(resolve, 100));
	ok("wiring: outside herdr nothing is reported", h.herdrCalls.length === 0, JSON.stringify(h.herdrCalls));
}

{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const h = harness(repo, { hasUI: false });
	await h.fire("session_start");
	await new Promise((resolve) => setTimeout(resolve, 100));
	ok("wiring: no UI means no reporting", h.herdrCalls.length === 0, JSON.stringify(h.herdrCalls));
}

// ======================================= shutdown deadline: wedged herdr calls

// A herdr socket that never answers must not block session_shutdown indefinitely.
// With no deadline, clear() awaits up to four never-resolving execs; pi sends
// SIGTERM and SIGKILLs 5s later, so the window is dangerously wide.
{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";

	const herdrCalls = [];
	const h = createFakePi({
		cwd: repo,
		hasUI: true,
		exec: async (command, args) => {
			if (command === "gh") return { ...gitOk, stdout: "[]" };
			if (command !== "herdr") return undefined;
			herdrCalls.push(args);
			return new Promise(() => {}); // never resolves — simulates a wedged socket
		},
	});
	extension(h.pi);
	await h.fire("session_start");
	// Let the fire-and-forget report IIFE run and enter the exec call.
	await until(() => herdrCalls.length > 0);

	const t0 = Date.now();
	// Race the shutdown against a generous outer guard: if the implementation has
	// no deadline, the shutdown never resolves and the outer timer fires instead.
	const completed = await Promise.race([
		h.fire("session_shutdown", { reason: "quit" }).then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
	]);
	const elapsed = Date.now() - t0;
	ok(
		"wiring: shutdown with wedged herdr completes within the deadline",
		completed === true && elapsed < 2_000,
		`completed=${String(completed)}, elapsed=${elapsed}ms`,
	);
}

// ================================== gh unavailable: the branch still follows

// The branch reported to herdr is refreshed by the PR monitor's re-read. Once gh
// switches the PR feature off for the session (missing, unauthenticated, not a
// GitHub remote) no poll is armed either, so input is the only thing left that
// can notice a `git switch` — and it must.
{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const noGhRepo = await makeRepo();
	const herdrCalls = [];
	const h = createFakePi({
		cwd: noGhRepo,
		hasUI: true,
		exec: async (command, args) => {
			// pi resolves an unspawnable binary as exit 1 with both streams empty,
			// which is how a missing gh actually arrives.
			if (command === "gh") return { ...gitOk, code: 1 };
			if (command !== "herdr") return undefined;
			herdrCalls.push(args);
			return gitOk;
		},
	});
	extension(h.pi);
	await h.fire("session_start");
	await until(() => herdrCalls.some((args) => args.includes("pi_branch=feature/one")));

	await pexec("git", ["switch", "-q", "-c", "feature/two"], { cwd: noGhRepo });
	await h.fire("input", {});
	const followed = await until(
		() =>
			herdrCalls.some((args) => args.includes("pi_branch=feature/two")) &&
			herdrCalls.some((args) => args.includes("\u03c0 - feature/two")),
	);
	ok("wiring: a git switch reaches herdr with gh unavailable", followed, JSON.stringify(herdrCalls));
	await rm(noGhRepo, { recursive: true, force: true });
}

// ============================ session replacement: the retired write must lose

// `/new` while a report is in flight: the old session's remaining write would
// land on top of the new session's, since both address the same ids.
//
// The gate is released as soon as the new session has *issued* its report, not
// after it has landed: herdr commands are queued per surface, so the new
// session's workspace write deliberately waits for the retiring session's
// spawned one to finish. That is the ordering guarantee — old first, new last.
{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const raceRepo = await makeRepo();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const herdrCalls = [];
	// Completion order, not call order: which write herdr applies LAST is the
	// whole question, and both sessions report through the same `pi`.
	const landed = [];
	const h = createFakePi({
		cwd: raceRepo,
		hasUI: true,
		exec: async (command, args) => {
			if (command === "gh") return { ...gitOk, stdout: "[]" };
			if (command !== "herdr") return undefined;
			herdrCalls.push(args);
			// Wedge the first session's workspace write; everything after runs free.
			if (herdrCalls.length === 1) await gate;
			landed.push(args);
			return gitOk;
		},
	});
	extension(h.pi);
	await h.fire("session_start");
	await until(() => herdrCalls.length > 0);

	await pexec("git", ["switch", "-q", "-c", "feature/two"], { cwd: raceRepo });
	await h.fire("session_start");
	release();
	const replaced = await until(() => herdrCalls.some((args) => args.includes("\u03c0 - feature/two")));
	ok("wiring: the new session reports its own branch", replaced, JSON.stringify(herdrCalls));

	await new Promise((resolve) => setTimeout(resolve, 100));
	ok(
		"wiring: a retired session does not retitle the pane behind the new one",
		herdrCalls.every((args) => !args.includes("\u03c0 - feature/one")),
		JSON.stringify(herdrCalls),
	);
	ok(
		"wiring: the retired session's workspace write lands before the new one",
		landed.filter((args) => args[0] === "workspace").at(-1)?.includes("pi_branch=feature/two") === true,
		JSON.stringify(landed),
	);
	await rm(raceRepo, { recursive: true, force: true });
}

process.env.HERDR_WORKSPACE_ID = saved.ws ?? "";
process.env.HERDR_PANE_ID = saved.pane ?? "";
await rm(repo, { recursive: true, force: true });
done();
