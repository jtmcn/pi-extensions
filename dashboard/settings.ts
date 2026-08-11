/**
 * Enabling `quietStartup`, which the dashboard needs to own the screen.
 *
 * Separate from `index.ts` and takes its path as an argument: this is the one
 * piece of the extension that writes to the user's configuration, and it is
 * tested against a temp file rather than through a fake `pi`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SetupResult =
	| { ok: true; path: string }
	| { ok: false; path: string; reason: string };

export function defaultSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/**
 * Return whether `quietStartup` is enabled at the given settings path.
 *
 * Never throws: a missing file, invalid JSON, or any read error returns false
 * so a startup failure here cannot break a session.
 */
export async function readQuietStartup(path: string): Promise<boolean> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			(parsed as Record<string, unknown>).quietStartup === true
		);
	} catch {
		return false;
	}
}

export async function enableQuietStartup(path: string): Promise<SetupResult> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			// An unreadable file (permissions, etc.) is not a first-run scenario.
			// Treat it as missing but report the real reason.
			return { ok: false, path, reason: `could not read ${path}: ${String(error)}` };
		}
		// No settings file yet — first run.
		raw = "{}";
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// Never clobber a file we could not parse: the user's whole configuration
		// is in there, and a rewrite would silently discard it.
		return { ok: false, path, reason: `could not parse ${path}: ${String(error)}` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, path, reason: `${path} is not a settings object` };
	}

	const settings = { ...(parsed as Record<string, unknown>), quietStartup: true };
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(settings, null, "\t")}\n`);
	} catch (error) {
		return { ok: false, path, reason: `could not write ${path}: ${String(error)}` };
	}
	return { ok: true, path };
}
