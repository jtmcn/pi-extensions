/**
 * Tests for per-session state (worktree/session.ts).
 *
 *   cd tests && npm install && node worktree/session.test.mjs
 *
 * The session object exists to make "reset everything on session_start"
 * unnecessary: a replaced session is disposed, not cleaned. What is worth
 * pinning down is therefore the lifetime — that a disposed session is inert —
 * and the two things focus changes must get right: focus is persisted as a
 * durable *entry* (a queued custom message is lost on reload), and restoring
 * focus from the transcript must not re-persist or re-announce it.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createSession, FOCUS_ENTRY_TYPE, FOCUS_MESSAGE_TYPE } = await loadExt("worktree/session.ts");

const REPO = {
	projectRoot: "/proj",
	worktreeRoot: "/proj/main",
	branch: "main",
	bare: false,
};

// `noRepo` rather than `repo: undefined`: a destructuring default fires on an
// explicit undefined, so the latter would silently hand back REPO.
function setup({ noRepo = false, hasUI = true, exec } = {}) {
	const repo = noRepo ? undefined : REPO;
	const entries = [];
	const messages = [];
	const statuses = [];
	const pi = {
		exec: exec ?? (async () => ({ stdout: "", stderr: "", code: 1, killed: false })),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		sendMessage: (message, options) => messages.push({ message, options }),
	};
	const ui = {
		say: () => {},
		report: () => {},
		clearReport: () => {},
		clearAll: () => {},
		setStatus: (_ctx, parts) => statuses.push(parts),
	};
	const ctx = { cwd: "/proj/main", hasUI, mode: "interactive" };
	const reported = [];
	// No model: nothing in this file reaches the registry, and the field is
	// explicit so a session that never opened one says so. `abort` is still
	// required: dispose() aborts it unconditionally, model or not.
	const session = createSession({
		pi,
		ui,
		ctx,
		repo,
		model: undefined,
		abort: new AbortController(),
		report: (branch) => reported.push(branch),
	});
	return { session, ctx, entries, messages, statuses, reported };
}

// ===================================================== focus persistence

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });

	ok("focus is readable", h.session.focus?.path === "/proj/feat");
	ok("focus is persisted as an entry", h.entries[0]?.customType === FOCUS_ENTRY_TYPE);
	ok(
		"the entry carries the path and branch",
		h.entries[0]?.data?.path === "/proj/feat" && h.entries[0]?.data?.branch === "feature/x",
		JSON.stringify(h.entries[0]),
	);
	ok("the model is told", h.messages[0]?.message.customType === FOCUS_MESSAGE_TYPE);
	ok("the note names the worktree", h.messages[0]?.message.content.includes("/proj/feat"));
	// deliverAs nextTurn is in-memory only, which is exactly why the state above
	// went into an entry rather than this message.
	ok("the note is queued for the next turn", h.messages[0]?.options?.deliverAs === "nextTurn");
	ok("focus paints", h.statuses.length >= 1);
	ok("the segment shows the worktree and branch", h.statuses.at(-1)?.[0] === "⑂ feat (feature/x)", JSON.stringify(h.statuses.at(-1)));
}

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	h.session.setFocus(h.ctx, undefined);
	ok("clearing focus records it too", h.entries.length === 2);
	ok("the cleared entry is empty", JSON.stringify(h.entries[1]?.data) === "{}");
	ok("clearing is announced", h.messages[1]?.message.content.includes("cleared"));
	ok("clearing empties the segment", JSON.stringify(h.statuses.at(-1)) === "[]");
}

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat" }, false);
	ok("announce=false still persists", h.entries.length === 1);
	ok("announce=false tells the model nothing", h.messages.length === 0);
	ok("a branchless worktree shows just the name", h.statuses.at(-1)?.[0] === "⑂ feat", JSON.stringify(h.statuses.at(-1)));
}

// ===================================================== restoring focus

{
	const h = setup();
	h.session.restoreFocus({ path: "/proj/feat", branch: "feature/x" });
	ok("restored focus is adopted", h.session.focus?.path === "/proj/feat");
	// Restoring is reading the transcript back, not making a decision: writing an
	// entry would append a duplicate on every reload, and announcing would tell
	// the model something it was already told.
	ok("restoring writes no entry", h.entries.length === 0);
	ok("restoring announces nothing", h.messages.length === 0);
	ok("restoring paints nothing by itself", h.statuses.length === 0);
}

// ===================================================== disposal

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	const paintsBefore = h.statuses.length;

	h.session.dispose();
	h.session.paint(h.ctx);
	ok("a disposed session does not paint", h.statuses.length === paintsBefore);

	// The ctx a session holds is stale the moment pi replaces that session, and
	// touching a stale ctx throws. Disposal is what makes that unreachable.
	h.session.prMonitor.refresh(true);
	h.session.prMonitor.onInput();
	await Promise.resolve();
	ok("a disposed session's monitor is dead", h.statuses.length === paintsBefore);
	ok("disposal is idempotent", (() => {
		h.session.dispose();
		return true;
	})());
}

// ===================================================== no repo

{
	const h = setup({ noRepo: true });
	ok("a session outside a repo still exists", h.session.repo === undefined);
	h.session.paint(h.ctx);
	ok("and paints an empty segment rather than nothing", JSON.stringify(h.statuses.at(-1)) === "[]");
}

// ===================================================== reporting the branch

{
	const h = setup();
	h.session.paint(h.ctx);
	ok("report: an unfocused session reports its own branch", h.reported.at(-1) === "main", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	ok("report: focus reports the worktree's branch", h.reported.at(-1) === "feature/x", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, undefined);
	ok("report: clearing focus goes back to the session's branch", h.reported.at(-1) === "main", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, { path: "/proj/detached" });
	ok("report: a detached worktree reports nothing to show", h.reported.at(-1) === undefined, JSON.stringify(h.reported));
}

{
	const h = setup();
	const before = h.reported.length;
	h.session.dispose();
	h.session.paint(h.ctx);
	ok("report: a disposed session reports nothing", h.reported.length === before, JSON.stringify(h.reported));
}

{
	const h = setup({ noRepo: true });
	h.session.paint(h.ctx);
	ok("report: outside a repo there is no branch to report", h.reported.at(-1) === undefined && h.reported.length === 1, JSON.stringify(h.reported));
}

// ===================================================== leases held

{
	const h = setup();
	ok("leases: a new session holds none", h.session.leases.length === 0);

	h.session.addLease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	h.session.addLease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "delegated" });
	ok("leases: each worktree is recorded", h.session.leases.map((l) => l.name).join(",") === "alpha,beta", JSON.stringify(h.session.leases));

	// A retarget can re-decide against the current owner and hold the same
	// worktree a second time; releasing it twice at shutdown would drop a lease
	// somebody else had taken in between.
	h.session.addLease({ name: "alpha", path: "/wt/alpha", runId: "run-2", provenance: "delegated" });
	ok("leases: the same worktree is replaced, not appended", h.session.leases.length === 2, JSON.stringify(h.session.leases));
	ok(
		"leases: and the replacement is what is held",
		h.session.leases.find((l) => l.name === "alpha")?.runId === "run-2",
		JSON.stringify(h.session.leases),
	);

	// Not persisted: a lease is a fact about a live process, and a restored one
	// would be a lie.
	ok("leases: nothing is written to the transcript", h.entries.length === 0, JSON.stringify(h.entries));
}

// ===================================================== leases handed back

{
	// A focus transition drops the origin's lease by path — what it knows is where
	// the agent was writing — and gets it back so it can decide when to release it.
	const h = setup();
	h.session.addLease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	h.session.addLease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "delegated" });

	ok("dropLease: a worktree nobody holds drops nothing", h.session.dropLease("/wt/gamma") === undefined);
	ok("dropLease: the lease is returned", h.session.dropLease("/wt/alpha")?.name === "alpha");
	ok("dropLease: and no longer held", h.session.leases.map((l) => l.name).join(",") === "beta", JSON.stringify(h.session.leases));
	ok("dropLease: dropping it twice is not dropping beta", h.session.dropLease("/wt/alpha") === undefined);
}

/** The whole queue, popped one at a time as the drain in `index.ts` does. */
function drainAll(session) {
	const drained = [];
	for (let lease = session.nextDeferredRelease(); lease !== undefined; lease = session.nextDeferredRelease()) {
		drained.push(lease);
	}
	return drained;
}

