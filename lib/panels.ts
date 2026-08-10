/**
 * A registry of panels the dashboard renders.
 *
 * The dashboard cannot know what a graphite stack is or whether an MCP server
 * connected — the extensions that own that knowledge push it here instead.
 *
 * State hangs off `globalThis` rather than module scope. Extensions are
 * separate top-level modules loaded by pi, and nothing promises they share a
 * module instance; a well-known symbol is true regardless.
 */

/**
 * A section contributed to the dashboard.
 *
 * Two invariants that allow `render.ts` to composite panels safely:
 *   1. `render` must not throw — a throwing panel takes the whole header down.
 *   2. `render` must return plain text with no ANSI escape sequences —
 *      the caller clips lines with `truncateVisible`, which relies on that.
 */
export interface Panel {
	/** Unique across all extensions. Re-registering an id replaces it. */
	id: string;
	/** The extension that owns it, so `resetPanels` can scope to one. */
	owner: string;
	/** Section heading, rendered as `[title]`. */
	title: string;
	/** Ascending. Ties break on id. */
	order: number;
	render(width: number): string[];
}

interface Registry {
	panels: Map<string, Panel>;
	listeners: Set<() => void>;
}

const KEY = Symbol.for("pi-extensions.panels");

function registry(): Registry {
	// Double cast: `globalThis` and an index signature do not overlap, so the
	// single-step version is an error rather than a widening.
	const host = globalThis as unknown as Record<symbol, unknown>;
	if (!host[KEY]) host[KEY] = { panels: new Map(), listeners: new Set() } satisfies Registry;
	return host[KEY] as Registry;
}

function notify(): void {
	for (const listener of registry().listeners) {
		// One extension's broken listener must not stop the others from painting.
		try {
			listener();
		} catch {}
	}
}

export function registerPanel(panel: Panel): void {
	registry().panels.set(panel.id, panel);
	notify();
}

/** Announce that a panel's `render` would now return something different. */
export function updatePanel(id: string): void {
	if (!registry().panels.has(id)) return;
	notify();
}

/**
 * Drop every panel one extension registered.
 *
 * Scoped to an owner because `session_start` fires once per extension, and the
 * first to run must not wipe panels the others already registered.
 */
export function resetPanels(owner: string): void {
	const { panels } = registry();
	for (const [id, panel] of panels) {
		if (panel.owner === owner) panels.delete(id);
	}
	notify();
}

export function listPanels(): Panel[] {
	return [...registry().panels.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
	const { listeners } = registry();
	listeners.add(listener);
	return () => listeners.delete(listener);
}
