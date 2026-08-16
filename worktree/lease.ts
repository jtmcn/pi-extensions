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
