/**
 * Shared git helpers for pi extensions.
 *
 * Layout-aware: works in ordinary repos (`repo/.git/`), linked worktrees
 * (`.git` file), and bare layouts (`proj/.bare` + `proj/main` + siblings).
 */

import { basename } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitRunner {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: string[],
		readonly result: ExecResult,
	) {
		super(message);
		this.name = "GitError";
	}
}

/** Run a git command. Returns the raw result; never throws on non-zero exit. */
export async function git(
	pi: GitRunner,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return pi.exec("git", args, { ...options, cwd });
}

/** Run a git command, throwing GitError on non-zero exit. Returns trimmed stdout. */
export async function gitOrThrow(
	pi: GitRunner,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<string> {
	const result = await git(pi, args, cwd, options);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim();
		throw new GitError(detail || `git ${args.join(" ")} failed (exit ${result.code})`, args, result);
	}
	return result.stdout.trim();
}

export interface RepoInfo {
	/** Absolute path to the common git dir (`repo/.git`, `proj/.bare`). */
	commonDir: string;
	/**
	 * Directory that holds the common git dir. This is the natural anchor for
	 * sibling worktrees: `repo/` for an ordinary repo, `proj/` for a bare layout.
	 */
	projectRoot: string;
	/** Toplevel of the worktree containing `cwd`, or undefined when cwd is not in one. */
	worktreeRoot?: string;
	/** Current branch name, or undefined when detached / not in a worktree. */
	branch?: string;
}

/** Resolve repository layout from any directory inside (or adjacent to) a repo. */
export async function getRepoInfo(pi: GitRunner, cwd: string): Promise<RepoInfo | undefined> {
	const common = await git(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (common.code !== 0) return undefined;

	const commonDir = common.stdout.trim();
	if (!commonDir) return undefined;

	const info: RepoInfo = {
		commonDir,
		projectRoot: dirnameOf(commonDir),
	};

	const top = await git(pi, ["rev-parse", "--show-toplevel"], cwd);
	if (top.code === 0 && top.stdout.trim()) {
		info.worktreeRoot = top.stdout.trim();
		const branch = await git(pi, ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
		if (branch.code === 0 && branch.stdout.trim()) info.branch = branch.stdout.trim();
	}

	return info;
}

export interface Worktree {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	lockReason?: string;
	prunable: boolean;
}

/** Parse `git worktree list --porcelain`. */
export async function listWorktrees(pi: GitRunner, cwd: string): Promise<Worktree[]> {
	const out = await gitOrThrow(pi, ["worktree", "list", "--porcelain"], cwd);
	const worktrees: Worktree[] = [];
	let current: Worktree | undefined;

	for (const line of out.split("\n")) {
		if (line === "") {
			if (current) worktrees.push(current);
			current = undefined;
			continue;
		}
		const spaceAt = line.indexOf(" ");
		const key = spaceAt === -1 ? line : line.slice(0, spaceAt);
		const value = spaceAt === -1 ? "" : line.slice(spaceAt + 1);

		switch (key) {
			case "worktree":
				current = { path: value, detached: false, bare: false, locked: false, prunable: false };
				break;
			case "HEAD":
				if (current) current.head = value;
				break;
			case "branch":
				if (current) current.branch = value.replace(/^refs\/heads\//, "");
				break;
			case "detached":
				if (current) current.detached = true;
				break;
			case "bare":
				if (current) current.bare = true;
				break;
			case "locked":
				if (current) {
					current.locked = true;
					if (value) current.lockReason = value;
				}
				break;
			case "prunable":
				if (current) current.prunable = true;
				break;
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

/** True when the worktree at `cwd` has uncommitted changes. */
export async function isDirty(pi: GitRunner, cwd: string): Promise<boolean> {
	const result = await git(pi, ["status", "--porcelain"], cwd);
	return result.code === 0 && result.stdout.trim().length > 0;
}

/** Count of uncommitted entries in the worktree at `cwd`. */
export async function countDirty(pi: GitRunner, cwd: string): Promise<number> {
	const result = await git(pi, ["status", "--porcelain"], cwd);
	if (result.code !== 0) return 0;
	return result.stdout.trim().split("\n").filter(Boolean).length;
}

/** True when `ref` resolves to something in this repo. */
export async function refExists(pi: GitRunner, ref: string, cwd: string): Promise<boolean> {
	const result = await git(pi, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
	return result.code === 0;
}

/** True when a local branch with this name exists. */
export async function branchExists(pi: GitRunner, branch: string, cwd: string): Promise<boolean> {
	const result = await git(pi, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
	return result.code === 0;
}

/** Best-effort default branch (`origin/HEAD`, then main, then master). */
export async function defaultBranch(pi: GitRunner, cwd: string): Promise<string | undefined> {
	const head = await git(pi, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
	for (const candidate of ["main", "master"]) {
		if (await branchExists(pi, candidate, cwd)) return candidate;
	}
	return undefined;
}

/** Sanitize an arbitrary string into a filesystem-safe worktree directory name. */
export function slugify(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._/-]+/g, "-")
			.replace(/\/+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 60) || "worktree"
	);
}

/** Display label for a worktree row. */
export function describeWorktree(worktree: Worktree): string {
	const name = basename(worktree.path);
	const ref = worktree.bare
		? "bare"
		: (worktree.branch ?? (worktree.head ? `detached ${worktree.head.slice(0, 8)}` : "unknown"));
	const flags = [worktree.locked ? "locked" : undefined, worktree.prunable ? "prunable" : undefined]
		.filter(Boolean)
		.join(", ");
	return flags ? `${name} [${ref}] (${flags})` : `${name} [${ref}]`;
}

function dirnameOf(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const at = normalized.lastIndexOf("/");
	return at <= 0 ? "/" : normalized.slice(0, at);
}

/** Convenience adapter so helpers can take the ExtensionAPI directly. */
export function runner(pi: ExtensionAPI): GitRunner {
	return { exec: (command, args, options) => pi.exec(command, args, options) };
}
