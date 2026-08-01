/**
 * Tests for the PR status display (worktree/pr.ts).
 *
 *   cd ~/.pi/agent/extensions/tests && npm install && node pr.test.mjs
 *
 * Pure functions only: formatting, CI rollup, poll cadence, command matching.
 * The rollup fixtures are real payloads from `gh pr view --json
 * statusCheckRollup` — a mixed array of CheckRun and StatusContext objects.
 */

import { join } from "node:path";
import { createJiti } from "jiti";

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_ENTRY = process.env.PI_DIST ?? (await resolvePiEntry());

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
});
const pr = await jiti.import(`${EXT}/worktree/pr.ts`);

let fails = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`ok    ${name}`);
	else {
		fails++;
		console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
	}
};

// ============================================================ state labels

const base = { number: 26904, state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/26904" };

ok("state: open", pr.prState(base) === "open");
ok("state: draft", pr.prState({ ...base, isDraft: true }) === "draft");
ok("state: merged", pr.prState({ ...base, state: "MERGED" }) === "merged");
ok("state: closed", pr.prState({ ...base, state: "CLOSED" }) === "closed");
ok(
	"state: a closed draft reads closed, not draft",
	pr.prState({ ...base, state: "CLOSED", isDraft: true }) === "closed",
	pr.prState({ ...base, state: "CLOSED", isDraft: true }),
);

// ============================================================== CI rollup

// Captured from equilibrium-energy/helios#26904: Graphite's check still running
// while buildkite had already succeeded.
const mixedPending = [
	{ __typename: "CheckRun", name: "Graphite / mergeability_check", status: "IN_PROGRESS", conclusion: "" },
	{ __typename: "StatusContext", context: "buildkite/helios", state: "SUCCESS" },
];

ok("rollup: empty array has no glyph", pr.rollupGlyph([]) === undefined);
ok("rollup: null has no glyph", pr.rollupGlyph(null) === undefined);
ok("rollup: undefined has no glyph", pr.rollupGlyph(undefined) === undefined);
ok("rollup: mixed with one in progress is pending", pr.rollupGlyph(mixedPending) === "●", pr.rollupGlyph(mixedPending));
ok(
	"rollup: all terminal successes pass",
	pr.rollupGlyph([
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "StatusContext", state: "SUCCESS" },
	]) === "✓",
);
ok(
	"rollup: skipped and neutral count as pass",
	pr.rollupGlyph([
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" },
	]) === "✓",
);
ok(
	"rollup: a CheckRun failure dominates",
	pr.rollupGlyph([
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
	]) === "✗",
);
ok(
	"rollup: a StatusContext error dominates",
	pr.rollupGlyph([{ __typename: "StatusContext", state: "ERROR" }]) === "✗",
);
ok(
	"rollup: failure beats pending",
	pr.rollupGlyph([
		{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
		{ __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" },
	]) === "✗",
);
ok(
	"rollup: cancelled is a failure",
	pr.rollupGlyph([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED" }]) === "✗",
);
ok(
	"rollup: an unknown conclusion is not silently a pass",
	pr.rollupGlyph([{ __typename: "CheckRun", status: "QUEUED", conclusion: "" }]) === "●",
);

// ================================================================= linking

ok(
	"url: graphite host and path",
	pr.graphiteUrl("equilibrium-energy/helios", 26904) ===
		"https://app.graphite.com/github/pr/equilibrium-energy/helios/26904",
	pr.graphiteUrl("equilibrium-energy/helios", 26904),
);

const link = pr.hyperlink("https://example.com/x", "text");
ok("link: OSC 8 wraps the text", link === "\x1b]8;;https://example.com/x\x07text\x1b]8;;\x07", JSON.stringify(link));

const formatted = pr.formatPr({ ...base, statusCheckRollup: mixedPending }, "equilibrium-energy/helios");
ok("format: visible text", stripAnsi(formatted) === "#26904 open ●", JSON.stringify(stripAnsi(formatted)));
ok("format: whole label is linked", formatted.startsWith("\x1b]8;;https://app.graphite.com/"), JSON.stringify(formatted));
ok(
	"format: no glyph when there are no checks",
	stripAnsi(pr.formatPr({ ...base, statusCheckRollup: [] }, "o/r")) === "#26904 open",
	stripAnsi(pr.formatPr({ ...base, statusCheckRollup: [] }, "o/r")),
);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);

/** Strip OSC 8 sequences so assertions can read the visible text. */
function stripAnsi(text) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
	return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

async function resolvePiEntry() {
	const { execSync } = await import("node:child_process");
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent/dist/index.js");
}
