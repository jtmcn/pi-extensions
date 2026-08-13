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

import { restoreBackground } from "./ansi.ts";
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
	/**
	 * The ANSI prefix pi's own `Box.applyBg` puts at the start of this row —
	 * `theme.bg(key, ...)`'s prefix half, chosen from `toolPendingBg` /
	 * `toolSuccessBg` / `toolErrorBg` the way `ToolExecutionComponent` does.
	 * Re-emitted after every reset in the body so a reset inside our own
	 * content cannot cancel the box's background for the rest of the row (see
	 * `restoreBackground` in `delta/ansi.ts`). Empty when this row has no box
	 * to restore.
	 */
	bgPrefix: string;
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

/**
 * A collapsed preview whose first row starts a logical ("\n"-separated) line,
 * never in the middle of one delta did not wrap itself.
 *
 * Delta will not wrap its own output when stdout is a pipe (`--width` and
 * `--wrap-max-lines` are both defeated, verified against real 0.19.2), so this
 * extension's own `wrap` step turns one long diff line into several visual
 * rows. `truncate` (pi's `truncateToVisualLines`) picks the last `maxVisualLines`
 * *visual* rows with no memory of where a logical line began, so its naive cut
 * can land mid-continuation — the reported bug: a preview starting inside a
 * wrapped line, gutter and all, on the row above.
 *
 * The fix re-derives, from the same `wrap`, which visual row starts each
 * logical line, and if the naive cut is not one of them, drops forward to the
 * next one — shrinking what's shown, never growing it. `skippedCount` grows by
 * exactly what was dropped, so the `... (N earlier lines, …)` hint stays
 * truthful. If no later logical-line start exists before the end (one
 * enormous single line with nothing after it), the naive cut is kept rather
 * than dropping to an empty preview.
 */
export function collapsedPreview(
	text: string,
	maxVisualLines: number,
	width: number,
	wrap: (text: string, width: number) => string[],
	truncate: TruncateFn,
): { visualLines: string[]; skippedCount: number } {
	const naive = truncate(text, maxVisualLines, width);
	if (naive.skippedCount === 0) return naive;

	// Row count per logical line: how many visual rows `wrap` turns it into.
	// A blank logical line still occupies one (empty) visual row when it sits
	// inside a larger text — `wrap`'s underlying `truncateToVisualLines`
	// special-cases an empty *whole* input to zero rows, which does not apply to
	// one blank line among others, hence the explicit `1` below.
	const lines = text.split("\n");
	const starts = new Set<number>();
	let index = 0;
	for (const line of lines) {
		starts.add(index);
		index += line === "" ? 1 : Math.max(1, wrap(line, width).length);
	}
	const total = index;

	if (starts.has(naive.skippedCount)) return naive;

	let next = naive.skippedCount + 1;
	while (next < total && !starts.has(next)) next += 1;
	if (next >= total) return naive;

	const all = wrap(text, width);
	return { visualLines: all.slice(next), skippedCount: next };
}

export function createBashResult(deps: BashResultDeps): BashResult {
	let input: BashResultInput = { body: "", warnings: [], expanded: false, bgPrefix: "" };

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
			// Restore the box background after every reset in `raw` *before* `fill`
			// expands its erase-in-line sentinel: the expanded padding then sits
			// between whichever background SGR precedes the sentinel and this
			// restored prefix, and inherits the right colour either way.
			const restored = raw ? restoreBackground(raw, input.bgPrefix) : "";
			const text = restored ? deps.fill(restored, width) : "";

			if (text) {
				if (input.expanded) {
					lines.push("", ...deps.wrap(text, width));
				} else {
					const preview = collapsedPreview(text, PREVIEW_LINES, width, deps.wrap, deps.truncate);
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
