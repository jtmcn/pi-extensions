/**
 * Tests for the PR status display (worktree/pr.ts).
 *
 *   cd tests && npm install && node worktree/pr.test.mjs
 *
 * Pure functions only: formatting, CI rollup, poll cadence, command matching,
 * and target resolution (focused worktree vs. session worktree). The rollup
 * fixtures are real payloads from `gh pr view --json statusCheckRollup` — a
 * mixed array of CheckRun and StatusContext objects.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const pr = await loadExt("worktree/pr.ts");

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

// =========================================================== poll cadence

ok("poll: open polls every minute", pr.nextPollDelay({ status: "pr", state: "open" }) === 60_000);
ok("poll: draft polls every minute", pr.nextPollDelay({ status: "pr", state: "draft" }) === 60_000);
ok("poll: merged stops", pr.nextPollDelay({ status: "pr", state: "merged" }) === undefined);
ok("poll: closed stops", pr.nextPollDelay({ status: "pr", state: "closed" }) === undefined);
ok("poll: no PR waits five minutes", pr.nextPollDelay({ status: "none" }) === 300_000);
ok("poll: first error backs off a minute", pr.nextPollDelay({ status: "error", consecutiveErrors: 1 }) === 60_000);
ok("poll: second error backs off two", pr.nextPollDelay({ status: "error", consecutiveErrors: 2 }) === 120_000);
ok("poll: third error backs off five", pr.nextPollDelay({ status: "error", consecutiveErrors: 3 }) === 300_000);
ok("poll: backoff is capped", pr.nextPollDelay({ status: "error", consecutiveErrors: 99 }) === 300_000);

// ========================================================== bash trigger

ok("trigger: gt submit", pr.matchesPrCommand("gt submit"));
ok("trigger: gt submit with flags", pr.matchesPrCommand("gt submit --no-interactive"));
ok("trigger: gh pr create", pr.matchesPrCommand("gh pr create --fill"));
ok("trigger: git push", pr.matchesPrCommand("git push -u origin HEAD"));
ok("trigger: later in a chain", pr.matchesPrCommand("pants test :: && git push"));
ok("trigger: ignores unrelated commands", !pr.matchesPrCommand("git status"));
ok("trigger: ignores gh pr view", !pr.matchesPrCommand("gh pr view 123"));
ok("trigger: ignores a substring match", !pr.matchesPrCommand("echo pushing"));

// ========================================================= target identity

// The feature's founding invariant: a focused worktree's branch never falls
// back to the session's, and vice versa. Each field is resolved as a unit.
ok(
	"target: focused with a branch wins, ignoring repo",
	JSON.stringify(
		pr.resolveTarget({ path: "/wt", branch: "feature" }, { worktreeRoot: "/repo", branch: "main" }),
	) === JSON.stringify({ cwd: "/wt", branch: "feature" }),
	JSON.stringify(pr.resolveTarget({ path: "/wt", branch: "feature" }, { worktreeRoot: "/repo", branch: "main" })),
);
ok(
	"target: focused but detached is undefined, never the session's branch",
	pr.resolveTarget({ path: "/wt" }, { worktreeRoot: "/repo", branch: "main" }) === undefined,
	JSON.stringify(pr.resolveTarget({ path: "/wt" }, { worktreeRoot: "/repo", branch: "main" })),
);
ok(
	"target: unfocused uses the session's worktree and branch",
	JSON.stringify(pr.resolveTarget(undefined, { worktreeRoot: "/repo", branch: "main" })) ===
		JSON.stringify({ cwd: "/repo", branch: "main" }),
	JSON.stringify(pr.resolveTarget(undefined, { worktreeRoot: "/repo", branch: "main" })),
);
ok(
	"target: unfocused and detached is undefined",
	pr.resolveTarget(undefined, { worktreeRoot: "/repo" }) === undefined,
	JSON.stringify(pr.resolveTarget(undefined, { worktreeRoot: "/repo" })),
);
ok("target: neither focused nor in a repo is undefined", pr.resolveTarget(undefined, undefined) === undefined);

done();

/** Strip OSC 8 sequences so assertions can read the visible text. */
function stripAnsi(text) {
	return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}
