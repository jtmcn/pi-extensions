/**
 * Focus is a transition, not an assignment (worktree/transition.ts).
 *
 *   cd tests && node worktree/transition.test.mjs
 *
 * `/worktree focus B` used to be a variable assignment: every subsequent tool
 * call was redirected into B while the session went on holding A, so an agent
 * could write into a worktree it did not hold and jimothy could hand B to
 * somebody else at the same time. Focus now carries the lease with it, and the
 * three rules that makes are what this file is about:
 *
 *   1. the destination is acquired *before* the origin is released, so a
 *      destination that cannot be held leaves focus exactly where it was;
 *   2. the origin is released when the agent *settles*, not at the moment focus
 *      moves — a tool call already in flight is still writing into it;
 *   3. the origin is released whatever its provenance, because a transition
 *      means the agent has left that worktree, which is when jimothy wants it
 *      back.
 *
 * Driven through the real registry in a throwaway repo and a fake `pi`, for the
 * same reason `restore.test.mjs` is: what is under test is the wiring between
 * the command, the session's lease list and jimothy's registry, and a mock of
 * any of the three would only test the mock.
 */

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

/**
 * A live process that is neither us nor our parent, to hold a lease.
 *
 * Same reasoning as `restore.test.mjs`: a lease held by a dead pid is a stale
 * lease and takes an entirely different row, so a stranger has to be genuinely
 * alive. Killed from an exit hook, and unref'd so it cannot hold the run open.
 */
const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
stranger.unref();
process.on("exit", () => stranger.kill());

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;
const { openModel } = await loadExt("worktree/jimothy.ts");
const { moveFocus } = await loadExt("worktree/transition.ts");
const { createSession } = await loadExt("worktree/session.ts");

/**
 * A repo with two jimothy-managed worktrees, created through the model so the
 * records are real rather than hand-written.
 *
 * The config is what keeps this out of the developer's home directory:
 * jimothy's default baseDir is `~/.jimothy/worktrees`, and a relative one is
 * resolved against the repository, so everything created here dies with the
 * temp repo.
 */
async function makeTwoManaged() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-transition-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	const model = await openModel(execRunner(), dir);
	const alpha = await model.registry.create("alpha", { base: "main" });
	const beta = await model.registry.create("beta", { base: "main" });
	return { dir, model, alpha, beta };
}

/**
 * Load the extension against a fake pi, standing in `cwd`.
 *
 * gh is answered as unavailable so the PR monitor disables itself immediately:
 * this file is about leases, and a real gh would make it slow and
 * machine-dependent.
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

/**
 * A real session over a real registry, whose *replacement* a test can trigger
 * at a chosen moment.
 *
 * One level below the pi harness, for the reason the drain block below is: what
 * is under test is an interleaving inside `takeLeaseOn`, and the fake pi has no
 * async seam in that window to hang the replacement on (the only scriptable one
 * is `ctx.ui.select`, which these rows never reach). Everything that matters is
 * real — the session, its deferred queue, jimothy's registry and the repo — and
 * only the schedule is controlled.
 *
 * Never idle: a tool call is in flight throughout, which is what defers a
 * release rather than performing it, and so creates the queue entry these blocks
 * are about.
 */
async function replaceableRig(runId) {
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const pi = {
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
		appendEntry: () => {},
		sendMessage: () => {},
	};
	const ui = { say: () => {}, report: () => {}, clearReport: () => {}, clearAll: () => {}, setStatus: () => {} };
	const ctx = {
		cwd: alpha.path,
		hasUI: false,
		mode: "interactive",
		isIdle: () => false,
		sessionManager: { getSessionId: () => runId },
	};
	const session = createSession({
		pi,
		ui,
		ctx,
		repo: { projectRoot: dir, worktreeRoot: alpha.path, branch: "jimothy/alpha", bare: false },
		model,
		abort: new AbortController(),
	});
	const state = { replaced: false };
	const env = {
		lease: {
			launcher: undefined,
			say: () => {},
			// The question `index.ts` answers: is this still the extension's session?
			current: () => !state.replaced,
		},
		model,
		home: alpha.path,
	};
	// The session stops being the extension's, and goes inert with it. The
	// synchronous half of a replacement, so a test can put it at an exact point in a
	// transition rather than racing it against one.
	const retire = () => {
		state.replaced = true;
		session.dispose();
	};
	// Everything `session_shutdown` does, in its order: drain the queue, release what
	// the session still holds, then retire it. `/reload` and `/fork` take this path
	// without ending the process, which is why a lease left behind here is held by a
	// *live* pid for the rest of that process's life.
	const shutdown = async () => {
		for (const lease of session.takeDeferredReleases()) {
			await model.registry.releaseLease(lease.name, lease.runId);
		}
		for (const lease of session.leases) {
			if (lease.provenance === "ours") await model.registry.releaseLease(lease.name, lease.runId);
		}
		retire();
	};
	// Where `session_start` leaves a session standing in a worktree jimothy manages.
	await model.registry.acquireLease("alpha", runId, process.pid, { label: "pi session" });
	session.addLease({ name: "alpha", path: alpha.path, runId, provenance: "ours" });
	return { dir, model, alpha, beta, session, ctx, env, retire, shutdown };
}

