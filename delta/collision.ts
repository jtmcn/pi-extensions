/**
 * Detecting when another extension has taken a tool name delta registered.
 *
 * pi keeps one definition per tool name. `registerTool` replaces the built-in
 * wholesale in `_refreshToolRegistry`, but among *extensions* registration is
 * first-wins: `getAllRegisteredTools` dedupes with `has(name) || set(name, ...)`,
 * so whichever extension loads first keeps the name and any later one silently
 * loses it. Because pi walks its discovery directory with `readdirSync`, the
 * load order — and therefore the winner — is effectively non-deterministic from
 * the user's perspective.
 *
 * `ctx` exposes no window onto this, but `pi.getAllTools()` returns each
 * surviving tool's `sourceInfo`, whose `path` points at whoever owns the name.
 * That is the only observable signal, and it is what this module turns into a
 * warning: if the `bash` (or `edit`) survivor is not delta itself, another
 * extension beat it, and delta's renderer will never run for that tool.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Whether two recorded paths refer to the same loaded extension.
 *
 * pi records `sourceInfo.path` as the *discovery* path (the symlinked directory
 * pi walks), while an extension's own `import.meta.url` is the real file. Both
 * resolve to the same target, so the comparison has to collapse symlinks —
 * otherwise a healthy install reads as a collision and the user is told they
 * lost a tool they actually own. A path that cannot be resolved (a stale one,
 * or a synthetic `<sdk:...>`/`<builtin:...>` on the way through) falls back to
 * a lexical `resolve` compare rather than throwing.
 */
export function sameRegistrationPath(a: string, b: string): boolean {
	const real = (p: string): string => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	};
	return real(a) === real(b);
}

export interface ToolSurvivor {
	name: string;
	/** `sourceInfo.path` of the surviving entry for this name. */
	path: string;
	/** `sourceInfo.source` — "builtin", "local", "sdk", ... */
	source: string;
}

export interface ToolCollision {
	/** The tool name delta registered but does not own. */
	name: string;
	/** Whoever owns it instead, as a human-readable location. */
	owner: string;
}

/**
 * Which of `ownedNames` delta lost to another extension.
 *
 * Three kinds of entry are not collisions:
 *   - absent: the name is not in the current tool set, so there is nothing
 *     being rendered for it to fight over;
 *   - owned by pi's built-in: nothing overrode pi's own definition (delta was
 *     filtered out entirely, not beaten by a real owner) — non-actionable;
 *   - owned by this extension itself (same path) — delta won.
 *
 * Every other owner — another local extension, or an SDK-registered tool with
 * its synthetic path — is a collision, because it means the definition that
 * actually runs (and renders) is not delta's.
 *
 * `same` compares a survivor's path against `ownPath`; it defaults to
 * `sameRegistrationPath` (symlink-aware) but is injectable so tests can run
 * without real files.
 */
export function toolCollisions(
	tools: readonly ToolSurvivor[],
	ownPath: string,
	ownedTools: readonly string[],
	same: (a: string, b: string) => boolean = sameRegistrationPath,
): ToolCollision[] {
	const lost: ToolCollision[] = [];
	for (const name of ownedTools) {
		const entry = tools.find((tool) => tool.name === name);
		if (!entry) continue;
		if (entry.source === "builtin") continue;
		if (same(entry.path, ownPath)) continue;
		lost.push({
			name,
			// A local path is enough on its own; a synthetic `<sdk:...>` needs its
			// source label to mean anything to the user.
			owner: entry.source === "local" ? entry.path : `${entry.source} ${entry.path}`.trim(),
		});
	}
	return lost;
}