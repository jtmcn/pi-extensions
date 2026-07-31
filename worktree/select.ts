/**
 * Pure argument parsing and worktree matching for the `/worktree` command.
 *
 * Kept free of I/O and pi types so it can be tested directly — the same reason
 * `focus.ts` is a library rather than inline in `index.ts`.
 */

import { basename } from "node:path";
import type { Worktree } from "../lib/git.ts";

/** Split a command argument string into tokens, honouring '…' and "…". */
export function tokenize(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (const char of args) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

export interface NewArgs {
	name?: string;
	base?: string;
	/** Tokens beyond `name` and `base`, which the caller should reject. */
	extra: string[];
}

/** Parse `/worktree new <name> [base]`. Quoted names with spaces are supported. */
export function parseNewArgs(args: string): NewArgs {
	const [name, base, ...extra] = tokenize(args);
	return { name, base, extra };
}

export type Match =
	| { kind: "none" }
	| { kind: "one"; worktree: Worktree }
	| { kind: "many"; worktrees: Worktree[] };

/**
 * Resolve a user-supplied worktree reference.
 *
 * Exact matches (path, directory name, branch) win outright. Prefix matches are
 * only accepted when unambiguous: `remove` is destructive, so silently picking
 * the first of several candidates is not acceptable.
 */
export function matchWorktree(worktrees: Worktree[], query: string, options?: { exactOnly?: boolean }): Match {
	const needle = query.trim();
	if (!needle) return { kind: "none" };

	const exact =
		worktrees.find((wt) => wt.path === needle) ??
		worktrees.find((wt) => basename(wt.path) === needle) ??
		worktrees.find((wt) => wt.branch === needle);
	if (exact) return { kind: "one", worktree: exact };
	if (options?.exactOnly) return { kind: "none" };

	const prefixed = worktrees.filter(
		(wt) => basename(wt.path).startsWith(needle) || wt.branch?.startsWith(needle),
	);
	if (prefixed.length === 1) return { kind: "one", worktree: prefixed[0] };
	if (prefixed.length > 1) return { kind: "many", worktrees: prefixed };
	return { kind: "none" };
}
