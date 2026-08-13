/**
 * Wiring. Everything below only happens because a session started, ended, or
 * was replaced, which is exactly what the unit tests cannot see.
 *
 *   node tests/delta/delta.test.mjs
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, piEntry, piTuiEntry } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("delta/index.ts")).default;

// Real pi calls initTheme() once at startup before anything renders. `renderDiff`
// (pi's fallback, used until delta answers) reads a module-level theme singleton
// rather than the theme object handed to renderers, so a test that exercises the
// edit fallback path needs this too, or it throws "Theme not initialized".
const piModule = await import(`file://${await piEntry()}`);
piModule.initTheme();
const { visibleWidth } = await import(`file://${await piTuiEntry()}`);

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

	// ---- execution runs with the session's cwd and the user's shell settings
	//
	// An extension tool *replaces* the built-in in pi's execution registry, so our
	// definition's `execute` is what runs. pi builds its own with
	// `createAllToolDefinitions(this._cwd, { bash: { commandPrefix, shellPath } })`;
	// a definition built at factory time has the process's cwd and no settings,
	// which silently drops the user's configured shell and runs commands in the
	// wrong directory.

	{
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: "export DELTA_PREFIX_RAN=yes" }));
		const h = createFakePi({ cwd: project, projectTrusted: true });
		extension(h.pi);
		await h.fire("session_start");
		const ctx = h.ctx();
		const bash = h.tools.get("bash");

		const text = (result) =>
			result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");

		const cwdResult = await bash.execute("call-cwd", { command: "pwd" }, undefined, undefined, ctx);
		ok("bash runs in the session's cwd", text(cwdResult).includes(project), JSON.stringify(text(cwdResult)));

		const prefixResult = await bash.execute("call-prefix", { command: 'echo "$DELTA_PREFIX_RAN"' }, undefined, undefined, ctx);
		ok("bash honours shellCommandPrefix", text(prefixResult).includes("yes"), JSON.stringify(text(prefixResult)));

		// edit takes no shell options, but the cwd decides which file a relative
		// path resolves to — and pi reports paths relative to it.
		await writeFile(join(project, "edited.txt"), "before\n");
		const editResult = await h.tools
			.get("edit")
			.execute("call-edit", { path: "edited.txt", edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, ctx);
		ok("edit resolves relative paths against the session's cwd", !editResult.isError, JSON.stringify(editResult));
		ok("edit actually edited the session's file", (await readFile(join(project, "edited.txt"), "utf8")).trim() === "after");

		await rm(join(agentDir, "settings.json"), { force: true });
	}

	// ---- config warnings surface as notices

	{
		await writeFile(join(agentDir, "delta.json"), "{ not json");
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");
		ok("malformed config warns", h.messages().some((m) => m.includes("invalid JSON")), JSON.stringify(h.messages()));
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

		// A *second, different* diff, in its own tool call. Re-rendering the same
		// one cannot test this: the first run leaves a negative cache entry for its
		// key, so the engine never reaches the availability probe again and
		// `onUnavailable` could not fire twice however broken the warn-once flag was.
		const secondArgs = { path: "f2.txt" };
		const secondContext = { ...baseContext, args: secondArgs, state: {}, toolCallId: "call-1b" };
		const secondCall = edit.renderCall(secondArgs, theme, { ...secondContext, lastComponent: undefined });
		edit.renderResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in f2.txt." }],
				details: { diff: "-2 c\n+2 d", patch: "diff --git a/f2.txt b/f2.txt\n@@ -1 +1 @@\n-c\n+d\n" },
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...secondContext, lastComponent: undefined },
		);
		secondCall.render(80);
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
		// pi's own component also returns an array of lines, so the discriminator is
		// `update()`: only our component has one.
		ok("diff command renders our component", typeof diff.update === "function", typeof diff.update);
		ok("non-diff command renders pi's, not ours", typeof plain.update !== "function", typeof plain.update);
		ok("diff command shows the diff", diff.render(80).join("\n").includes("+b"));
	}

	// ---- an errored diff command must not throw inside pi's renderer
	//
	// pi's bash `execute` calls `onUpdate` immediately, so a partial result is
	// rendered before the error arrives — and for a diff command that partial
	// render leaves *our* component in `context.lastComponent`. Delegating the
	// error to pi's built-in then hands our component to code that does
	// `context.lastComponent ?? new BashResultRenderComponent()` followed by
	// `component.clear()`: TypeError. pi catches it and dumps the whole
	// untruncated output instead. `git diff --exit-code`, `git diff --quiet`,
	// `git show <bad-ref>` and `git diff` outside a repo all reach this.

	{
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");
		const bash = h.tools.get("bash");
		const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
		const base = {
			args: { command: "git diff --exit-code" },
			cwd: project,
			invalidate: () => {},
			state: {},
			expanded: false,
			showImages: false,
			executionStarted: true,
			argsComplete: true,
			toolCallId: "call-err",
		};

		const partial = bash.renderResult(
			{ content: [{ type: "text", text: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{ ...base, isError: false, isPartial: true, lastComponent: undefined },
		);
		ok("the partial diff render is ours", typeof partial.update === "function");

		let thrown;
		let errored;
		try {
			errored = bash.renderResult(
				{ content: [{ type: "text", text: "Command failed with exit code 1" }], details: undefined },
				{ expanded: false, isPartial: false },
				theme,
				{ ...base, isError: true, isPartial: false, lastComponent: partial },
			);
		} catch (error) {
			thrown = error;
		}
		ok("an error after a partial diff render does not throw", thrown === undefined, String(thrown));
		ok("the error render falls back to pi's component", errored !== undefined && typeof errored.update !== "function");

		// pi then renders whatever came back; a component pi cannot paint is no
		// better than one that threw.
		let renderThrew;
		try {
			errored.render(80);
		} catch (error) {
			renderThrew = error;
		}
		ok("the error component renders", renderThrew === undefined, String(renderThrew));
	}

	// ---- bash result text is extracted the way pi extracts it
	//
	// pi's `getTextOutput` is `sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "")`.
	// `git -c color.ui=always diff` is a blessed match in detect.test.mjs, and a
	// CRLF repo puts raw carriage returns in the output: both are exactly what
	// delta/ansi.ts exists to keep out of pi's frame.

	{
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");
		const bash = h.tools.get("bash");
		const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
		const ansiDiff =
			"\x1b[1mdiff --git a/f b/f\x1b[m\r\n\x1b[36m@@ -1 +1 @@\x1b[m\r\n\x1b[31m-a\x1b[m\r\n\x1b[32m+b\x1b[m\r";
		const component = bash.renderResult(
			{ content: [{ type: "text", text: ansiDiff }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{
				args: { command: "git -c color.ui=always diff" },
				cwd: project,
				invalidate: () => {},
				state: {},
				isError: false,
				expanded: true,
				isPartial: false,
				lastComponent: undefined,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				toolCallId: "call-ansi",
			},
		);
		// The theme here is the identity, and delta is not installed, so anything
		// escape-shaped on screen came straight from the tool result.
		const frame = component.render(80).join("\n");
		ok("ANSI from the command is stripped", !frame.includes("\x1b"), JSON.stringify(frame));
		ok("carriage returns are stripped", !frame.includes("\r"), JSON.stringify(frame));
		ok("the diff itself survives", frame.includes("+b") && frame.includes("@@ -1 +1 @@"), JSON.stringify(frame));
	}

	// ---- no rendered line may exceed the width it was rendered at
	//
	// pi's renderer throws "Rendered line N exceeds terminal width" and stops the
	// TUI (pi-tui's tui-main-screen.js); `Box.render` pads but does not clip. This
	// is the wiring-level check: both tools, both slots, delta absent — which is
	// the *worst* case, because pi's own `renderDiff` fallback knows no width.

	{
		const h = createFakePi({ cwd: project });
		extension(h.pi);
		await h.fire("session_start");
		const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
		const long = "x".repeat(200);
		const tooWide = (lines, width) => lines.filter((line) => visibleWidth(line) > width);

		// edit: header (a long path) plus pi's fallback diff
		const edit = h.tools.get("edit");
		const args = { path: `${"deeply/nested/".repeat(6)}file.txt` };
		const editContext = {
			args,
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
			toolCallId: "call-wide",
		};
		const editCall = edit.renderCall(args, theme, editContext);
		ok("edit header fits the render width", tooWide(editCall.render(60), 60).length === 0, JSON.stringify(editCall.render(60).map((l) => visibleWidth(l))));

		edit.renderResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
				details: { diff: `-${long}\n+${long}`, patch: `diff --git a/f b/f\n@@ -1 +1 @@\n-${long}\n+${long}\n` },
			},
			{ expanded: false, isPartial: false },
			theme,
			editContext,
		);
		ok("settled edit frame fits the render width", tooWide(editCall.render(60), 60).length === 0, JSON.stringify(editCall.render(60).map((l) => visibleWidth(l))));

		// The error branch paints its own line, which is just as fatal when long.
		const errorContext = { ...editContext, state: {}, toolCallId: "call-wide-err" };
		const editErrorCall = edit.renderCall(args, theme, errorContext);
		edit.renderResult(
			{ content: [{ type: "text", text: `edit failed: ${long}` }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{ ...errorContext, isError: true },
		);
		ok(
			"failed edit frame fits the render width",
			tooWide(editErrorCall.render(60), 60).length === 0,
			JSON.stringify(editErrorCall.render(60).map((l) => visibleWidth(l))),
		);

		// bash: expanded (no truncation to save us) and collapsed (the hint)
		const bash = h.tools.get("bash");
		const bashResult = {
			content: [{ type: "text", text: `diff --git a/f b/f\n@@ -1 +1 @@\n-${long}\n+${long}` }],
			details: {
				truncation: { truncated: true, truncatedBy: "lines", outputLines: 4, totalLines: 900 },
				fullOutputPath: `/tmp/${"nested/".repeat(20)}full-output.txt`,
			},
		};
		const bashContext = {
			args: { command: "git diff" },
			cwd: project,
			invalidate: () => {},
			state: { startedAt: Date.now() - 1234 },
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			executionStarted: true,
			argsComplete: true,
			showImages: false,
		};
		for (const expanded of [true, false]) {
			const component = bash.renderResult(bashResult, { expanded, isPartial: false }, theme, {
				...bashContext,
				expanded,
				toolCallId: `call-wide-${expanded}`,
			});
			const lines = component.render(30);
			ok(
				`bash ${expanded ? "expanded" : "collapsed"} frame fits the render width`,
				tooWide(lines, 30).length === 0,
				JSON.stringify(lines.map((l) => visibleWidth(l))),
			);
		}
	}

	// ---- a run that lands after session_shutdown must not repaint
	//
	// `session_shutdown` fires when pi tears the extension runtime down (quit,
	// reload, session replacement). A delta run scheduled just before it is still
	// out there, and its completion calls the render context's `invalidate` — the
	// stale-ctx hazard the repo conventions exist for. The engine's generation
	// guard covers session_start; it has to cover this window too.
	//
	// Driven by a real (fake) delta binary, because the point is a subprocess that
	// is still running when the session goes away.

	{
		const fakeDelta = join(root, "fake-delta");
		await writeFile(
			fakeDelta,
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "delta 0.0.0"; exit 0; fi\nsleep 0.2\ncat >/dev/null\necho "DELTA-RENDERED"\n',
			{ mode: 0o755 },
		);
		await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: fakeDelta }));

		const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };
		const args = { path: "shutdown.txt" };
		const result = {
			content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
			details: { diff: "-a\n+b", patch: "diff --git a/s.txt b/s.txt\n@@ -1 +1 @@\n-a\n+b\n" },
		};
		/** Render an edit row and report how often the delta run asked for a repaint. */
		const paint = async ({ shutdown }) => {
			const h = createFakePi({ cwd: project });
			extension(h.pi);
			await h.fire("session_start");
			let invalidations = 0;
			const context = {
				args,
				cwd: project,
				invalidate: () => {
					invalidations += 1;
				},
				state: {},
				isError: false,
				expanded: false,
				isPartial: false,
				lastComponent: undefined,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				toolCallId: `call-shutdown-${shutdown}`,
			};
			const edit = h.tools.get("edit");
			const component = edit.renderCall(args, theme, context);
			edit.renderResult(result, { expanded: false, isPartial: false }, theme, context);
			component.render(80); // a miss: schedules the delta run
			if (shutdown) await h.fire("session_shutdown");
			await settle(600);
			return { invalidations, painted: component.render(80).join("\n") };
		};

		// Control: without a shutdown the run lands, repaints, and is on screen. If
		// this fails the fake binary is broken and the assertion below proves nothing.
		const live = await paint({ shutdown: false });
		ok("a live session is repainted when delta answers", live.invalidations === 1, String(live.invalidations));
		ok("delta's output reaches the frame", live.painted.includes("DELTA-RENDERED"), JSON.stringify(live.painted));

		const torn = await paint({ shutdown: true });
		ok("a run landing after session_shutdown does not repaint", torn.invalidations === 0, String(torn.invalidations));

		await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: "delta-does-not-exist" }));
	}
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
}

done();
