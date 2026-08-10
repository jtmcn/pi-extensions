/**
 * Startup dashboard for pi.
 *
 * Replaces pi's built-in startup header with a screen that says where you are,
 * what skills are loaded and what they cost, and whatever the other extensions
 * in this collection have to report.
 *
 * Requires `"quietStartup": true` in `~/.pi/agent/settings.json`, because pi's
 * own resource listing lives in a container `setHeader` cannot reach and only
 * that setting suppresses it. `/dashboard setup` writes it.
 *
 * This file is wiring only:
 *
 *   skills.ts   what pi loaded, recovered from the system prompt
 *   sizes.ts    what each skill costs to read
 *   layout.ts   columns that never wrap
 *   render.ts   the screen itself
 *   ../lib/panels.ts   what other extensions contribute
 *
 * The one rule to preserve: **the header component must never close over
 * `ctx`.** Panels update asynchronously, and a repaint that reached a
 * superseded context would throw "extension ctx is stale" and take pi down.
 * The component closes over `tui` and a module-level model instead.
 */

import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { listPanels, subscribe } from "../lib/panels.ts";
import { type DashboardModel, renderDashboard } from "./render.ts";
import { measureSkills } from "./sizes.ts";
import { parseContextFiles, parseSkills } from "./skills.ts";

export default function (pi: ExtensionAPI) {
	/**
	 * The current screen's data, replaced wholesale on every `session_start`.
	 *
	 * The header component reads this rather than capturing a model, so a
	 * repaint triggered by a late panel update always renders current data.
	 */
	let model: DashboardModel | undefined;

	pi.on("session_start", async (_event, ctx) => {
		model = undefined;
		if (ctx.mode !== "tui") return;

		const prompt = ctx.getSystemPrompt();
		const parsed = parseSkills(prompt);
		const commands = pi.getCommands();

		model = {
			version: VERSION,
			skills: await measureSkills(parsed.skills),
			skillsAvailable: !parsed.present || parsed.skills.length > 0,
			contextFiles: parseContextFiles(prompt),
			prompts: commands.filter((c) => c.source === "prompt").map((c) => `/${c.name}`),
			extensions: [
				...new Set(
					commands
						.filter((c) => c.source === "extension")
						.map((c) => c.sourceInfo?.source || c.name),
				),
			].sort(),
			panels: [],
		};

		ctx.ui.setHeader((tui, theme) => {
			let expanded = false;
			// Repaint when a panel arrives or changes. `tui` outlives the turn
			// safely; `ctx` would not.
			const unsubscribe = subscribe(() => tui.requestRender());
			// Typed structurally rather than as pi's `Component`: that type comes
			// from pi-tui and is not re-exported from the package entry.
			const component: {
				render(width: number): string[];
				invalidate(): void;
				setExpanded(value: boolean): void;
				dispose(): void;
			} = {
				render(width: number): string[] {
					if (!model) return [];
					const rendered = renderDashboard({ ...model, panels: listPanels() }, theme, width);
					return expanded ? rendered.expanded : rendered.collapsed;
				},
				invalidate() {},
				setExpanded(value: boolean) {
					expanded = value;
				},
				dispose() {
					unsubscribe();
				},
			};
			return component;
		});
	});

	pi.on("session_shutdown", () => {
		model = undefined;
	});
}
