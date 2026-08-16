/**
 * The invariant a human's eye caught and this file exists to pin: every
 * visible column of every delta-rendered tool row has to sit on a non-default
 * background for as long as pi's box is painting that row. Break it and a
 * themed diff shows the terminal's own background — dark navy rectangles to
 * the right of a diff line, or a fully navy row where a diff line is blank —
 * instead of pi's tool-box colour.
 *
 * The mechanism (see delta/ansi.ts's `restoreBackground` doc comment): pi's
 * `Box.applyBg` wraps one row's content *and* its trailing padding in a single
 * background span. Any `ESC[0m` inside that content cancels the span for
 * everything after it, padding included, because a terminal does not
 * re-apply a prefix on its own. Delta emits exactly that reset at the end of
 * (almost) every content line.
 *
 * This file drives pi's *real* `ToolExecutionComponent` — the actual `Box`,
 * the actual `theme.bg` — rather than asserting against delta/index.ts's
 * internals, so a fix that satisfies the unit tests in ansi.test.mjs but
 * fails to reach the real render path would still be caught here.
 *
 *   node tests/delta/background-bleed.test.mjs
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, piEntry } from "../harness.mjs";

const pexec = promisify(execFile);
const { ok, skip, done } = assertions();

const extension = (await loadExt("delta/index.ts")).default;
const piModule = await import(`file://${await piEntry()}`);
piModule.initTheme();
const { ToolExecutionComponent } = piModule;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A small, independent SGR state machine: walks a rendered line the way a real
// terminal would, tracking only whether the background is currently "default"
// (the app's own background, i.e. the bug) or something else. It does not
// import anything from delta/ansi.ts — the point is to check the real visual
// contract from outside, not to agree with restoreBackground's own bookkeeping.
// ---------------------------------------------------------------------------

/**
 * Classify one SGR sequence's parameters. 256-colour and 24-bit colour
 * introducers (`38`/`48` followed by `5;n` or `2;r;g;b`) are consumed as one
 * unit so an RGB component that happens to equal 0 or 49 is never misread as a
 * reset code — the same hazard restoreBackground's own parser has to avoid.
 */
function sgrEffects(body) {
	const tokens = body === "" ? ["0"] : body.split(";");
	const effects = [];
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i] === "" ? "0" : tokens[i];
		if (tok === "38" || tok === "48") {
			const isBg = tok === "48";
			const mode = tokens[i + 1];
			if (mode === "5") {
				effects.push(isBg ? "bg-set" : "fg-set");
				i += 3;
				continue;
			}
			if (mode === "2") {
				effects.push(isBg ? "bg-set" : "fg-set");
				i += 5;
				continue;
			}
			i += 1;
			continue;
		}
		if (tok === "0") effects.push("full-reset");
		else if (tok === "49") effects.push("bg-reset");
		else if (/^4[0-7]$/.test(tok) || /^10[0-7]$/.test(tok)) effects.push("bg-set");
		i += 1;
	}
	return effects;
}

/**
 * Walk one rendered line and return the column index of the first printable
 * character emitted while the background is at the terminal default, or -1 if
 * every printable column had a non-default background. CSI sequences update
 * background state; OSC sequences (hyperlinks) are skipped without changing
 * it; anything else printable advances the column count.
 */
function firstDefaultBackgroundColumn(line) {
	let i = 0;
	let column = 0;
	let hasBg = false;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\x1b") {
			const next = line[i + 1];
			if (next === "[") {
				let j = i + 2;
				while (j < line.length && !/[A-Za-z]/.test(line[j])) j += 1;
				const finalByte = line[j];
				const body = line.slice(i + 2, j);
				if (finalByte === "m") {
					for (const effect of sgrEffects(body)) {
						if (effect === "bg-set") hasBg = true;
						else if (effect === "bg-reset" || effect === "full-reset") hasBg = false;
					}
				}
				i = j + 1;
				continue;
			}
			if (next === "]") {
				// OSC, terminated by BEL or ST (`ESC\`). Does not touch SGR state.
				let j = i + 2;
				while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j += 1;
				i = line[j] === "\x07" ? j + 1 : j + 2;
				continue;
			}
			// Unrecognised escape: skip defensively rather than count it as visible.
			i += 2;
			continue;
		}
		if (!hasBg) return column;
		i += 1;
		column += 1;
	}
	return -1;
}

