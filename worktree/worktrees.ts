/**
 * `git worktree prune`, and nothing else.
 *
 * This file used to hold the extension's own create and remove — a second
 * implementation of what jimothy's registry does, agreeing with it only by
 * coincidence. Every door now goes through the registry, so all of it is gone,
 * including the read-only-subtree salvage that finished a removal git had
 * half-completed: that lives in jimothy (`src/worktree/salvage.ts`), where
 * `Registry.remove` calls it.
 *
 * Prune stays because it has no registry equivalent and needs none. It is git
 * maintenance over git's own administrative files, and `Registry.list()`'s
 * reconciliation is what drops the records for whatever it pruned — so
 * `/worktree prune` prunes and then refreshes.
 */

import { type GitRunner, gitOrThrow } from "../lib/git.ts";

export async function pruneWorktrees(pi: GitRunner, projectRoot: string, signal?: AbortSignal): Promise<string> {
	return gitOrThrow(pi, ["worktree", "prune", "--verbose"], projectRoot, { signal });
}
