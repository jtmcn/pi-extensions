/**
 * Wiring. Everything below only happens because a session started, ended, or
 * was replaced, which is exactly what the unit tests cannot see.
 *
 *   node tests/delta/delta.test.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, piEntry } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("delta/index.ts")).default;

// Real pi calls initTheme() once at startup before anything renders. `renderDiff`
// (pi's fallback, used until delta answers) reads a module-level theme singleton
// rather than the theme object handed to renderers, so a test that exercises the
// edit fallback path needs this too, or it throws "Theme not initialized".
const piModule = await import(`file://${await piEntry()}`);
piModule.initTheme();

// Pin the agent dir so the real ~/.pi/agent/delta.json cannot change results.
const root = await mkdtemp(join(tmpdir(), "delta-wiring-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(join(project, ".pi"), { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- registration

{
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	ok("registers bash", h.tools.has("bash"));
	ok("registers edit", h.tools.has("edit"));
	ok("does not register write", !h.tools.has("write"));
	ok("bash keeps an execute", typeof h.tools.get("bash").execute === "function");
	ok("bash keeps its parameters schema", h.tools.get("bash").parameters !== undefined);
	ok("bash keeps its prompt snippet", typeof h.tools.get("bash").promptSnippet === "string");
	ok("edit defines both render slots", typeof h.tools.get("edit").renderCall === "function" && typeof h.tools.get("edit").renderResult === "function");
}

// ---- config warnings surface as notices

{
	await writeFile(join(agentDir, "delta.json"), "{ not json");
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	await h.fire("session_start");
	ok("malformed config warns", h.messages().some((m) => m.includes("invalid JSON")), JSON.stringify(h.messages()));
	ok("malformed config does not throw", true);
	await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: "delta-does-not-exist" }));
}

// ---- a missing binary warns once, then never again

{
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	await h.fire("session_start");

	const edit = h.tools.get("edit");
	const context = {
		args: { path: "f.txt" },
		cwd: project,
		invalidate: () => {},
		state: {},
		isError: false,
		expanded: false,
		isPartial: false,
		lastComponent: undefined,
		executionStarted: true,
		argsComplete: true,
		showImages: false,
		toolCallId: "call-1",
	};
	const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
	const result = {
		content: [{ type: "text", text: "Successfully replaced 1 block(s) in f.txt." }],
		details: { diff: "-1 a\n+1 b", patch: "diff --git a/f.txt b/f.txt\n@@ -1 +1 @@\n-a\n+b\n" },
	};

	const component = edit.renderResult(result, { expanded: false, isPartial: false }, theme, context);
	ok("edit result renders lines", Array.isArray(component.render(80)));
	// renderDiff highlights the changed token with theme.inverse, so "+1 b" is not
	// a contiguous substring; assert on the line prefix and the header instead.
	const painted = component.render(80).join("\n");
	ok("edit result shows pi's fallback diff", /\+1 /.test(painted), JSON.stringify(painted));
	ok("edit result shows the header", painted.includes("edit") && painted.includes("f.txt"), JSON.stringify(painted));
	await settle(200);
	component.render(80);
	await settle(200);
	const warnings = h.messages().filter((m) => m.includes("delta"));
	ok("missing binary warns once", warnings.length === 1, JSON.stringify(h.messages()));
}

// ---- a superseded session is never painted through
//
// fake-pi mints a fresh ctx per session_start, so a stale write is detectable.

{
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	await h.fire("session_start");
	const first = h.ctx();
	await h.fire("session_start");
	await settle(200);
	ok("previous session wrote nothing after replacement", first.own.notices.length <= 1, JSON.stringify(first.own.notices));
	// createFakePi() mints one ctx eagerly (before any session_start), matching
	// real pi's need for a ctx to exist for pre-session calls. Two session_start
	// fires on top of that mint two more, so three total, not two.
	ok("three contexts were minted", h.contexts.length === 3, String(h.contexts.length));
}

// ---- bash: non-diff commands keep pi's rendering

{
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	await h.fire("session_start");
	const bash = h.tools.get("bash");
	const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
	const base = {
		cwd: project,
		invalidate: () => {},
		state: {},
		isError: false,
		expanded: false,
		isPartial: false,
		lastComponent: undefined,
		executionStarted: true,
		argsComplete: true,
		showImages: false,
		toolCallId: "call-1",
	};
	const result = { content: [{ type: "text", text: "hello" }], details: undefined };

	const plain = bash.renderResult(result, { expanded: false, isPartial: false }, theme, { ...base, args: { command: "echo hello" } });
	ok("non-diff command still renders", plain !== undefined && typeof plain.render === "function");

	const diff = bash.renderResult(
		{ content: [{ type: "text", text: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...base, args: { command: "git diff" } },
	);
	ok("diff command renders our component", Array.isArray(diff.render(80)));
	ok("diff command shows the diff", diff.render(80).join("\n").includes("+b"));
}

if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
await rm(root, { recursive: true, force: true });
done();
