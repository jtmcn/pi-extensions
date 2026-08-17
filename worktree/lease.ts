/**
 * Who holds this worktree, and what this session should do about it.
 *
 * The spec's handoff protocol is a table of situations, and this is that table
 * as one function. It is pure for the same reason `select.ts` is: every
 * situation here is otherwise reachable only by arranging real processes, and a
 * rule nobody can test is a rule that quietly stops being true.
 *
 * Two of these rules are load-bearing and neither is obvious:
 *
 * - **A launcher's lease is recognised by parentage, not by a variable.**
 *   `JIMOTHY_RUN_ID` names the run; what proves this process is that run's agent
 *   is that the lease's owner is literally our parent. jimothy spawns pi
 *   directly, so inside pi the launcher is `process.ppid`. Everything further
 *   down the tree — a pi subagent, a pi the model started from bash — fails the
 *   check, and without it the variable would be a capability that every
 *   descendant inherits.
 * - **Provenance asks who will release the lease, not who took it.** A
 *   hand-launched pi that runs `/reload` meets its own lease and adopts it;
 *   classified by how it was obtained, that lease would never be released,
 *   because there is no launcher to release it.
 * - **Which run launched this process is a fact about the process**, so
 *   `captureLauncherEnv` keeps it on `globalThis` rather than in the extension
 *   closure that read it: a session replacement rebuilds that closure, and the
 *   environment it would read again has already been scrubbed.
 */

import type { LeaseState, WorktreeLease, WorktreeRecord } from "jimothy/worktrees";

/** What jimothy told this process when it launched it. */
export interface LauncherEnv {
	/** The run that holds the lease jimothy took before pi existed. */
	runId: string;
	/**
	 * The worktree jimothy leased, which is not always the one this session will
	 * write to: a resumed session restores focus from its transcript, so the
	 * launcher can hold A while the agent's target is B.
	 */
	worktree?: string;
}

/**
 * Read the launcher's variables and remove them from the environment.
 *
 * Deleting is not tidiness. pi runs other pi processes, every one of them
 * inherits this environment, and a child that kept these would run
 * `session_start` in the same worktree and retarget the live agent's lease onto
 * its own pid — which, when that child exited, would leave the lease naming a
 * dead pid while the real agent was still writing.
 *
 * Both keys are deleted even when they do not amount to a launcher, because an
 * inherited half is exactly as dangerous as an inherited whole.
 */
export function readLauncherEnv(env: NodeJS.ProcessEnv): LauncherEnv | undefined {
	const runId = env.JIMOTHY_RUN_ID;
	const worktree = env.JIMOTHY_WORKTREE;
	delete env.JIMOTHY_RUN_ID;
	delete env.JIMOTHY_WORKTREE;
	if (!runId) return undefined;
	return worktree ? { runId, worktree } : { runId };
}

/**
 * Where the launcher's identity is remembered, keyed like `lib/panels.ts`'s
 * registry and for the same reason: a well-known symbol on `globalThis` is the
 * only in-process memory nothing can take away.
 */
const LAUNCHER_KEY = Symbol.for("pi-extensions.worktree.launcher");

interface LauncherSlot {
	env: LauncherEnv | undefined;
}

/**
 * Read the launcher's variables once per *process*, scrubbing them every time.
 *
 * Which run launched this process is a fact about the process, not about a
 * module or a session, and it has to be stored somewhere that outlives both.
 * Measured under a pty rather than reasoned about:
 *
 *   /new      the extension module survives (one load, same instance), but the
 *             factory re-runs, so an extension closure is rebuilt.
 *   /reload   the module is re-imported as well, so module-level state goes too.
 *
 * Either way a fresh closure that read the environment again would find it
 * already scrubbed and conclude there was no launcher — which classifies a
 * *delegated* lease (held under the launcher's run id) as "ours", so the
 * extension releases at the next shutdown a lease the spec says it must never
 * release. `globalThis` survives both.
 *
 * The scrub is not latched with the value: every call deletes both keys, so a
 * later session cannot inherit a variable something else put back.
 */
