/**
 * Branch discovery and resolution for `/worktree checkout`.
 *
 * Split the way `select.ts` is: parsing, resolution and naming are pure and
 * carry the tests, and the two git calls are thin wrappers over them.
 *
 * The rule that shapes everything here is that a local branch wins over a
 * remote one of the same name. A local branch can hold commits the remote does
 * not, so resolving to the remote would either lose them or need a reset this
 * command has no business performing.
 */

import { slugify } from "../lib/git.ts";

export interface RemoteBranch {
	/** Remote name, e.g. `origin`. May itself contain slashes. */
	remote: string;
	/** Branch name on the remote, e.g. `joel/fix-parser`. */
	name: string;
	/** Fully qualified short ref, e.g. `origin/joel/fix-parser`. */
	full: string;
}

export interface BranchList {
	local: string[];
	remote: RemoteBranch[];
	remotes: string[];
}

export const EMPTY_BRANCHES: BranchList = { local: [], remote: [], remotes: [] };

export type BranchMatch =
	/** `shadows` is the remote ref this local branch was preferred over. */
	| { kind: "local"; branch: string; shadows?: string }
	/** `branch` is the local branch to create; `full` is what it tracks. */
	| { kind: "remote"; branch: string; full: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" };

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";

/**
 * Parse `git for-each-ref --format=%(refname) refs/heads refs/remotes`.
 *
 * `remotes` is needed rather than splitting on the first path segment: git
 * accepts `git remote add a/b`, so `refs/remotes/a/b/main` is remote `a/b` on
 * branch `main`. Longest name first, so `a/b` is preferred over `a`.
 */
export function parseBranchRefs(output: string, remotes: string[]): BranchList {
	const ordered = [...remotes].sort((a, b) => b.length - a.length);
	const local: string[] = [];
	const remote: RemoteBranch[] = [];

	for (const line of output.split("\n")) {
		const ref = line.trim();
		if (ref.startsWith(HEADS)) {
			local.push(ref.slice(HEADS.length));
			continue;
		}
		if (!ref.startsWith(REMOTES)) continue;
		const rest = ref.slice(REMOTES.length);
		const name = ordered.find((candidate) => rest.startsWith(`${candidate}/`));
		if (!name) continue;
		const branch = rest.slice(name.length + 1);
		// `<remote>/HEAD` is a symref to a branch that is already in this list.
		if (!branch || branch === "HEAD") continue;
		remote.push({ remote: name, name: branch, full: `${name}/${branch}` });
	}

	return { local, remote, remotes: [...remotes] };
}

/** Resolve a user-supplied branch reference. Local branches win. */
export function resolveBranch(branches: BranchList, query: string): BranchMatch {
	const needle = query.trim().replace(/^refs\/heads\//, "");
	if (!needle) return { kind: "none" };

	const asLocal = (branch: string, shadows?: string): BranchMatch =>
		shadows ? { kind: "local", branch, shadows } : { kind: "local", branch };

	if (branches.local.includes(needle)) {
		const shadow = branches.remote.find((r) => r.name === needle) ?? branches.remote.find((r) => r.full === needle);
		return asLocal(needle, shadow?.full);
	}

	const byFull = branches.remote.find((r) => r.full === needle);
	if (byFull) {
		// `origin/foo` asked for by name, but a local `foo` exists: same rule.
		return branches.local.includes(byFull.name) ? asLocal(byFull.name, byFull.full) : { kind: "remote", branch: byFull.name, full: byFull.full };
	}

	const byName = branches.remote.filter((r) => r.name === needle);
	if (byName.length === 1) return { kind: "remote", branch: byName[0].name, full: byName[0].full };
	if (byName.length > 1) return { kind: "ambiguous", candidates: byName.map((r) => r.full) };
	return { kind: "none" };
}

/**
 * Directory name for a checked-out branch.
 *
 * Takes the *local* branch name — resolution has already stripped the remote.
 * Stripping `branchPrefix` keeps your own branches short while leaving someone
 * else's attributed, and reuses the rule `suggest.ts` already applies.
 */
export function checkoutName(branch: string, branchPrefix: string): string {
	const stripped = branchPrefix && branch.startsWith(branchPrefix) ? branch.slice(branchPrefix.length) : branch;
	return slugify(stripped);
}

/** The remote to fetch: the one named in the query, else origin, else the first. */
export function defaultRemote(branches: BranchList, query?: string): string | undefined {
	if (query) {
		const ordered = [...branches.remotes].sort((a, b) => b.length - a.length);
		const named = ordered.find((remote) => query.startsWith(`${remote}/`));
		if (named) return named;
	}
	return branches.remotes.includes("origin") ? "origin" : branches.remotes[0];
}

/**
 * Rows for the interactive picker: locals first, then remotes that no local
 * branch shadows — a shadowed one would resolve to the local branch anyway, so
 * offering both would be two labels for one outcome.
 */
export function branchOptions(branches: BranchList, checkedOut: Set<string>): { value: string; label: string }[] {
	const options = branches.local.map((branch) => ({
		value: branch,
		label: checkedOut.has(branch) ? `${branch} (checked out)` : branch,
	}));
	for (const remote of branches.remote) {
		if (branches.local.includes(remote.name)) continue;
		options.push({
			value: remote.full,
			label: checkedOut.has(remote.name) ? `${remote.full} (checked out)` : remote.full,
		});
	}
	return options;
}
