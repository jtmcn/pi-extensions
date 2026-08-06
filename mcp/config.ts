/**
 * Configuration for the mcp extension.
 *
 * Resolution order (later wins, per server name):
 *   1. ~/.pi/agent/mcp.json                  (global)
 *   2. <cwd>/.pi/mcp.json                    (project-local, trusted projects only)
 *
 * The server map accepts both `servers` and `mcpServers` as the key, so an
 * existing Claude Code / Cursor block can be pasted in unchanged. `extends`
 * goes further and reads the server map straight out of another JSON file
 * (e.g. `~/.claude.json`), so one set of servers can feed both tools.
 *
 * Project-local config is gated on trust because a server spec is an arbitrary
 * command line — the same boundary pi applies to `.pi/` generally.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
	/** Working directory for the server. Relative paths resolve against the session cwd. */
	cwd?: string;
	/** Skip this server entirely. */
	disabled?: boolean;
	/**
	 * Tool allow-list. Every exposed tool's schema is spent from the system
	 * prompt budget, so this is the main cost control — omitting it exposes
	 * everything the server offers.
	 */
	tools?: string[];
	/** Per-request timeout override. */
	timeoutMs?: number;
}

export interface McpConfig {
	servers: Record<string, McpServerConfig>;
	/**
	 * How long the first turn waits for servers to finish connecting.
	 *
	 * Servers connect in the background so startup is not serialized behind
	 * them, but a turn that begins before `tools/list` returns cannot see the
	 * tools at all — the tool list is sent with the request. This bounds that
	 * race without letting one slow server hold the session hostage.
	 */
	startupTimeoutMs: number;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export interface LoadConfigOptions {
	/** Session cwd; also the root for project-local config and relative server cwds. */
	cwd: string;
	projectTrusted: boolean;
	/** Injectable for tests. Defaults to the real `~/.pi/agent`. */
	agentDir?: string;
	/** Injectable for tests. Defaults to the real home directory. */
	home?: string;
}

export interface LoadedConfig {
	config: McpConfig;
	/** Config files found and applied, in precedence order. */
	sources: string[];
	/** Non-fatal problems: malformed JSON, bad field types, unusable entries. */
	warnings: string[];
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
	const home = options.home ?? homedir();
	const candidates = [join(options.agentDir ?? getAgentDir(), "mcp.json")];
	if (options.projectTrusted) {
		candidates.push(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"));
	}

	const servers: Record<string, McpServerConfig> = {};
	const sources: string[] = [];
	const warnings: string[] = [];
	let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;

	for (const file of candidates) {
		const raw = await readJson(file, warnings);
		if (!raw) continue;
		sources.push(file);

		if (raw.startupTimeoutMs !== undefined) {
			if (
				typeof raw.startupTimeoutMs === "number" &&
				Number.isFinite(raw.startupTimeoutMs) &&
				raw.startupTimeoutMs >= 0
			) {
				startupTimeoutMs = raw.startupTimeoutMs;
			} else {
				warnings.push(`${file}: "startupTimeoutMs" must be a non-negative number`);
			}
		}

		// `extends` is applied first so the file's own servers can override it.
		for (const inherited of toStringArray(raw.extends)) {
			const path = expandHome(inherited, home);
			const base = await readJson(path, warnings);
			if (!base) {
				warnings.push(`${file}: extends "${inherited}" could not be read`);
				continue;
			}
			sources.push(path);
			mergeServers(servers, base, path, options, home, warnings);
		}

		mergeServers(servers, raw, file, options, home, warnings);
	}

	return { config: { servers, startupTimeoutMs }, sources, warnings };
}

/** Servers that should actually be started. */
export function enabledServers(config: McpConfig): [string, McpServerConfig][] {
	return Object.entries(config.servers).filter(([, server]) => !server.disabled);
}

function mergeServers(
	target: Record<string, McpServerConfig>,
	raw: Record<string, unknown>,
	file: string,
	options: LoadConfigOptions,
	home: string,
	warnings: string[],
): void {
	const block = (raw.servers ?? raw.mcpServers) as unknown;
	if (block === undefined) return;
	if (!isPlainObject(block)) {
		warnings.push(`${file}: "servers" must be an object`);
		return;
	}

	for (const [name, value] of Object.entries(block)) {
		const parsed = parseServer(name, value, file, options, home, warnings);
		if (parsed) target[name] = parsed;
	}
}

function parseServer(
	name: string,
	value: unknown,
	file: string,
	options: LoadConfigOptions,
	home: string,
	warnings: string[],
): McpServerConfig | undefined {
	if (!isPlainObject(value)) {
		warnings.push(`${file}: server "${name}" must be an object`);
		return undefined;
	}

	// Remote transports are a different protocol (Streamable HTTP + usually
	// OAuth). Say so explicitly instead of failing to spawn a missing command.
	if (typeof value.url === "string" || value.type === "http" || value.type === "sse") {
		warnings.push(`${file}: server "${name}" is a remote/HTTP server, which is not supported yet`);
		return undefined;
	}

	if (typeof value.command !== "string" || !value.command.trim()) {
		warnings.push(`${file}: server "${name}" needs a non-empty "command"`);
		return undefined;
	}

	const args = value.args === undefined ? [] : toStringArray(value.args);
	if (value.args !== undefined && args.length !== (value.args as unknown[]).length) {
		warnings.push(`${file}: server "${name}" has non-string entries in "args"`);
	}

	const server: McpServerConfig = { command: value.command, args };

	if (value.env !== undefined) {
		if (isPlainObject(value.env) && Object.values(value.env).every((v) => typeof v === "string")) {
			server.env = value.env as Record<string, string>;
		} else {
			warnings.push(`${file}: server "${name}" has a non-string "env" value`);
		}
	}

	if (value.cwd !== undefined) {
		if (typeof value.cwd === "string") {
			const expanded = expandHome(value.cwd, home);
			server.cwd = isAbsolute(expanded) ? expanded : resolve(options.cwd, expanded);
		} else {
			warnings.push(`${file}: server "${name}" has a non-string "cwd"`);
		}
	}

	if (value.disabled !== undefined) {
		if (typeof value.disabled === "boolean") server.disabled = value.disabled;
		else warnings.push(`${file}: server "${name}" has a non-boolean "disabled"`);
	}

	if (value.tools !== undefined) {
		if (Array.isArray(value.tools) && value.tools.every((t) => typeof t === "string")) {
			server.tools = value.tools as string[];
		} else {
			warnings.push(`${file}: server "${name}" has a non-string entry in "tools"`);
		}
	}

	if (value.timeoutMs !== undefined) {
		if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
			server.timeoutMs = value.timeoutMs;
		} else {
			warnings.push(`${file}: server "${name}" has an invalid "timeoutMs"`);
		}
	}

	return server;
}

async function readJson(
	file: string,
	warnings: string[],
): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isPlainObject(parsed)) {
			warnings.push(`${file}: expected a JSON object`);
			return undefined;
		}
		return parsed;
	} catch (error) {
		warnings.push(`${file}: invalid JSON (${(error as Error).message})`);
		return undefined;
	}
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function toStringArray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
