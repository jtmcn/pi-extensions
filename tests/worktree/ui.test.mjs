/**
 * Tests for the worktree extension's output layer (worktree/ui.ts).
 *
 *   cd tests && npm install && node worktree/ui.test.mjs
 *
 * pi has three output situations and only one of them is the obvious one:
 * interactive (`ctx.ui.*` works), print (`ctx.ui.*` are no-ops, so stdout is the
 * only way to be heard), and headless/JSON (say nothing). A feature that gets
 * this wrong looks perfect in interactive use and is silent under `pi -p`.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createUi } = await loadExt("worktree/ui.ts");

/** A ctx in one of the three output situations, recording what it was asked to do. */
function fakeCtx({ hasUI, mode = "interactive" }) {
	const calls = { notify: [], widget: [], status: [] };
	return {
		hasUI,
		mode,
		ui: {
			notify: (message, level) => calls.notify.push({ message, level }),
			setWidget: (key, content) => calls.widget.push({ key, content }),
			setStatus: (key, content) => calls.status.push({ key, content }),
		},
		calls,
	};
}

function setup() {
	const out = [];
	const err = [];
	const ui = createUi({
		statusKey: "worktree",
		prefix: "worktree",
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
	});
	return { ui, out, err };
}

// ===================================================== say

{
	const { ui, out, err } = setup();
	const ctx = fakeCtx({ hasUI: true });
	ui.say(ctx, "hello");
	ok("interactive: notifies", ctx.calls.notify[0]?.message === "worktree: hello");
	ok("interactive: default level is info", ctx.calls.notify[0]?.level === "info");
	ok("interactive: writes to neither stream", out.length === 0 && err.length === 0);
}

{
	const { ui, out, err } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "print" });
	ui.say(ctx, "hello");
	ok("print: falls back to stdout", out[0] === "worktree: hello\n");
	ui.say(ctx, "bad", "error");
	ok("print: errors go to stderr", err[0] === "worktree: bad\n");
	ok("print: never calls the no-op notify", ctx.calls.notify.length === 0);
}

{
	const { ui, out, err } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "json" });
	ui.say(ctx, "hello");
	ok("headless: says nothing anywhere", out.length === 0 && err.length === 0 && ctx.calls.notify.length === 0);
}

// ===================================================== report and clearReport

{
	const { ui, out } = setup();
	const ctx = fakeCtx({ hasUI: true });
	ui.report(ctx, "Title:", ["one", "two"]);
	ok("interactive: renders a widget", ctx.calls.widget[0]?.key === "worktree");
	ok("interactive: indents the body", JSON.stringify(ctx.calls.widget[0]?.content) === JSON.stringify(["Title:", "  one", "  two"]));
	ok("interactive: report writes no stdout", out.length === 0);

	ui.clearReport(ctx);
	ok("interactive: clearing removes the widget", ctx.calls.widget[1]?.content === undefined);

	// Only the first clear does anything: nothing is on screen after it.
	const before = ctx.calls.widget.length;
	ui.clearReport(ctx);
	ok("clearing twice is a no-op", ctx.calls.widget.length === before);
}

{
	const { ui, out } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "print" });
	ui.report(ctx, "Title:", ["one"]);
	ok("print: report goes to stdout", out[0] === "Title:\n  one\n");
	ui.clearReport(ctx);
	ok("print: nothing to clear, and no widget call", ctx.calls.widget.length === 0);
}

{
	const { ui, out } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "json" });
	ui.report(ctx, "Title:", ["one"]);
	ok("headless: report is silent", out.length === 0 && ctx.calls.widget.length === 0);
}

// ===================================================== setStatus

{
	const { ui } = setup();
	const ctx = fakeCtx({ hasUI: true });
	ui.setStatus(ctx, ["⑂ feat", "#7"]);
	ok("status: joins the parts", ctx.calls.status[0]?.content === "⑂ feat #7");

	ui.setStatus(ctx, []);
	ok("status: no parts clears the segment rather than showing empty", ctx.calls.status[1]?.content === undefined);
}

{
	const { ui } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "print" });
	ui.setStatus(ctx, ["⑂ feat"]);
	ok("no UI: there is no footer to paint", ctx.calls.status.length === 0);
}

// ===================================================== clearAll

{
	const { ui } = setup();
	const ctx = fakeCtx({ hasUI: true });
	ui.report(ctx, "Title:", ["one"]);
	ui.clearAll(ctx);
	ok("shutdown: clears the status segment", ctx.calls.status.at(-1)?.content === undefined);
	ok("shutdown: clears the widget", ctx.calls.widget.at(-1)?.content === undefined);

	// Whether or not a report was showing: shutdown must leave nothing behind for
	// the next session to inherit.
	const fresh = fakeCtx({ hasUI: true });
	ui.clearAll(fresh);
	ok("shutdown: clears even with no report on screen", fresh.calls.widget.at(-1)?.content === undefined);
}

{
	const { ui } = setup();
	const ctx = fakeCtx({ hasUI: false, mode: "print" });
	ui.clearAll(ctx);
	ok("no UI: shutdown touches nothing", ctx.calls.status.length === 0 && ctx.calls.widget.length === 0);
}

// ===================================================== farewell

// Unlike `say`, this one is keyed on `mode` alone: at quit the TUI is already
// coming down, so stdout is the only channel that reaches the user.
{
	const { ui, out, err } = setup();
	const ctx = fakeCtx({ hasUI: true, mode: "tui" });
	ui.farewell(ctx, ["worktree: lucky-willow (joel/lucky-willow)", "  cd /repo/wt/lucky-willow"]);
	ok(
		"quit: writes the block to stdout",
		out[0] === "worktree: lucky-willow (joel/lucky-willow)\n  cd /repo/wt/lucky-willow\n",
	);
	ok("quit: does not notify a UI that is being torn down", ctx.calls.notify.length === 0);
	ok("quit: nothing on stderr", err.length === 0);
}

{
	const { ui, out } = setup();
	ui.farewell(fakeCtx({ hasUI: false, mode: "print" }), ["one"]);
	ok("print: still reaches stdout", out[0] === "one\n");
}

// stdout is a protocol stream in these modes; a human-readable line corrupts it.
{
	const { ui, out, err } = setup();
	ui.farewell(fakeCtx({ hasUI: false, mode: "json" }), ["one"]);
	ui.farewell(fakeCtx({ hasUI: true, mode: "rpc" }), ["one"]);
	ok("json and rpc: silent, so the stream stays parseable", out.length === 0 && err.length === 0);
}

{
	const { ui, out } = setup();
	ui.farewell(fakeCtx({ hasUI: true, mode: "tui" }), []);
	ok("nothing to say: writes no stray newline", out.length === 0);
}

done();
