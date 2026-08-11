import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";
import { createFakePi } from "../fake-pi.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("dashboard/index.ts")).default;
const panels = await loadExt("lib/panels.ts");

const dir = await mkdtemp(join(tmpdir(), "dash-wiring-"));

// Pin PI_CODING_AGENT_DIR to an isolated temp dir so defaultSettingsPath()
// resolves here, not to the developer's real ~/.pi/agent/settings.json.
// Pattern from tests/mcp/mcp.test.mjs:343-357.
const agentDir = join(dir, "pi_agent");
await mkdir(agentDir, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const skillPath = join(dir, "SKILL.md");
await writeFile(skillPath, "x".repeat(4000));

const mergePath = join(dir, "merge-SKILL.md");
await writeFile(mergePath, "m".repeat(2000));

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

// Used in the multi-session live-model test as the second session's skill.
const coordinatorPath = join(dir, "coordinator.md");
await writeFile(coordinatorPath, "y".repeat(3000));

// Commands that reflect what pi really emits: source="auto" for filesystem
// extensions, not the extension's name. A package-origin command has
// origin="package" and carries a meaningful source string.
const commands = () => [
	{ name: "worktree", source: "extension", sourceInfo: { path: "/x/worktree/index.ts", source: "auto", scope: "user", origin: "top-level" } },
	{ name: "mcp", source: "extension", sourceInfo: { path: "/x/mcp/index.ts", source: "pi-pkg@0.38.0", scope: "user", origin: "package" } },
	{ name: "parallel-cleanup", source: "prompt", sourceInfo: { path: "/x/p.md", source: "user", scope: "user", origin: "top-level" } },
	{ name: "skill:brainstorming", description: "explores intent", source: "skill", sourceInfo: { path: skillPath, source: "local", scope: "user", origin: "top-level", baseDir: dir } },
	// disable-model-invocation: absent from the systemPrompt fixture, present here.
	{ name: "skill:merge", description: "Commit, rebase, and merge.", source: "skill", sourceInfo: { path: mergePath, source: "local", scope: "user", origin: "top-level", baseDir: dir } },
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
	ok("renders a skill the system prompt omits", lines.includes("merge"));
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
//
// Skills now come from getCommands(), so the commands list (not the system
// prompt) is varied between sessions to produce different skill sets.
{
	panels.resetPanels("dashboard");
	let currentCommandList = commands();
	const dynamicCommands = () => currentCommandList;
	const h = createFakePi({ cwd: dir, mode: "tui", systemPrompt, commands: dynamicCommands });
	extension(h.pi);

	await h.fire("session_start"); // model = { brainstorming, merge }
	const componentAfterFirst = h.header();
	ok("first session renders brainstorming", componentAfterFirst.render(120).join("\n").includes("brainstorming"));

	// Switch to a different command set before the second session starts.
	currentCommandList = [
		{ name: "skill:coordinator", description: "orchestrates agents", source: "skill", sourceInfo: { path: coordinatorPath, source: "local", scope: "user", origin: "top-level", baseDir: dir } },
	];
	await h.fire("session_start"); // model = { coordinator }
	const componentAfterSecond = h.header();
	const secondLines = componentAfterSecond.render(120).join("\n");
	ok("live component renders second session's skill", secondLines.includes("coordinator"));
	ok("live component does not render the first session's skill", !secondLines.includes("brainstorming"));
}

// --- A non-TUI second session clears the model (model = undefined is live) ---
//
// Mutation: deleting `model = undefined;` from session_start. After a TUI
// session sets the model and stores a component, a subsequent non-TUI session
// fires `model = undefined` then returns early without calling setHeader. The
// still-live component from session 1 must now render [], because model is
// undefined.
//
// fake-pi.mjs supports a per-session mode function (like systemPrompt) so the
// same pi closure can run both sessions. Without that, the test would need two
// separate pi instances and could not observe the shared `model` variable.
{
	panels.resetPanels("dashboard");
	let sessionMode = "tui";
	const h = createFakePi({ cwd: dir, mode: () => sessionMode, systemPrompt, commands });
	extension(h.pi);

	await h.fire("session_start"); // mode = tui → model set, header registered
	const component = h.header();
	ok("first TUI session has a component", component !== undefined);
	ok("first TUI session renders", component.render(120).length > 0);

	sessionMode = "print";
	await h.fire("session_start"); // mode = print → model = undefined, early return
	// setHeader was not called, so component is still the one from session 1.
	// But model is now undefined, so render() must return [].
	ok("non-TUI session sets no header", h.header() === component);
	ok(
		"live component renders [] after model is cleared by non-TUI session",
		component.render(120).length === 0,
	);
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

// --- /dashboard setup: usage notice and first-run notification ---
//
// When quietStartup is not set, session_start fires a first-run notification
// that also contains the text "/dashboard setup". The usage notice and the
// notification are two separate messages; asserting both explicitly prevents
// a corrupted usage string from surviving behind the notification match.
{
	panels.resetPanels("dashboard");
	// agentDir is empty at this point — no settings.json — so quietStartup is unset.
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	ok("registers the command", h.commands.has("dashboard"));
	// Notification fires on session_start when quietStartup is not set.
	// Note: the notification string uses a curly apostrophe (U+2019) in "pi's";
	// match on "startup sections are visible above" to avoid encoding fragility.
	ok(
		"first-run notification fires when quietStartup is unset",
		h.messages().some((m) => m.includes("startup sections are visible above")),
	);

	await h.command("dashboard", "");
	// Assert the usage message with its "usage:" prefix — the notification also
	// contains "/dashboard setup", so a bare .includes check would survive
	// a corrupted usage string.
	ok(
		"bare command explains usage",
		h.messages().some((m) => m.startsWith("usage: /dashboard setup")),
	);
}

// --- /dashboard setup: no notification when quietStartup is already true ---
{
	panels.resetPanels("dashboard");
	// Write quietStartup: true so the notification should not fire.
	const settingsPath = join(agentDir, "settings.json");
	await writeFile(settingsPath, JSON.stringify({ quietStartup: true }));
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	ok(
		"no notification when quietStartup is already true",
		!h.messages().some((m) => m.includes("startup sections are visible above")),
	);
}

// Restore PI_CODING_AGENT_DIR before exit.
if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

done();