{
	// The queue `agent_settled` drains: a release that cannot happen yet, because a
	// tool call already in flight is still writing into that worktree.
	const h = setup();
	ok("deferRelease: a new session has nothing queued", h.session.deferredReleases.length === 0);

	h.session.deferRelease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	h.session.deferRelease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "delegated" });
	const drained = drainAll(h.session);
	ok("deferRelease: everything queued comes back, in order", drained.map((l) => l.name).join(",") === "alpha,beta", JSON.stringify(drained));
	ok("deferRelease: draining empties the queue, so nothing is released twice", h.session.deferredReleases.length === 0);

	// Inert after dispose, like paint(): a replaced session will never drain this,
	// so a lease parked on it would be one nothing ever releases.
	h.session.dispose();
	h.session.deferRelease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	ok("deferRelease: a disposed session queues nothing", h.session.deferredReleases.length === 0);
}

{
	// One at a time, and that is the point: a release takes the registry's lock, and
	// while it is in flight the *rest* of the queue must stay visible — to
	// `cancelRelease`, so a transition returning to one of those worktrees can take it
	// back, and to the drain's own check. Taking the whole queue up front made every
	// entry after the first invisible for the whole drain.
	const h = setup();
	h.session.deferRelease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	h.session.deferRelease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "ours" });

	const first = h.session.nextDeferredRelease();
	ok("nextDeferredRelease: hands back the oldest entry first", first?.name === "alpha", JSON.stringify(first));
	ok(
		"nextDeferredRelease: and leaves the rest of the queue where it is",
		h.session.deferredReleases.map((l) => l.name).join(",") === "beta",
		JSON.stringify(h.session.deferredReleases),
	);
	ok("nextDeferredRelease: so a later entry can still be cancelled", h.session.cancelRelease("/wt/beta")?.name === "beta");
	ok("nextDeferredRelease: and an empty queue hands back nothing", h.session.nextDeferredRelease() === undefined);
}

