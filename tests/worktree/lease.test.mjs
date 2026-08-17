/**
 * The lease decision, as a table.
 *
 * The spec's handoff protocol is a seven-row table, and this is that table with
 * assertions. Two rows carry the whole design: a launcher's lease is recognised
 * only when the owner is literally our parent process, and a lease is released
 * by whoever the runId says will release it — never by how it was obtained.
 *
 * Pure, so a situation is constructed rather than raced. The racing tests live
 * in restore.test.mjs, where a real registry and a real session exist.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { captureLauncherEnv, decideLease, forgetLauncherEnv, leaseProvenance, readLauncherEnv, sameHolder } =
	await loadExt("worktree/lease.ts");

const record = { id: "r1", name: "alpha", path: "/wt/alpha", branch: "jimothy/alpha", baseCommit: "a1" };
const lease = (over = {}) => ({ runId: "run-1", pid: 4242, since: "2026-08-14T12:00:00.000Z", ...over });
const free = { state: "free" };
const stale = (l = lease()) => ({ state: "stale", lease: l });
const held = (l = lease()) => ({ state: "held", lease: l, ageMs: 1000 });
const base = { record, state: free, launcherRunId: undefined, pid: 100, ppid: 50, hasUI: true };

// --- not managed ---------------------------------------------------------
ok("no record means nothing to lease", decideLease({ ...base, record: undefined }).kind === "unmanaged");
ok(
	"even when something claims to hold it",
	decideLease({ ...base, record: undefined, state: held() }).kind === "unmanaged",
);

// --- free and stale ------------------------------------------------------
ok("a free lease is acquired", decideLease(base).kind === "acquire");
ok("so is a stale one — the dead-pid rule is the registry's", decideLease({ ...base, state: stale() }).kind === "acquire");

// --- our own lease, from a previous session in this process --------------
{
	const decision = decideLease({ ...base, state: held(lease({ pid: 100 })) });
	ok("a lease under our own pid is adopted", decision.kind === "adopt");
	ok("and keeps the runId it already has", decision.runId === "run-1");
}

// --- the launcher's lease ------------------------------------------------
{
	const decision = decideLease({
		...base,
		state: held(lease({ runId: "launch-1", pid: 50 })),
		launcherRunId: "launch-1",
	});
	ok("the launcher's lease is retargeted", decision.kind === "retarget");
	ok("keeping the launcher's runId", decision.runId === "launch-1");
	ok("and naming the pid it is moving from", decision.fromPid === 50);
}
{
	// The variable was inherited, not earned: a subagent has pi as its parent.
	const decision = decideLease({
		...base,
		state: held(lease({ runId: "launch-1", pid: 4242 })),
		launcherRunId: "launch-1",
		ppid: 100,
	});
	ok("a matching runId whose owner is not our parent is not ours to retarget", decision.kind === "prompt");
}
{
	const decision = decideLease({
		...base,
		state: held(lease({ runId: "someone-else", pid: 50 })),
		launcherRunId: "launch-1",
	});
	ok("our parent holding a different run's lease is still a stranger", decision.kind === "prompt");
}

// --- a live stranger -----------------------------------------------------
{
	const decision = decideLease({ ...base, state: held() });
	ok("with a UI, ask", decision.kind === "prompt");
	ok("and hand over what holds it, so the prompt can say", decision.lease.runId === "run-1");
	// Carried rather than recomputed: the age the user is shown must be the one
	// the registry measured, and `describeLease` needs it.
	ok("and how long it has held it", decision.ageMs === 1000);
}
ok("without a UI, warn and continue", decideLease({ ...base, state: held(), hasUI: false }).kind === "warn");
ok(
	"a subagent in its parent's worktree warns rather than prompting",
	decideLease({ ...base, state: held(), hasUI: false, launcherRunId: "launch-1" }).kind === "warn",
);

// --- provenance ----------------------------------------------------------
ok("the launcher's runId is delegated", leaseProvenance("launch-1", "launch-1") === "delegated");
ok("our own is ours", leaseProvenance("pi-session-1", "launch-1") === "ours");
ok("with no launcher, everything is ours", leaseProvenance("pi-session-1", undefined) === "ours");
// The case a how-it-was-obtained rule gets wrong: a hand-launched pi that
// reloads adopts its own lease, and must still release it on the way out.
ok("an adopted lease with no launcher is still ours", leaseProvenance("pi-session-1", undefined) === "ours");

// --- the same holder, or another one --------------------------------------
//
// Consent to take a worktree over names a holder, and is worth nothing about
// any other. Both halves of the identity are needed: a run that released and
// re-acquired keeps its runId under a new pid, and a pid that finished one run
// and started another keeps its pid under a new runId.
ok("the same run under the same pid is the same holder", sameHolder(lease(), lease()) === true);
ok("even if it has held it longer", sameHolder(lease(), lease({ since: "2026-08-14T13:00:00.000Z" })) === true);
ok("the same run under a different pid is not", sameHolder(lease(), lease({ pid: 99 })) === false);
ok("nor a different run under the same pid", sameHolder(lease(), lease({ runId: "run-2" })) === false);
ok("nor anything else", sameHolder(lease(), lease({ runId: "run-2", pid: 99 })) === false);

// --- the launcher environment, which is read once and scrubbed -----------
{
	const env = { JIMOTHY_RUN_ID: "launch-1", JIMOTHY_WORKTREE: "/wt/alpha", PATH: "/usr/bin" };
	const launcher = readLauncherEnv(env);
	ok("reads the run id", launcher.runId === "launch-1");
	ok("reads the worktree it leased", launcher.worktree === "/wt/alpha");
	ok("deletes the run id", "JIMOTHY_RUN_ID" in env === false);
	ok("deletes the worktree", "JIMOTHY_WORKTREE" in env === false);
	ok("leaves everything else alone", env.PATH === "/usr/bin");
}
{
	const env = { JIMOTHY_RUN_ID: "launch-1" };
	const launcher = readLauncherEnv(env);
	ok("a run id without a worktree is still a launcher", launcher.runId === "launch-1");
	ok("with no worktree", launcher.worktree === undefined);
}
{
	// A worktree with no run id cannot be acted on — and must still be scrubbed,
	// or a child would inherit it.
	const env = { JIMOTHY_WORKTREE: "/wt/alpha" };
	ok("a worktree alone is not a launcher", readLauncherEnv(env) === undefined);
	ok("and is scrubbed anyway", "JIMOTHY_WORKTREE" in env === false);
}
ok("an ordinary environment has no launcher", readLauncherEnv({ PATH: "/usr/bin" }) === undefined);

// --- the launcher, remembered for the life of the process ----------------
//
// A session replacement rebuilds the extension closure, and `/reload` re-imports
// the module as well, so the second session's read finds an environment the
// first one already scrubbed. Remembering the answer per process is what keeps a
// delegated lease delegated across one — restore.test.mjs drives that end to end.
{
	forgetLauncherEnv();
	const first = { JIMOTHY_RUN_ID: "launch-1", JIMOTHY_WORKTREE: "/wt/alpha" };
	ok("the first read captures what the launcher said", captureLauncherEnv(first)?.runId === "launch-1");
	ok("and scrubs it", "JIMOTHY_RUN_ID" in first === false);
	ok("a later read of an empty environment still knows it", captureLauncherEnv({})?.runId === "launch-1");
	const reappeared = { JIMOTHY_RUN_ID: "inherited", JIMOTHY_WORKTREE: "/wt/beta" };
	ok("a variable that reappears does not change its mind", captureLauncherEnv(reappeared)?.runId === "launch-1");
	ok("and is scrubbed anyway, so no child inherits it", "JIMOTHY_RUN_ID" in reappeared === false);
	ok("both of them", "JIMOTHY_WORKTREE" in reappeared === false);
	forgetLauncherEnv();
	ok("forgetting is what lets a test file be many processes", captureLauncherEnv({}) === undefined);
}

done();
