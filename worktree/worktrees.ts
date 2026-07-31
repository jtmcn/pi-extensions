/**
 * Worktree create/remove operations layered on the shared git helpers.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
	branchExists,
	defaultBranch,
	git,
	type GitRunner,
	gitOrThrow,
	listWorktrees,
	refExists,
	slugify,
	type Worktree,
} from "../lib/git.ts";
import type { WorktreeConfig } from "./config.ts";
import { worktreePath } from "./config.ts";

export interface CreateOptions {
	/** Directory name for the worktree. Slugified. */
	name: string;
	/** Branch to check out. Created from `base` when it does not exist. */
	branch: string;
	/** Start point for a new branch. Defaults to config.defaultBase or repo default. */
	base?: string;
	config: WorktreeConfig;
	projectRoot: string;
	/** Worktree to copy `config.copyFiles` from. */
	sourceWorktree?: string;
	signal?: AbortSignal;
}

export interface CreateResult {
	path: string;
	branch: string;
	base?: string;
	createdBranch: boolean;
	copied: string[];
	postCreate?: { command: string; code: number; output: string };
}

/** Minimal surface `createWorktree` needs: git plus an arbitrary shell for `postCreate`. */
export interface CommandRunner extends GitRunner {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export async function createWorktree(pi: CommandRunner, options: CreateOptions): Promise<CreateResult> {
	const { config, projectRoot, signal } = options;
	const name = slugify(options.name);
	const target = worktreePath(config, projectRoot, name);

	if (await pathExists(target)) {
		throw new Error(`Path already exists: ${target}`);
	}

	const branch = options.branch.trim();
	if (!branch) throw new Error("Branch name is required");

	const existing = await branchExists(pi, branch, projectRoot);
	const inUse = (await listWorktrees(pi, projectRoot)).find((wt) => wt.branch === branch);
	if (inUse) {
		throw new Error(`Branch "${branch}" is already checked out at ${inUse.path}`);
	}

	await mkdir(dirname(target), { recursive: true });

	let base: string | undefined;
	if (existing) {
		await gitOrThrow(pi, ["worktree", "add", target, branch], projectRoot, { signal });
	} else {
		base = options.base ?? config.defaultBase ?? (await defaultBranch(pi, projectRoot));
		if (base && !(await refExists(pi, base, projectRoot))) {
			throw new Error(`Base ref "${base}" does not exist`);
		}
		const args = ["worktree", "add", "-b", branch, target];
		if (base) args.push(base);
		await gitOrThrow(pi, args, projectRoot, { signal });
	}

	const copied = await copyFiles(options.sourceWorktree, target, config.copyFiles);

	let postCreate: CreateResult["postCreate"];
	if (config.postCreate) {
		const result = await pi.exec("bash", ["-lc", config.postCreate], { cwd: target, signal });
		postCreate = {
			command: config.postCreate,
			code: result.code,
			output: (result.stdout + result.stderr).trim(),
		};
	}

	return { path: target, branch, base, createdBranch: !existing, copied, postCreate };
}

export interface RemoveOptions {
	worktree: Worktree;
	projectRoot: string;
	force: boolean;
	/** Also delete the branch that was checked out there. */
	deleteBranch?: boolean;
	signal?: AbortSignal;
}

export async function removeWorktree(pi: GitRunner, options: RemoveOptions): Promise<void> {
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(options.worktree.path);
	await gitOrThrow(pi, args, options.projectRoot, { signal: options.signal });

	if (options.deleteBranch && options.worktree.branch) {
		const flag = options.force ? "-D" : "-d";
		const result = await git(pi, ["branch", flag, options.worktree.branch], options.projectRoot, {
			signal: options.signal,
		});
		if (result.code !== 0) {
			throw new Error(
				`Worktree removed, but branch "${options.worktree.branch}" was kept: ${(result.stderr || result.stdout).trim()}`,
			);
		}
	}
}

export async function pruneWorktrees(pi: GitRunner, projectRoot: string, signal?: AbortSignal): Promise<string> {
	return gitOrThrow(pi, ["worktree", "prune", "--verbose"], projectRoot, { signal });
}

async function copyFiles(source: string | undefined, target: string, patterns: string[]): Promise<string[]> {
	if (!source || patterns.length === 0) return [];
	const copied: string[] = [];
	for (const entry of patterns) {
		const from = join(source, entry);
		if (!(await pathExists(from))) continue;
		const to = join(target, entry);
		await mkdir(dirname(to), { recursive: true });
		await cp(from, to, { recursive: true, errorOnExist: false, force: true });
		copied.push(entry);
	}
	return copied;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