/** Assert the invariant across every line a render produced. */
function assertBackgroundEverywhere(label, lines) {
	const offenders = lines.map((line, row) => ({ row, col: firstDefaultBackgroundColumn(line) })).filter((entry) => entry.col !== -1);
	ok(
		label,
		offenders.length === 0,
		JSON.stringify({ offenders, lines }),
	);
}

// ---------------------------------------------------------------------------
// A diff with an added blank line — the "fully navy row" in the screenshot —
// plus ordinary added/removed/context lines, run through both a synthetic
// stand-in for delta and (if installed) the real binary.
// ---------------------------------------------------------------------------

const DIFF_TEXT = [
	"diff --git a/f b/f",
	"index 1111111..2222222 100644",
	"--- a/f",
	"+++ b/f",
	"@@ -1,3 +1,4 @@",
	" context before",
	"-old line",
	"+new line",
	"+",
	" context after",
].join("\n");

const root = await mkdtemp(join(tmpdir(), "delta-bleed-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(project, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

/**
 * Render `DIFF_TEXT` as a `bash` tool row through pi's real
 * `ToolExecutionComponent`, wait for the (possibly async) engine to answer,
 * and return the lines for both the collapsed and expanded states.
 */
async function renderBashDiff(width) {
	const h = createFakePi({ cwd: project });
	extension(h.pi);
	await h.fire("session_start");

	const bashDef = h.tools.get("bash");
	const ui = { requestRender() {} };
	const component = new ToolExecutionComponent(
		"bash",
		"call-bleed",
		{ command: "git diff" },
		{},
		bashDef,
		ui,
		project,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({ content: [{ type: "text", text: DIFF_TEXT }], details: undefined }, false);

	// First render is always a cache miss (fallback shown, a run scheduled);
	// wait for it, then render again to pick up the real engine answer.
	component.render(width);
	await settle(600);

	component.setExpanded(true);
	const expanded = component.render(width);
	component.setExpanded(false);
	const collapsed = component.render(width);

	return { expanded, collapsed };
}

// ---- synthetic engine answer: deterministic, runs whether or not real delta
// is installed, and reproduces delta's exact per-line shape from the doc
// comment (content, full reset, delta's own background, erase-in-line, full
// reset) plus the blank-added-line case.

// String concatenation rather than template-literal interpolation: this
// script's source is itself embedded in a template literal below, and a
// second layer of `${...}` interpolation inside that is exactly the kind of
// double-escaping that is easy to get subtly wrong (and did, the first time
// this test was written: it silently produced context lines with no reset at
// all, so the invariant it exists to catch never fired).
const fakeDelta = join(root, "fake-delta.mjs");
await writeFile(
	fakeDelta,
	[
		"#!/usr/bin/env node",
		'if (process.argv.includes("--version")) {',
		'	process.stdout.write("delta 0.0.0\\n");',
		"	process.exit(0);",
		"}",
		'let input = "";',
		'process.stdin.setEncoding("utf8");',
		'process.stdin.on("data", (chunk) => { input += chunk; });',
		'process.stdin.on("end", () => {',
		'	const ADD_BG = "\\x1b[48;2;40;59;40m";', // delta's own added-line background
		'	const DEL_BG = "\\x1b[48;2;59;40;40m";', // delta's own removed-line background
		'	const HEADER_FG = "\\x1b[34m";',
		'	const FG = "\\x1b[38;2;248;248;242m";',
		'	const RESET = "\\x1b[0m";',
		'	const ERASE = "\\x1b[0K";', // becomes FILL_SENTINEL after sanitize()
		"	const out = [];",
		'	for (const line of input.split("\\n")) {',
		'		if (line === "") continue;',
		'		if (line[0] === "+") {',
			// Delta's real shape: content, reset, its own background, erase-in-line, reset.
		"			out.push(FG + line.slice(1) + RESET + ADD_BG + ERASE + RESET);",
		'		} else if (line[0] === "-") {',
		"			out.push(FG + line.slice(1) + RESET + DEL_BG + ERASE + RESET);",
		'		} else if (line[0] === " ") {',
			// A context line: delta has no colour band to extend here, so it ends
			// with a plain reset and nothing after — the shape that reproduces the
			// bug even with delta's own line backgrounds suppressed (this
			// extension's default config).
			"			out.push(FG + line.slice(1) + RESET);",
		"		} else {",
		"			out.push(HEADER_FG + line + RESET);",
		"		}",
		"	}",
		'	process.stdout.write(out.join("\\n"));',
		"});",
		"",
	].join("\n"),
	{ mode: 0o755 },
);

{
	await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: fakeDelta, args: [] }));
	const { expanded, collapsed } = await renderBashDiff(60);
	ok("synthetic engine: expanded render is non-empty", expanded.length > 0);
	ok("synthetic engine: collapsed render is non-empty", collapsed.length > 0);
	// DIFF_TEXT's "+" line (nothing after it) is the blank added line from the
	// screenshot; assertBackgroundEverywhere below covers its rendered row along
	// with every other line, which is what actually matters — a blank line has
	// no distinguishing text of its own once rendered, only background.
	ok("the diff under test does contain a blank added line", DIFF_TEXT.includes("\n+\n"), DIFF_TEXT);
	assertBackgroundEverywhere("synthetic engine: every column of every expanded line has a non-default background", expanded);
	assertBackgroundEverywhere("synthetic engine: every column of every collapsed line has a non-default background", collapsed);

	// Narrower width too: a different wrap boundary must not reopen the gap.
	const narrow = await renderBashDiff(30);
	assertBackgroundEverywhere("synthetic engine, width 30: every column of every expanded line has a non-default background", narrow.expanded);
	assertBackgroundEverywhere("synthetic engine, width 30: every column of every collapsed line has a non-default background", narrow.collapsed);
}

