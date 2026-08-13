/**
 * The two pi settings that change how `bash` runs a command.
 *
 * Registering a tool named `bash` replaces pi's in the execution registry, so
 * *our* definition's `execute` is what runs. pi builds its own with settings
 * applied — `createAllToolDefinitions(cwd, { bash: { commandPrefix, shellPath } })`
 * in `agent-session.js` — and a definition built without them silently ignores
 * the user's configured shell. Neither setting is reachable through the
 * extension API, so they are read back from the same files pi reads.
 *
 * Resolution matches pi's `SettingsManager`: global `<agentDir>/settings.json`,
 * then `<projectRoot>/.pi/settings.json` when the project is trusted, project
 * winning. Anything unreadable, unparseable, or of the wrong type is ignored —
 * never thrown, and never warned about either: this is read per tool call, pi
 * has already reported its own settings file being broken, and a second copy of
 * that complaint once per bash command would be worse than silence.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ShellSettings {
	/** pi's `shellCommandPrefix`: prepended to every command. */
	commandPrefix?: string;
	/** pi's `shellPath`: the shell binary to spawn. */
	shellPath?: string;
}

export interface LoadShellSettingsOptions {
	projectRoot: string;
	projectTrusted: boolean;
	/** Overridable so tests do not read the real ~/.pi/agent. */
	agentDir?: string;
}

/**
 * pi normalizes `shellPath` with an unexported helper before using it; the half
 * that matters off Windows is tilde expansion, and a literal `~/bin/fish` does
 * not spawn.
 */
/** A settings file as an object, or undefined if it is missing or unusable. */
async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export async function loadShellSettings(options: LoadShellSettingsOptions): Promise<ShellSettings> {
	const files = [join(options.agentDir ?? getAgentDir(), "settings.json")];
	if (options.projectTrusted) {
		files.push(join(options.projectRoot, CONFIG_DIR_NAME, "settings.json"));
	}

	const settings: ShellSettings = {};
	for (const file of files) {
		const raw = await readJsonObject(file);
		if (!raw) continue;
		const prefix = raw.shellCommandPrefix;
		if (typeof prefix === "string" && prefix) settings.commandPrefix = prefix;
		const shellPath = raw.shellPath;
		if (typeof shellPath === "string" && shellPath) settings.shellPath = expandTilde(shellPath);
	}
	return settings;
}

/** Identity of a settings set, for memoizing the tool definition built from it. */
export function shellSettingsKey(cwd: string, settings: ShellSettings): string {
	return `${cwd}\u0000${settings.shellPath ?? ""}\u0000${settings.commandPrefix ?? ""}`;
}
