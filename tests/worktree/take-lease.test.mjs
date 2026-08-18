/**
 * A lease acquired for a session that has already gone (worktree/take-lease.ts).
 *
 *   cd tests && node worktree/take-lease.test.mjs
 *
 * Every function in `take-lease.ts` re-checks `env.current(active)` after an
 * await, and the module header argues one horn of why: a replaced session must
 * record no lease, because a lease on a disposed session's list is one nothing
 * will ever release. The other horn was unguarded — a bail *after* a successful
 * acquisition left the registry holding the worktree under this live pid and a
 * run id no session answers for. Nothing releases that: the outgoing session's
 * shutdown has already run, so it is held for the life of the pi process and
 * every other agent is told the worktree is in use by a session that no longer
 * exists.
 *
 * The replacement is forced where it really happens — during the registry call —
 * by wrapping `acquireLease`, which is the only moment in the acquire row that a
 * `/new`, a fork or a reload can land in. `env` and the session are fakes because
 * `current` and `addLease` are precisely what is being observed; the registry,
 * the records and the repository are real, since what has to be proven is what
 * the *registry* is left holding.
 */

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

/**
 * A live process that is neither us nor our parent, to hold a lease the prompt
 * row has to displace. A dead pid would be a *stale* lease and take another row
 * entirely. Unref'd and killed from an exit hook, like every other file here.
 */
const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
stranger.unref();
process.on("exit", () => stranger.kill());

const { ok, done } = assertions();
const { takeLeaseOn } = await loadExt("worktree/take-lease.ts");
const { openModel } = await loadExt("worktree/jimothy.ts");

/** A repo with one jimothy-managed worktree, created through the model. */
async function makeManaged() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-take-lease-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	const model = await openModel(execRunner(), dir);
	const record = await model.registry.create("alpha", { base: "main" });
	return { dir, model, record };
}

async function ownerOf(model, name) {
	return (await model.registry.snapshot()).managed.find((r) => r.name === name)?.owner;
}

/**
 * The environment `take-lease.ts` reads from `index.ts`'s closure, plus a session
 * that is replaced the moment the registry hands the lease over.
 */
function replacedDuringAcquire(model, { hasUI = false, selects = [] } = {}) {
	let replaced = false;
	const acquire = model.registry.acquireLease.bind(model.registry);
	model.registry.acquireLease = async (...args) => {
		const result = await acquire(...args);
		// `/new`, a fork or a reload, landing while the registry was locked.
		replaced = true;
		return result;
	};
	const held = [];
	const said = [];
	const answers = [...selects];
	const prompts = [];
	const env = {
		launcher: undefined,
		say: (_ctx, message, level) => said.push({ message, level }),
		current: () => !replaced,
	};
	const active = { addLease: (lease) => held.push(lease) };
	const ctx = {
		cwd: "/unused",
		hasUI,
		mode: hasUI ? "interactive" : "print",
		sessionManager: { getSessionId: () => "doomed-session" },
		ui: {
			select: async (title, options) => {
				prompts.push({ title, options });
				return answers.length ? answers.shift() : undefined;
			},
		},
		shutdown: () => {},
	};
	return { env, active, ctx, held, said, prompts, wasReplaced: () => replaced };
}

// ===================================================== the free row

{
	const { dir, model, record } = await makeManaged();
	const h = replacedDuringAcquire(model);

	const took = await takeLeaseOn(h.env, h.active, h.ctx, model, record.path);

	ok("a session replaced during the acquire is told the worktree is not its to use", took === false);
	ok("the replacement happened where it was aimed", h.wasReplaced());
	ok("no lease is recorded on the session that has gone", h.held.length === 0, JSON.stringify(h.held));
	ok(
		"and the worktree it had just taken is handed straight back",
		(await ownerOf(model, "alpha")) === undefined,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	ok("nothing is said through a context that is now stale", h.said.length === 0, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

// ===================================================== the prompt row

{
	// The worst version: the user consents, a live stranger is displaced, and the
	// session ends before the lease is recorded. Bailing while still holding what it
	// took would leave the worktree taken from a run that was working in it *and*
	// held by nobody who can give it back.
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });
	const h = replacedDuringAcquire(model, { hasUI: true, selects: ["Take over"] });

	const took = await takeLeaseOn(h.env, h.active, h.ctx, model, record.path);

	ok("the user was asked before anything was displaced", h.prompts.length === 1, JSON.stringify(h.prompts));
	ok("the transition is refused", took === false);
	ok("no lease is recorded", h.held.length === 0, JSON.stringify(h.held));
	ok(
		"and a take-over that outlived its session holds nothing",
		(await ownerOf(model, "alpha")) === undefined,
		JSON.stringify(await ownerOf(model, "alpha")),
	);

	await rm(dir, { recursive: true, force: true });
}

done();
