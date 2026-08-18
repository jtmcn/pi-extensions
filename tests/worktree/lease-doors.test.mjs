/**
 * The doors that touch the worktree lease, wired to the real transition.
 *
 *   cd tests && node worktree/lease-doors.test.mjs
 *
 * This file exists because of what the other three could not see. `commands.test.mjs`
 * and `tool.test.mjs` both stub `moveFocus`, and `transition.test.mjs` only ever
 * dispatches `/worktree focus`. So nothing wired the real transition, the real
 * deferred queue and the real registry into `remove` and `adopt` — and both of
 * them turned out to have a hole exactly there:
 *
 *   - `/worktree remove` handed its own lease back through `dropLease`, which
 *     cannot see a release still sitting in the deferred queue. jimothy then
 *     refused the removal, naming *this* session as the holder that made it
 *     impossible.
 *   - `/worktree adopt` of the worktree the agent is writing in minted a record
 *     nothing acquired: managed, unleased, being written to, and offered to the
 *     next session with no prompt.
 *
 * Everything below therefore goes through the extension's registered command —
 * the same path a keystroke takes — over a real git repo and a real jimothy
 * registry, and drives `agent_settled` where the queue is involved.
 */

import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;
const { openModel } = await loadExt("worktree/jimothy.ts");

const exists = async (path) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * A repo with jimothy-managed worktrees, hand-made unmanaged ones, or both.
 *
 * The relative `baseDir` is what keeps managed worktrees inside the temp repo:
 * jimothy's default is `~/.jimothy/worktrees`, and one created there would
 * outlive the test in the developer's home directory.
 */
async function makeRepo({ managed = [], unmanaged = [] } = {}) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-lease-doors-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	const model = await openModel(execRunner(), dir);
	const records = {};
	for (const name of managed) records[name] = await model.registry.create(name, { base: "main" });
	const loose = {};
	for (const name of unmanaged) {
		loose[name] = join(dir, "loose", name);
		await pexec("git", ["worktree", "add", "-q", "-b", name, loose[name]], { cwd: dir });
	}
	return { dir, model, records, loose };
}

/**
 * The extension against a fake pi, standing in `cwd`.
 *
 * gh is answered as unavailable so the PR monitor switches itself off: this file
 * is about leases, and a real gh would make it slow and machine-dependent.
 */
function harness(cwd, options = {}) {
	const h = createFakePi({
		cwd,
		exec: (command) => (command === "gh" ? { stdout: "", stderr: "", code: 1, killed: false } : undefined),
		...options,
	});
	extension(h.pi);
	return h;
}

/** Who the registry currently says holds a worktree, read without the lock. */
async function ownerOf(model, name) {
	return (await model.registry.snapshot()).managed.find((r) => r.name === name)?.owner;
}

/** The focus the session last persisted, which is the focus it is running with. */
function lastFocus(h) {
	const entries = h.appended.filter((entry) => entry.customType === "worktree-focus");
	return entries.at(-1)?.data?.path;
}

// ===================================================== remove, with a release still pending