// ===================================================== acquire, then release on settle

{
	// The heart of it: B is held before A is let go, and A is not let go until the
	// agent settles, because a tool call in flight is still writing into A.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	ok("the session leases the worktree it started in", (await ownerOf(model, "alpha"))?.pid === process.pid);

	h.idle = false; // an agent run is in flight
	await h.command("worktree", "focus beta");

	ok("the destination is acquired", (await ownerOf(model, "beta"))?.pid === process.pid, JSON.stringify(h.notices));
	ok("focus moved there", lastFocus(h) === beta.path, JSON.stringify(h.appended));
	ok(
		"and the origin is still held while the agent runs",
		(await ownerOf(model, "alpha"))?.pid === process.pid,
		JSON.stringify(await ownerOf(model, "alpha")),
	);

	await h.fire("agent_settled", { type: "agent_settled" });
	ok("the origin is released once the agent settles", (await ownerOf(model, "alpha")) === undefined);
	ok("and the destination is still held", (await ownerOf(model, "beta"))?.pid === process.pid);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// An idle session has nothing in flight, so the origin goes back at once
	// rather than waiting for a settle that may be a whole turn away.
	const { dir, model, alpha } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");

	await h.command("worktree", "focus beta");

	ok("an idle session releases the origin immediately", (await ownerOf(model, "alpha")) === undefined);
	ok("and holds the destination", (await ownerOf(model, "beta"))?.pid === process.pid);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// Two transitions inside one turn, the second going back where the first came
	// from. The origin's release is still queued when it is re-acquired, so a drain
	// that took the queue at face value would release a worktree the agent is
	// writing in *right now* — focused, and holding nothing.
	const { dir, model, alpha } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");

	h.idle = false; // one agent run, two focus changes inside it
	await h.command("worktree", "focus beta");
	await h.command("worktree", "focus off");
	ok("focus came home", lastFocus(h) === undefined, JSON.stringify(h.appended));

	await h.fire("agent_settled", { type: "agent_settled" });
	ok(
		"a worktree focus returned to is not released by the queue it left behind",
		(await ownerOf(model, "alpha"))?.pid === process.pid,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	ok("and the one focus actually left is released", (await ownerOf(model, "beta")) === undefined);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ===================================================== a destination that cannot be held

{
	// Refused, and nothing moves: the alternative is an agent writing into a
	// worktree it was just told it could not have.
	const { dir, model, alpha } = await makeTwoManaged();
	await model.registry.acquireLease("beta", "someone-else", stranger.pid, { label: "pi session" });
	// No scripted answer: the harness resolves `select` as undefined, which is what
	// pi does when the dialog is dismissed — and dismissal is not consent.
	const h = harness(alpha.path);
	await h.fire("session_start");

	await h.command("worktree", "focus beta");

	ok("the user is asked about the destination", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));
	ok(
		"and told what holds it",
		/in use by pi session someone-else/.test(h.prompts.select[0]?.title ?? ""),
		JSON.stringify(h.prompts.select[0]?.title),
	);
	// A transition that declines does not quit pi — unlike session_start's prompt,
	// which really does — so the decline button must not read "Quit" here: that
	// would tell the user something is about to happen that is not.
	ok(
		"the decline option says what actually happens, not session_start's wording",
		h.prompts.select[0]?.options[0] === "Stay here",
		JSON.stringify(h.prompts.select[0]?.options),
	);
	ok("focus does not move", lastFocus(h) === undefined, JSON.stringify(h.appended));
	ok("the stranger keeps the destination", (await ownerOf(model, "beta"))?.runId === "someone-else");
	ok(
		"and we keep the worktree we are still writing in",
		(await ownerOf(model, "alpha"))?.pid === process.pid,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	// session_start quits pi when the user declines to displace another session,
	// because there is nowhere else for that session to go. A transition has
	// somewhere: exactly where it already was.
	ok("declining a focus move does not quit pi", h.shutdowns.length === 0, JSON.stringify(h.messages()));
	ok(
		"and the refusal is reported",
		h.messages().some((m) => /"beta" is held by another session/.test(m)),
		JSON.stringify(h.notices),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// The ordering itself, rather than its result. The prompt is the one moment a
	// test can look at the world *during* the transition: the destination has not
	// been acquired yet, so if the origin were released first it would already be
	// free here.
	const { dir, model, alpha } = await makeTwoManaged();
	await model.registry.acquireLease("beta", "someone-else", stranger.pid, { label: "pi session" });
	let originWhileAsking;
	const h = harness(alpha.path, {
		selects: [
			async () => {
				originWhileAsking = await ownerOf(model, "alpha");
				return "Take over";
			},
		],
	});
	await h.fire("session_start");

	await h.command("worktree", "focus beta");

	ok(
		"the origin is still held while the destination is being acquired",
		originWhileAsking?.pid === process.pid,
		JSON.stringify(originWhileAsking),
	);
	ok("the destination is taken over", (await ownerOf(model, "beta"))?.pid === process.pid);
	ok("under this session's run id", (await ownerOf(model, "beta"))?.runId === "fake-session-id");
	ok("and only then is the origin released", (await ownerOf(model, "alpha")) === undefined);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ===================================================== clearing focus is the same in reverse

{
	const { dir, model, alpha } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");

	await h.command("worktree", "focus off");

	ok("clearing focus reacquires the session's own worktree", (await ownerOf(model, "alpha"))?.pid === process.pid);
	ok("and releases the one it left", (await ownerOf(model, "beta")) === undefined);
	ok("focus is cleared", lastFocus(h) === undefined, JSON.stringify(h.appended));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// ...including the refusal. Dropping focus onto a worktree a stranger now
	// holds would silently point the agent at a directory it does not hold, which
	// is the failure the whole transition exists to prevent.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	await h.command("worktree", "focus off");

	ok("focus is kept when the session's own worktree cannot be reacquired", lastFocus(h) === beta.path);
	ok("the worktree we are writing in is still ours", (await ownerOf(model, "beta"))?.pid === process.pid);
	ok("and the stranger keeps ours", (await ownerOf(model, "alpha"))?.runId === "someone-else");
	ok("without quitting", h.shutdowns.length === 0, JSON.stringify(h.messages()));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ===================================================== the focused worktree disappears

{
	// Another session's `/worktree remove`, or `jimothy wt rm` in another
	// terminal. Focus is validated at `session_start` and never again, so without
	// this every tool call after that is redirected into a directory that no
	// longer exists — and the error names a path the user never typed.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");
	await rm(beta.path, { recursive: true, force: true });

	await h.command("worktree", "focus off");

	ok(
		"a focused worktree that is gone is reported",
		h.messages().some((m) => /is gone; focus cleared/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("focus is cleared", lastFocus(h) === undefined, JSON.stringify(h.appended));
	ok("its lease is not left behind", (await ownerOf(model, "beta")) === undefined);
	ok("and the session's own worktree is held again", (await ownerOf(model, "alpha"))?.pid === process.pid);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// ...and it is dropped even when the move that noticed it is then refused.
	// Otherwise a refusal would leave the session pointing at a directory that no
	// longer exists, which is the state this check exists to end — and the refusal
	// is the case where it lasts longest, because nothing else clears it.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");
	await rm(beta.path, { recursive: true, force: true });
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	await h.command("worktree", "focus off");

	ok("focus is cleared even though the move was refused", lastFocus(h) === undefined, JSON.stringify(h.appended));
	ok("the vanished worktree's lease is still handed back", (await ownerOf(model, "beta")) === undefined);
	ok("and the stranger keeps the one we could not have", (await ownerOf(model, "alpha"))?.runId === "someone-else");

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// Focusing the worktree that has just been declared gone. `from` is captured
	// before that is noticed, so a short-circuit on "already focused there" would
	// put focus straight back onto the missing directory, without a lease, one line
	// after saying focus had been cleared.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");
	await rm(beta.path, { recursive: true, force: true });

	await h.command("worktree", "focus beta");

	ok("focusing the vanished worktree again does not re-focus it", lastFocus(h) === undefined, JSON.stringify(h.appended));
	ok(
		"and the refusal says the directory is missing",
		h.messages().some((m) => /no longer exists/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("nothing is left holding it", (await ownerOf(model, "beta")) === undefined);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ===================================================== a deferred release is not lost

{
	// The queue is drained by `agent_settled` — and by the session ending, which
	// `/reload` does without ending the process. A lease dropped from the session's
	// list and never released would be held by a live pid for the rest of that
	// process's life, recoverable only with `jimothy wt release --force`.
	const { dir, model, alpha } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	h.idle = false;
	await h.command("worktree", "focus beta");
	ok("the origin is still held while the agent runs", (await ownerOf(model, "alpha"))?.pid === process.pid);

	await h.fire("session_shutdown", { reason: "reload" });
	ok("a session that ends first releases what it deferred", (await ownerOf(model, "alpha")) === undefined);
	ok("along with the lease it was holding", (await ownerOf(model, "beta")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	// The same two transitions, with the drain landing *inside* the second one.
	//
	// One level below the harness, deliberately. What is under test is an
	// interleaving — `agent_settled` draining the queue between the transition's
	// registry read and the moment it records the lease — and the fake pi has no
	// async seam inside that window to hang the drain on (the only scriptable one is
	// `ctx.ui.select`, which this row never reaches). Driving `moveFocus` over a real
	// session, a real registry and the real deferred queue keeps everything that
	// matters real and makes the schedule controllable: `snapshot()` *is* the read,
	// so wrapping it is exactly "the queue was drained during the decision".
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const appended = [];
	const pi = {
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
		appendEntry: (customType, data) => appended.push({ customType, data }),
		sendMessage: () => {},
	};
	const ui = { say: () => {}, report: () => {}, clearReport: () => {}, clearAll: () => {}, setStatus: () => {} };
	// Never idle: a tool call is in flight for the whole block, which is what defers
	// the release and so creates the queue entry this is about.
	const ctx = {
		cwd: alpha.path,
		hasUI: false,
		mode: "interactive",
		isIdle: () => false,
		sessionManager: { getSessionId: () => "fake-session-id" },
	};
	const session = createSession({
		pi,
		ui,
		ctx,
		repo: { projectRoot: dir, worktreeRoot: alpha.path, branch: "jimothy/alpha", bare: false },
		model,
		abort: new AbortController(),
	});
	const notices = [];
	const env = {
		lease: {
			launcher: undefined,
			say: (_ctx, message, level) => notices.push({ message, level }),
			current: () => true,
		},
		model,
		home: alpha.path,
	};

	// Where `session_start` leaves a session standing in a worktree jimothy manages.
	await model.registry.acquireLease("alpha", "fake-session-id", process.pid, { label: "pi session" });
	session.addLease({ name: "alpha", path: alpha.path, runId: "fake-session-id", provenance: "ours" });

	await moveFocus(env, session, ctx, { path: beta.path, branch: beta.branch });
	ok("the origin is still held with its release queued", (await ownerOf(model, "alpha"))?.pid === process.pid);

	const read = model.registry.snapshot.bind(model.registry);
	let drained = false;
	model.registry.snapshot = async (...args) => {
		const result = await read(...args);
		// After the read, before the decision is applied: the exact window in which a
		// drain frees a worktree the transition is about to record as held.
		if (!drained) {
			drained = true;
			for (const lease of session.takeDeferredReleases()) {
				await model.registry.releaseLease(lease.name, lease.runId);
			}
		}
		return result;
	};
	try {
		await moveFocus(env, session, ctx, undefined);
	} finally {
		model.registry.snapshot = read;
	}

	ok("the drain ran inside the transition", drained);
	ok(
		"a drain landing mid-transition cannot free the worktree focus returned to",
		(await ownerOf(model, "alpha"))?.pid === process.pid,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	ok(
		"and the session's own list agrees with the registry",
		session.leases.some((lease) => lease.path === alpha.path),
		JSON.stringify(session.leases),
	);
	ok("focus came home", session.focus === undefined, JSON.stringify(session.focus));

	session.dispose();
	await rm(dir, { recursive: true, force: true });
}

{
	// Cancelling the destination's queued release is a loan, not a write-off: a
	// transition that is then *refused* still owes it. Here the session's own
	// worktree is deleted from under it, so `focus off` cannot resolve the
	// destination at all — and the release cancelled a moment earlier must still
	// happen when the agent settles, or the lease is lost to a local variable and the
	// worktree stays held by a live pid for the rest of the process's life.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	h.idle = false;
	await h.command("worktree", "focus beta");
	ok("the session's own worktree is queued for release", (await ownerOf(model, "alpha"))?.pid === process.pid);
	await rm(alpha.path, { recursive: true, force: true });

	await h.command("worktree", "focus off");

	ok(
		"a destination that no longer exists refuses the move",
		h.messages().some((m) => /no longer exists/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("focus stays where it was", lastFocus(h) === beta.path, JSON.stringify(h.appended));

	await h.fire("agent_settled", { type: "agent_settled" });
	ok(
		"and the release the refused transition took out of the queue still happens",
		(await ownerOf(model, "alpha")) === undefined,
		JSON.stringify(await ownerOf(model, "alpha")),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// ...and the same loan when the session is *replaced or shut down* while the
	// destination is being acquired, which is the sibling of the abandoned acquire in
	// `take-lease.test.mjs`. The entry is out of the queue, `session_shutdown`'s drain
	// has already run over a queue that no longer names it, and after disposal
	// `deferRelease` is inert — so handing it back parks it nowhere, and the registry
	// goes on holding the worktree under this live pid, for a session that no longer
	// exists, on no session's lease list.
	//
	// The replacement is forced where it really happens: inside `takeLeaseOn`'s read,
	// by wrapping `snapshot()`, so the transition is genuinely mid-flight when the
	// session dies rather than being told about it afterwards.
	const { dir, model, alpha, beta, session, ctx, env, shutdown } = await replaceableRig("doomed-session");

	await moveFocus(env, session, ctx, { path: beta.path, branch: beta.branch });
	ok("the origin is queued for release, not released", (await ownerOf(model, "alpha"))?.pid === process.pid);

	const read = model.registry.snapshot.bind(model.registry);
	let shutDown = false;
	model.registry.snapshot = async (...args) => {
		const result = await read(...args);
		if (!shutDown) {
			shutDown = true;
			await shutdown();
		}
		return result;
	};
	let moved;
	try {
		moved = await moveFocus(env, session, ctx, undefined);
	} finally {
		model.registry.snapshot = read;
	}

	ok("the session was replaced inside the transition", shutDown);
	ok("which reports no move", moved === false);
	ok(
		"and the release it cancelled is not lost to a queue nothing will drain",
		(await ownerOf(model, "alpha")) === undefined,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	ok("nor parked on the dead session's queue", session.takeDeferredReleases().length === 0);
	ok("and the worktree focus was on is released by the shutdown", (await ownerOf(model, "beta")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	// The other side of the same coin: the destination *was* acquired, and the session
	// died between that answer and the transition's own staleness check. The lease is
	// recorded on a disposed session's list — which nothing reads — so the cancelled
	// entry has to be released here too, not deferred.
	//
	// The replacement lands one seam later than the block above: `isPidAlive` is
	// consulted while the decision is being classified, i.e. after `takeLeaseOn`'s
	// last `current` check, so the acquisition succeeds and `moveFocus` is the first
	// thing to notice the session is gone.
	const { dir, model, alpha, beta, session, ctx, env, retire } = await replaceableRig("outlived-session");

	await moveFocus(env, session, ctx, { path: beta.path, branch: beta.branch });
	ok("the origin is queued for release again", (await ownerOf(model, "alpha"))?.pid === process.pid);

	const alive = model.deps.isPidAlive;
	let armed = false;
	let retired = false;
	// Synchronous, because `checkLease` is: a replacement started here and awaited
	// later could resolve after `moveFocus` has already read `current`, which would
	// make this block race rather than test.
	model.deps.isPidAlive = (pid) => {
		if (armed && !retired) {
			retired = true;
			retire();
		}
		return alive(pid);
	};
	armed = true;
	let moved;
	try {
		moved = await moveFocus(env, session, ctx, undefined);
	} finally {
		model.deps.isPidAlive = alive;
	}

	ok("the session was replaced after the destination was acquired", retired);
	ok("so focus does not move", moved === false);
	ok(
		"and the cancelled release still happens",
		(await ownerOf(model, "alpha")) === undefined,
		JSON.stringify(await ownerOf(model, "alpha")),
	);
	ok("with nothing left queued", session.takeDeferredReleases().length === 0);

	await rm(dir, { recursive: true, force: true });
}

// ===================================================== a registry that cannot be read

{
	// Unlike `session_start`, which carries on unleased because pi is already
	// running, a transition that cannot even look at the lease does not happen.
	const { dir, model, alpha, beta } = await makeTwoManaged();
	const h = harness(alpha.path);
	await h.fire("session_start");
	await h.command("worktree", "focus beta");
	// Corrupt after the move, so the failure lands on the transition itself rather
	// than on the listing `/worktree focus <name>` does before it.
	await writeFile(join(dir, ".git", "jimothy", "registry.json"), "{ not valid json");

	await h.command("worktree", "focus off");

	ok(
		"the failure is reported",
		h.messages().some((m) => /lease unavailable/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("and focus does not move", lastFocus(h) === beta.path, JSON.stringify(h.appended));

	await rm(dir, { recursive: true, force: true });
}

done();
