/**
 * Compose the startup screen.
 *
 * Pure: a model, a theme and a width in, two arrays of lines out. Everything
 * that needs the filesystem, git or pi happens before this is called, so the
 * whole screen is testable without a session.
 */

import { layoutRows } from "./layout.ts";
import { type MascotTheme, mascotLines } from "./mascot.ts";
import type { Panel } from "../lib/panels.ts";
import { barGlyph, formatTokens, type SizedSkill, totalTokens } from "./sizes.ts";
import { skillScope } from "./skills.ts";

export type { MascotTheme };

export interface DashboardModel {
	version: string;
	skills: SizedSkill[];
	/** false when the prompt held a skills block this could not parse. */
	skillsAvailable: boolean;
	contextFiles: string[];
	prompts: string[];
	extensions: string[];
	/**
	 * Pre-sorted by order then id; `listPanels()` from lib/panels.ts provides
	 * this ordering. `renderDashboard` renders panels in the order it receives them.
	 */
	panels: Panel[];
}

export interface Rendered {
	collapsed: string[];
	expanded: string[];
}

const INDENT = 4;
const PROMPT_PREVIEW = 2;

function heading(theme: MascotTheme, title: string, detail?: string): string {
	const label = theme.fg("mdHeading", `[${title}]`);
	return detail ? `${label}  ${theme.fg("dim", detail)}` : label;
}

/** Preserve first-seen order so scopes do not shuffle between sessions. */
function groupByScope(skills: SizedSkill[]): Map<string, SizedSkill[]> {
	const groups = new Map<string, SizedSkill[]>();
	for (const skill of skills) {
		const scope = skillScope(skill.location);
		const bucket = groups.get(scope);
		if (bucket) bucket.push(skill);
		else groups.set(scope, [skill]);
	}
	for (const bucket of groups.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
	return groups;
}

function renderSkills(model: DashboardModel, theme: MascotTheme, width: number, expanded: boolean): string[] {
	if (!model.skillsAvailable) {
		return [heading(theme, "Skills", "unavailable (pi format changed)")];
	}
	if (model.skills.length === 0) return [];

	const total = totalTokens(model.skills);
	const max = Math.max(...model.skills.map((s) => s.tokens ?? 0));
	const lines = [
		heading(theme, "Skills", `${model.skills.length} · ~${formatTokens(total)} tok if all read`),
	];

	for (const [scope, skills] of groupByScope(model.skills)) {
		lines.push(theme.fg("muted", `  ${scope} (${skills.length})`));
		if (expanded) {
			for (const skill of skills) {
				const bar = barGlyph(skill.tokens, max);
				lines.push(`${" ".repeat(INDENT)}${skill.name} ${theme.fg("accent", bar)}`);
				lines.push(theme.fg("dim", `${" ".repeat(INDENT + 2)}${skill.description}`.slice(0, width)));
			}
			continue;
		}
		const cells = skills.map((skill) => ({ label: skill.name, bar: barGlyph(skill.tokens, max) }));
		for (const row of layoutRows(cells, width, INDENT)) {
			const rendered = row.map((cell) => `${cell.label} ${theme.fg("accent", cell.bar)}`).join("  ");
			lines.push(`${" ".repeat(INDENT)}${rendered}`);
		}
	}
	return lines;
}

export function renderDashboard(model: DashboardModel, theme: MascotTheme, width: number): Rendered {
	const build = (expanded: boolean): string[] => {
		const lines = [...mascotLines(theme, model.version), ""];

		for (const panel of model.panels) {
			lines.push(heading(theme, panel.title));
			lines.push(...panel.render(width));
			lines.push("");
		}

		const skills = renderSkills(model, theme, width, expanded);
		if (skills.length > 0) lines.push(...skills, "");

		if (model.contextFiles.length > 0) {
			if (expanded) {
				lines.push(heading(theme, "Context"));
				for (const file of model.contextFiles) lines.push(theme.fg("dim", `  ${file}`));
			} else {
				lines.push(heading(theme, "Context", model.contextFiles.join(", ")));
			}
		}

		if (model.prompts.length > 0) {
			if (expanded) {
				lines.push(heading(theme, "Prompts"));
				for (const prompt of model.prompts) lines.push(theme.fg("dim", `  ${prompt}`));
			} else {
				const shown = model.prompts.slice(0, PROMPT_PREVIEW);
				const rest = model.prompts.length - shown.length;
				const summary = `${model.prompts.length} · ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
				lines.push(heading(theme, "Prompts", summary));
			}
		}

		// Extensions are four names you already know; only worth the room when
		// the screen is already expanded.
		if (expanded && model.extensions.length > 0) {
			lines.push(heading(theme, "Extensions"));
			lines.push(theme.fg("dim", `  ${model.extensions.join(", ")}`));
		}

		// Truncation here is the last line of defence: a panel is free to
		// return anything, and the header must never wrap.
		return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
	};

	return { collapsed: build(false), expanded: build(true) };
}
