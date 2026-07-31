/**
 * Focus mode: redirect tool calls into a worktree without moving the session.
 *
 * pi's `ctx.cwd` is immutable for the life of a session, so "switching" to a
 * worktree is implemented by rewriting tool inputs:
 *
 *   - `bash`      -> prefixed with `cd <worktree>`
 *   - path tools  -> relative paths resolve against <worktree>; absolute paths
 *                    inside the session's own worktree are remapped across
 *
 * This is a soft boundary, not a sandbox. Absolute paths outside the session
 * worktree are deliberately left alone so the model can still read anything it
 * legitimately needs (other worktrees, /tmp, system files).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Built-in tools whose `path` argument should follow the focused worktree. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

/** Tools where `path` is optional and defaults to the working directory. */
const OPTIONAL_PATH_TOOLS = new Set(["ls", "find", "grep"]);

export interface FocusTarget {
	/** Absolute path of the focused worktree. */
	path: string;
	/** Branch checked out there, for display. */
	branch?: string;
}

export interface FocusOptions {
	/** The session's own worktree root; source range for absolute remapping. */
	sessionRoot?: string;
	/** Whether absolute paths under `sessionRoot` are remapped. */
	remapAbsolutePaths: boolean;
}

export interface Rewrite {
	kind: "bash" | "path";
	from: string;
	to: string;
}

/**
 * Rewrite a tool input in place. Returns a description of what changed, or
 * undefined when the call was left untouched.
 */
export function applyFocus(
	toolName: string,
	input: Record<string, unknown>,
	target: FocusTarget,
	options: FocusOptions,
): Rewrite | undefined {
	if (toolName === "bash") return rewriteBash(input, target);
	if (PATH_TOOLS.has(toolName)) return rewritePath(toolName, input, target, options);
	return undefined;
}

function rewriteBash(input: Record<string, unknown>, target: FocusTarget): Rewrite | undefined {
	const command = input.command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const prefix = `cd ${shellQuote(target.path)} || exit 1`;
	if (command.startsWith(prefix)) return undefined;

	input.command = `${prefix}\n${command}`;
	return { kind: "bash", from: "$PWD", to: target.path };
}

function rewritePath(
	toolName: string,
	input: Record<string, unknown>,
	target: FocusTarget,
	options: FocusOptions,
): Rewrite | undefined {
	// `read` historically also accepts `file_path`.
	const key = typeof input.path === "string" ? "path" : typeof input.file_path === "string" ? "file_path" : "path";
	const raw = input[key];

	if (raw === undefined || raw === "") {
		if (!OPTIONAL_PATH_TOOLS.has(toolName)) return undefined;
		input[key] = target.path;
		return { kind: "path", from: ".", to: target.path };
	}

	if (typeof raw !== "string") return undefined;

	const next = redirect(raw, target.path, options);
	if (!next || next === raw) return undefined;

	input[key] = next;
	return { kind: "path", from: raw, to: next };
}

/** Compute the focused-worktree equivalent of `path`, or undefined to leave as-is. */
export function redirect(path: string, worktree: string, options: FocusOptions): string | undefined {
	if (!isAbsolute(path)) {
		return resolve(worktree, path);
	}

	if (!options.remapAbsolutePaths) return undefined;

	const sessionRoot = options.sessionRoot;
	if (!sessionRoot || sameOrInside(path, worktree)) return undefined;
	if (!sameOrInside(path, sessionRoot)) return undefined;

	const suffix = relative(sessionRoot, path);
	if (suffix === "" ) return worktree;
	if (suffix.startsWith("..")) return undefined;
	return resolve(worktree, suffix);
}

/** True when `path` is `root` itself or nested inside it. */
export function sameOrInside(path: string, root: string): boolean {
	const normalizedRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
	return path === normalizedRoot || path.startsWith(`${normalizedRoot}${sep}`);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
