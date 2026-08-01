/**
 * Pull-request display for the worktree status segment.
 *
 * Pure and I/O-free, like `focus.ts` and `select.ts`: everything here is a
 * function of a `gh` JSON payload, so it can be tested without a network, a
 * repo, or pi. The subprocess calls live in `gh.ts`, the wiring in `index.ts`.
 */

/** PR state as displayed. `draft` is a display-only refinement of OPEN. */
export type PrState = "open" | "draft" | "merged" | "closed";

/**
 * One entry of `gh pr view --json statusCheckRollup`.
 *
 * The array is heterogeneous: GitHub Actions produce `CheckRun` objects
 * (`status` + `conclusion`), while external reporters like Buildkite produce
 * `StatusContext` objects (`state`). There is no server-side rollup field in
 * this payload, so the glyph has to be reduced client-side.
 */
export interface RollupEntry {
	__typename?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

/** The subset of `gh pr view --json …` this module reads. */
export interface PullRequest {
	number: number;
	state: string;
	isDraft: boolean;
	url: string;
	statusCheckRollup?: RollupEntry[] | null;
}

const FAILED_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PASSED_STATES = new Set(["SUCCESS", "EXPECTED"]);

export const GLYPH_PASS = "✓";
export const GLYPH_FAIL = "✗";
export const GLYPH_PENDING = "●";

/** Display label for a PR's state. Draft only applies while the PR is open. */
export function prState(pr: PullRequest): PrState {
	const state = pr.state.toUpperCase();
	if (state === "OPEN") return pr.isDraft ? "draft" : "open";
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "closed";
	return "open";
}

/**
 * Reduce a mixed check array to one glyph.
 *
 * Failure dominates pending, which dominates pass. Anything unrecognised
 * counts as pending rather than passing: a green tick is the one answer that
 * must never be a guess.
 */
export function rollupGlyph(entries: RollupEntry[] | null | undefined): string | undefined {
	if (!entries || entries.length === 0) return undefined;

	let pending = false;
	for (const entry of entries) {
		const conclusion = entry.conclusion?.toUpperCase() ?? "";
		const state = entry.state?.toUpperCase() ?? "";
		if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) return GLYPH_FAIL;
		if (PASSED_CONCLUSIONS.has(conclusion) || PASSED_STATES.has(state)) continue;
		pending = true;
	}
	return pending ? GLYPH_PENDING : GLYPH_PASS;
}

/**
 * Graphite's PR page for a GitHub PR.
 *
 * `app.graphite.com` is the host Graphite's own mergeability check reports in
 * its `detailsUrl`; `app.graphite.dev` merely redirects there.
 */
export function graphiteUrl(nameWithOwner: string, number: number): string {
	return `https://app.graphite.com/github/pr/${nameWithOwner}/${number}`;
}

/**
 * Wrap text in an OSC 8 hyperlink.
 *
 * pi's footer tolerates this: `visibleWidth()` scores the escape as zero,
 * `truncateToWidth()` preserves it, and the footer's sanitiser strips only
 * `\r\n\t`. The TUI emits an OSC 8 reset per line, so the link cannot leak.
 */
export function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** The footer label for a PR: `#26904 open ●`, linked to Graphite. */
export function formatPr(pr: PullRequest, nameWithOwner: string): string {
	const glyph = rollupGlyph(pr.statusCheckRollup);
	const label = `#${pr.number} ${prState(pr)}${glyph ? ` ${glyph}` : ""}`;
	return hyperlink(graphiteUrl(nameWithOwner, pr.number), label);
}

// ---- Poll cadence ----------------------------------------------------------

/** Cadence while a PR is open or draft: CI moves on roughly this timescale. */
export const POLL_OPEN_MS = 60_000;
/** Cadence with no PR on the branch, so a freshly created one still appears. */
export const POLL_NO_PR_MS = 300_000;
/** Backoff after consecutive fetch errors, indexed by error count. */
export const ERROR_BACKOFF_MS = [60_000, 120_000, 300_000];
/** No user input for this long suspends polling until the next input. */
export const IDLE_SUSPEND_MS = 900_000;
/** Delay after a submitting command, giving GitHub time to create the PR. */
export const BASH_TRIGGER_DELAY_MS = 8_000;
/** A cached entry older than this is repainted, then refreshed in background. */
export const STALE_MS = 60_000;

export type PollStatus = "pr" | "none" | "error";

export interface PollInput {
	status: PollStatus;
	/** Present when `status` is "pr". */
	state?: PrState;
	/** Consecutive failures so far, including the one that just happened. */
	consecutiveErrors?: number;
}

/**
 * Milliseconds until the next fetch, or `undefined` to stop polling.
 *
 * Merged and closed are terminal: nothing about them changes again, so the
 * timer stops until a branch or focus change revives it.
 */
export function nextPollDelay(input: PollInput): number | undefined {
	if (input.status === "error") {
		const index = Math.min(Math.max(input.consecutiveErrors ?? 1, 1), ERROR_BACKOFF_MS.length) - 1;
		return ERROR_BACKOFF_MS[index];
	}
	if (input.status === "none") return POLL_NO_PR_MS;
	return input.state === "open" || input.state === "draft" ? POLL_OPEN_MS : undefined;
}

/**
 * True for commands that plausibly create a PR or move its head.
 *
 * A heuristic on command text, deliberately: a miss only means the display
 * waits for the normal cadence. `\b` on the trailing word keeps `git pushed`
 * and `echo pushing` from matching.
 */
export function matchesPrCommand(command: string): boolean {
	return /\b(?:gt\s+submit|gh\s+pr\s+create|git\s+push)\b/.test(command);
}
