/**
 * Recover the loaded skills and context files from the system prompt.
 *
 * `ExtensionContext` exposes no resource loader, so what pi lists in its own
 * startup sections is not directly available. The system prompt is the only
 * route — and it carries descriptions and absolute paths, which is more than
 * the built-in listing shows.
 *
 * This parses a format pi never promised. `tests/dashboard/skills.test.mjs`
 * round-trips through pi's exported `formatSkillsForPrompt` so a format change
 * fails the suite rather than silently emptying the panel.
 */

export interface ParsedSkill {
	name: string;
	description: string;
	location: string;
}

export interface SkillsBlock {
	/** Whether the prompt contained an `<available_skills>` block at all. */
	present: boolean;
	skills: ParsedSkill[];
}

const SKILL_BLOCK = /<available_skills>([\s\S]*?)<\/available_skills>/;
const SKILL_ENTRY = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
const CONTEXT_PATH = /<project_instructions\s+path="([^"]*)"/g;

/** Inverse of pi's `escapeXml`. Order matters: `&amp;` must go last. */
function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export function parseSkills(systemPrompt: string): SkillsBlock {
	const block = SKILL_BLOCK.exec(systemPrompt);
	// An unterminated block still means pi tried: report present so the caller
	// can say "unavailable" rather than "no skills".
	const present = block !== null || systemPrompt.includes("<available_skills>");
	if (!block) return { present, skills: [] };

	const skills: ParsedSkill[] = [];
	SKILL_ENTRY.lastIndex = 0;
	for (const match of block[1].matchAll(SKILL_ENTRY)) {
		skills.push({
			name: unescapeXml(match[1].trim()),
			description: unescapeXml(match[2].trim()),
			location: unescapeXml(match[3].trim()),
		});
	}
	return { present, skills };
}

export function parseContextFiles(systemPrompt: string): string[] {
	const paths: string[] = [];
	CONTEXT_PATH.lastIndex = 0;
	for (const match of systemPrompt.matchAll(CONTEXT_PATH)) {
		if (match[1]) paths.push(match[1]);
	}
	return paths;
}

/**
 * Group label for a skill, derived from where it lives.
 *
 * Package installs are checked before git checkouts because a package can be
 * vendored inside one.
 */
export function skillScope(location: string): string {
	const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(location);
	if (pkg) return pkg[1];

	const git = /\/git\/[^/]+\/[^/]+\/([^/]+)\//.exec(location);
	if (git) return git[1];

	if (location.includes("/agent/skills/")) return "personal";
	return "project";
}
