import { assertions, loadExt, piEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { parseSkills, parseContextFiles, skillScope } = await loadExt("dashboard/skills.ts");
const { formatSkillsForPrompt } = await import(await piEntry());

// --- Round-trip against pi's own formatter ---
const fixtures = [
	{
		name: "brainstorming",
		description: "Explores user intent & requirements <before> \"work\"",
		filePath: "/Users/x/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md",
		disableModelInvocation: false,
	},
	{
		name: "coordinator",
		description: "Orchestrate multiple worktree agents.",
		filePath: "/Users/x/.pi/agent/skills/coordinator/SKILL.md",
		disableModelInvocation: false,
	},
];
const prompt = `You are pi.${formatSkillsForPrompt(fixtures)}\n\nMore prompt.`;
const parsed = parseSkills(prompt);

ok("round-trip: block detected", parsed.present);
ok("round-trip: every skill recovered", parsed.skills.length === 2);
ok("round-trip: names", parsed.skills.map((s) => s.name).join(",") === "brainstorming,coordinator");
ok(
	"round-trip: XML entities decoded",
	parsed.skills[0].description === 'Explores user intent & requirements <before> "work"',
);
ok("round-trip: locations", parsed.skills[1].location === fixtures[1].filePath);

// --- Degradation ---
ok("no block: not present", parseSkills("plain prompt").present === false);
ok("no block: no skills", parseSkills("plain prompt").skills.length === 0);
const truncated = "<available_skills>\n  <skill>\n    <name>half</name>";
ok("malformed block: present", parseSkills(truncated).present === true);
ok("malformed block: yields nothing", parseSkills(truncated).skills.length === 0);

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
