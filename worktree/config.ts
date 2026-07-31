/**
 * Configuration for the worktree extension.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. ~/.pi/agent/worktree.json                (global)
 *   3. <projectRoot>/.pi/worktree.json          (project-local, trusted projects only)
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorktreeConfig {
	/**
	 * Where new worktrees are created. Relative paths resolve against the project
	 * root (the directory holding `.git` / `.bare`). Supports `{name}`, which is
	 * replaced by the worktree name; without it the name is appended.
	 */
	path: string;
	/** Prepended to branch names created by `/worktree new` when absent. */
	branchPrefix: string;
	/** Files/dirs copied from the current worktree into a new one (gitignored config, etc.). */
	copyFiles: string[];
	/** Shell command run inside a newly created worktree. */
	postCreate?: string;
	/** Focus the new worktree automatically after `/worktree new`. */
	autoFocus: boolean;
	/**
	 * While focused, rewrite absolute paths that point inside the session's own
	 * worktree so they land in the focused worktree instead.
	 */
	remapAbsolutePaths: boolean;
	/** Base ref for new branches. Defaults to the repo's default branch. */
	defaultBase?: string;
}

export const DEFAULT_CONFIG: WorktreeConfig = {
	path: ".claude/worktrees",
	branchPrefix: "",
	copyFiles: [],
	autoFocus: true,
	remapAbsolutePaths: true,
};

export interface LoadConfigOptions {
	projectRoot: string;
	projectTrusted: boolean;
}

export interface LoadedConfig {
	config: WorktreeConfig;
	/** Config files that were found and applied, in precedence order. */
	sources: string[];
	/** Non-fatal problems (malformed JSON, bad field types). */
	warnings: string[];
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
	const candidates: string[] = [join(getAgentDir(), "worktree.json")];
	if (options.projectTrusted) {
		candidates.push(join(options.projectRoot, CONFIG_DIR_NAME, "worktree.json"));
	}

	let config = { ...DEFAULT_CONFIG };
	const sources: string[] = [];
	const warnings: string[] = [];

	for (const file of candidates) {
		const raw = await readJson(file, warnings);
		if (!raw) continue;
		config = merge(config, raw, file, warnings);
		sources.push(file);
	}

	return { config, sources, warnings };
}

/** Resolve the directory a worktree named `name` should live in. */
export function worktreePath(config: WorktreeConfig, projectRoot: string, name: string): string {
	const template = config.path.includes("{name}") ? config.path : join(config.path, "{name}");
	const filled = template.replaceAll("{name}", name);
	return isAbsolute(filled) ? resolve(filled) : resolve(projectRoot, filled);
}

async function readJson(file: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`${file}: expected a JSON object`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		warnings.push(`${file}: invalid JSON (${(error as Error).message})`);
		return undefined;
	}
}

function merge(
	base: WorktreeConfig,
	raw: Record<string, unknown>,
	file: string,
	warnings: string[],
): WorktreeConfig {
	const next = { ...base };

	const str = (key: keyof WorktreeConfig) => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "string") {
			warnings.push(`${file}: "${key}" must be a string`);
			return;
		}
		(next[key] as string) = value;
	};
	const bool = (key: keyof WorktreeConfig) => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "boolean") {
			warnings.push(`${file}: "${key}" must be a boolean`);
			return;
		}
		(next[key] as boolean) = value;
	};

	str("path");
	str("branchPrefix");
	str("postCreate");
	str("defaultBase");
	bool("autoFocus");
	bool("remapAbsolutePaths");

	if (raw.copyFiles !== undefined) {
		if (Array.isArray(raw.copyFiles) && raw.copyFiles.every((entry) => typeof entry === "string")) {
			next.copyFiles = raw.copyFiles as string[];
		} else {
			warnings.push(`${file}: "copyFiles" must be an array of strings`);
		}
	}

	return next;
}
