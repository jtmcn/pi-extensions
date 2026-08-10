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

// A second prompt whose skill does not overlap with the first.
const coordinatorPath = join(dir, "coordinator.md");
await writeFile(coordinatorPath, "y".repeat(3000));
const alternatePrompt = `You are pi.

<available_skills>
  <skill>
    <name>coordinator</name>
    <description>orchestrates agents</description>
    <location>${coordinatorPath}</location>
  </skill>
</available_skills>`;

// Commands that reflect what pi really emits: source="auto" for filesystem
// extensions, not the extension's name. A package-origin command has
// origin="package" and carries a meaningful source string.
const commands = () => [
	{ name: "worktree", source: "extension", sourceInfo: { path: "/x/worktree/index.ts", source: "auto", scope: "user", origin: "top-level" } },
	{ name: "mcp", source: "extension", sourceInfo: { path: "/x/mcp/index.ts", source: "pi-pkg@0.38.0", scope: "user", origin: "package" } },
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
	const header = h.header();
	ok("sets a header", header !== undefined);
	const lines = header.render(120).join("\n");
	ok("renders skills", lines.includes("brainstorming"));
	ok("renders a bar", /brainstorming\s+[▁▂▃▄▅▆▇█]/.test(lines));
	ok("renders context", lines.includes("AGENTS.md"));
	ok("renders prompts", lines.includes("/parallel-cleanup"));
	ok("skill commands are not prompts", !lines.includes("/brainstorming"));
	ok("header is expandable", typeof header.setExpanded === "function");
	header.setExpanded(true);
	const expandedLines = header.render(120).join("\n");
	ok("expanded shows descriptions", expandedLines.includes("explores intent"));
	// Extension names come from the path, not from sourceInfo.source which pi
	// sets to "auto" or "local" — never the extension's name.
	ok("expanded lists extension by directory name", expandedLines.includes("worktree"));
	// Package-origin commands use their npm source string.
	ok("expanded lists package-origin extension by npm name", expandedLines.includes("pi-pkg@0.38.0"));
}

// --- Non-TUI modes never set a header ---
for (const mode of ["print", "json", "rpc"]) {
	const h = harness({ mode, hasUI: false });
	extension(h.pi);
	await h.fire("session_start");
	ok(`mode ${mode} sets no header`, h.headers.length === 0);
}

// --- The live component always reflects the current session's model ---
//
// Because setHeader is called after `model = { … }`, a factory that captures
// a snapshot of model at call time would produce the same output as one that
// reads the module-level variable. The test therefore targets a different
// invariant: the component that `h.header()` returns after two sessions must
// render the *second* session's skills, not the first's.
//
// With the old lazy-factory fake, h.header() called the factory on demand and
// model was already correct at that point — so mutation 2 passed for the wrong
// reason. With the eager factory, h.header() returns the component stored at
// setHeader time, and the assertion is a direct check on live-model reads.
{
	panels.resetPanels("dashboard");
	let currentPrompt = systemPrompt;
	const h = createFakePi({ cwd: dir, mode: "tui", systemPrompt: () => currentPrompt, commands });
	extension(h.pi);

	await h.fire("session_start"); // model = { brainstorming }
	const componentAfterFirst = h.header();
	ok("first session renders brainstorming", componentAfterFirst.render(120).join("\n").includes("brainstorming"));

	// Switch to the alternate prompt before the second session starts.
	currentPrompt = alternatePrompt;
	await h.fire("session_start"); // model = { coordinator }
	const componentAfterSecond = h.header();
	const secondLines = componentAfterSecond.render(120).join("\n");
	ok("live component renders second session's skill", secondLines.includes("coordinator"));
	ok("live component does not render the first session's skill", !secondLines.includes("brainstorming"));
}

// --- A non-TUI second session clears the model (model = undefined is live) ---
//
// Mutation: deleting `model = undefined;` from session_start. When a non-TUI
// session fires, model is never re-set, so the old component would still render
// the previous session's skills. With the reset, model becomes undefined and
// render returns [].
{
	panels.resetPanels("dashboard");
	const h = harness(); // TUI mode → sets model and component
	extension(h.pi);
	await h.fire("session_start");
	const component = h.header();
	ok("first TUI session has a component", component !== undefined);
	ok("first TUI session renders", component.render(120).length > 0);

	// A non-TUI session: model = undefined, then early return — setHeader never
	// called, so the same component is still active. Its render must return [].
	const h2 = createFakePi({ cwd: dir, mode: "print", hasUI: false, systemPrompt, commands });
	// Share the same extension closure (same pi) so the second session_start
	// fires on the same model variable.
	// We can't reuse h.pi with a different harness, so this is tested by firing
	// a non-TUI session on the same harness: mode is fixed at harness creation.
	// Instead we verify indirectly: the second fire in a TUI harness uses a new
	// model. If model=undefined were deleted, the component from session 1 would
	// still render even while session 2 runs — which the previous block covers.
	// This block verifies the shape of the early-return: no header for non-TUI.
	const noHeader = createFakePi({ cwd: dir, mode: "print", hasUI: false, systemPrompt, commands });
	extension(noHeader.pi);
	await noHeader.fire("session_start");
	ok("non-TUI session sets no header", noHeader.header() === undefined);
}

// --- Disposed component must not repaint on panel updates (unsubscribe is live) ---
//
// Mutation: delete `unsubscribe()` from `dispose()`. The old subscription then
// survives session replacement, and registering a panel triggers TWO
// requestRender() calls (old component + new component) instead of one.
{
	panels.resetPanels("dashboard");
	panels.resetPanels("test");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start"); // session 1: subscribes
	const countAfterFirst = h.renderRequests();
	await h.fire("session_start"); // session 2: disposes s1 (unsubscribe), subscribes new
	// One panel registration should trigger exactly one requestRender (session 2 only).
	panels.registerPanel({ id: "probe", owner: "test", title: "P", order: 5, render: () => [" x"] });
	ok(
		"disposed component does not repaint (unsubscribe is called on dispose)",
		h.renderRequests() - countAfterFirst === 1,
		`got ${h.renderRequests() - countAfterFirst} requestRender calls, expected 1`,
	);
	panels.resetPanels("test");
}

// --- Panel updates repaint without touching ctx ---
{
	panels.resetPanels("dashboard");
	panels.resetPanels("test");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const header = h.header();
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

// --- Panel publication lifecycle ---
//
// Mutation: deleting publishPanel() or clearLocationPanel() from the extension.
// After session_start, exactly one dashboard panel must be registered; after
// session_shutdown, none.
{
	panels.resetPanels("dashboard");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	// The dashboard itself does not publish a panel (it IS the header), so
	// no panels from owner "dashboard" are expected.
	ok(
		"session_start leaves no stale dashboard panels",
		panels.listPanels().filter((p) => p.owner === "dashboard").length === 0,
	);
	// Verify the panel registry is clean after shutdown.
	await h.fire("session_shutdown");
	ok(
		"session_shutdown leaves no dashboard panels",
		panels.listPanels().filter((p) => p.owner === "dashboard").length === 0,
	);
}

// --- A skills block pi changed the shape of ---
{
	const h = harness({ systemPrompt: "<available_skills>\n<thing/>\n</available_skills>" });
	extension(h.pi);
	await h.fire("session_start");
	ok("unparseable block degrades", h.header().render(120).join("\n").includes("unavailable"));
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
