/**
 * A stand-in for pi's bash result rendering, for diff commands only.
 *
 * Substituting delta's output into the tool result is not possible: pi's
 * `getTextOutput` runs `stripAnsi` over result content before styling it. So for
 * a diff command this component replaces pi's, and has to reproduce what pi's
 * does — collapsed preview, expand hint, truncation warning, timing.
 *
 * `PREVIEW_LINES` and `formatDuration` are copies of unexported values in pi's
 * `bash.js`. `tests/delta/bash-result.test.mjs` reads pi's source and fails if
 * either changes, so the divergence is caught rather than discovered.
 *
 * One deliberate difference from pi: no `setInterval` ticking the elapsed-time
 * line. pi refreshes it once a second from a timer; a diff command finishes in
 * milliseconds, and a timer that outlives its session is the single most
 * dangerous thing an extension can hold.
 */

import type { Engine } from "./engine.ts";

/** Pinned copy of pi's `BASH_PREVIEW_LINES` (core/tools/bash.js). */
export const PREVIEW_LINES = 5;

/** Pinned copy of pi's `formatDuration` (core/tools/bash.js). */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export interface ThemeLike {
	fg(color: string, text: string): string;
}

export type TruncateFn = (
	text: string,
	maxLines: number,
	width: number,
) => { visualLines: string[]; skippedCount: number };

export interface BashResultInput {
	/** The diff text, with pi's truncation footer already split off. */
	body: string;
	/** Parts of the `[…]` warning line, from `bashWarnings`. */
	warnings: string[];
	expanded: boolean;
	timing?: { label: string; ms: number };
}

export interface BashResult {
	render(width: number): string[];
	invalidate(): void;
	update(input: BashResultInput): void;
}

export interface BashResultDeps {
	engine: Engine;
	theme: ThemeLike;
	/** pi's per-line `toolOutput` styling, used until delta answers. */
	fallback: (text: string) => string;
	invalidate: () => void;
	/** pi's `truncateToVisualLines`, injected so tests need no TUI. */
	truncate: TruncateFn;
	/** pi's expand hint, which needs the keybinding registry. */
	expandHint: (skipped: number) => string;
	/**
	 * Expand `sanitize`'s erase-in-line sentinel (see `delta/ansi.ts`) into the
	 * padding delta used it for, width-aware. A no-op on text with no sentinel,
	 * so it is safe to call on delta's output and pi's fallback text alike.
	 */
	fill: (text: string, width: number) => string;
	/**
	 * Wrap text to `width`, ANSI-aware, one array entry per visual line.
	 *
	 * pi's renderer throws "Rendered line N exceeds terminal width" and stops the
	 * TUI when a component emits a line wider than its render width. `truncate`
	 * already wraps the collapsed preview; the expanded body, the hint, the
	 * warning line, and the timing line all need this. (pi's own bash renderer
	 * truncates its hint instead; wrapping keeps the whole hint readable and is
	 * equally safe.)
	 */
	wrap: (text: string, width: number) => string[];
}

export function createBashResult(deps: BashResultDeps): BashResult {
	let input: BashResultInput = { body: "", warnings: [], expanded: false };

	return {
		update(next) {
			input = next;
		},
		invalidate() {
			// The engine owns the cache; nothing to drop here.
		},
		render(width) {
			const lines: string[] = [];
			const rendered = input.body ? deps.engine.lookup(input.body, width, deps.invalidate) : undefined;
			const raw = rendered ?? (input.body ? deps.fallback(input.body) : "");
			const text = raw ? deps.fill(raw, width) : "";

			if (text) {
				if (input.expanded) {
					lines.push("", ...deps.wrap(text, width));
				} else {
					const preview = deps.truncate(text, PREVIEW_LINES, width);
					lines.push("");
					if (preview.skippedCount > 0) lines.push(...deps.wrap(deps.expandHint(preview.skippedCount), width));
					lines.push(...preview.visualLines);
				}
			}

			if (input.warnings.length > 0) {
				lines.push("", ...deps.wrap(deps.theme.fg("warning", `[${input.warnings.join(". ")}]`), width));
			}
			if (input.timing) {
				lines.push(
					"",
					...deps.wrap(deps.theme.fg("muted", `${input.timing.label} ${formatDuration(input.timing.ms)}`), width),
				);
			}

			return lines;
		},
	};
}
