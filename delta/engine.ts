/**
 * When delta runs, and what the renderer sees while it has not answered yet.
 *
 * `lookup` is called from a synchronous render, so it can only ever return what
 * is already cached. On a miss it schedules delta and asks for a repaint when
 * the answer arrives. Everything else here exists to stop that loop from
 * misbehaving:
 *
 *   - in-flight keys, so a component rendered five times spawns one process;
 *   - negative entries, so a failure is not retried on every later frame;
 *   - a generation counter, so a run that finishes after its session was
 *     replaced never touches the stale `invalidate` — that throws "extension
 *     ctx is stale" and takes the process down.
 */

import { type Cache, cacheKey } from "./cache.ts";
import type { DeltaConfig } from "./config.ts";
import type { Runner } from "./run.ts";

export interface Engine {
	/**
	 * Delta's rendering of `text` at `width` if it is ready, otherwise undefined
	 * with a run scheduled. `invalidate` is called once, later, if that run
	 * produces something and the session is still current.
	 */
	lookup(text: string, width: number, invalidate: () => void): string | undefined;
	/** Drop all session state: cache, probe, warning, and in-flight runs. */
	reset(): void;
}

export interface EngineDeps {
	cache: Cache;
	runner: Runner;
	config: () => DeltaConfig;
	version: () => string;
	/** Called at most once per session when the binary is missing. */
	onUnavailable?: () => void;
}

export function createEngine(deps: EngineDeps): Engine {
	let generation = 0;
	let warned = false;

	return {
		lookup(text, width, invalidate) {
			const config = deps.config();
			if (!config.enabled || !text) return undefined;
			// A huge diff is shown as a handful of collapsed lines, so rendering it
			// in full would spend a subprocess on output nobody reads.
			if (Buffer.byteLength(text, "utf-8") > config.maxBytes) return undefined;

			const key = cacheKey(text, width, deps.version());
			const entry = deps.cache.get(key);
			if (entry?.kind === "ready") return entry.text;
			if (entry?.kind === "failed") return undefined;
			if (deps.cache.inFlight(key)) return undefined;

			deps.cache.markInFlight(key);
			const started = generation;

			void (async () => {
				let output: string | undefined;
				try {
					if (await deps.runner.available()) {
						output = await deps.runner.render(text, width);
					} else if (!warned) {
						warned = true;
						deps.onUnavailable?.();
					}
				} catch {
					output = undefined;
				}

				deps.cache.clearInFlight(key);
				// The negative entry is what stops the next frame from starting this
				// run over again, for the rest of the session.
				deps.cache.set(key, output === undefined ? { kind: "failed" } : { kind: "ready", text: output });

				if (started !== generation || output === undefined) return;
				try {
					invalidate();
				} catch {
					// The component outlived its session. Nothing to repaint.
				}
			})();

			return undefined;
		},
		reset() {
			generation += 1;
			warned = false;
			deps.cache.reset();
			deps.runner.reset();
		},
	};
}
