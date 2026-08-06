/**
 * PR status monitor.
 *
 * Keeps the branch's pull request in the status footer live: fetches it through
 * `gh`, polls at a cadence chosen by what it found, refreshes after a command
 * that may have created one, and suspends while the session is idle.
 *
 * Everything here used to live in index.ts, tangled with the command layer.
 * It is a factory over injected dependencies rather than a module over `pi` so
 * the state machine can be tested without a fake `pi`, the network, or a repo:
 * `runner` is the only way it reaches the outside world, and the clock is
 * injectable.
 *
 * The invariants that earlier defects came from, all still enforced below:
 *
 *  - **Single flight.** Overlapping triggers must not start two fetches; a
 *    request that arrives mid-fetch is remembered and re-run once, not dropped.
 *  - **Retirement.** The session can be *replaced* (`/new`, resume) while a fetch
 *    is in flight. One monitor belongs to one session and is disposed with it,
 *    and every await point rechecks that, so a superseded fetch paints nothing.
 *  - **Re-read the branch before the backoff.** The branch can change inside a
 *    live session, and that read is local git, unaffected by whatever is wrong
 *    with `gh`.
 *  - **Repaint when the displayed target moves**, or the previous branch's PR is
 *    left on screen, linked.
 */

import { git, type GitRunner } from "../lib/git.ts";
import { fetchNameWithOwner, fetchPr, type PrLookup } from "./gh.ts";
import {
	BASH_TRIGGER_DELAY_MS,
	BRANCH_READ_TIMEOUT_MS,
	formatPr,
	IDLE_SUSPEND_MS,
	matchesPrCommand,
	nextPollDelay,
	prState,
	STALE_MS,
} from "./pr.ts";

/** The worktree whose PR is displayed. */
export interface PrMonitorTarget {
	cwd: string;
	branch: string;
}

