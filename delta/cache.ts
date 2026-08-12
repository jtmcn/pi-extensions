/**
 * Rendered-diff cache.
 *
 * Three jobs, each guarding a specific failure:
 *   - bounded storage, so a long session does not grow forever;
 *   - negative entries, so a diff delta could not render is not retried on
 *     every repaint for the rest of the session;
 *   - in-flight keys, so N repaints of one diff spawn one process.
 */

import { createHash } from "node:crypto";

export type Entry = { kind: "ready"; text: string } | { kind: "failed" };

export interface Cache {
	get(key: string): Entry | undefined;
	set(key: string, entry: Entry): void;
	inFlight(key: string): boolean;
	markInFlight(key: string): void;
	clearInFlight(key: string): void;
	reset(): void;
	size(): number;
}

/**
 * Identity of a rendered diff: its text, the width it was laid out for, and the
 * config that produced it. A resize or a config edit must miss.
 */
export function cacheKey(text: string, width: number, version: string): string {
	return `${createHash("sha1").update(text).digest("hex")}:${width}:${version}`;
}

export function createCache(limit = 64): Cache {
	const entries = new Map<string, Entry>();
	const pending = new Set<string>();

	return {
		get(key) {
			const entry = entries.get(key);
			if (entry === undefined) return undefined;
			// Map iterates in insertion order, so deleting and re-inserting moves
			// this key to the end and keeps eviction least-recently-*used*.
			entries.delete(key);
			entries.set(key, entry);
			return entry;
		},
		set(key, entry) {
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > limit) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		inFlight: (key) => pending.has(key),
		markInFlight(key) {
			pending.add(key);
		},
		clearInFlight(key) {
			pending.delete(key);
		},
		reset() {
			entries.clear();
			pending.clear();
		},
		size: () => entries.size,
	};
}
