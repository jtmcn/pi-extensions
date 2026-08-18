/**
 * Moving focus, and the worktree lease with it.
 *
 * Every door goes through here: `/worktree focus`, `new` and `checkout` with
 * `autoFocus`, `remove` clearing the focus it just deleted (all in
 * `commands.ts`), and the model-facing tool (`tool.ts`). None of them calls the
 * session's `setFocus` directly any more, which is the point — that one moves
 * the agent without moving the lease, and rules that differ per door are the
 * two-models bug in miniature. `setFocus` survives on its own outside this file
 * in three places, none of them a counter-example: this file's own last step;
 * the restore path in `index.ts`, where there is no transition to make because
 * nothing was focused before; and `moveFocusHere`'s no-model branch in
 * `index.ts`, which *is* a transition — focus really does move — but one with
 * no registry to lease anything from, so there is nothing here for it to call
 * into.
 *
 * The rules, all three of which have a failure behind them:
 *
 *   1. **Acquire the destination before releasing the origin.** If it cannot be
 *      held, focus does not move at all; the alternative is an agent writing
 *      into a worktree it was refused.
 *   2. **Release the origin when the agent settles**, not when focus moves.
 *      Focus is applied at `tool_call` time, so a call already in flight is
 *      still writing into the origin. A release still queued for the
 *      *destination* is therefore cancelled on the way in, before the registry is
 *      read: it is proof this session still holds that worktree, and a drain
 *      landing between the read and `addLease` would hand back a lease the
 *      transition is about to record as held.
 *   3. **Release it whatever its provenance** — see `releaseOrigin`.
 */

import { stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FocusTarget } from "./focus.ts";
import type { Model } from "./jimothy.ts";
import type { HeldLease, WorktreeSession } from "./session.ts";
import { type LeaseEnv, takeLeaseOn } from "./take-lease.ts";

export interface TransitionEnv {
	lease: LeaseEnv;
	model: Model;
	/** The session's own worktree: what focus returns to when it is cleared. */
	home: string;
}

/** Is there still a directory there? */
const exists = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Give a lease back, now or when the agent settles.
 *
 * Released regardless of provenance, which looks like it contradicts phase 3's
 * rule that a delegated lease is never released by this extension — it does not.
 * That rule is about `session_shutdown`, where jimothy's own `finally` is about
 * to run and owns the lease. A transition is the opposite situation: the agent
 * has *left* that worktree, which is exactly when jimothy wants it back, and
 * `releaseLease` is runId-guarded, so an early release can never unlock a
 * worktree somebody else has since taken.
 *
 * The cost, stated so nobody rediscovers it as a bug: pi's own cwd is still the
 * origin, so a user typing into the terminal is working in a worktree the
 * session no longer holds.
 */
const releaseOrigin = async (
	env: TransitionEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	lease: HeldLease,
): Promise<void> => {
	// Not idle means a tool call is in flight and is still writing into that
	// worktree; releasing it here would invite a second agent into a directory
	// being written. `index.ts` drains the queue on `agent_settled`.
	if (!ctx.isIdle()) {
		active.deferRelease(lease);
		return;
	}
	// `expectedPid`, like the drain in `index.ts`: this releases the lease *we*
	// hold, not whatever holds that name by the time the registry is written. A
	// `false` says it was not ours any more, which is not a failure and has nobody
	// to tell — focus has already left that worktree either way.
	await env.model.registry.releaseLease(lease.name, lease.runId, { expectedPid: process.pid }).catch((error: Error) => {
		// A release that fails is not a reason to undo a focus change the user
		// asked for, so this reports and returns. The `current` check is the usual
		// one: the session can have been replaced while the registry was locked, and
		// its `ctx` is stale from that moment.
		if (!env.lease.current(active)) return;
		env.lease.say(ctx, `could not release worktree "${lease.name}": ${error.message}`, "warning");
	});
};

/**
 * Give back a release this transition cancelled and then could not use.
 *
 * While the session is still current this is the ordinary give-back: back
 * through `releaseOrigin`, which defers it again while a tool call may still be
 * writing there. A session replaced or shut down during the acquisition is the
 * case this exists for, and it cannot be handed back at all — after disposal
 * `deferRelease` is inert, and `session_shutdown`'s drain has already run (over
 * a queue this entry was cancelled out of), so the entry would be a lease
 * nothing ever releases: the registry holding the worktree under this live pid
 * and a run id no session answers for, recorded on no session's lease list. So
 * it is released outright instead, and swallowed rather than reported, exactly
 * as an acquire abandoned mid-flight is (`take-lease.ts`, the acquire row): the
 * context is stale from the moment `current` went false.
 */
const releaseCancelled = async (
	env: TransitionEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	lease: HeldLease,
): Promise<void> => {
	if (env.lease.current(active)) {
		await releaseOrigin(env, active, ctx, lease);
		return;
	}
	await env.model.registry.releaseLease(lease.name, lease.runId).catch(() => {});
};

