/**
 * Enabling `quietStartup`, which the dashboard needs to own the screen.
 *
 * Separate from `index.ts` and takes its path as an argument: this is the one
 * piece of the extension that writes to the user's configuration, and it is
 * tested against a temp file rather than through a fake `pi`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SetupResult =
	| { ok: true; path: string }
	| { ok: false; path: string; reason: string };

export function defaultSettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

export async function enableQuietStartup(path: string): Promise<SetupResult> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		// No settings file yet is a first run, not a failure.
		raw = "{}";
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// Never clobber a file we could not read: the user's whole configuration
		// is in there, and a rewrite would silently discard it.
		return { ok: false, path, reason: `could not parse ${path}: ${String(error)}` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, path, reason: `${path} is not a settings object` };
	}

	const settings = { ...(parsed as Record<string, unknown>), quietStartup: true };
	await writeFile(path, `${JSON.stringify(settings, null, "\t")}\n`);
	return { ok: true, path };
}