export interface PrMonitorDeps {
	/** Reaches git and gh. The only route to the outside world. */
	runner: GitRunner;
	/** The worktree whose PR should be shown, or undefined when there is none. */
	getTarget: () => PrMonitorTarget | undefined;
	/** Path of the displayed worktree, whose HEAD is re-read before fetching. */
	getHead: () => string | undefined;
	/**
	 * Write a re-read branch back to whichever object supplied `head`.
	 *
	 * The monitor does not own focus or repo state; it reports what it read and
	 * lets the caller decide where it belongs.
	 */
	setBranch: (head: string, branch: string | undefined) => void;
	/** Repaint the footer. Called only when the label could have changed. */
	paint: () => void;
	/** False in print, JSON, and headless runs: no footer means no polling. */
	hasUI: () => boolean;
	/** Injectable for tests. */
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface PrMonitor {
	/** Fetch the active target's PR in the background. Never awaited. */
	refresh: (force?: boolean) => void;
	/** User input: end idle suspension, refresh if stale, re-arm the poll. */
	onInput: () => void;
	/** A command ran; refresh shortly if it looks like it touched a PR. */
	onBashCommand: (command: unknown) => void;
	/** The formatted PR label for the active target, if one is cached. */
	label: () => string | undefined;
	/**
	 * Retire the monitor: cancel its timers and make everything still in flight
	 * inert. Idempotent, and there is no way back — the session it belonged to is
	 * gone, so a new session gets a new monitor.
	 */
	dispose: () => void;
}

export function createPrMonitor(deps: PrMonitorDeps): PrMonitor {
	const { runner, getTarget, getHead, setBranch, paint, hasUI } = deps;
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));

	/**
	 * Last lookup per `<cwd>\0<branch>`, so switching focus repaints instantly
	 * and only refreshes in the background.
	 */
	const cache = new Map<string, { fetchedAt: number; lookup: PrLookup }>();
	/** `owner/name` for the repo, fetched once per session. */
	let nameWithOwner: string | undefined;
	/** Cleared for the session when gh is missing, unauthenticated, or non-GitHub. */
	let available = true;
	/** Consecutive fetch failures, for backoff. */
	let errors = 0;
	/** Guard so overlapping triggers cannot start two fetches. */
	let fetching = false;
	/** Pending poll. Holds no ctx: a captured one is stale after session replacement. */
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Pending post-submit refresh. */
	let bashTimer: ReturnType<typeof setTimeout> | undefined;
	/** Last user input, for idle suspension. */
	let lastInputAt = now();
	/** When the last fetch attempt failed, for the input-path backoff. */
	let lastErrorAt: number | undefined;
	/** A refresh was requested while one was already in flight; re-run once done. */
	let pending = false;
	/** Whether the pending, dropped refresh above was forced. */
	let pendingForce = false;
	/**
	 * Set once, by dispose().
	 *
	 * A session can be replaced while a fetch is in flight. Rather than a
	 * generation counter compared after every await — which only worked because
	 * this closure was reused across sessions — the monitor belongs to one session
	 * and is retired with it. Every await point rechecks this, so a superseded
	 * fetch touches no shared state and paints nothing.
	 */
	let disposed = false;

	const key = (target: PrMonitorTarget) => `${target.cwd}\0${target.branch}`;

	const stopTimers = () => {
		if (timer) clearTimer(timer);
		if (bashTimer) clearTimer(bashTimer);
		timer = undefined;
		bashTimer = undefined;
	};

	const label = (): string | undefined => {
		if (disposed) return undefined;
		const target = getTarget();
		if (!target || !nameWithOwner) return undefined;
		const entry = cache.get(key(target));
		if (entry?.lookup.status !== "pr") return undefined;
		return formatPr(entry.lookup.pr, nameWithOwner);
	};

	/**
	 * Arm the next poll, cadence chosen by what the last fetch found.
	 *
	 * A self-rescheduling timeout rather than an interval: the delay depends on
	 * the result just fetched. Sleeping sessions stop polling entirely — the
	 * next `onInput` refreshes and re-arms.
	 */
	const schedulePoll = () => {
		// Mirrors refresh: no footer to keep live means no reason to keep polling.
		if (!hasUI()) return;
		if (timer) clearTimer(timer);
		timer = undefined;
		if (!available || now() - lastInputAt > IDLE_SUSPEND_MS) return;

		const target = getTarget();
		if (!target) return;

		const cached = cache.get(key(target));
		const delay =
			errors > 0
				? nextPollDelay({ status: "error", consecutiveErrors: errors })
				: cached?.lookup.status === "pr"
					? nextPollDelay({ status: "pr", state: prState(cached.lookup.pr) })
					: nextPollDelay({ status: "none" });
		if (delay === undefined) return;

		timer = setTimer(() => {
			timer = undefined;
			refresh(true);
		}, delay);
		// Do not hold the process open for a status decoration.
		timer.unref?.();
	};

	const refresh = (force = false): void => {
		// Print, JSON, and headless runs have no footer to paint into; never spawn
		// gh for output that can never render.
		if (disposed) return;
		if (!hasUI()) return;
		if (!available) return;

		if (fetching) {
			// The request is not lost: re-run once the in-flight fetch settles.
			pending = true;
			pendingForce = pendingForce || force;
			return;
		}

		fetching = true;
		void (async () => {
			try {
				// The branch can change inside a live session (`git switch`, `gt submit`
				// on a new branch); re-read it rather than trust the one-shot value from
				// session start (or from when focus was set), so getTarget() below sees
				// the current branch. Read the *displayed* worktree: while focused, the
				// session's own branch is not what the footer shows.
				const previous = getTarget();
				const previousKey = previous ? key(previous) : undefined;
				const head = getHead();
				if (head) {
					const symbolicRef = await git(runner, ["symbolic-ref", "--quiet", "--short", "HEAD"], head, {
						timeout: BRANCH_READ_TIMEOUT_MS,
					});
					// The session may have been replaced while that git call ran.
					if (disposed) return;
					const branch =
						symbolicRef.code === 0 && symbolicRef.stdout.trim() ? symbolicRef.stdout.trim() : undefined;
					// The same worktree with a different HEAD is not a focus change: no
					// setFocus, no entry, no message. The caller decides where this goes.
					setBranch(head, branch);

					// The only other repaint is on the success path below, so both early
					// returns that follow would otherwise leave the previous branch's PR
					// on screen, linked. Repaint from cache the moment the target moves;
					// the caller renders no PR when the new target has no cached entry, so
					// a detached HEAD clears the label instead of stranding it.
					const moved = getTarget();
					if ((moved ? key(moved) : undefined) !== previousKey) paint();
				}

				// During a gh outage, every submitted message would otherwise spawn
				// another gh call (up to 10s, serialized). Bypassed by a forced refresh
				// (poll timer, bash trigger). Deliberately *after* the branch re-read
				// above: that read is local git and unaffected by whatever is wrong with
				// gh, and gating it would leave a `git switch` showing the old branch's
				// PR — linked — for the length of the backoff.
				if (!force && errors > 0 && lastErrorAt !== undefined) {
					const backoff = nextPollDelay({ status: "error", consecutiveErrors: errors });
					if (backoff !== undefined && now() - lastErrorAt < backoff) return;
				}

				const target = getTarget();
				if (!target) return;

				const targetKey = key(target);
				const cached = cache.get(targetKey);
				if (!force && cached && now() - cached.fetchedAt < STALE_MS) return;

				if (!nameWithOwner) {
					const lookup = await fetchNameWithOwner(runner, target.cwd);
					// The session may have been replaced — possibly into another repo.
					// Writing nameWithOwner now would link every later PR to the wrong one.
					if (disposed) return;
					if (lookup.status === "unavailable") {
						available = false;
						return;
					}
					if (lookup.status === "error") {
						errors += 1;
						lastErrorAt = now();
						return;
					}
					nameWithOwner = lookup.nameWithOwner;
				}

				const lookup = await fetchPr(runner, target.branch, target.cwd);
				if (disposed) return;
				if (lookup.status === "unavailable") {
					available = false;
					return;
				}
				if (lookup.status === "error") {
					errors += 1;
					lastErrorAt = now();
					return;
				}

				errors = 0;
				lastErrorAt = undefined;
				cache.set(targetKey, { fetchedAt: now(), lookup });

				// The target may have moved while gh was running; only paint if not.
				const current = getTarget();
				if (current && key(current) === targetKey) paint();
			} finally {
				if (!disposed) {
					fetching = false;
					schedulePoll();
					if (pending) {
						const force = pendingForce;
						pending = false;
						pendingForce = false;
						refresh(force);
					}
				}
			}
		})();
	};

	const onInput = () => {
		if (disposed) return;
		lastInputAt = now();
		refresh();
		if (!timer) schedulePoll();
	};

	/**
	 * Refresh shortly after a command that may have created or moved a PR.
	 *
	 * Delayed because GitHub needs a moment to create the PR and register its
	 * checks.
	 */
	const onBashCommand = (command: unknown) => {
		if (disposed) return;
		if (typeof command !== "string" || !matchesPrCommand(command)) return;
		if (bashTimer) clearTimer(bashTimer);
		bashTimer = setTimer(() => {
			bashTimer = undefined;
			refresh(true);
		}, BASH_TRIGGER_DELAY_MS);
		bashTimer.unref?.();
	};

	const dispose = () => {
		// Order does not matter here, which is the point: there is no "reset the
		// state but forget to cancel the timers" hazard left to get wrong.
		disposed = true;
		stopTimers();
		cache.clear();
	};

	return { refresh, onInput, onBashCommand, label, dispose };
}
