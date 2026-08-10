/**
 * Where you are, for the dashboard.
 *
 * The dashboard does not know what a graphite stack is and should not shell out
 * to `gt`. This extension already owns repo layout, so it owns this too.
 *
 * `gt ls -s` takes roughly 0.4s, which is too long to block startup: the panel
 * publishes `pending` immediately and republishes when the answer lands.
 */

import { type GitRunner } from "../lib/git.ts";
import { registerPanel, resetPanels } from "../lib/panels.ts";

const OWNER = "worktree";
const PANEL_ID = "location";

/**
 * Which session's stack read is allowed to publish.
 *
 * Bumped on every `session_start`. A read from a superseded session finds its
 * token stale and drops its result instead of overwriting the new session's
 * location.
 */
let locationCycle = 0;

export function beginLocationCycle(): number {
	return ++locationCycle;
}

export function isCurrentLocationCycle(token: number): boolean {
	return token === locationCycle;
}

export interface StackEntry {
	branch: string;
	current: boolean;
	note?: string;
}

export type StackState =
	| { kind: "pending" }
	| { kind: "stack"; entries: StackEntry[] }
	| { kind: "untracked"; branch: string }
	| { kind: "unavailable" };

export interface LocationInfo {
	path: string;
	branch?: string;
	dirty: number;
	ahead?: number;
	behind?: number;
}

/**
 * Parse `gt ls -s`.
 *
 * Lines look like `◉  main` or `│ ◯  joel/feature (needs restack)`. The filled
 * circle marks the current branch; the tree glyphs before it are drawing, not
 * data.
 */
export function parseStack(stdout: string): StackEntry[] {
	const entries: StackEntry[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const match = /([◉◯])\s*[─┘│]*\s+(\S+)(?:\s+\((.+)\))?\s*$/.exec(line);
		if (!match) continue;
		entries.push({
			branch: match[2],
			current: match[1] === "◉",
			...(match[3] ? { note: match[3] } : {}),
		});
	}
	return entries;
}

export async function readStack(
	pi: GitRunner,
	cwd: string,
	branch: string | undefined,
): Promise<StackState> {
	let result: Awaited<ReturnType<GitRunner["exec"]>>;
	try {
		result = await pi.exec("gt", ["ls", "-s"], { cwd });
	} catch {
		// gt is not installed. Not every repo uses graphite; say nothing.
		return { kind: "unavailable" };
	}

	if (result.code !== 0) {
		const message = `${result.stderr}${result.stdout}`;
		// The common case in a worktree this extension created: the branch is
		// real but graphite has never been told about it.
		if (/untracked branch/i.test(message) && branch) return { kind: "untracked", branch };
		return { kind: "unavailable" };
	}

	const entries = parseStack(result.stdout);
	return entries.length > 0 ? { kind: "stack", entries } : { kind: "unavailable" };
}

export function locationLines(location: LocationInfo, stack: StackState, width: number): string[] {
	const facts: string[] = [];
	if (location.dirty > 0) facts.push(`${location.dirty} files dirty`);
	if (location.ahead) facts.push(`↑${location.ahead}`);
	if (location.behind) facts.push(`↓${location.behind}`);

	const head = [
		`  ${location.path}`,
		location.branch ? `⑂ ${location.branch}` : "",
		facts.length > 0 ? `· ${facts.join(" · ")}` : "",
	]
		.filter(Boolean)
		.join("  ");

	const lines = [head];
	if (stack.kind === "pending") lines.push("  reading stack…");
	else if (stack.kind === "untracked") lines.push(`  not in a graphite stack (gt track ${stack.branch})`);
	else if (stack.kind === "stack") {
		for (const entry of stack.entries) {
			const glyph = entry.current ? "◉" : "◯";
			lines.push(`  ${glyph} ${entry.branch}${entry.note ? ` (${entry.note})` : ""}`);
		}
	}
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

export function publishLocationPanel(location: LocationInfo, stack: StackState): void {
	registerPanel({
		id: PANEL_ID,
		owner: OWNER,
		title: "Location",
		order: 10,
		render: (width) => locationLines(location, stack, width),
	});
}

export function clearLocationPanel(): void {
	resetPanels(OWNER);
}
