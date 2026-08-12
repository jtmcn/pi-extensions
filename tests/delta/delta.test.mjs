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

try {
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

	// ---- edit: call, then result, then call again shows exactly one header
	//
	// Regression test for a double-render bug: pi keeps the call and result
	// renderer components separate (`callRendererComponent` /
	// `resultRendererComponent` in tool-execution.js's `ToolExecutionComponent`)
	// — each slot gets its own `lastComponent` — but shares one `context.state`
	// object across both slots for the whole tool call. A component built from
	// `lastComponent` in the result slot can never see the call slot's
	// component, so a wrapper that keys off `lastComponent` builds a second,
	// independent component there. Once a result exists, pi's real container
	// paints both: header (and, once settled, diff) from the call slot, header
	// again from the result slot.

	{
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");

		const edit = h.tools.get("edit");
		const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
		// One `state` object, shared by both slots, exactly as pi's real
		// ToolExecutionComponent shares `this.rendererState` between them.
		const state = {};
		const args = { path: "g.txt" };
		const baseContext = {
			args,
			cwd: project,
			invalidate: () => {},
			state,
			isError: false,
			expanded: false,
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			showImages: false,
			toolCallId: "call-2",
		};
		const headerCount = (text) => (text.match(/edit/g) ?? []).length;

		// Call, while pending: pi's real container shows only this so far.
		const pendingCall = edit.renderCall(args, theme, { ...baseContext, lastComponent: undefined });
		const pendingPainted = pendingCall.render(80).join("\n");
		ok("pending call shows exactly one header", headerCount(pendingPainted) === 1, JSON.stringify(pendingPainted));

		// Result lands: real pi calls the result renderer with its own, separate
		// (still-undefined) `lastComponent`, sharing only `state` with the call
		// slot.
		const result = {
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in g.txt." }],
			details: { diff: "-old\n+new", patch: "diff --git a/g.txt b/g.txt\n@@ -1 +1 @@\n-old\n+new\n" },
		};
		const resultComponent = edit.renderResult(result, { expanded: false, isPartial: false }, theme, { ...baseContext, lastComponent: undefined });

		// pi's real container paints both the (now-updated) call component and
		// the result component, back to back — exactly what appears on screen.
		const settledCallPainted = pendingCall.render(80).join("\n");
		const settledResultPainted = resultComponent.render(80).join("\n");
		const combined = `${settledCallPainted}\n${settledResultPainted}`;
		ok("settled edit shows exactly one header across both slots", headerCount(combined) === 1, JSON.stringify({ settledCallPainted, settledResultPainted }));
		ok("result slot paints nothing itself", settledResultPainted.length === 0, JSON.stringify(settledResultPainted));
		ok("the settled diff is visible", combined.includes("+new"), JSON.stringify(combined));

		// Call slot renders again (pi re-renders it on some updates): still one
		// header, and the settled diff survives.
		const secondCall = edit.renderCall(args, theme, { ...baseContext, lastComponent: pendingCall });
		const secondCombined = `${secondCall.render(80).join("\n")}\n${resultComponent.render(80).join("\n")}`;
		ok("re-rendering the call slot still shows exactly one header", headerCount(secondCombined) === 1, JSON.stringify(secondCombined));
		ok("re-rendering the call slot keeps the settled diff", secondCombined.includes("+new"), JSON.stringify(secondCombined));
	}

	// ---- a missing binary warns once, then never again

	{
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");

		const edit = h.tools.get("edit");
		const state = {};
		const args = { path: "f.txt" };
		const baseContext = {
			args,
			cwd: project,
			invalidate: () => {},
			state,
			isError: false,
			expanded: false,
			isPartial: false,
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

		// pi always renders the call slot first, sharing `state` with the result
		// slot in the same pass, so the wiring never sees a result without a
		// preceding call.
		const callComponent = edit.renderCall(args, theme, { ...baseContext, lastComponent: undefined });
		const resultComponent = edit.renderResult(result, { expanded: false, isPartial: false }, theme, { ...baseContext, lastComponent: undefined });
		ok("result slot renders nothing", resultComponent.render(80).length === 0, JSON.stringify(resultComponent.render(80)));

		ok("call component renders lines", Array.isArray(callComponent.render(80)));
		// renderDiff highlights the changed token with theme.inverse, so "+1 b" is not
		// a contiguous substring; assert on the line prefix and the header instead.
		const painted = callComponent.render(80).join("\n");
		ok("edit result shows pi's fallback diff", /\+1 /.test(painted), JSON.stringify(painted));
		ok("edit result shows the header", painted.includes("edit") && painted.includes("f.txt"), JSON.stringify(painted));
		await settle(200);
		callComponent.render(80);
		await settle(200);
		const warnings = h.messages().filter((m) => m.includes("delta"));
		ok("missing binary warns once", warnings.length === 1, JSON.stringify(h.messages()));
	}

	// ---- a superseded session's in-flight config load writes and notifies nothing
	//
	// `h.fire()` sequentially awaited (as every other section here does) drains
	// each session_start's internal await before the next one starts, so it can
	// never model two sessions actually overlapping. This section fires a second
	// session_start *before* awaiting the first, so both invocations are
	// genuinely in flight together, racing inside the awaited `loadConfig()`
	// call — the exact scenario in which an unguarded handler would assign
	// module state and notify through a ctx that a newer session has already
	// superseded.

	{
		await writeFile(join(agentDir, "delta.json"), "{ not json");
		const h = createFakePi({ cwd: project });
		extension(h.pi);

		const firstFire = h.fire("session_start");
		const first = h.ctx();
		const secondFire = h.fire("session_start");
		const second = h.ctx();
		await Promise.all([firstFire, secondFire]);
		await settle(200);

		ok("two distinct contexts were minted", first !== second && h.contexts.length === 3);
		ok("the superseded session wrote nothing", first.own.notices.length === 0, JSON.stringify(first.own.notices));
		ok(
			"the current session still warns about the malformed config",
			second.own.notices.some((n) => n.message.includes("invalid JSON")),
			JSON.stringify(second.own.notices),
		);

		await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: "delta-does-not-exist" }));
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
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
}

done();
