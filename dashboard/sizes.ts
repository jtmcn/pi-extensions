/**
 * What each skill costs to load.
 *
 * Size is SKILL.md alone, not the skill directory: `read`-ing the skill is what
 * you pay, and a 3 KB SKILL.md inside a 96 KB directory should not read as
 * expensive.
 */

import { stat } from "node:fs/promises";
import type { ParsedSkill } from "./skills.ts";

export interface SizedSkill extends ParsedSkill {
	/** undefined when the file could not be stat'd. */
	tokens: number | undefined;
}

/** Eight levels, so a bar is always exactly one column wide. */
const GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export async function measureSkills(skills: ParsedSkill[]): Promise<SizedSkill[]> {
	return Promise.all(
		skills.map(async (skill) => {
			try {
				const info = await stat(skill.location);
				return { ...skill, tokens: Math.round(info.size / 4) };
			} catch {
				// A skill listed in the prompt but gone from disk is odd, not fatal.
				return { ...skill, tokens: undefined };
			}
		}),
	);
}

/**
 * Relative to the largest skill, not to an absolute scale.
 *
 * Absolute scaling renders 30 of 35 skills as `▁` and tells you nothing.
 */
export function barGlyph(tokens: number | undefined, max: number): string {
	if (tokens === undefined || max <= 0) return " ";
	const level = Math.ceil((tokens / max) * GLYPHS.length);
	return GLYPHS[Math.min(GLYPHS.length - 1, Math.max(0, level - 1))];
}

export function totalTokens(skills: SizedSkill[]): number {
	return skills.reduce((sum, skill) => sum + (skill.tokens ?? 0), 0);
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const thousands = tokens / 1000;
	return thousands >= 10 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`;
}
