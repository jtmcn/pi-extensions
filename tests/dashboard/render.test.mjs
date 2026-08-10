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

// Width invariant — skill names long enough that layoutRows truncates them,
// so a full row lands at the target width. At width=60 (1 col, labelWidth=54)
// the row is exactly 60; at width=90 (2 col, labelWidth=40) it is exactly 90;
// at width=120 (3 col, labelWidth=35) it is 119. In all three cases widening
// layoutRows's label slot by 10 produces a row that exceeds the target width,
// so the truncation guard in render.ts is the only thing keeping longest<=width.
const mkLongName = (prefix) => (prefix + "-").padEnd(70, "-");
const superpowersPath = (id) =>
	`/u/.pi/agent/git/github.com/obra/superpowers/skills/${id}/SKILL.md`;
const widthModel = {
	version: "1.0.0",
	skillsAvailable: true,
	skills: [
		skill(mkLongName("alpha"), superpowersPath("a"), 1000),
		skill(mkLongName("beta"), superpowersPath("b"), 2000),
		skill(mkLongName("gamma"), superpowersPath("c"), 1500),
	],
	contextFiles: [],
	prompts: [],
	extensions: [],
	panels: [],
};
for (const width of [120, 90, 60]) {
	const rendered = renderDashboard(widthModel, theme, width);
	const longest = Math.max(...[...rendered.collapsed, ...rendered.expanded].map((l) => l.length));
	ok(`no rendered line exceeds ${width}`, longest <= width, `longest was ${longest}`);
}

// Property 2: panels may return arbitrarily long lines; render.ts must clip them.
// This is the more direct test — no layout arithmetic, just an absurdly wide
// panel line that the truncation guard at the bottom of renderDashboard catches.
const widePanel = { id: "wide", owner: "t", title: "Wide", order: 5, render: () => ["x".repeat(200)] };
const wideResult = renderDashboard({ ...model, panels: [widePanel] }, theme, 80);
ok(
	"render.ts truncates panel lines that exceed width",
	wideResult.collapsed.every((l) => l.length <= 80),
	`longest was ${Math.max(...wideResult.collapsed.map((l) => l.length))}`,
);

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

// Panels render in the order they are given. Ordering derivation (sort by
// order then id) is tested in panels.test.mjs against listPanels(); here we
// only verify that renderDashboard preserves the order it receives.
//
// The input deliberately puts BEE (order:30) before AY (order:10). A sort
// inside renderDashboard would reorder them by order-value, making AY first;
// pass-through preserves BEE first. The assertion therefore breaks if someone
// re-introduces a sort in renderDashboard.
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
ok("panels render in order", ordered.collapsed.join("\n").indexOf("[BEE]") < ordered.collapsed.join("\n").indexOf("[AY]"));

ok("mascot is stable", mascotLines(theme, "1.2.3").join("\n").includes("1.2.3"));

// ANSI theme: emits real escape sequences so the ANSI-aware width guard is exercised.
// Under the identity theme above, line.length equals visible width, so the byte-counting
// bug was invisible. This theme exposes it.
const ansiTheme = {
	fg: (_c, t) => `\x1b[2m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[0m`,
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// After stripping complete escapes any remaining \x1b is a severed sequence.
const hasSeveredEscape = (s) => stripAnsi(s).includes("\x1b");

for (const width of [120, 90, 60]) {
	const rendered = renderDashboard(widthModel, ansiTheme, width);
	const lines = [...rendered.collapsed, ...rendered.expanded];
	const longestVisible = Math.max(...lines.map((l) => stripAnsi(l).length));
	ok(`ANSI: no visible line exceeds ${width}`, longestVisible <= width, `longest visible was ${longestVisible}`);
	const severed = lines.filter((l) => hasSeveredEscape(l));
	ok(`ANSI: no severed escape at width ${width}`, severed.length === 0, `severed: ${JSON.stringify(severed[0])}`);
}

done();