export function captureLauncherEnv(env: NodeJS.ProcessEnv): LauncherEnv | undefined {
	const scrubbed = readLauncherEnv(env);
	// Double cast: `globalThis` and an index signature do not overlap, so the
	// single-step version is an error rather than a widening.
	const host = globalThis as unknown as Record<symbol, LauncherSlot | undefined>;
	host[LAUNCHER_KEY] ??= { env: scrubbed };
	return host[LAUNCHER_KEY]?.env;
}

/**
 * Forget what the launcher said, so the next capture reads the environment.
 *
 * For tests only: a real process is launched once and remembers for its life,
 * which is the whole point of `captureLauncherEnv`. A test file is many
 * processes' worth of sessions in one, and without this the first session in it
 * would decide the launcher for every session after it.
 */
export function forgetLauncherEnv(): void {
	delete (globalThis as unknown as Record<symbol, LauncherSlot | undefined>)[LAUNCHER_KEY];
}

export type LeaseDecision =
	/** Nothing to lease: jimothy does not manage this directory. */
	| { kind: "unmanaged" }
	/** Free, or held by a pid that is gone. The registry reports what it reclaimed. */
	| { kind: "acquire" }
	/** Our launcher's lease, moved onto this process without changing hands. */
	| { kind: "retarget"; runId: string; fromPid: number }
	/** Already ours — a lease that survived `/reload`, `/fork` or `/new`. */
	| { kind: "adopt"; runId: string }
	/** A live stranger, and a user to ask. `ageMs` is the registry's measurement. */
	| { kind: "prompt"; lease: WorktreeLease; ageMs: number }
	/** A live stranger and no way to ask. */
	| { kind: "warn"; lease: WorktreeLease; ageMs: number };

export function decideLease(input: {
	/** The record for the effective write target, or undefined when unmanaged. */
	record: WorktreeRecord | undefined;
	state: LeaseState;
	/** The launcher's run id, if this process was started by jimothy. */
	launcherRunId: string | undefined;
	pid: number;
	ppid: number;
	hasUI: boolean;
}): LeaseDecision {
	if (!input.record) return { kind: "unmanaged" };
	// A stale lease is the registry's to reclaim: `acquireLease` displaces a dead
	// owner and reports it, so there is nothing to decide here.
	if (input.state.state !== "held") return { kind: "acquire" };

	const { lease, ageMs } = input.state;
	// Ours already. Mutually exclusive with the retarget row below — a process is
	// not its own parent — so the order of these two says nothing.
	if (lease.pid === input.pid) return { kind: "adopt", runId: lease.runId };
	if (input.launcherRunId && lease.runId === input.launcherRunId && lease.pid === input.ppid) {
		return { kind: "retarget", runId: lease.runId, fromPid: lease.pid };
	}
	// A live stranger. Headless runs are bounded and usually read-only, a prompt
	// is impossible, and killing a scripted run is worse than the warning.
	//
	// `ageMs` travels with the lease so the line the user reads is the registry's
	// measurement rather than a second one taken here, which would disagree with
	// `/worktree list` by however long the decision took.
	return input.hasUI ? { kind: "prompt", lease, ageMs } : { kind: "warn", lease, ageMs };
}

/**
 * Who releases the lease this session holds.
 *
 * `delegated` means jimothy's own `finally` owns it and matches on this runId,
 * so the extension must leave it alone; if the launcher is dead by then, the
 * lease is left naming a dead pid and the dead-pid rule reclaims it.
 */
export function leaseProvenance(runId: string, launcherRunId: string | undefined): "delegated" | "ours" {
	return runId === launcherRunId ? "delegated" : "ours";
}

/**
 * Is this the same holder the decision was made about?
 *
 * Both halves matter and neither alone is enough: a run that released and
 * re-acquired keeps its runId under a new pid, and a pid that outlives one run
 * and starts another keeps its pid under a new runId. Displacing either on a
 * consent given about the other displaces a run nobody was shown.
 *
 * Here rather than at the call site because `decideLease` is meant to be the
 * only place a lease situation is classified, and a re-check before breaking a
 * lease is exactly that.
 */
export function sameHolder(a: WorktreeLease, b: WorktreeLease): boolean {
	return a.runId === b.runId && a.pid === b.pid;
}
