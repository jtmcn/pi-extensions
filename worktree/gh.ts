/**
 * The `gh` calls behind the PR status display.
 *
 * Kept out of `index.ts` so the failure classification is testable with a fake
 * runner, and out of `pr.ts` so that module stays pure. Takes the same
 * `GitRunner` interface `lib/git.ts` defines — it is just "something that can
 * run a command".
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../lib/git.ts";
import { type PullRequest, selectPr } from "./pr.ts";

/** Cap on a single gh call. Measured cost is ~0.5s; this is a stuck-network guard. */
export const GH_TIMEOUT_MS = 10_000;

/** The `--json` fields the display reads. */
const PR_FIELDS = "number,state,isDraft,url,statusCheckRollup";

/**
 * How many of a branch's PRs to fetch.
 *
 * A reused branch accumulates closed PRs; the display only needs enough of them
 * to pick the right one (see `selectPr`), not the whole history.
 */
const PR_LIST_LIMIT = 10;

/**
 * Outcome of a PR lookup.
 *
 * `unavailable` is terminal for the session — no `gh`, not authenticated, not
 * a GitHub remote — and switches the whole feature off. `error` is transient
 * and retried with backoff.
 */
export type PrLookup =
	| { status: "pr"; pr: PullRequest }
	| { status: "none" }
	| { status: "error" }
	| { status: "unavailable" };

/** Outcome of a repo lookup, classified the same way. */
export type RepoLookup =
	| { status: "repo"; nameWithOwner: string }
	| { status: "error" }
	| { status: "unavailable" };

/** Substrings in gh's stderr that mean "never going to work here". */
const UNAVAILABLE_PATTERNS = [
	"gh auth login",
	"authentication required",
	"not logged into",
	"known github host",
	"could not determine",
];

/**
 * The repo's `owner/name`, classified like a PR lookup. Cache the success.
 *
 * A bare "missing" answer would be indistinguishable between a transient blip
 * and "this is not a GitHub repo" — and since the caller disables the whole
 * feature on a terminal answer, one blip would kill it for the session.
 */
export async function fetchNameWithOwner(runner: GitRunner, cwd: string): Promise<RepoLookup> {
	const result = await run(runner, ["repo", "view", "--json", "nameWithOwner"], cwd);
	// Only a runner that throws yields undefined; pi's own exec never does.
	if (!result) return { status: "unavailable" };
	const failure = classifyFailure(result);
	if (failure) return failure;

	try {
		const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string };
		return parsed.nameWithOwner ? { status: "repo", nameWithOwner: parsed.nameWithOwner } : { status: "error" };
	} catch {
		return { status: "error" };
	}
}

/**
 * Look up the PR for `branch`, classifying every failure mode.
 *
 * `pr list --head` rather than `pr view <branch>`: `pr view`'s argument is
 * `<number> | <url> | <branch>`, resolved number-first, so a branch literally
 * named `1234` would display and link PR #1234 instead. `--state all` is
 * needed for merged and closed PRs to appear at all, and makes "no PR" an
 * empty array with exit 0 rather than a stderr message.
 */
export async function fetchPr(runner: GitRunner, branch: string, cwd: string): Promise<PrLookup> {
	const result = await run(
		runner,
		["pr", "list", "--head", branch, "--state", "all", "--limit", String(PR_LIST_LIMIT), "--json", PR_FIELDS],
		cwd,
	);
	if (!result) return { status: "unavailable" };
	const failure = classifyFailure(result);
	if (failure) return failure;

	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (!Array.isArray(parsed)) return { status: "error" };
		const pr = selectPr(parsed as PullRequest[]);
		// A non-empty list that yielded nothing usable is a malformed payload, not
		// an answer: retry rather than report "no PR".
		if (!pr) return parsed.length === 0 ? { status: "none" } : { status: "error" };
		return { status: "pr", pr };
	} catch {
		return { status: "error" };
	}
}

/**
 * Classify a failed gh call, or `undefined` when the call succeeded and its
 * `stdout` is worth parsing. Shared by both lookups, which fail identically.
 */
function classifyFailure(result: ExecResult): { status: "error" | "unavailable" } | undefined {
	// A timed-out or aborted call resolves as exit 0 with whatever had been
	// flushed so far. A truncated payload usually fails to parse, but "usually"
	// is not a classification — reject it explicitly.
	if (result.killed) return { status: "error" };

	if (result.code !== 0) {
		const stderr = result.stderr.toLowerCase();
		if (UNAVAILABLE_PATTERNS.some((pattern) => stderr.includes(pattern))) return { status: "unavailable" };
		// pi's exec resolves an unspawnable binary as exit 1 with both streams
		// empty rather than throwing, so this — not a caught throw — is how a
		// missing gh actually arrives. A gh that ran always says something.
		if (!result.stderr.trim() && !result.stdout.trim()) return { status: "unavailable" };
		return { status: "error" };
	}

	return undefined;
}

/** Run gh, converting a spawn throw into `undefined`. */
async function run(runner: GitRunner, args: string[], cwd: string): Promise<ExecResult | undefined> {
	try {
		return await runner.exec("gh", args, { cwd, timeout: GH_TIMEOUT_MS });
	} catch {
		return undefined;
	}
}
