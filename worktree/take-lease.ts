/**
 * Who holds the worktree this session writes to.
 *
 * The decision table is `lease.ts` and stays pure; this file is the half that
 * touches the registry and the user — acquiring, retargeting, prompting, and
 * recording what was taken on the session. It is called from two places, which
 * is why it is a module rather than a closure in `index.ts`: `session_start`
 * (`takeLeaseForSession`) and every focus transition (`takeLeaseOn`).
 *
 * Every function here holds a `WorktreeSession` across awaits, so every one of
 * them re-checks `env.current(active)` afterwards. A session replaced mid-flight
 * must record no lease: `active.addLease` on a disposed session is a lease
 * nothing will ever release, which wedges the worktree until someone runs
 * `jimothy wt release --force`.
 */

import { realpath } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkLease,
	describeLease,
	describeReclaim,
	type WorktreeLease,
	type WorktreeRecord,
} from "jimothy/worktrees";
import { decideLease, type LauncherEnv, type LeaseDecision, leaseProvenance, sameHolder } from "./lease.ts";
import type { Model } from "./jimothy.ts";
import type { WorktreeSession } from "./session.ts";

/** What a lease taken by this extension calls itself, wherever one is rendered. */
const LEASE_LABEL = "pi session";

/**
 * What this module needs from `index.ts`'s closure, injected rather than
 * imported: the answers live in per-process state (`session`, `launcher`) or
 * are pi wiring (`say`), and every await below is a point a session can be
 * replaced under us — which is exactly what `current` exists to answer.
 */
