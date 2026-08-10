import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { renderDashboard } = await loadExt("dashboard/render.ts");
const { mascotLines } = await loadExt("dashboard/mascot.ts");

/** Identity theme: colors are invisible in a terminal but not in an assertion. */
const theme = { fg: (_color, text) => text, bold: (text) => text };

const skill = (name, location, tokens) => ({ name, description: `does ${name}`, location, tokens });
const model = {
	version: "0.84.1",
	skillsAvailable: true,
	skills: [
		skill("brainstorming", "/u/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md", 2500),
		skill("writing-plans", "/u/.pi/agent/git/github.com/obra/superpowers/skills/writing-plans/SKILL.md", 1700),
		skill("coordinator", "/u/.pi/agent/skills/coordinator/SKILL.md", 1900),
	],
	contextFiles: ["/u/Code/proj/AGENTS.md"],
	prompts: ["/one", "/two", "/three"],
	extensions: ["worktree", "mcp"],
	panels: [
		{ id: "mcp", owner: "mcp", title: "MCP", order: 20, render: () => ["  linear ✓ 12"] },
	],
};

const out = renderDashboard(model, theme, 120);
const collapsed = out.collapsed.join("\n");
const expanded = out.expanded.join("\n");

ok("shows the version", collapsed.includes("0.84.1"));
ok("draws the mascot", collapsed.includes("█"));
ok("skills heading carries the count", /\[Skills\][^\n]*3/.test(collapsed));
ok("skills heading carries the total", /\[Skills\][^\n]*6\.1k/.test(collapsed));
ok("groups by scope", collapsed.includes("superpowers (2)") && collapsed.includes("personal (1)"));
ok("shows skill names", collapsed.includes("brainstorming"));
ok("shows a bar", /brainstorming\s+█/.test(collapsed));
ok("renders registered panels", collapsed.includes("[MCP]") && collapsed.includes("linear ✓ 12"));
ok("collapsed hides descriptions", !collapsed.includes("does brainstorming"));
ok("expanded shows descriptions", expanded.includes("does brainstorming"));
ok("collapsed elides prompts", /\[Prompts\][^\n]*\+1 more/.test(collapsed));
ok("expanded lists every prompt", expanded.includes("/three"));
ok("collapsed hides extensions", !collapsed.includes("[Extensions]"));
ok("expanded lists extensions", expanded.includes("[Extensions]") && expanded.includes("worktree"));
ok("shows context files", collapsed.includes("AGENTS.md"));

// Width invariant, with the identity theme so lengths are real.
for (const width of [120, 90, 60]) {
	const rendered = renderDashboard(model, theme, width);
	const longest = Math.max(...[...rendered.collapsed, ...rendered.expanded].map((l) => l.length));
	ok(`no rendered line exceeds ${width}`, longest <= width, `longest was ${longest}`);
}

// Degradation
const broken = renderDashboard({ ...model, skillsAvailable: false, skills: [] }, theme, 120);
ok("unparseable skills say so", broken.collapsed.join("\n").includes("unavailable"));
const empty = renderDashboard(
	{ version: "1", skills: [], skillsAvailable: true, contextFiles: [], prompts: [], extensions: [], panels: [] },
	theme,
	120,
);
ok("no skills omits the section", !empty.collapsed.join("\n").includes("[Skills]"));
ok("empty model still draws the mascot", empty.collapsed.join("\n").includes("█"));

// Panels render in order
const ordered = renderDashboard(
	{
		...model,
		panels: [
			{ id: "b", owner: "x", title: "BEE", order: 30, render: () => ["  bee"] },
			{ id: "a", owner: "x", title: "AY", order: 10, render: () => ["  ay"] },
		],
	},
	theme,
	120,
);
ok("panels render in order", ordered.collapsed.join("\n").indexOf("[AY]") < ordered.collapsed.join("\n").indexOf("[BEE]"));

ok("mascot is stable", mascotLines(theme, "1.2.3").join("\n").includes("1.2.3"));

done();
