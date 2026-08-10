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

/** A repo with one commit on `feature/one`. */
async function makeRepo() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-")));
	await pexec("git", ["init", "-q", "-b", "feature/one"], { cwd: dir });
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

process.env.HERDR_WORKSPACE_ID = saved.ws ?? "";
process.env.HERDR_PANE_ID = saved.pane ?? "";
await rm(repo, { recursive: true, force: true });
done();
