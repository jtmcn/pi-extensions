import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";
import { createFakePi } from "../fake-pi.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("dashboard/index.ts")).default;
const panels = await loadExt("lib/panels.ts");

const dir = await mkdtemp(join(tmpdir(), "dash-wiring-"));
const skillPath = join(dir, "SKILL.md");
await writeFile(skillPath, "x".repeat(4000));

const systemPrompt = `You are pi.

<available_skills>
  <skill>
    <name>brainstorming</name>
    <description>explores intent</description>
    <location>${skillPath}</location>
  </skill>
</available_skills>

<project_context>
<project_instructions path="${join(dir, "AGENTS.md")}">
rules
</project_instructions>
</project_context>`;

const commands = () => [
	{ name: "worktree", source: "extension", sourceInfo: { path: "/x/worktree/index.ts", source: "worktree", scope: "user", origin: "top-level" } },
	{ name: "parallel-cleanup", source: "prompt", sourceInfo: { path: "/x/p.md", source: "user", scope: "user", origin: "top-level" } },
	{ name: "brainstorming", source: "skill", sourceInfo: { path: skillPath, source: "user", scope: "user", origin: "top-level" } },
];

const harness = (overrides = {}) =>
	createFakePi({ cwd: dir, mode: "tui", systemPrompt, commands, ...overrides });

// --- Renders in a TUI ---
{
	panels.resetPanels("dashboard");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const header = h.header(120);
	ok("sets a header", header !== undefined);
	const lines = header.render(120).join("\n");
	ok("renders skills", lines.includes("brainstorming"));
	ok("renders a bar", /brainstorming\s+[▁▂▃▄▅▆▇█]/.test(lines));
	ok("renders context", lines.includes("AGENTS.md"));
	ok("renders prompts", lines.includes("/parallel-cleanup"));
	ok("skill commands are not prompts", !lines.includes("/brainstorming"));
	ok("header is expandable", typeof header.setExpanded === "function");
	header.setExpanded(true);
	ok("expanded shows descriptions", header.render(120).join("\n").includes("explores intent"));
}

// --- Non-TUI modes never set a header ---
for (const mode of ["print", "json", "rpc"]) {
	const h = harness({ mode, hasUI: false });
	extension(h.pi);
	await h.fire("session_start");
	ok(`mode ${mode} sets no header`, h.headers.length === 0);
}

// --- A superseded session must not paint ---
{
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const first = h.contexts.at(-1);
	const paintsBefore = first.own.headers.length;
	await h.fire("session_start");
	await h.settle();
	ok("second session gets its own header", h.contexts.at(-1).own.headers.length === 1);
	ok("first session never paints again", first.own.headers.length === paintsBefore);
}

// --- Panel updates repaint without touching ctx ---
{
	panels.resetPanels("dashboard");
	panels.resetPanels("test");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const header = h.header(120);
	ok("no panel yet", !header.render(120).join("\n").includes("[LATE]"));
	panels.registerPanel({
		id: "late",
		owner: "test",
		title: "LATE",
		order: 5,
		render: () => ["  arrived"],
	});
	ok("late panel appears", header.render(120).join("\n").includes("arrived"));
	header.dispose?.();
	panels.resetPanels("test");
}

// --- A skills block pi changed the shape of ---
{
	const h = harness({ systemPrompt: "<available_skills>\n<thing/>\n</available_skills>" });
	extension(h.pi);
	await h.fire("session_start");
	ok("unparseable block degrades", h.header(120).render(120).join("\n").includes("unavailable"));
}

// --- /dashboard setup ---
{
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	ok("registers the command", h.commands.has("dashboard"));

	await h.command("dashboard", "");
	ok("bare command explains usage", h.messages().some((m) => m.includes("/dashboard setup")));
}

done();