// ---- real delta, if installed. Skips cleanly (not a failure) otherwise, so
// the suite runs the same on a machine without delta on PATH.

{
	let hasDelta = false;
	try {
		const { code } = await pexec("delta", ["--version"]).then(
			() => ({ code: 0 }),
			(error) => ({ code: error.code ?? 1 }),
		);
		hasDelta = code === 0;
	} catch {
		hasDelta = false;
	}

	if (!hasDelta) {
		skip("real delta is not on PATH; skipping the real-binary background invariant");
	} else {
		// The real default config (README): delta's own line backgrounds
		// suppressed, syntax highlighting and the gutter kept.
		await writeFile(
			join(agentDir, "delta.json"),
			JSON.stringify({ args: ["--minus-style", "syntax normal", "--plus-style", "syntax normal"] }),
		);
		const { expanded, collapsed } = await renderBashDiff(60);
		ok("real delta: expanded render is non-empty", expanded.length > 0, JSON.stringify(expanded));
		ok("real delta: collapsed render is non-empty", collapsed.length > 0);
		assertBackgroundEverywhere("real delta: every column of every expanded line has a non-default background", expanded);
		assertBackgroundEverywhere("real delta: every column of every collapsed line has a non-default background", collapsed);

		// The classic banded rendering (README's `"args": []` escape hatch):
		// delta emits its own full-width background fills, which is the shape
		// that motivated fill()'s erase-in-line handling in the first place.
		await writeFile(join(agentDir, "delta.json"), JSON.stringify({ args: [] }));
		const banded = await renderBashDiff(60);
		ok("real delta, args: []: expanded render is non-empty", banded.expanded.length > 0);
		assertBackgroundEverywhere("real delta, args: []: every column of every expanded line has a non-default background", banded.expanded);
		assertBackgroundEverywhere("real delta, args: []: every column of every collapsed line has a non-default background", banded.collapsed);
	}
}

await writeFile(join(agentDir, "delta.json"), JSON.stringify({ command: "delta-does-not-exist" }));
if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
await rm(root, { recursive: true, force: true });

done();
