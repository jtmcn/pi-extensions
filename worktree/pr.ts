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