{
	// Two transitions inside one non-idle turn: focus leaves alpha (queued for
	// release) and then comes back to it. Draining the queue afterwards would
	// release a worktree the session is holding *and writing in* — an unleased
	// agent, which is the failure the whole transition exists to prevent.
	const h = setup();
	h.session.addLease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	const alpha = h.session.dropLease("/wt/alpha");
	h.session.deferRelease(alpha);
	h.session.deferRelease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "ours" });

	h.session.addLease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });

	const drained = drainAll(h.session);
	ok(
		"addLease: re-acquiring cancels the release queued for that worktree",
		drained.map((l) => l.name).join(",") === "beta",
		JSON.stringify(drained),
	);
	ok("addLease: and it is still held", h.session.leases.map((l) => l.name).join(",") === "alpha", JSON.stringify(h.session.leases));
}

{
	// The queue's other half. Draining can only drain, which left two
	// callers unable to see a pending release at all: a transition returning to that
	// worktree (it must cancel the release *before* it reads the registry, or a drain
	// landing in between frees a lease the session then records), and `/worktree
	// remove` (which has to hand our own lease back, and was refused by jimothy
	// naming this very session as the holder).
	const h = setup();
	h.session.deferRelease({ name: "alpha", path: "/wt/alpha", runId: "run-1", provenance: "ours" });
	h.session.deferRelease({ name: "beta", path: "/wt/beta", runId: "run-1", provenance: "delegated" });

	ok("cancelRelease: a path with nothing queued cancels nothing", h.session.cancelRelease("/wt/gamma") === undefined);
	const taken = h.session.cancelRelease("/wt/alpha");
	ok("cancelRelease: the queued lease is handed to the caller", taken?.name === "alpha", JSON.stringify(taken));
	ok("cancelRelease: and is no longer queued", h.session.cancelRelease("/wt/alpha") === undefined);
	const drained = drainAll(h.session);
	ok(
		"cancelRelease: a later drain releases only what is left",
		drained.map((l) => l.name).join(",") === "beta",
		JSON.stringify(drained),
	);
	ok("cancelRelease: and cancelling does not make it held", h.session.leases.length === 0, JSON.stringify(h.session.leases));
}

done();
