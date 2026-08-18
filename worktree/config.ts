/**
 * Configuration for the worktree extension.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. ~/.pi/agent/worktree.json                (global)
 *   3. <projectRoot>/.pi/worktree.json          (project-local, trusted projects only)
 *
 * What is left here is only what this extension itself decides. Everything about
 * *making* a worktree — where it lands, what its branch is called, what is copied
 * into it — is jimothy's now, because every door that creates one goes through
 * jimothy's registry and provisioning. A key that used to live here and moved is
 * listed in `MOVED` and warned about rather than silently ignored.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorktreeConfig {
	/** Focus a new worktree automatically after `/worktree new`. */
	autoFocus: boolean;
	/**
	 * While focused, rewrite absolute paths that point inside the session's own
	 * worktree so they land in the focused worktree instead.
	 */
	remapAbsolutePaths: boolean;
}

export const DEFAULT_CONFIG: WorktreeConfig = {
	autoFocus: true,
	remapAbsolutePaths: true,
};

/**
 * Keys this extension used to own, and what actually became of them.
 *
 * Deliberately not phrased as a clean rename, because it is not one. `copy` in
 * jimothy's config copies *files*, where `copyFiles` also took directories, so a
 * directory entry has to be listed file by file. And `postCreate` has no
 * equivalent in jimothy's provisioning at all: a worktree made through this
 * extension no longer runs one, and a warning that implied otherwise would let a
 * user believe their setup step is still happening.
 */
const MOVED: Record<string, string> = {
	path: "worktrees now live under jimothy's `baseDir` (jimothy.config.json)",
	branchPrefix: "set `branchPrefix` in jimothy.config.json (default `jimothy/`)",
	defaultBase: "set `defaultBase` in jimothy.config.json",
	copyFiles: "use `copy` in jimothy.config.json — note it copies files, not directories",
	postCreate: "postCreate has no equivalent in jimothy's provisioning and is no longer run",
};

export interface LoadConfigOptions {
	projectRoot: string;
	projectTrusted: boolean;
}

export interface LoadedConfig {
	config: WorktreeConfig;
	/** Config files that were found and applied, in precedence order. */
	sources: string[];
	/** Non-fatal problems (malformed JSON, bad field types, keys that moved). */
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

	const bool = (key: keyof WorktreeConfig) => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "boolean") {
			warnings.push(`${file}: "${key}" must be a boolean`);
			return;
		}
		next[key] = value;
	};

	bool("autoFocus");
	bool("remapAbsolutePaths");

	// Warned rather than ignored with the unknown keys: a setting that is still in
	// the file is one the user believes is in effect, and for `postCreate` that
	// belief is a build step they think is running.
	for (const [key, moved] of Object.entries(MOVED)) {
		if (raw[key] !== undefined) warnings.push(`${file}: "${key}" is no longer used — ${moved}`);
	}

	return next;
}
