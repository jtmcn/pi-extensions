/**
 * The diff body pi paints, in delta's rendering or pi's own.
 *
 * Shaped as a pi TUI component: `render(width)` returns lines, and `width` is
 * the real render width, which is how a resize gets delta re-run at the size it
 * will actually be displayed at.
 *
 * `patch` is a standard unified patch (delta needs the `diff --git` header to
 * know the filename and pick a grammar); `diff` is pi's display diff, which is
 * all `renderDiff` accepts. Both come from the same tool result.
 */

import type { Engine } from "./engine.ts";

export interface DiffBody {
	render(width: number): string[];
	invalidate(): void;
	set(patch: string | undefined, diff: string | undefined): void;
}

export interface DiffBodyDeps {
	engine: Engine;
	/** pi's `renderDiff`, used until delta answers and whenever it cannot. */
	fallback: (diff: string) => string;
	/** Ask pi to repaint this tool row. */
	invalidate: () => void;
	/**
	 * Expand `sanitize`'s erase-in-line sentinel (see `delta/ansi.ts`) into the
	 * padding delta used it for, width-aware. A no-op on text with no sentinel,
	 * so it is safe to call on delta's output and pi's fallback text alike.
	 */
	fill: (text: string, width: number) => string;
	/**
	 * Wrap text to `width`, ANSI-aware, one array entry per visual line.
	 *
	 * Not cosmetic: pi's renderer throws "Rendered line N exceeds terminal width"
	 * and stops the TUI when a component hands back a line wider than the width it
	 * was given, and nothing downstream clips for us. Neither delta (which is told
	 * a width but may still emit a longer line) nor pi's own `renderDiff` (which
	 * is not told one at all) can be trusted to fit.
	 */
	wrap: (text: string, width: number) => string[];
}

export function createDiffBody(deps: DiffBodyDeps): DiffBody {
	let patch: string | undefined;
	let diff: string | undefined;

	return {
		set(nextPatch, nextDiff) {
			patch = nextPatch;
			diff = nextDiff;
		},
		invalidate() {
			// Nothing is cached here; the engine owns the cache.
		},
		render(width) {
			const rendered = patch ? deps.engine.lookup(patch, width, deps.invalidate) : undefined;
			// `rendered` went through sanitize() (see run.ts), which now strips pre-
			// existing U+E000. The fallback (pi's renderDiff) has not, so strip here
			// before fill() can mistake content glyphs for erase-in-line sentinels.
			const raw = rendered ?? (diff ? deps.fallback(diff).replace(/\uE000/g, "") : undefined);
			if (!raw) return [];
			const text = deps.fill(raw, width);
			// The leading blank line matches pi's own Spacer before a diff.
			return ["", ...deps.wrap(text, width)];
		},
	};
}
