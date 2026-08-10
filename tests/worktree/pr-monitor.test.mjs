/**
 * Tests for the PR status monitor (worktree/pr-monitor.ts).
 *
 *   cd tests && npm install && node worktree/pr-monitor.test.mjs
 *
 * The monitor is the state machine every defect in the PR feature came from:
 * single flight, the pending re-run, error backoff, idle suspension, the branch
 * re-read and its write-back, and the guard that makes a superseded fetch inert.
 *
 * No fake `pi`, no repo, no network, no real clock. The monitor reaches the
 * outside world only through the injected runner, and its timers and `now()` are
 * injected too, so every one of those paths is directly reachable here — which
 * is the reason the module was extracted in the first place.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createPrMonitor } = await loadExt("worktree/pr-monitor.ts");
const { IDLE_SUSPEND_MS, STALE_MS, BASH_TRIGGER_DELAY_MS, ERROR_BACKOFF_MS } = await loadExt("worktree/pr.ts");

const PR = {
	number: 7,
	state: "OPEN",
	isDraft: false,
	url: "https://github.com/o/r/pull/7",
	statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
};

/**
 * A monitor wired to controllable everything.
 *
 * `gh` answers come from the `gh` option (a function of the argv), git's
 * symbolic-ref from `branch`. Timers are collected rather than armed, so a test
 * can fire them deliberately.
 */
function setup(options = {}) {
	const calls = [];
	const timers = [];
	const state = {
		branch: options.branch ?? "feature/one",
		target: options.target ?? { cwd: "/repo", branch: "feature/one" },
		head: options.head ?? "/repo",
		hasUI: options.hasUI ?? true,
		time: 1_000_000,
		paints: 0,
		branchWrites: [],
	};

	const gh = options.gh ?? (() => ({ code: 0, stdout: JSON.stringify([PR]), stderr: "", killed: false }));
	const repoView = options.repoView ?? (() => ({ code: 0, stdout: '{"nameWithOwner":"o/r"}', stderr: "", killed: false }));

	const monitor = createPrMonitor({
		runner: {
			async exec(command, args, opts) {
				calls.push({ command, args, opts });
				if (command === "git") {
					return { code: 0, stdout: `${state.branch}\n`, stderr: "", killed: false };
				}
				if (command === "gh" && args[0] === "repo") return await repoView(args);
				if (command === "gh" && args[0] === "pr") return await gh(args);
				throw new Error(`unexpected command ${command}`);
			},
		},
		getTarget: () => state.target,
		getHead: () => state.head,
		setBranch: (head, branch) => {
			state.branchWrites.push({ head, branch });
			// The real caller writes the re-read branch back into the object getTarget()
			// reads, which is what makes a `git switch` look like a moved target. Opt-in,
			// because most tests here drive the target by hand instead.
			if (options.writeBack) state.target = branch ? { cwd: head, branch } : undefined;
		},
		paint: () => {
			state.paints++;
		},
		hasUI: () => state.hasUI,
		now: () => state.time,
		setTimer: (fn, ms) => {
			const handle = { fn, ms, cancelled: false };
			timers.push(handle);
			return handle;
		},
		clearTimer: (handle) => {
			handle.cancelled = true;
		},
	});

	const ghCalls = () => calls.filter((c) => c.command === "gh");
	const prCalls = () => calls.filter((c) => c.command === "gh" && c.args[0] === "pr");
	const live = () => timers.filter((t) => !t.cancelled);
	// The monitor's fetch is deliberately not awaitable (a session must never wait
	// on the network), so drain the microtask queue instead.
	const settle = async () => {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	};
	return { monitor, state, calls, ghCalls, prCalls, timers, live, settle };
}

// ===================================================== the happy path

{
	const h = setup();
	h.monitor.refresh();
	await h.settle();
	ok("fetches the repo then the PR", h.ghCalls().length === 2 && h.ghCalls()[0].args[0] === "repo");
	ok("labels the cached PR", h.monitor.label()?.includes("#7"), h.monitor.label());
	ok("paints on success", h.state.paints >= 1);
	ok("re-reads HEAD before fetching", h.calls[0].command === "git");
	ok("writes the re-read branch back", h.state.branchWrites[0]?.branch === "feature/one");
	ok("arms a poll afterwards", h.live().length === 1);
}

// ===================================================== no UI, no work

{
	const h = setup({ hasUI: false });
	h.monitor.refresh();
	await h.settle();
	ok("no UI: nothing is fetched", h.calls.length === 0);
	ok("no UI: no label", h.monitor.label() === undefined);
	ok("no UI: no timer armed", h.live().length === 0);
}

// ===================================================== single flight

