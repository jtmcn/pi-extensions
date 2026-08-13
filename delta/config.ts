/**
 * Configuration for the delta extension.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. ~/.pi/agent/delta.json               (global)
 *   3. <projectRoot>/.pi/delta.json         (project-local, trusted projects only)
 *
 * `args` is appended to delta's argv after the flags this extension forces, so a
 * user setting beats both the defaults and their own git config.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface DeltaConfig {
	/** Master switch. When false, nothing is ever handed to delta. */
	enabled: boolean;
	/** The binary to run. */
	command: string;
	/** Extra delta arguments, appended last so they win. */
	args: string[];
	/** Per-invocation timeout. */
	timeoutMs: number;
	/** Diffs larger than this skip delta entirely. */
	maxBytes: number;
	/** Regex sources added to the bash command matcher, e.g. "^jj\\s+diff". */
	extraCommands: string[];
}

/**
 * Upper bounds for the numeric settings. See `num()` in `merge` for why each one
 * matters; both are deliberately generous, since the point is to rule out values
 * that break an invariant elsewhere rather than to second-guess a preference.
 */
const LIMITS = {
	/** 30s. Long enough for any diff worth rendering, short enough to end. */
	timeoutMs: 30_000,
	/** 4MiB. At 64 cache entries that bounds the cache in the tens of MiB. */
	maxBytes: 4 * 1024 * 1024,
} as const;

export const DEFAULT_CONFIG: DeltaConfig = {
	enabled: true,
	command: "delta",
	// Suppress delta's line-level background fills (dark navy minus, dark maroon plus) so
	// they don't clash with pi's toolSuccessBg frame. Syntax highlighting, the red/green
	// line-number gutter, and word-level emphasis backgrounds are preserved. A user can
	// restore the banded look with "args": [] in delta.json.
	args: ["--minus-style", "syntax normal", "--plus-style", "syntax normal"],
	timeoutMs: 2000,
	maxBytes: 262_144,
	extraCommands: [],
};

export interface LoadConfigOptions {
	projectRoot: string;
	projectTrusted: boolean;
	/** Overridable so tests do not read the real ~/.pi/agent. */
	agentDir?: string;
}

export interface LoadedConfig {
	config: DeltaConfig;
	/** Config files found and applied, in precedence order. */
	sources: string[];
	/** Non-fatal problems: malformed JSON, bad field types. */
	warnings: string[];
	/** Identity of this config, for the render cache key. */
	version: string;
}

/** Short hash of the config, so a config edit invalidates cached renderings. */
export function configVersion(config: DeltaConfig): string {
	return createHash("sha1").update(JSON.stringify(config)).digest("hex").slice(0, 8);
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
	const candidates = [join(options.agentDir ?? getAgentDir(), "delta.json")];
	if (options.projectTrusted) {
		candidates.push(join(options.projectRoot, CONFIG_DIR_NAME, "delta.json"));
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

	return { config, sources, warnings, version: configVersion(config) };
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
	base: DeltaConfig,
	raw: Record<string, unknown>,
	file: string,
	warnings: string[],
): DeltaConfig {
	const next = { ...base };

	const bool = (key: "enabled") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "boolean") {
			warnings.push(`${file}: "${key}" must be a boolean`);
			return;
		}
		next[key] = value;
	};
	const str = (key: "command") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "string" || !value) {
			warnings.push(`${file}: "${key}" must be a non-empty string`);
			return;
		}
		next[key] = value;
	};
	const num = (key: "timeoutMs" | "maxBytes") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			warnings.push(`${file}: "${key}" must be a positive number`);
			return;
		}
		// Clamped, not rejected: an over-large value is a judgement call rather than a
		// mistake in kind, and the ceilings are what keep the rest of the extension
		// honest. `maxBytes` bounds the diff handed to delta and every rendering of
		// one is held in a 64-entry cache, so it is also the only thing bounding that
		// cache's memory; `timeoutMs` is spent blocking nothing, but a multi-minute
		// value means a diff that never resolves and an in-flight entry that never
		// clears.
		const ceiling = LIMITS[key];
		if (value > ceiling) {
			warnings.push(`${file}: "${key}" capped at ${ceiling} (was ${value})`);
			next[key] = ceiling;
			return;
		}
		next[key] = value;
	};
	const strings = (key: "args" | "extraCommands") => {
		const value = raw[key];
		if (value === undefined) return;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			warnings.push(`${file}: "${key}" must be an array of strings`);
			return;
		}
		next[key] = value as string[];
	};

	bool("enabled");
	str("command");
	num("timeoutMs");
	num("maxBytes");
	strings("args");
	strings("extraCommands");

	// A misspelled key is the one config mistake with no symptom: the value is
	// never read, and the file looks like it was applied. Every other kind of bad
	// config already warns, so this is the gap.
	for (const key of Object.keys(raw)) {
		if (!(key in DEFAULT_CONFIG)) warnings.push(`${file}: unknown key "${key}"`);
	}

	return next;
}
