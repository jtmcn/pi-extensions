/**
 * The `gh` calls behind the PR status display.
 *
 * Kept out of `index.ts` so the failure classification is testable with a fake
 * runner, and out of `pr.ts` so that module stays pure. Takes the same
 * `GitRunner` interface `lib/git.ts` defines — it is just "something that can
 * run a command".
 */

import type { GitRunner } from "../lib/git.ts";
import type { PullRequest } from "./pr.ts";

/** Cap on a single gh call. Measured cost is ~0.5s; this is a stuck-network guard. */
export const GH_TIMEOUT_MS = 10_000;

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
	if (!result) return { status: "unavailable" };

	if (result.code !== 0) {
		const stderr = result.stderr.toLowerCase();
		if (UNAVAILABLE_PATTERNS.some((pattern) => stderr.includes(pattern))) return { status: "unavailable" };
		return { status: "error" };
	}

	try {
		const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string };
		return parsed.nameWithOwner ? { status: "repo", nameWithOwner: parsed.nameWithOwner } : { status: "error" };
	} catch {
		return { status: "error" };
	}
}

/** Look up the PR for `branch`, classifying every failure mode. */
export async function fetchPr(runner: GitRunner, branch: string, cwd: string): Promise<PrLookup> {
	const result = await run(
		runner,
		["pr", "view", branch, "--json", "number,state,isDraft,url,statusCheckRollup"],
		cwd,
	);
	// A throw from exec means the binary is missing or unspawnable.
	if (!result) return { status: "unavailable" };

	if (result.code !== 0) {
		const stderr = result.stderr.toLowerCase();
		// gh uses exit 1 for both "no PR" and real errors, so the message decides.
		if (stderr.includes("no pull requests found")) return { status: "none" };
		if (UNAVAILABLE_PATTERNS.some((pattern) => stderr.includes(pattern))) return { status: "unavailable" };
		return { status: "error" };
	}

	try {
		const pr = JSON.parse(result.stdout) as PullRequest;
		if (typeof pr?.number !== "number") return { status: "error" };
		return { status: "pr", pr };
	} catch {
		return { status: "error" };
	}
}

/** Run gh, converting a spawn throw into `undefined`. */
async function run(runner: GitRunner, args: string[], cwd: string) {
	try {
		return await runner.exec("gh", args, { cwd, timeout: GH_TIMEOUT_MS });
	} catch {
		return undefined;
	}
}
