/**
 * Worktree create/remove operations layered on the shared git helpers.
 */

import { chmod, cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
	branchExists,
	defaultBranch,
	git,
	GitError,
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
	/**
	 * Remote-tracking ref to branch from, e.g. `origin/foo`. Mutually exclusive
	 * with `base`: a tracked branch has its start point already. Ignored when
	 * the local branch already exists, which is deliberate — that branch may
	 * hold unpushed commits.
	 */
	track?: string;
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
	/** The remote ref the new branch tracks, when one was used. */
	track?: string;
	createdBranch: boolean;
	copied: string[];
	/** Non-fatal problems (a `copyFiles` entry that could not be copied, etc.). */
	warnings: string[];
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
	if (options.track && options.base) throw new Error("base and track are mutually exclusive");

	const existing = await branchExists(pi, branch, projectRoot);
	const inUse = (await listWorktrees(pi, projectRoot)).find((wt) => wt.branch === branch);
	if (inUse) {
		throw new Error(`Branch "${branch}" is already checked out at ${inUse.path}`);
	}

	await mkdir(dirname(target), { recursive: true });

	let base: string | undefined;
	let track: string | undefined;
	if (existing) {
		await gitOrThrow(pi, ["worktree", "add", target, branch], projectRoot, { signal });
	} else if (options.track) {
		track = options.track;
		if (!(await refExists(pi, track, projectRoot))) {
			throw new Error(`Remote branch "${track}" does not exist`);
		}
		await gitOrThrow(pi, ["worktree", "add", "--track", "-b", branch, target, track], projectRoot, { signal });
	} else {
		base = options.base ?? config.defaultBase ?? (await defaultBranch(pi, projectRoot));
		if (base && !(await refExists(pi, base, projectRoot))) {
			throw new Error(`Base ref "${base}" does not exist`);
		}
		const args = ["worktree", "add", "-b", branch, target];
		if (base) args.push(base);
		await gitOrThrow(pi, args, projectRoot, { signal });
	}

	// The worktree exists from here on: a copy failure must not reject, or the
	// caller reports failure while leaving an orphan that blocks the retry.
	const warnings: string[] = [];
	const copied = await copyFiles(options.sourceWorktree, target, config.copyFiles, warnings);

	let postCreate: CreateResult["postCreate"];
	if (config.postCreate) {
		const result = await pi.exec("bash", ["-lc", config.postCreate], { cwd: target, signal });
		postCreate = {
			command: config.postCreate,
			code: result.code,
			output: (result.stdout + result.stderr).trim(),
		};
	}

	return { path: target, branch, base, track, createdBranch: !existing, copied, warnings, postCreate };
}

export interface RemoveOptions {
	worktree: Worktree;
	projectRoot: string;
	/** Force removal of a worktree with uncommitted changes. */
	force: boolean;
	/** Also delete the branch that was checked out there. */
	deleteBranch?: boolean;
	/**
	 * Use `git branch -D` instead of `-d`. Deliberately separate from `force`:
	 * a dirty working tree says nothing about whether the branch is merged, and
	 * conflating the two silently discards unmerged commits.
	 */
	forceDeleteBranch?: boolean;
	signal?: AbortSignal;
}

export async function removeWorktree(pi: GitRunner, options: RemoveOptions): Promise<void> {
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(options.worktree.path);
	const removal = await git(pi, args, options.projectRoot, { signal: options.signal });
	if (removal.code !== 0) await finishFailedRemoval(pi, options, args, removal);

	if (options.deleteBranch && options.worktree.branch) {
		const flag = options.forceDeleteBranch ? "-D" : "-d";
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

/**
 * Salvage a `git worktree remove` that died partway through deleting files.
 *
 * git unlinks the administrative directory under `worktrees/` even when the
 * working-tree delete fails — there is no point keeping a corrupted worktree —
 * so the failure is *not* retryable: the worktree is already deregistered and a
 * second `git worktree remove` just reports "is not a working tree". What it
 * leaves behind is an orphaned directory that also blocks re-creating a
 * worktree at that path.
 *
 * The usual cause is a read-only subtree. pants materializes its tool digests
 * under `pants.d/tmp/immutable_inputs*​/` as mode 555 directories, and unlinking
 * a file needs the write bit on its *parent*, so the recursive delete stops
 * with EACCES on the first file inside one.
 *
 * Registration is the discriminator, and it has to be: when git still lists the
 * worktree it refused before touching anything (a dirty tree without `--force`,
 * a lock), and finishing the job on the filesystem would destroy exactly the
 * files that refusal exists to protect.
 */
async function finishFailedRemoval(
	pi: GitRunner,
	options: RemoveOptions,
	args: string[],
	result: ExecResult,
): Promise<void> {
	const detail = (result.stderr || result.stdout).trim();
	const failure = new GitError(detail || `git ${args.join(" ")} failed (exit ${result.code})`, args, result);

	// A listing that itself fails tells us nothing, so assume the worktree stands.
	const registered = await listWorktrees(pi, options.projectRoot).catch(() => undefined);
	if (!registered || registered.some((wt) => wt.path === options.worktree.path)) throw failure;

	if (!(await pathExists(options.worktree.path))) return;
	try {
		await removeTree(options.worktree.path);
	} catch (error) {
		throw new Error(
			`${failure.message}\nWorktree was deregistered, but ${options.worktree.path} could not be cleaned up: ${(error as Error).message}`,
		);
	}
}

/** `rm -rf` that first restores write permission when it is what is missing. */
async function removeTree(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EACCES" && code !== "EPERM") throw error;
	}
	await makeWritable(path);
	await rm(path, { recursive: true, force: true });
}

/**
 * Add the owner write bit to every directory in a tree.
 *
 * Only directories matter — POSIX unlink checks the parent directory's
 * permissions, not the file's. Symlinks are skipped rather than followed:
 * `chmod` resolves them, and worktrees routinely hold symlinks to shared config
 * outside the tree that is being deleted.
 */
async function makeWritable(path: string): Promise<void> {
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isDirectory()) return;

	// u+rwx: write to unlink children, read and execute to list and descend.
	if ((info.mode & 0o700) !== 0o700) await chmod(path, info.mode | 0o700).catch(() => {});

	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory()) await makeWritable(join(path, entry.name));
	}
}

export async function pruneWorktrees(pi: GitRunner, projectRoot: string, signal?: AbortSignal): Promise<string> {
	return gitOrThrow(pi, ["worktree", "prune", "--verbose"], projectRoot, { signal });
}

async function copyFiles(
	source: string | undefined,
	target: string,
	patterns: string[],
	warnings: string[],
): Promise<string[]> {
	if (!source || patterns.length === 0) return [];
	const copied: string[] = [];
	for (const entry of patterns) {
		const from = join(source, entry);
		if (!(await pathExists(from))) continue;
		const to = join(target, entry);
		try {
			await mkdir(dirname(to), { recursive: true });
			await cp(from, to, { recursive: true, errorOnExist: false, force: true });
			copied.push(entry);
		} catch (error) {
			warnings.push(`could not copy ${entry}: ${(error as Error).message}`);
		}
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
