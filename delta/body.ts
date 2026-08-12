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
			const text = rendered ?? (diff ? deps.fallback(diff) : undefined);
			if (!text) return [];
			// The leading blank line matches pi's own Spacer before a diff.
			return ["", ...text.split("\n")];
		},
	};
}
