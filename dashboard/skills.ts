/**
 * Skills and context files from pi's resource loader.
 *
 * Skills come from `pi.getCommands()`, not the system prompt. The system-prompt
 * approach used `formatSkillsForPrompt`, which drops every skill whose
 * frontmatter has `disable-model-invocation: true` (core/skills.js:258). On a
 * real machine that silently hid four skills — `merge`, `open-pr`, `rebase`,
 * and `worktree` — exactly the ones invoked by name. `getCommands()` returns
 * the resource loader's list unfiltered, with `sourceInfo.path` pointing at
 * each skill's SKILL.md, which is what `measureSkills` and `skillScope` need.
 */

export interface ParsedSkill {
	name: string;
	description: string;
	location: string;
}

const CONTEXT_PATH = /<project_instructions\s+path="([^"]*)"/g;

/** The shape of `pi.getCommands()` entries this module needs. */
interface SkillCommand {
	name: string;
	description?: string;
	source: string;
	sourceInfo?: { path?: string };
}

/**
 * The loaded skills, from `pi.getCommands()`.
 *
 * Not from the system prompt: `formatSkillsForPrompt` drops every skill with
 * `disable-model-invocation: true` (`core/skills.js:258`), so parsing the
 * prompt silently hid the skills you invoke by name. `getCommands()` reports
 * the resource loader's list unfiltered, and `sourceInfo.path` is the skill's
 * SKILL.md — which is what `measureSkills` and `skillScope` need.
 */
export function skillsFromCommands(commands: readonly SkillCommand[]): ParsedSkill[] {
	const skills: ParsedSkill[] = [];
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const location = command.sourceInfo?.path;
		// A skill we cannot locate cannot be measured or scoped; listing it
		// without either would be worse than omitting it.
		//
		// Asymmetry note: `SlashCommandInfo.sourceInfo` is required and
		// `SourceInfo.path` is typed `string`, so this guard is unreachable
		// through the declared API. It is kept anyway because the failure mode
		// — a skill vanishing from the list and the count, silently — is the
		// exact class of bug this branch exists to fix. Removing a defence
		// whose cost is one `continue` is not worth the risk.
		if (!location) continue;
		skills.push({
			name: command.name.replace(/^skill:/, ""),
			description: command.description ?? "",
			location,
		});
	}
	return skills;
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