{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const h = setup({
		gh: async () => {
			await gate;
			return { code: 0, stdout: JSON.stringify([PR]), stderr: "", killed: false };
		},
	});

	h.monitor.refresh();
	await h.settle();
	const during = h.prCalls().length;
	// Forced, so the re-run cannot be short-circuited by the cache entry the
	// in-flight fetch is about to write — otherwise "it re-ran" and "it was dropped"
	// look identical from out here, and a test that cannot tell them apart is not a
	// test. (Confirmed by mutation: deleting the re-run must fail this.)
	h.monitor.refresh(true);
	h.monitor.refresh(true);
	await h.settle();
	ok("a second refresh does not start a second fetch", h.prCalls().length === during && during === 1);

	release();
	await h.settle();
	ok(
		"the two dropped requests collapse into exactly one re-run",
		h.prCalls().length === 2,
		`${h.prCalls().length} pr calls`,
	);
	// Every settled fetch re-arms the poll, so a re-run that fails to clear the
	// pending flag spins: refresh → early return → finally → refresh, burning CPU
	// behind a status decoration. The gh call count cannot see it (those refreshes
	// short-circuit before gh); the timer churn can.
	ok("settling leaves the monitor idle, not rescheduling itself", h.timers.length <= 4, `${h.timers.length} timers armed`);
}

// ===================================================== staleness and force

{
	const h = setup();
	h.monitor.refresh();
	await h.settle();
	ok("first fetch happened", h.prCalls().length === 1);

	h.monitor.refresh();
	await h.settle();
	ok("a fresh cache entry is not refetched", h.prCalls().length === 1);

	h.monitor.refresh(true);
	await h.settle();
	ok("a forced refresh bypasses the cache", h.prCalls().length === 2);

	h.state.time += STALE_MS + 1;
	h.monitor.refresh();
	await h.settle();
	ok("a stale entry is refetched", h.prCalls().length === 3);
}

// ===================================================== error backoff

{
	const h = setup({ gh: () => ({ code: 1, stdout: "", stderr: "api.github.com: no such host\n", killed: false }) });
	h.monitor.refresh();
	await h.settle();
	ok("an error is recorded, not cached as an answer", h.monitor.label() === undefined);
	const afterFirst = h.prCalls().length;

	h.monitor.refresh();
	await h.settle();
	ok("an unforced refresh inside the backoff does not call gh", h.prCalls().length === afterFirst);

	h.monitor.refresh(true);
	await h.settle();
	ok("a forced refresh bypasses the backoff", h.prCalls().length === afterFirst + 1);

	h.state.time += ERROR_BACKOFF_MS[ERROR_BACKOFF_MS.length - 1] + 1;
	h.monitor.refresh();
	await h.settle();
	ok("past the backoff an unforced refresh runs again", h.prCalls().length === afterFirst + 2);
}

// the branch re-read must survive the backoff: it is local git, and gating it
// would strand the previous branch's PR on screen for the whole backoff.
{
	const h = setup({ gh: () => ({ code: 1, stdout: "", stderr: "api.github.com: no such host\n", killed: false }) });
	h.monitor.refresh();
	await h.settle();
	const writes = h.state.branchWrites.length;
	h.state.branch = "feature/two";
	h.monitor.refresh();
	await h.settle();
	ok("HEAD is re-read even while backing off", h.state.branchWrites.length === writes + 1);
	ok("and the new branch is reported", h.state.branchWrites.at(-1)?.branch === "feature/two");
}

// ===================================================== gh unavailable

{
	const h = setup({ repoView: () => ({ code: 1, stdout: "", stderr: "", killed: false }) });
	h.monitor.refresh();
	await h.settle();
	const after = h.ghCalls().length;
	ok("an unavailable gh is detected", after === 1);

	h.monitor.refresh(true);
	await h.settle();
	ok("the feature stays off for the session", h.ghCalls().length === after);
	ok("and no poll is armed", h.live().length === 0);
}

// The branch re-read must survive gh being switched off entirely, not just the
// backoff. Such a session arms no poll either, so input is the only thing left
// that notices a `git switch` — and the branch on screen is also what is
// reported to herdr, which would otherwise name the old branch forever.
{
	const h = setup({
		writeBack: true,
		repoView: () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	});
	h.monitor.refresh();
	await h.settle();
	const writes = h.state.branchWrites.length;
	const paints = h.state.paints;
	const ghBefore = h.ghCalls().length;

	h.state.branch = "feature/two";
	h.monitor.onInput();
	await h.settle();
	ok("gh off: HEAD is still re-read", h.state.branchWrites.length === writes + 1, `${h.state.branchWrites.length} writes`);
	ok("gh off: the new branch is written back", h.state.branchWrites.at(-1)?.branch === "feature/two");
	ok("gh off: the moved target repaints", h.state.paints > paints, `${h.state.paints} vs ${paints}`);
	ok("gh off: gh is not called again", h.ghCalls().length === ghBefore, `${h.ghCalls().length} vs ${ghBefore}`);
	ok("gh off: still no poll armed", h.live().length === 0, `${h.live().length} timers`);
}

