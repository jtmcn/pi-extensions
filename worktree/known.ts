/**
 * One shape for a worktree, whether or not jimothy manages it.
 *
 * `Registry.list()` reports two kinds: records jimothy created or adopted, and
 * the git worktrees it did not. Everything in the command layer — the listing,
 * the matcher, the completion cache — wants a single list, and every one of them
 * needs the branch, including for the unmanaged half: `/worktree focus <branch>`
 * has always resolved by branch name, and losing that would be a silent
 * regression rather than a visible one.
 *
 * Pure and free of pi types, for the same reason `select.ts` is: it can then be
 * tested directly.
 */

import { basename } from "node:path";
import { describeStatus, type Deps, type WorktreeListing } from "jimothy/worktrees";

export interface KnownWorktree {
	/** The registry name when managed; the directory's basename otherwise. */
	name: string;
	path: string;
	/** Absent for a detached worktree, which git reports without a branch. */
	branch?: string;
	managed: boolean;
	/**
	 * The model's one-line status — held, provisioned, or not — for a managed
	 * worktree. Absent for an unmanaged one, which jimothy knows nothing about
	 * beyond what git reports.
	 */
	status?: string;
}

/**
 * Flatten a listing, managed first.
 *
 * Order is deliberate rather than incidental: the managed worktrees are the
 * ones this tool is for, so they are listed first here. `/worktree list`
 * itself shows the repository's main working tree ahead of this order still —
 * `commands.ts` unshifts it onto the front once this list is built, since
 * `Registry.list()` leaves it out on purpose. A name or branch claimed by more
 * than one entry is not settled by this order, though — that is
 * `matchWorktree`'s job (see `select.ts`), which prefers a managed worktree
 * over an unmanaged one so list order can stay purely about display.
 *
 * `deps` supplies the clock and the pid probe `describeStatus` needs. Reading
 * the clock once here means two worktrees leased at the same moment cannot
 * report different ages in one listing.
 */
export function toKnown(listing: WorktreeListing, deps: Deps): KnownWorktree[] {
	const now = deps.now();
	const managed = listing.managed.map((record) => ({
		name: record.name,
		path: record.path,
		branch: record.branch,
		managed: true,
		status: describeStatus(record, deps.isPidAlive, now),
	}));
	const unmanaged = listing.unmanaged.map((entry) => ({
		name: basename(entry.path),
		path: entry.path,
		...(entry.branch === undefined ? {} : { branch: entry.branch }),
		managed: false,
	}));
	return [...managed, ...unmanaged];
}

/** One line for a worktree, used by the listing and by every selection prompt. */
export function describeKnown(worktree: KnownWorktree): string {
	const parts = [worktree.name];
	if (worktree.branch) parts.push(`(${worktree.branch})`);
	else parts.push("(detached)");
	if (worktree.managed) {
		if (worktree.status) parts.push(`— ${worktree.status}`);
	} else {
		// Said plainly rather than implied by omission: an unmanaged worktree is
		// one jimothy will not provision, lease or remove.
		parts.push("— unmanaged");
	}
	return parts.join(" ");
}