export interface LeaseEnv {
	launcher: LauncherEnv | undefined;
	say: (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => void;
	/**
	 * Is `active` still the session the extension is running? Injected rather
	 * than imported: the answer lives in `index.ts`'s closure, and every await
	 * below is a point the session can be replaced under us.
	 */
	current: (active: WorktreeSession) => boolean;
}

/** The model's own rendering of a live holder, so this and `/worktree list` agree. */
const held = (decision: { lease: WorktreeLease; ageMs: number }) =>
	describeLease({ state: "held", lease: decision.lease, ageMs: decision.ageMs });

/**
 * The worktree a decision is being made about, and who is asking.
 *
 * One object rather than three parameters because the three travel together
 * through every re-decision: a bounded retry has to reconsider *this* worktree,
 * and a version of that recursion which went back to "whatever the session's
 * target is" would, on a focus transition, re-decide the wrong directory.
 */
interface Target {
	/**
	 * Realpath of the worktree. Records store resolved paths, and an unresolved
	 * one silently matches nothing — a session in a symlinked worktree would
	 * decide it is unmanaged and take no lease at all.
	 */
	path: string;
	/** The launcher's run id, when this is a worktree jimothy may have leased for us. */
	launcherRunId: string | undefined;
	/**
	 * What a live stranger holding this worktree means for the caller.
	 *
	 * `session-start` has nowhere else to go: declining to displace the holder
	 * ends the session, and a headless run carries on unleased because killing a
	 * scripted run is worse than the warning.
	 *
	 * `transition` has somewhere — exactly where it already is. Either answer
	 * simply refuses the move, which is the spec's rule for focus (§"Focus moves
	 * the lease": "the transition is refused (or prompts, with UI) and focus does
	 * not move"). Quitting pi because the user declined to take over the worktree
	 * they were merely trying to look at would be absurd.
	 */
	entry: "session-start" | "transition";
}

/**
 * Carry out a decision, and record what we ended up holding.
 *
 * Returns whether the session should carry on starting: false when the user
 * chose to quit, which is the one row that ends the process, and false when
 * this session has been replaced under us and there is nothing left to start.
 *
 * `retries.retarget` bounds the retarget row's re-decision: `true` on the
 * first call (from `takeLease`'s default), `false` on the recursive one, so a
 * lease that changes hands twice in a row is never chased a third time.
 * `retries.takeover` bounds the prompt row's re-decision the same way, and for
 * the same reason — see that row. One object rather than two booleans because
 * two positional flags of the same type transpose silently.
 */
const applyDecision = async (
	env: LeaseEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	model: Model,
	target: Target,
	record: WorktreeRecord | undefined,
	decision: LeaseDecision,
	retries: { retarget: boolean; takeover: boolean },
): Promise<boolean> => {
	// Unmanaged is not a failure, on either entry point: focusing a worktree
	// jimothy does not manage has always worked, and refusing it here would make
	// `/worktree adopt` a precondition for a command that never needed one.
	if (!record || decision.kind === "unmanaged") return true;
	const hold = (runId: string) =>
		active.addLease({
			name: record.name,
			path: record.path,
			runId,
			provenance: leaseProvenance(runId, env.launcher?.runId),
		});

	switch (decision.kind) {
		case "acquire": {
			const runId = ctx.sessionManager.getSessionId();
			const result = await model.registry.acquireLease(record.name, runId, process.pid, {
				label: LEASE_LABEL,
			});
			if (!env.current(active)) return false;
			// A worktree that was "in use" a moment ago and now simply opens makes
			// the lease look like it meant nothing.
			if (result.reclaimed) env.say(ctx, describeReclaim(record.name, result.reclaimed), "info");
			hold(runId);
			return true;
		}
		case "retarget": {
			const moved = await model.registry.retargetLease(record.name, decision.runId, {
				fromPid: decision.fromPid,
				pid: process.pid,
				label: LEASE_LABEL,
			});
			if (!env.current(active)) return false;
			// False means the lease changed hands between the read and this call —
			// the launcher died and someone reclaimed it. Start again from the
			// current facts rather than assuming, but only once: `retargetRetry`
			// is what enforces that bound, since nothing about the decision shape
			// itself stops a record that races back into the retarget row from
			// recursing again. A lease that has changed hands twice under us in a
			// millisecond is not safely ours to chase further, so the second
			// failure is left unleased and reported by name. Exercised only by a
			// real race between two processes, not by a test — see the report.
			if (moved) hold(decision.runId);
			else if (retries.retarget) return await decideFor(env, active, ctx, model, target, { ...retries, retarget: false });
			else env.say(ctx, `worktree "${record.name}" lease changed hands again; leaving it unleased`, "warning");
			return true;
		}
		case "adopt":
			// Already ours: `lease.pid === input.pid` in decideLease. An "ours" lease no
			// longer reaches this row — session_shutdown releases it before the
			// replacement's session_start runs, so that case takes the acquire row
			// instead. What lands here now is a delegated lease: retargeted onto this
			// pid at an earlier session_start, left alone by every shutdown since
			// (jimothy's own `finally` owns it), and still naming the launcher's run
			// id when the process reloads, forks, or is otherwise replaced. Whether it
			// is ours to release is still the runId's business, not this row's — hold()
			// classifies it as delegated below. Task 7 exercises this end to end.
			hold(decision.runId);
			return true;
		case "warn": {
			// A headless run is bounded and usually read-only; a prompt is
			// impossible and killing a scripted run is worse than the warning. This
			// is also the row every pi-inside-a-pi lands on.
			//
			// A transition has the option a session start does not: it can decline to
			// move. Nothing is lost by staying, and moving would put the agent's writes
			// in a worktree another live process is holding.
			const atStart = target.entry === "session-start";
			const consequence = atStart ? "continuing without a lease" : "focus not moved";
			env.say(ctx, `worktree "${record.name}" is ${held(decision)}; ${consequence}`, "warning");
			return atStart;
		}
		case "prompt": {
			const choice = await ctx.ui.select(`Worktree "${record.name}" is ${held(decision)}`, [
				"Quit",
				"Take over",
			]);
			// The longest wait in here by far, and the one most likely to outlive the
			// session that opened it.
			if (!env.current(active)) return false;
			// Dismissal is not consent: anything other than an explicit take-over
			// leaves the other session alone.
			//
			// Shutting down from inside `session_start` — a handler pi awaits before it
			// shows the prompt — was spiked under a pty before this was written: pi
			// exits 0 in under a second and does not wait for the rest of the handler,
			// so nothing after this call is guaranteed to run.
			if (choice !== "Take over") {
				env.say(ctx, `worktree "${record.name}" is held by another session`, "warning");
				// See `Target.entry`: a session that cannot have the worktree it is about
				// to write to has nowhere to go; a transition that cannot have the one it
				// was moving to stays where it is.
				if (target.entry === "session-start") ctx.shutdown();
				return false;
			}
			// Consent was given to displace the run the prompt *named*, and nobody
			// else. Answering takes seconds, `breakLease` breaks whoever holds it
			// now, and in between the holder may have released and a second live
			// session acquired — force-breaking that one displaces a run the user was
			// never shown. So re-read and re-classify immediately before breaking.
			//
			// This narrows the window from human thinking time to two registry calls;
			// it does not close it. Closing it needs a compare-and-break in the model
			// (`breakLease(name, { force, expected: { runId, pid } })`), which belongs
			// to the phase that touches jimothy — this one does not edit it.
			const latest = (await model.registry.snapshot()).managed.find((entry) => entry.path === record.path);
			if (!env.current(active)) return false;
			const state = latest ? checkLease(latest, model.deps.isPidAlive, model.deps.now()) : { state: "free" as const };
			if (!(state.state === "held" && sameHolder(state.lease, decision.lease))) {
				// Released, reclaimed, or taken by someone else. Decide again from the
				// current facts and let the ordinary path have it — which asks afresh
				// naming the new holder, acquires if it is now free, or warns. Bounded
				// exactly as the retarget row is: once, so a worktree changing hands
				// under every prompt cannot loop the session.
				if (retries.takeover) return await decideFor(env, active, ctx, model, target, { ...retries, takeover: false });
				env.say(ctx, `worktree "${record.name}" changed hands again; leaving it unleased`, "warning");
				return true;
			}
			// Force, because the whole point of this row is that the holder is alive:
			// without it `breakLease` refuses. The displaced run is named, because
			// someone is losing a worktree they are still working in.
			const displaced = await model.registry.breakLease(record.name, { force: true });
			if (!env.current(active)) return false;
			if (displaced) {
				env.say(ctx, `took over "${record.name}" from run ${displaced.runId} (pid ${displaced.pid})`, "warning");
			}
			return await applyDecision(env, active, ctx, model, target, record, { kind: "acquire" }, retries);
		}
	}
};

/**
 * Decide what to do about one worktree, and do it.
 *
 * The shared half of both entry points, and the only place a lease situation is
 * read out of the registry: `session_start` adds the launcher's retarget before
 * it, and a transition adds nothing at all.
 *
 * The snapshot, not `list()`: this runs in every pi session that opens a
 * repository, and the reconciling read would take the registry's lock and
 * rewrite `registry.json` for all of them.
 */
const decideFor = async (
	env: LeaseEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	model: Model,
	target: Target,
	retries: { retarget: boolean; takeover: boolean },
): Promise<boolean> => {
	const record = (await model.registry.snapshot()).managed.find((entry) => entry.path === target.path);
	if (!env.current(active)) return false;
	const decision = decideLease({
		record,
		state: record ? checkLease(record, model.deps.isPidAlive, model.deps.now()) : { state: "free" },
		launcherRunId: target.launcherRunId,
		pid: process.pid,
		ppid: process.ppid,
		hasUI: ctx.hasUI,
	});
	return await applyDecision(env, active, ctx, model, target, record, decision, retries);
};

/**
 * Move the launcher's lease onto this process, for a worktree that is not the
 * one this session will write to.
 *
 * Deliberately narrow: every other row — free, stale, a stranger — belongs to
 * the worktree we are actually writing to, and acting on any of them here would
 * take a lease on a directory nobody is going to touch. A launcher whose lease
 * has already been reclaimed by someone else therefore leaves with nothing
 * happening, which is correct: it is no longer ours to move.
 *
 * The lease this holds is `delegated`, so `session_shutdown` deliberately
 * leaves it: jimothy's own `finally` releases it under the same run id. Giving
 * it back when the agent settles on the other worktree is phase 4's focus
 * transition, not an omission here.
 */
const retargetLaunched = async (env: LeaseEnv, active: WorktreeSession, model: Model, path: string) => {
	const record = (await model.registry.snapshot()).managed.find((entry) => entry.path === path);
	// A session replaced while this snapshot was in flight has nothing left to
	// retarget onto: recording a lease here would land it on `active.leases`
	// after that session is disposed, with nothing left to release it.
	if (!env.current(active)) return;
	if (!record) return;
	const decision = decideLease({
		record,
		state: checkLease(record, model.deps.isPidAlive, model.deps.now()),
		launcherRunId: env.launcher?.runId,
		pid: process.pid,
		ppid: process.ppid,
		// Never prompt about this one: the question the user answers is about the
		// worktree the agent is going to write to, and asking twice at startup —
		// once about a directory they did not choose — is worse than silence. This
		// is a deliberate use of the warn row *for its silence*, not a claim about
		// the terminal: if a later phase makes `warn` say something, this call site
		// needs its own quieter path.
		hasUI: false,
	});
	// Only ever a retarget. On a re-entry through `takeLease`'s bounded retries
	// the lease is already on this pid, so the decision is `adopt` and this
	// returns without doing the work twice.
	//
	// The same short-circuit means that after a session replacement the delegated
	// lease is *not* re-recorded on the new session's `leases`: the decision is
	// `adopt`, and this returns before `addLease`. Harmless, and the focus
	// transition does not change that: it releases the worktree focus *leaves*,
	// and a worktree this session never focused onto is one it never wrote in. One
	// it does focus onto is leased through `takeLeaseOn` on the way in, so it is on
	// the list by the time focus leaves it again.
	if (decision.kind !== "retarget") return;
	const moved = await model.registry.retargetLease(record.name, decision.runId, {
		fromPid: decision.fromPid,
		pid: process.pid,
		label: LEASE_LABEL,
	});
	// Same reasoning as the snapshot check above: a stale `active` here means
	// `addLease` below would write onto a disposed session's list.
	//
	// Neither check in this function is reachable from a test: the only
	// scriptable async gap in the whole handshake is `ctx.ui.select`, and this
	// function never prompts (`hasUI: false` above) — it is always done, one
	// way or another, before `takeLease` ever reaches a select. See the report.
	if (!env.current(active)) return;
	// False says the lease changed hands between the read and the call, which is
	// the same answer as the rows above and gets the same treatment: silence and
	// nothing held. Unlike the target's retarget row there is nothing to re-decide
	// — a worktree this session will not write to has no other row it may take.
	if (!moved) return;
	active.addLease({
		name: record.name,
		path: record.path,
		runId: decision.runId,
		provenance: leaseProvenance(decision.runId, env.launcher?.runId),
	});
};

/**
 * Lease the worktree this session will write to.
 *
 * The target is the restored focus when there is one, because every tool call
 * is rewritten into it — leasing the cwd there would hold the worktree nobody
 * is writing to. It is realpath'd because records store resolved paths, and an
 * unresolved one silently matches nothing: a session in a symlinked worktree
 * would decide it is unmanaged and take no lease at all.
 *
 * Everything here is reported and nothing is fatal: pi is already running.
 * Returns whether the session should carry on starting — false when the user
 * answered the prompt row with "quit", and false when this session was replaced
 * while the handshake was waiting.
 */
const takeLease = async (
	env: LeaseEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	retries: { retarget: boolean; takeover: boolean } = { retarget: true, takeover: true },
): Promise<boolean> => {
	const model = active.model;
	if (!model) return true;
	try {
		const path = await realpath(active.focus?.path ?? ctx.cwd);
		// A replacement here is not reachable from a test: `realpath` is not the
		// select seam the rest of this handshake is exercised through, and nothing
		// before it can prompt. Kept for the same reason the checks below are —
		// see the report — a replaced session must record no lease, regardless of
		// which await it was waiting on when it was replaced.
		if (!env.current(active)) return false;

		// Sandwiched deliberately, and only one order works: the launcher's worktree
		// is interesting only by comparison with the target, so the target must be
		// resolved above this; and the retarget must land before the target is
		// acquired below. The reading order is the reverse — what the target's rows
		// do is the main story and this is the aside — so it is written down here
		// rather than left to be inferred from where the lines happen to sit.
		//
		// The launcher's worktree is not always the one we will write to: a resumed
		// session restores focus from its transcript, so jimothy can hold A while
		// the agent's target is B. Retargeting A first is what makes the failure
		// case right as well — if B cannot be acquired, focus is dropped and the
		// agent falls back to cwd, which is A, and we are holding it.
		//
		// Only ever a retarget: this is a lease already taken in our name. A
		// worktree we were not launched into takes the ordinary path below.
		if (env.launcher?.worktree) {
			// `catch`: the launcher's worktree can have been removed while pi ran, and
			// a missing directory here says nothing about the one we are writing to.
			const launched = await realpath(env.launcher.worktree).catch(() => undefined);
			if (!env.current(active)) return false;
			// `retargetLaunched` never prompts, so nothing inside it can be the point a
			// session is replaced at in a test; this check exists for the same reason
			// its own internal ones do — not reachable, still required.
			if (launched && launched !== path) await retargetLaunched(env, active, model, launched);
			if (!env.current(active)) return false;
		}

		return await decideFor(
			env,
			active,
			ctx,
			model,
			{ path, launcherRunId: env.launcher?.runId, entry: "session-start" },
			retries,
		);
	} catch (error) {
		// Lock contention and a corrupt registry both arrive here as a UserError,
		// and a session never dies of either.
		if (!env.current(active)) return false;
		env.say(ctx, `worktree lease unavailable: ${(error as Error).message}`, "warning");
		return true;
	}
};

/**
 * Lease the worktree the given session will write to, at `session_start`.
 *
 * A thin wrapper over `takeLease`: the retries bound is an internal recursion
 * limit, not something a caller should ever need to pass in, so it is not part
 * of the exported signature.
 */
export async function takeLeaseForSession(
	env: LeaseEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
): Promise<boolean> {
	return await takeLease(env, active, ctx);
}

/**
 * Take the lease on one worktree, for a caller that already knows which.
 *
 * The session-start entry point differs only in what it does *before* this:
 * reading the launcher's environment and retargeting its worktree. A transition
 * has no launcher rows — nothing about moving focus makes this process the
 * launcher's agent — so it decides from the registry alone.
 *
 * Returns whether the worktree is ours to write in: acquired, taken over,
 * already held by us, or unmanaged and needing no lease at all. False is a
 * refusal — a live stranger the user would not displace, a registry that could
 * not be read, or a session replaced while this was waiting — and the caller
 * must not move focus there.
 */
export async function takeLeaseOn(
	env: LeaseEnv,
	active: WorktreeSession,
	ctx: ExtensionContext,
	model: Model,
	path: string,
): Promise<boolean> {
	try {
		const target = await realpath(path);
		if (!env.current(active)) return false;
		return await decideFor(
			env,
			active,
			ctx,
			model,
			// No launcher run id: being launched by jimothy says something about the
			// worktree it launched us into, and nothing whatever about one the agent
			// decides to move to later.
			{ path: target, launcherRunId: undefined, entry: "transition" },
			{ retarget: true, takeover: true },
		);
	} catch (error) {
		// Lock contention, a corrupt registry, a directory that cannot be resolved.
		// Unlike `session_start`, which carries on unleased because pi is already
		// running, a transition that cannot even read the lease does not happen:
		// there is nothing to gain by moving the agent's writes into a worktree whose
		// owner we failed to look up.
		if (!env.current(active)) return false;
		// A worktree removed from another terminal is the commonest way to get here,
		// and `realpath`'s ENOENT reads as an internal fault rather than as the one
		// fact the user needs. Name the directory and say what is wrong with it: an
		// opaque error about a path they never typed is precisely what the vanished
		// worktree check exists to stop.
		const message =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? `worktree ${path} no longer exists; focus not moved`
				: `worktree lease unavailable: ${(error as Error).message}`;
		env.say(ctx, message, "warning");
		return false;
	}
}