// ===================================================== target movement

{
	// feature/one has a PR; feature/two does not. The label must follow the target
	// rather than stranding the old branch's PR on screen, linked.
	const h = setup({
		gh: (args) => ({
			code: 0,
			stdout: JSON.stringify(args[3] === "feature/one" ? [PR] : []),
			stderr: "",
			killed: false,
		}),
	});
	h.monitor.refresh();
	await h.settle();
	ok("the branch with a PR is labelled", h.monitor.label()?.includes("#7"), h.monitor.label());
	const paintsBefore = h.state.paints;

	h.state.branch = "feature/two";
	h.state.target = { cwd: "/repo", branch: "feature/two" };
	h.monitor.refresh();
	await h.settle();
	ok("a moved target repaints", h.state.paints > paintsBefore);
	ok("the old branch's PR is not shown for the new one", h.monitor.label() === undefined, h.monitor.label());
}

{
	// Target moves *while* gh is in flight: the result belongs to nobody on screen.
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const h = setup({
		gh: async () => {
			await gate;
			return { code: 0, stdout: JSON.stringify([PR]), stderr: "", killed: false };
		},
	});
	h.monitor.refresh();
	await h.settle();
	const paintsBefore = h.state.paints;
	h.state.target = { cwd: "/elsewhere", branch: "other" };
	release();
	await h.settle();
	ok("a result for a target that moved away does not paint", h.state.paints === paintsBefore);
}

// ============================================ disposal makes a fetch inert

{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const h = setup({
		gh: async () => {
			await gate;
			return { code: 0, stdout: JSON.stringify([PR]), stderr: "", killed: false };
		},
	});
	h.monitor.refresh();
	await h.settle();
	const paintsBefore = h.state.paints;

	// The session was replaced mid-fetch: this monitor belonged to it and is done.
	h.monitor.dispose();
	release();
	await h.settle();
	ok("a superseded fetch does not paint", h.state.paints === paintsBefore);
	ok("a superseded fetch caches nothing", h.monitor.label() === undefined);
	ok("disposal cancels pending timers", h.live().length === 0);
}

{
	// The difference from a generation counter: a disposed monitor is not a monitor
	// waiting to be reused. Nothing can restart it — not a caller, not a timer that
	// already escaped, not the pending re-run of a fetch that was in flight.
	const h = setup();
	h.monitor.dispose();
	h.monitor.refresh(true);
	h.monitor.onInput();
	h.monitor.onBashCommand("gh pr create --fill");
	await h.settle();
	ok("a disposed monitor runs nothing", h.calls.length === 0, `${h.calls.length} calls`);
	ok("a disposed monitor arms nothing", h.live().length === 0);
	ok("a disposed monitor reports no label", h.monitor.label() === undefined);
}

{
	// A poll timer that was already armed when the session was replaced: firing it
	// must not resurrect the monitor.
	const h = setup();
	h.monitor.refresh();
	await h.settle();
	const armed = h.live()[0];
	ok("a poll was armed", armed !== undefined);

	const callsBefore = h.calls.length;
	h.monitor.dispose();
	armed.fn();
	await h.settle();
	ok("an escaped timer cannot revive a disposed monitor", h.calls.length === callsBefore);
}

// ===================================================== idle suspension

{
	const h = setup();
	h.monitor.refresh();
	await h.settle();
	ok("a poll is armed while active", h.live().length === 1);

	h.state.time += IDLE_SUSPEND_MS + 1;
	h.monitor.refresh(true);
	await h.settle();
	ok("an idle session stops polling", h.live().length === 0);

	h.monitor.onInput();
	await h.settle();
	ok("input ends idle suspension and re-arms", h.live().length === 1);
}

// ===================================================== bash triggers

{
	const h = setup();
	h.monitor.onBashCommand("gh pr create --fill");
	ok("a submit command arms a delayed refresh", h.live().length === 1);
	ok("with the documented delay", h.live()[0].ms === BASH_TRIGGER_DELAY_MS);

	const armed = h.live()[0];
	h.monitor.onBashCommand("gh pr create --fill");
	ok("a second trigger replaces the first", armed.cancelled === true && h.live().length === 1);

	h.live()[0].fn();
	await h.settle();
	ok("firing the trigger fetches", h.prCalls().length === 1);
}

{
	const h = setup();
	h.monitor.onBashCommand("ls -la");
	ok("an unrelated command arms nothing", h.live().length === 0);
	h.monitor.onBashCommand(undefined);
	ok("a non-string command is ignored", h.live().length === 0);
}

done();