{
	// `/worktree focus alpha` then `/worktree focus off` inside one agent run leaves
	// alpha's release queued for `agent_settled`. Removing it then has to hand that
	// lease back — and `dropLease` alone cannot, because the lease is no longer on
	// the session's list. jimothy sees a live lease under a live pid and refuses,
	// reporting that the worktree is in use by this very session.
	const { dir, model, records } = await makeRepo({ managed: ["alpha"] });
	const h = harness(dir, { confirms: [true, false] });
	await h.fire("session_start");

	h.idle = false; // one agent run, both focus changes inside it
	await h.command("worktree", "focus alpha");
	ok("the focused worktree is leased", (await ownerOf(model, "alpha"))?.pid === process.pid);
	await h.command("worktree", "focus off");
	ok("and is still held with its release queued", (await ownerOf(model, "alpha"))?.pid === process.pid);

	await h.command("worktree", "remove alpha");

	ok(
		"a removal is not refused by this session's own pending release",
		h.messages().every((m) => !/in use by/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("the removal is reported", h.messages().some((m) => /removed alpha/.test(m)), JSON.stringify(h.notices));
	ok("the worktree is gone", !(await exists(records.alpha.path)));
	ok("and so is its record", (await ownerOf(model, "alpha")) === undefined, JSON.stringify(await ownerOf(model, "alpha")));

	// The queue must have nothing left in it: a release aimed at a worktree that no
	// longer exists is a warning the user can do nothing about.
	await h.fire("agent_settled", { type: "agent_settled" });
	ok(
		"and nothing is left to release when the agent settles",
		h.messages().every((m) => !/could not release/.test(m)),
		JSON.stringify(h.notices),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// The ordinary shape, through the real transition rather than a stub: removing
	// the worktree the session is focused on releases the lease it is holding,
	// removes it, and clears focus by transitioning home.
	const { dir, model, records } = await makeRepo({ managed: ["alpha"] });
	const h = harness(dir, { confirms: [true, false] });
	await h.fire("session_start");
	await h.command("worktree", "focus alpha");

	await h.command("worktree", "remove alpha");

	ok("the focused worktree is removed", !(await exists(records.alpha.path)));
	ok("focus is cleared, not left pointing at it", lastFocus(h) === undefined, JSON.stringify(h.appended));
	ok("and no lease survives it", (await ownerOf(model, "alpha")) === undefined);

	await h.fire("agent_settled", { type: "agent_settled" });
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ===================================================== adopt, and the write target

{
	// Focusing an unmanaged worktree takes no lease, because there is no record to
	// hold. Adopting it mints one — and until now nothing acquired it, so the agent
	// went on writing in a worktree that was leasable, unleased, and would be handed
	// to the next session with no prompt at all.
	const { dir, model, loose } = await makeRepo({ unmanaged: ["scratch"] });
	const h = harness(dir);
	await h.fire("session_start");
	await h.command("worktree", "focus scratch");
	ok("focus moved to the unmanaged worktree", lastFocus(h) === loose.scratch, JSON.stringify(h.appended));

	await h.command("worktree", `adopt ${loose.scratch}`);

	const owner = await ownerOf(model, "scratch");
	ok("adopting the focused worktree leases it", owner?.pid === process.pid, JSON.stringify(owner));
	ok("under this session's run id", owner?.runId === "fake-session-id", JSON.stringify(owner));
	ok("labelled as a pi session, like every other lease this extension takes", owner?.label === "pi session", JSON.stringify(owner));
	ok("and it is reported as adopted", h.messages().some((m) => /adopted scratch/.test(m)), JSON.stringify(h.notices));

	// Held by the session, so its shutdown gives it back rather than leaving it for
	// the process's lifetime.
	await h.fire("session_shutdown", { reason: "quit" });
	ok("and the lease is released on the way out", (await ownerOf(model, "scratch")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	// The same hole with nothing focused: the session's own worktree, adopted in
	// place. `session_start` took no lease because there was no record; the adoption
	// makes one, and the agent is writing there right now.
	const { dir, model, loose } = await makeRepo({ unmanaged: ["scratch"] });
	const h = harness(loose.scratch);
	await h.fire("session_start");
	ok("an unmanaged session worktree starts unleased", (await ownerOf(model, "scratch")) === undefined);

	await h.command("worktree", `adopt ${loose.scratch}`);

	ok(
		"adopting the session's own worktree leases it",
		(await ownerOf(model, "scratch"))?.pid === process.pid,
		JSON.stringify(await ownerOf(model, "scratch")),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// And only the write target. A worktree this session is not writing in is
	// adopted unleased on purpose: taking a lease on it would hold a directory
	// nobody here is touching, which is the mirror image of the bug above.
	const { dir, model, loose } = await makeRepo({ unmanaged: ["scratch"] });
	const h = harness(dir);
	await h.fire("session_start");

	await h.command("worktree", `adopt ${loose.scratch}`);

	ok("a record was created", (await model.registry.snapshot()).managed.some((r) => r.name === "scratch"));
	ok(
		"but a worktree the session is not writing in is left unleased",
		(await ownerOf(model, "scratch")) === undefined,
		JSON.stringify(await ownerOf(model, "scratch")),
	);
	ok(
		"and the main working tree is not what was compared",
		h.messages().every((m) => !new RegExp(basename(dir)).test(m)),
		JSON.stringify(h.notices),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

done();
