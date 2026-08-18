/**
 * Moving focus, and the worktree lease with it.
 *
 * Today one door goes through here: `/worktree focus`. The rest do not yet —
 * `new` and `checkout` with `autoFocus`, `remove` clearing the focus it just
 * deleted (all three in `commands.ts`), and the model-facing tool (`tool.ts`)
 * still call `setFocus` directly, so they still move the agent without moving
 * the lease. Porting them is the rest of this phase, and they are named here
 * rather than left to be discovered because the rules cannot be allowed to
 * differ per door: that is the two-models bug in miniature, and it is what this
 * whole integration exists to end. When the last of them is ported this becomes
 * what it is meant to be — the one path that moves focus.
 *
 * The rules, all three of which have a failure behind them:
 *
 *   1. **Acquire the destination before releasing the origin.** If it cannot be
 *      held, focus does not move at all; the alternative is an agent writing
 *      into a worktree it was refused.
 *   2. **Release the origin when the agent settles**, not when focus moves.
 *      Focus is applied at `tool_call` time, so a call already in flight is
 *      still writing into the origin.
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
	await env.model.registry.releaseLease(lease.name, lease.runId).catch((error: Error) => {
		// A release that fails is not a reason to undo a focus change the user
		// asked for, so this reports and returns. The `current` check is the usual
		// one: the session can have been replaced while the registry was locked, and
		// its `ctx` is stale from that moment.
		if (!env.lease.current(active)) return;
		env.lease.say(ctx, `could not release worktree "${lease.name}": ${error.message}`, "warning");
	});
};

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

	// Destination first, always. If it cannot be held, focus does not move: the
	// alternative is an agent writing into a worktree it was refused.
	if (!(await takeLeaseOn(env.lease, active, ctx, env.model, to))) return false;
	// A session replaced while the destination was being acquired has no focus
	// worth setting and no lease list worth editing.
	if (!env.lease.current(active)) return false;

	active.setFocus(ctx, next, opts.announce);

	// `from` is undefined only when the block above cleared focus, and that block
	// already handed the lease back; there is nothing left to drop.
	const origin = from === undefined ? undefined : active.dropLease(from);
	if (origin) await releaseOrigin(env, active, ctx, origin);
	return true;
}