/**
 * Give back the leases a transition queued, one at a time.
 *
 * The other half of `deferRelease`, and the only thing besides `session_shutdown`
 * that empties that queue. Both drains in `index.ts` come through here so there is
 * one implementation of the two guards below rather than two that agree by
 * coincidence.
 *
 * **Two guards, for two different failures. Neither one covers the other.**
 *
 *   1. `active.leases`, checked immediately before each release. A re-acquisition
 *      by *this session* is invisible to the registry: the decision it takes is
 *      `adopt`, which writes nothing at all — same run id, same pid, same `since`
 *      — so the session's own lease list is the only witness that the worktree is
 *      held again. Without this check a drain that had already taken the entry
 *      would hand back a worktree the agent is writing in.
 *   2. `expectedPid`, inside jimothy's own write. It catches what the check above
 *      cannot see: a lease that has moved onto *another live pid*, which is what a
 *      launcher handing over produces. There the registry is the only witness, and
 *      the run id alone does not tell the two apart — a retarget keeps it.
 *
 * **Narrowed, not closed.** A re-acquisition that lands between the check and
 * jimothy's write is still released. Nothing in one process closes that: an
 * adoption leaves no trace in the registry for a compare-and-release to compare
 * against, so the window is as small as the check can make it and no smaller.
 * What it does close is the whole *rest* of the queue: entries are popped one at a
 * time (see `nextDeferredRelease`), so a transition can still cancel them while an
 * earlier release is in flight.
 *
 * A release that declines returns `false` rather than throwing, and nothing is
 * done with it: this is a background drain with nobody to report to, and "the
 * lease was not mine to give back" is the outcome asked for, not an error. A
 * release that *fails* — a lock we could not take, a registry we could not read —
 * goes to `onError`, whose caller decides whether there is still a live session to
 * tell.
 */
export async function drainDeferredReleases(
	model: Model,
	active: WorktreeSession,
	onError: (lease: HeldLease, error: Error) => void,
): Promise<void> {
	for (let lease = active.nextDeferredRelease(); lease !== undefined; lease = active.nextDeferredRelease()) {
		const queued = lease;
		// Taken back by a transition while an earlier release was in flight: the
		// session holds this worktree again, and the agent may already be writing in it.
		if (active.leases.some((held) => held.name === queued.name)) continue;
		await model.registry
			.releaseLease(queued.name, queued.runId, { expectedPid: process.pid })
			.catch((error: Error) => onError(queued, error));
	}
}

/**
 * Move focus, carrying the lease with it.
 *
 * Returns whether focus moved. `false` means the destination could not be
 * acquired and focus is unchanged — the caller reports, it does not retry.
 */
export async function moveFocus(
	env: TransitionEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	next: FocusTarget | undefined,
	opts: { announce?: boolean } = {},
): Promise<boolean> {
	let from: string | undefined = active.focus?.path ?? env.home;

	// Checked here rather than only at `session_start`, because a worktree can go
	// away mid-session — another session's `/worktree remove`, or `jimothy wt rm`
	// in another terminal — and every tool call after that is redirected into a
	// directory that no longer exists. The error names a path the user never
	// typed, so it reads as a broken shell rather than a missing worktree.
	//
	// It also leaves the transition below with no origin at all, which `from`
	// records by becoming undefined. Neither of the two paths that look like one is
	// usable: the vanished worktree cannot be the origin — it is gone, and its lease
	// was handed back inside this block, so a `from === to` short-circuit would
	// re-focus a missing directory a line after saying focus was cleared; and
	// `env.home` cannot be it either — focusing away released home's lease, so
	// short-circuiting `focus off` against it would leave the session focused on a
	// worktree it does not hold.
	if (active.focus && !(await exists(active.focus.path))) {
		if (!env.lease.current(active)) return false;
		env.lease.say(ctx, `focused worktree ${active.focus.path} is gone; focus cleared`, "warning");
		// Its lease went with it as far as this session is concerned: the record may
		// survive (git reports a hand-deleted worktree as prunable), so drop ours
		// rather than assuming the registry has.
		const orphan = active.dropLease(active.focus.path);
		active.setFocus(ctx, undefined, false);
		if (orphan) await releaseOrigin(env, active, ctx, orphan);
		from = undefined;
	}

	// Hoisted rather than repeated inside the `from === to` branch below: it covers
	// both awaits above it — `exists` and the release — for everything that follows,
	// including the branch that calls `setFocus` and so reaches `pi.appendEntry` and
	// `pi.sendMessage`, neither of which is guarded by `disposed` the way `paint` is.
	if (!env.lease.current(active)) return false;

	const to = next?.path ?? env.home;

	// Focusing what is already focused is not a transition, and must not release
	// the lease that focus is standing on.
	if (from === to) {
		active.setFocus(ctx, next, opts.announce);
		return true;
	}

	// A release still queued for the destination has not happened yet, so this
	// session still holds that worktree: take the queue entry back *before* the
	// registry is read below. `addLease` cancels a queued release too, but only
	// after the read — and `agent_settled` can drain the queue during it, which
	// leaves the registry free, this session believing it holds the worktree, and
	// the agent writing into it unleased. That is the failure the whole transition
	// exists to prevent, so the cancellation happens where nothing can drain
	// between it and the decision.
	//
	// Safe because a queued release *is* the proof we hold it: the decision below
	// can only be `adopt`, which records this same lease again.
	const queued = active.cancelRelease(to);

	// Destination first, always. If it cannot be held, focus does not move: the
	// alternative is an agent writing into a worktree it was refused.
	if (!(await takeLeaseOn(env.lease, active, ctx, env.model, to))) {
		// Focus did not move, so a release cancelled above is still owed — through the
		// same door while this session is still current, released outright when it is
		// not, because the queue is inert by then. See `releaseCancelled`.
		if (queued) await releaseCancelled(env, active, ctx, queued);
		return false;
	}
	// A session replaced while the destination was being acquired has no focus
	// worth setting and no lease list worth editing — but a release cancelled on the
	// way in is still owed, and the queue that would have carried it is inert.
	if (!env.lease.current(active)) {
		if (queued) await releaseCancelled(env, active, ctx, queued);
		return false;
	}

	active.setFocus(ctx, next, opts.announce);

	// `from` is undefined only when the block above cleared focus, and that block
	// already handed the lease back; there is nothing left to drop.
	const origin = from === undefined ? undefined : active.dropLease(from);
	if (origin) await releaseOrigin(env, active, ctx, origin);
	return true;
}
