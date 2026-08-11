import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { skillsFromCommands, parseContextFiles, skillScope } = await loadExt("dashboard/skills.ts");

const commands = [
	{
		name: "skill:brainstorming",
		description: "Explores intent before implementation",
		source: "skill",
		sourceInfo: { path: "/u/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md" },
	},
	{
		// disable-model-invocation: absent from the system prompt, present here.
		name: "skill:merge",
		description: "Commit, rebase, and merge the current branch.",
		source: "skill",
		sourceInfo: { path: "/u/.pi/agent/skills/merge/SKILL.md" },
	},
	{ name: "parallel-cleanup", description: "a prompt", source: "prompt", sourceInfo: { path: "/u/p.md" } },
	{ name: "worktree", description: "an extension", source: "extension", sourceInfo: { path: "/u/worktree/index.ts" } },
];

const skills = skillsFromCommands(commands);
ok("only skill commands become skills", skills.length === 2);
ok("strips the skill: prefix", skills[0].name === "brainstorming");
ok("keeps the description", skills[0].description === "Explores intent before implementation");
ok("uses sourceInfo.path as the location", skills[0].location.endsWith("brainstorming/SKILL.md"));
ok(
	"includes a skill the model cannot invoke",
	skills.some((s) => s.name === "merge"),
);
ok("preserves order", skills.map((s) => s.name).join(",") === "brainstorming,merge");
ok("empty input yields no skills", skillsFromCommands([]).length === 0);
ok("a skill with no sourceInfo is dropped", skillsFromCommands([{ name: "skill:x", source: "skill" }]).length === 0);
ok(
	"a missing description becomes empty, not undefined",
	skillsFromCommands([{ name: "skill:y", source: "skill", sourceInfo: { path: "/y/SKILL.md" } }])[0].description === "",
);
ok("scope still derives from the location", skillScope(skills[1].location) === "personal");

// --- Scope derivation ---
const scopes = [
	["/Users/x/.pi/agent/git/github.com/obra/superpowers/skills/a/SKILL.md", "superpowers"],
	["/Users/x/.pi/agent/npm/node_modules/pi-subagents/skills/a/SKILL.md", "pi-subagents"],
	["/Users/x/.pi/agent/npm/node_modules/@scope/pkg/skills/a/SKILL.md", "@scope/pkg"],
	["/Users/x/.pi/agent/skills/a/SKILL.md", "personal"],
	["/Users/x/Code/proj/.pi/skills/a/SKILL.md", "project"],
];
for (const [path, expected] of scopes) {
	ok(`scope: ${expected}`, skillScope(path) === expected, `got ${skillScope(path)}`);
}

// --- Context files ---
const withContext = `
<project_context>
<project_instructions path="/Users/x/Code/proj/AGENTS.md">
# Working here
</project_instructions>
<project_instructions path="/Users/x/Code/proj/CLAUDE.md">
more
</project_instructions>
</project_context>`;
const files = parseContextFiles(withContext);
ok("context: both files", files.length === 2);
ok("context: first path", files[0] === "/Users/x/Code/proj/AGENTS.md");
ok("context: none when absent", parseContextFiles("nothing here").length === 0);

done();
