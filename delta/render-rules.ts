/**
 * The decisions the two render slots make, separated from the wiring that makes
 * them.
 *
 * `index.ts` owns component lifecycle: reusing a component across frames,
 * sharing one between `edit`'s call and result slots through `context.state`,
 * and returning the empty component that stops a row painting twice. None of
 * that is expressible without pi's render context, and pretending otherwise
 * would mean passing four pi objects into a "pure" module.
 *
 * What *is* expressible without it is everything in this file: which renderer a
 * result should go to, what text to pull out of it, which background pi would
 * have painted, what the timing line says, and how a path is displayed. Those
 * are the parts worth testing directly rather than through a fake pi, and a few
 * of them guard behaviour that is otherwise hard to reach — see
 * `isOurComponent` and `backgroundKey`.
 */

import { plain } from "./ansi.ts";
import { isDiffCommand } from "./detect.ts";

/** The parts of a tool result this module reads. */
interface TextPart {
	type: string;
	text?: string;
}

/**
 * Whether a component pi handed back is one of ours.
 *
 * This exists to prevent a crash, not for tidiness. pi's bash `execute` calls
 * `onUpdate` immediately, so a diff command's *partial* result is rendered by us
 * before an error can arrive, and `context.lastComponent` is then our component.
 * If the result then has to go to pi's own renderer, pi does
 * `context.lastComponent ?? new BashResultRenderComponent()` followed by
 * `component.clear()` — and ours has no `clear`, so pi throws a TypeError inside
 * its own renderer, catches it, and dumps the whole untruncated output with no
 * preview, no expand hint, no warnings and no timing.
 *
 * `git diff --exit-code`, `git diff --quiet`, `git show <bad-ref>` and `git diff`
 * outside a repository all take that path. Structural detection (`update` is a
 * function) rather than `instanceof`, because the component is a plain object
 * built by a factory.
 */
export function isOurComponent(component: unknown): boolean {
	return typeof (component as { update?: unknown } | undefined)?.update === "function";
}

/**
 * Whether this bash result should be rendered by delta rather than by pi.
 *
 * Errors keep pi's rendering because the text is a message, not a diff, and the
 * command matcher decides the rest. Both halves matter: a diff command that
 * failed still has no diff in it.
 */
export function usesDelta(options: {
	command: string;
	isError: boolean;
	patterns: readonly RegExp[];
}): boolean {
	if (options.isError) return false;
	return isDiffCommand(options.command, options.patterns);
}

/** The `command` argument of a bash call, however pi happens to have typed it. */
export function bashCommand(args: unknown): string {
	return String((args as { command?: unknown } | undefined)?.command ?? "");
}

/**
 * A tool result's text, as pi's own `getTextOutput` would produce it.
 *
 * `plain` is what makes this match: pi strips ANSI and carriage returns before
 * styling, so without it `git -c color.ui=always diff` feeds its own escapes to
 * delta and to the fallback styler, and a CRLF repository puts raw `\r` into
 * pi's frame.
 */
export function resultText(content: readonly TextPart[] | undefined): string {
	return plain(
		(content ?? [])
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	).trim();
}

/**
 * The theme key pi's own `Box.applyBg` would have used for this row.
 *
 * Mirrors `ToolExecutionComponent.updateDisplay`'s `bgFn` selection: pending
 * while the result is partial, error once it has failed, success otherwise. The
 * row's background prefix has to match that exactly, because `restoreBackground`
 * re-emits it after every SGR reset in delta's output (see `ansi.ts`); a
 * mismatch paints one colour over another mid-row.
 *
 * The error case is unreachable from the bash slot today, which is precisely why
 * it is worth having here: the caller returns early on `isError`, so a test that
 * went through the render slot could not reach this branch at all, and the
 * mapping would be pinned by nothing if that guard ever moved.
 */
export function backgroundKey(options: {
	isPartial: boolean;
	isError: boolean;
}): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	if (options.isPartial) return "toolPendingBg";
	if (options.isError) return "toolErrorBg";
	return "toolSuccessBg";
}

/** What pi's timing line says, or nothing if the call never recorded a start. */
export function timing(options: {
	startedAt: number | undefined;
	endedAt: number | undefined;
	isPartial: boolean;
	now: number;
}): { label: string; ms: number } | undefined {
	if (options.startedAt === undefined) return undefined;
	return {
		// pi's own wording: a running command has elapsed time, a finished one took it.
		label: options.isPartial ? "Elapsed" : "Took",
		ms: (options.endedAt ?? options.now) - options.startedAt,
	};
}

/**
 * How an edit's target path is shown: relative to the session cwd when it is
 * inside it, otherwise as given.
 *
 * `path` and `file_path` are both accepted because pi's edit schema has used
 * both spellings; an unnamed target falls back to an ellipsis rather than
 * rendering an empty header.
 */
export function displayPath(args: Record<string, unknown> | undefined, cwd: string): string {
	const raw = String(args?.path ?? args?.file_path ?? "");
	if (raw.startsWith(`${cwd}/`)) return raw.slice(cwd.length + 1);
	return raw || "...";
}
