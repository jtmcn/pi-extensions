# PR Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current branch's pull request — number, state, and CI rollup — as a clickable Graphite link in pi's footer.

**Architecture:** The existing `worktree` pi extension grows a PR display. Pure formatting and poll-cadence logic go in `worktree/pr.ts`; the two `gh` subprocess calls go in `worktree/gh.ts` behind the `GitRunner` interface `lib/git.ts` already defines; `worktree/index.ts` only wires them into the status segment it already owns. Living inside `worktree` is what makes the PR shown always match the branch shown, including when the extension's focus mode redirects the session into another worktree.

**Tech Stack:** TypeScript loaded by pi through jiti (no build step), Node's `node:test`-free hand-rolled `ok()` harness in `tests/`, `gh` CLI for data, OSC 8 escape sequences for the hyperlink.

**Spec:** `docs/superpowers/specs/2026-08-01-pr-status-bar-design.md`

## Global Constraints

- **No build step.** pi loads TypeScript via jiti. Import local modules with the explicit `.ts` extension (`../lib/git.ts`), matching the rest of the repo.
- **Pure modules stay pure.** `worktree/pr.ts` imports nothing from pi and performs no I/O — same rule `focus.ts` and `select.ts` follow.
- **Tabs, not spaces.** The repo indents with tabs. Double quotes for strings, semicolons, trailing commas in multiline literals.
- **Failures are silent.** This is decoration: never call `ctx.ui.notify()` from PR code, in any error path.
- **Never block the session.** No `await` on a PR fetch inside an event handler; refreshes are fire-and-forget.
- **Never capture `ctx` in a timer.** Read the module-scoped `sessionCtx`, which `session_shutdown` clears.
- **Do not start timers in the extension factory.** pi forbids it; start them lazily at the first refresh.
- Graphite host is exactly `https://app.graphite.com` (not `.dev`).
- Typecheck with `./typecheck.sh` — it is the only thing that catches type errors.

---

### Task 1: PR display formatting

Pure functions that turn a `gh` JSON payload into the footer string.

**Files:**
- Create: `worktree/pr.ts`
- Create: `tests/pr.test.mjs`
- Modify: `tests/package.json` (add `pr.test.mjs` to the `test` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type PrState = "open" | "draft" | "merged" | "closed"`
  - `interface RollupEntry { __typename?: string; status?: string; conclusion?: string; state?: string }`
  - `interface PullRequest { number: number; state: string; isDraft: boolean; url: string; statusCheckRollup?: RollupEntry[] | null }`
  - `prState(pr: PullRequest): PrState`
  - `rollupGlyph(entries: RollupEntry[] | null | undefined): string | undefined`
  - `graphiteUrl(nameWithOwner: string, number: number): string`
  - `hyperlink(url: string, text: string): string`
  - `formatPr(pr: PullRequest, nameWithOwner: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/pr.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Code/pi-extensions/tests && node pr.test.mjs
```

Expected: a jiti resolution error — `worktree/pr.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `worktree/pr.ts`:

```typescript
/**
 * Pull-request display for the worktree status segment.
 *
 * Pure and I/O-free, like `focus.ts` and `select.ts`: everything here is a
 * function of a `gh` JSON payload, so it can be tested without a network, a
 * repo, or pi. The subprocess calls live in `gh.ts`, the wiring in `index.ts`.
 */

/** PR state as displayed. `draft` is a display-only refinement of OPEN. */
export type PrState = "open" | "draft" | "merged" | "closed";

/**
 * One entry of `gh pr view --json statusCheckRollup`.
 *
 * The array is heterogeneous: GitHub Actions produce `CheckRun` objects
 * (`status` + `conclusion`), while external reporters like Buildkite produce
 * `StatusContext` objects (`state`). There is no server-side rollup field in
 * this payload, so the glyph has to be reduced client-side.
 */
export interface RollupEntry {
	__typename?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

/** The subset of `gh pr view --json …` this module reads. */
export interface PullRequest {
	number: number;
	state: string;
	isDraft: boolean;
	url: string;
	statusCheckRollup?: RollupEntry[] | null;
}

const FAILED_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PASSED_STATES = new Set(["SUCCESS", "EXPECTED"]);

export const GLYPH_PASS = "✓";
export const GLYPH_FAIL = "✗";
export const GLYPH_PENDING = "●";

/** Display label for a PR's state. Draft only applies while the PR is open. */
export function prState(pr: PullRequest): PrState {
	const state = pr.state.toUpperCase();
	if (state === "OPEN") return pr.isDraft ? "draft" : "open";
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "closed";
	return "open";
}

/**
 * Reduce a mixed check array to one glyph.
 *
 * Failure dominates pending, which dominates pass. Anything unrecognised
 * counts as pending rather than passing: a green tick is the one answer that
 * must never be a guess.
 */
export function rollupGlyph(entries: RollupEntry[] | null | undefined): string | undefined {
	if (!entries || entries.length === 0) return undefined;

	let pending = false;
	for (const entry of entries) {
		const conclusion = entry.conclusion?.toUpperCase() ?? "";
		const state = entry.state?.toUpperCase() ?? "";
		if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) return GLYPH_FAIL;
		if (PASSED_CONCLUSIONS.has(conclusion) || PASSED_STATES.has(state)) continue;
		pending = true;
	}
	return pending ? GLYPH_PENDING : GLYPH_PASS;
}

/**
 * Graphite's PR page for a GitHub PR.
 *
 * `app.graphite.com` is the host Graphite's own mergeability check reports in
 * its `detailsUrl`; `app.graphite.dev` merely redirects there.
 */
export function graphiteUrl(nameWithOwner: string, number: number): string {
	return `https://app.graphite.com/github/pr/${nameWithOwner}/${number}`;
}

/**
 * Wrap text in an OSC 8 hyperlink.
 *
 * pi's footer tolerates this: `visibleWidth()` scores the escape as zero,
 * `truncateToWidth()` preserves it, and the footer's sanitiser strips only
 * `\r\n\t`. The TUI emits an OSC 8 reset per line, so the link cannot leak.
 */
export function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** The footer label for a PR: `#26904 open ●`, linked to Graphite. */
export function formatPr(pr: PullRequest, nameWithOwner: string): string {
	const glyph = rollupGlyph(pr.statusCheckRollup);
	const label = `#${pr.number} ${prState(pr)}${glyph ? ` ${glyph}` : ""}`;
	return hyperlink(graphiteUrl(nameWithOwner, pr.number), label);
}
```

- [ ] **Step 4: Register the test file**

In `tests/package.json`, change the `test` script to:

```json
"test": "node worktree.test.mjs && node mcp.test.mjs && node pr.test.mjs"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/Code/pi-extensions/tests && node pr.test.mjs && ../typecheck.sh
```

Expected: `ALL PASS` then `typecheck: ok`.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/pr.ts tests/pr.test.mjs tests/package.json
git commit -m "Add PR display formatting for the status segment"
```

---

### Task 2: Poll cadence and the bash trigger predicate

Still pure: when to fetch next, and which shell commands mean "a PR may have just appeared".

**Files:**
- Modify: `worktree/pr.ts` (append)
- Modify: `tests/pr.test.mjs` (append a section before the final `console.log`)

**Interfaces:**
- Consumes: `PrState` from Task 1.
- Produces:
  - `type PollStatus = "pr" | "none" | "error"`
  - `interface PollInput { status: PollStatus; state?: PrState; consecutiveErrors?: number }`
  - `nextPollDelay(input: PollInput): number | undefined` — `undefined` means stop polling
  - `matchesPrCommand(command: string): boolean`
  - Constants `POLL_OPEN_MS`, `POLL_NO_PR_MS`, `ERROR_BACKOFF_MS`, `IDLE_SUSPEND_MS`, `BASH_TRIGGER_DELAY_MS`, `STALE_MS`

- [ ] **Step 1: Write the failing test**

Append to `tests/pr.test.mjs`, immediately before the final `console.log(...)` line:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Code/pi-extensions/tests && node pr.test.mjs
```

Expected: FAIL lines for every `poll:` and `trigger:` case (`pr.nextPollDelay is not a function`).

- [ ] **Step 3: Write the implementation**

Append to `worktree/pr.ts`:

```typescript
// ---- Poll cadence ----------------------------------------------------------

/** Cadence while a PR is open or draft: CI moves on roughly this timescale. */
export const POLL_OPEN_MS = 60_000;
/** Cadence with no PR on the branch, so a freshly created one still appears. */
export const POLL_NO_PR_MS = 300_000;
/** Backoff after consecutive fetch errors, indexed by error count. */
export const ERROR_BACKOFF_MS = [60_000, 120_000, 300_000];
/** No user input for this long suspends polling until the next input. */
export const IDLE_SUSPEND_MS = 900_000;
/** Delay after a submitting command, giving GitHub time to create the PR. */
export const BASH_TRIGGER_DELAY_MS = 8_000;
/** A cached entry older than this is repainted, then refreshed in background. */
export const STALE_MS = 60_000;

export type PollStatus = "pr" | "none" | "error";

export interface PollInput {
	status: PollStatus;
	/** Present when `status` is "pr". */
	state?: PrState;
	/** Consecutive failures so far, including the one that just happened. */
	consecutiveErrors?: number;
}

/**
 * Milliseconds until the next fetch, or `undefined` to stop polling.
 *
 * Merged and closed are terminal: nothing about them changes again, so the
 * timer stops until a branch or focus change revives it.
 */
export function nextPollDelay(input: PollInput): number | undefined {
	if (input.status === "error") {
		const index = Math.min(Math.max(input.consecutiveErrors ?? 1, 1), ERROR_BACKOFF_MS.length) - 1;
		return ERROR_BACKOFF_MS[index];
	}
	if (input.status === "none") return POLL_NO_PR_MS;
	return input.state === "open" || input.state === "draft" ? POLL_OPEN_MS : undefined;
}

/**
 * True for commands that plausibly create a PR or move its head.
 *
 * A heuristic on command text, deliberately: a miss only means the display
 * waits for the normal cadence. `\b` on the trailing word keeps `git pushed`
 * and `echo pushing` from matching.
 */
export function matchesPrCommand(command: string): boolean {
	return /\b(?:gt\s+submit|gh\s+pr\s+create|git\s+push)\b/.test(command);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/Code/pi-extensions/tests && node pr.test.mjs && ../typecheck.sh
```

Expected: `ALL PASS` then `typecheck: ok`.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/pr.ts tests/pr.test.mjs
git commit -m "Add PR poll cadence and submit-command matching"
```

---

### Task 3: The `gh` calls

Two subprocess calls behind the runner interface, with every failure classified.

**Files:**
- Create: `worktree/gh.ts`
- Create: `tests/gh.test.mjs`
- Modify: `tests/package.json` (add `gh.test.mjs` to the `test` script)

**Interfaces:**
- Consumes: `PullRequest` from Task 1; `GitRunner` from `../lib/git.ts` (shape: `{ exec(command, args, options?) => Promise<{ stdout, stderr, code, killed }> }`).
- Produces:
  - `type PrLookup = { status: "pr"; pr: PullRequest } | { status: "none" } | { status: "error" } | { status: "unavailable" }`
  - `fetchNameWithOwner(runner: GitRunner, cwd: string): Promise<string | undefined>`
  - `fetchPr(runner: GitRunner, branch: string, cwd: string): Promise<PrLookup>`
  - `GH_TIMEOUT_MS`

`"unavailable"` is terminal for the session (no `gh`, not authenticated, not a GitHub remote); `"error"` is transient and retried with backoff.

- [ ] **Step 1: Write the failing test**

Create `tests/gh.test.mjs`:

```javascript
/**
 * Tests for the gh calls behind the PR status display (worktree/gh.ts).
 *
 *   cd ~/.pi/agent/extensions/tests && npm install && node gh.test.mjs
 *
 * No subprocesses: a scripted fake runner returns canned stdout/stderr/exit
 * codes, including the real error strings gh produces.
 */

import { join } from "node:path";
import { createJiti } from "jiti";

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_ENTRY = process.env.PI_DIST ?? (await resolvePiEntry());

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
});
const gh = await jiti.import(`${EXT}/worktree/gh.ts`);

let fails = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`ok    ${name}`);
	else {
		fails++;
		console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
	}
};

/** A runner that returns a canned result and records the call. */
const fakeRunner = (result) => {
	const calls = [];
	return {
		calls,
		async exec(command, args, options = {}) {
			calls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false, ...result };
		},
	};
};

const PR_JSON = JSON.stringify({
	number: 26904,
	state: "OPEN",
	isDraft: false,
	url: "https://github.com/equilibrium-energy/helios/pull/26904",
	statusCheckRollup: [{ __typename: "StatusContext", context: "buildkite/helios", state: "SUCCESS" }],
});

// ========================================================== nameWithOwner

{
	const runner = fakeRunner({ stdout: '{"nameWithOwner":"equilibrium-energy/helios"}\n' });
	const name = await gh.fetchNameWithOwner(runner, "/repo");
	ok("repo: parses nameWithOwner", name === "equilibrium-energy/helios", name);
	ok("repo: runs in the given cwd", runner.calls[0].options.cwd === "/repo");
	ok("repo: passes a timeout", runner.calls[0].options.timeout === gh.GH_TIMEOUT_MS);
}

{
	const runner = fakeRunner({ code: 1, stderr: "not a github repository" });
	ok("repo: failure yields undefined", (await gh.fetchNameWithOwner(runner, "/repo")) === undefined);
}

{
	const runner = fakeRunner({ stdout: "not json" });
	ok("repo: unparseable output yields undefined", (await gh.fetchNameWithOwner(runner, "/repo")) === undefined);
}

// ================================================================= fetchPr

{
	const runner = fakeRunner({ stdout: PR_JSON });
	const result = await gh.fetchPr(runner, "joel/thing", "/repo");
	ok("pr: status is pr", result.status === "pr", JSON.stringify(result));
	ok("pr: number parsed", result.pr?.number === 26904);
	ok("pr: branch passed to gh", runner.calls[0].args.includes("joel/thing"), JSON.stringify(runner.calls[0].args));
	ok(
		"pr: asks for every field the display needs",
		runner.calls[0].args.at(-1) === "number,state,isDraft,url,statusCheckRollup",
		runner.calls[0].args.at(-1),
	);
}

{
	// The exact message gh prints for a branch with no PR.
	const runner = fakeRunner({ code: 1, stderr: "no pull requests found for branch \"joel/thing\"\n" });
	ok("pr: no PR is not an error", (await gh.fetchPr(runner, "joel/thing", "/repo")).status === "none");
}

{
	const runner = fakeRunner({ code: 4, stderr: "gh auth login required\n" });
	ok("pr: unauthenticated is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({
		code: 1,
		stderr: "none of the git remotes configured for this repository point to a known GitHub host\n",
	});
	ok("pr: non-github remote is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = { async exec() { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } };
	ok("pr: missing gh binary is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({ code: 1, stderr: "dial tcp: lookup api.github.com: no such host\n" });
	ok("pr: network failure is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

{
	const runner = fakeRunner({ stdout: "{oops" });
	ok("pr: unparseable JSON is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);

async function resolvePiEntry() {
	const { execSync } = await import("node:child_process");
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent/dist/index.js");
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Code/pi-extensions/tests && node gh.test.mjs
```

Expected: a jiti resolution error — `worktree/gh.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `worktree/gh.ts`:

```typescript
/**
 * The `gh` calls behind the PR status display.
 *
 * Kept out of `index.ts` so the failure classification is testable with a fake
 * runner, and out of `pr.ts` so that module stays pure. Takes the same
 * `GitRunner` interface `lib/git.ts` defines — it is just "something that can
 * run a command".
 */

import type { GitRunner } from "../lib/git.ts";
import type { PullRequest } from "./pr.ts";

/** Cap on a single gh call. Measured cost is ~0.5s; this is a stuck-network guard. */
export const GH_TIMEOUT_MS = 10_000;

/**
 * Outcome of a PR lookup.
 *
 * `unavailable` is terminal for the session — no `gh`, not authenticated, not
 * a GitHub remote — and switches the whole feature off. `error` is transient
 * and retried with backoff.
 */
export type PrLookup =
	| { status: "pr"; pr: PullRequest }
	| { status: "none" }
	| { status: "error" }
	| { status: "unavailable" };

/** Substrings in gh's stderr that mean "never going to work here". */
const UNAVAILABLE_PATTERNS = [
	"gh auth login",
	"authentication required",
	"not logged into",
	"known github host",
	"could not determine",
];

/** The repo's `owner/name`, or undefined when gh cannot say. Cache this. */
export async function fetchNameWithOwner(runner: GitRunner, cwd: string): Promise<string | undefined> {
	const result = await run(runner, ["repo", "view", "--json", "nameWithOwner"], cwd);
	if (!result || result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string };
		return parsed.nameWithOwner || undefined;
	} catch {
		return undefined;
	}
}

/** Look up the PR for `branch`, classifying every failure mode. */
export async function fetchPr(runner: GitRunner, branch: string, cwd: string): Promise<PrLookup> {
	const result = await run(
		runner,
		["pr", "view", branch, "--json", "number,state,isDraft,url,statusCheckRollup"],
		cwd,
	);
	// A throw from exec means the binary is missing or unspawnable.
	if (!result) return { status: "unavailable" };

	if (result.code !== 0) {
		const stderr = result.stderr.toLowerCase();
		// gh uses exit 1 for both "no PR" and real errors, so the message decides.
		if (stderr.includes("no pull requests found")) return { status: "none" };
		if (UNAVAILABLE_PATTERNS.some((pattern) => stderr.includes(pattern))) return { status: "unavailable" };
		return { status: "error" };
	}

	try {
		const pr = JSON.parse(result.stdout) as PullRequest;
		if (typeof pr?.number !== "number") return { status: "error" };
		return { status: "pr", pr };
	} catch {
		return { status: "error" };
	}
}

/** Run gh, converting a spawn throw into `undefined`. */
async function run(runner: GitRunner, args: string[], cwd: string) {
	try {
		return await runner.exec("gh", args, { cwd, timeout: GH_TIMEOUT_MS });
	} catch {
		return undefined;
	}
}
```

- [ ] **Step 4: Register the test file**

In `tests/package.json`, change the `test` script to:

```json
"test": "node worktree.test.mjs && node mcp.test.mjs && node pr.test.mjs && node gh.test.mjs"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/Code/pi-extensions/tests && node gh.test.mjs && ../typecheck.sh
```

Expected: `ALL PASS` then `typecheck: ok`.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/gh.ts tests/gh.test.mjs tests/package.json
git commit -m "Add gh lookups for the PR status display"
```

---

### Task 4: Wire the PR into the status segment

State, cache, and painting. No timer yet — this task ends with a PR visible on session start.

**Files:**
- Modify: `worktree/index.ts` (imports; new state block; `setStatus`; `session_start`; `session_shutdown`; `setFocus`)

**Interfaces:**
- Consumes: `formatPr` (Task 1), `STALE_MS` (Task 2), `fetchNameWithOwner`, `fetchPr`, `PrLookup` (Task 3).
- Produces: internal only — `refreshPr(force?: boolean): void` and `prLabel(): string | undefined`, both closure-scoped inside the default export. Task 5 calls them.

- [ ] **Step 1: Add the imports**

In `worktree/index.ts`, after the existing `import { matchWorktree, parseNewArgs } from "./select.ts";` line, add:

```typescript
import { fetchNameWithOwner, fetchPr, type PrLookup } from "./gh.ts";
import { formatPr, STALE_MS } from "./pr.ts";
```

- [ ] **Step 2: Add the PR state block**

In `worktree/index.ts`, immediately after the `let knownWorktrees: Worktree[] = [];` declaration and its comment, add:

```typescript
	// ---- PR status ---------------------------------------------------------

	/**
	 * Last lookup per `<cwd>\0<branch>`, so switching focus repaints instantly
	 * and only refreshes in the background.
	 */
	const prCache = new Map<string, { fetchedAt: number; lookup: PrLookup }>();
	/** `owner/name` for the repo, fetched once per session. */
	let nameWithOwner: string | undefined;
	/** Cleared for the session when gh is missing, unauthenticated, or non-GitHub. */
	let prAvailable = true;
	/** Consecutive fetch failures, for backoff. */
	let prErrors = 0;
	/** Guard so overlapping triggers cannot start two fetches. */
	let prFetching = false;

	/** The worktree whose PR is displayed: the focused one, else the session's. */
	const prTarget = (): { cwd: string; branch: string } | undefined => {
		const cwd = focus?.path ?? repo?.worktreeRoot;
		const branch = focus?.branch ?? repo?.branch;
		return cwd && branch ? { cwd, branch } : undefined;
	};

	const prKey = (target: { cwd: string; branch: string }) => `${target.cwd}\0${target.branch}`;

	/** The formatted PR label for the active target, if one is cached. */
	const prLabel = (): string | undefined => {
		const target = prTarget();
		if (!target || !nameWithOwner) return undefined;
		const entry = prCache.get(prKey(target));
		if (entry?.lookup.status !== "pr") return undefined;
		return formatPr(entry.lookup.pr, nameWithOwner);
	};

	/**
	 * Refresh the active target's PR in the background.
	 *
	 * Never awaited by a handler: a session must not wait on the network. The
	 * result is dropped if focus moved while the fetch was in flight.
	 */
	const refreshPr = (force = false): void => {
		const target = prTarget();
		if (!prAvailable || prFetching || !target) return;

		const key = prKey(target);
		const cached = prCache.get(key);
		if (!force && cached && Date.now() - cached.fetchedAt < STALE_MS) return;

		prFetching = true;
		void (async () => {
			try {
				if (!nameWithOwner) {
					nameWithOwner = await fetchNameWithOwner(pi, target.cwd);
					if (!nameWithOwner) {
						prAvailable = false;
						return;
					}
				}

				const lookup = await fetchPr(pi, target.branch, target.cwd);
				if (lookup.status === "unavailable") {
					prAvailable = false;
					return;
				}
				if (lookup.status === "error") {
					prErrors += 1;
					return;
				}

				prErrors = 0;
				prCache.set(key, { fetchedAt: Date.now(), lookup });

				// Focus may have moved while gh was running; only paint if not.
				const current = prTarget();
				if (sessionCtx && current && prKey(current) === key) setStatus(sessionCtx);
			} finally {
				prFetching = false;
			}
		})();
	};
```

Note: `pi` satisfies the `GitRunner` interface directly — it has the same `exec` signature — so it is passed as the runner.

- [ ] **Step 3: Rewrite `setStatus` to include the PR**

Replace the existing `setStatus` in `worktree/index.ts`:

```typescript
	const setStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!focus) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = focus.branch ? `${basename(focus.path)} (${focus.branch})` : basename(focus.path);
		ctx.ui.setStatus(STATUS_KEY, `⑂ ${label}`);
	};
```

with:

```typescript
	/**
	 * Paint the footer segment: focused worktree, PR, or both.
	 *
	 * Unfocused sessions show the PR alone — pi's own footer line already reads
	 * `<pwd> (<branch>)`, so the branch is not lost. With neither, the segment
	 * is cleared rather than left showing something stale.
	 */
	const setStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const parts: string[] = [];
		if (focus) {
			const label = focus.branch ? `${basename(focus.path)} (${focus.branch})` : basename(focus.path);
			parts.push(`⑂ ${label}`);
		}
		const pr = prLabel();
		if (pr) parts.push(pr);
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" ") : undefined);
	};
```

- [ ] **Step 4: Reset PR state and kick a refresh on session start**

In the `session_start` handler, the block that resets session state currently reads:

```typescript
		config = { ...DEFAULT_CONFIG };
		configSources = [];
		knownWorktrees = [];
		focus = undefined;
```

Append the PR resets to it:

```typescript
		config = { ...DEFAULT_CONFIG };
		configSources = [];
		knownWorktrees = [];
		focus = undefined;
		prCache.clear();
		nameWithOwner = undefined;
		prAvailable = true;
		prErrors = 0;
```

Then, at the very end of the same handler, the final line is `setStatus(ctx);`. Add a refresh after it:

```typescript
		setStatus(ctx);
		refreshPr();
```

(Leave the earlier `setStatus(ctx); return;` early-exit for "not a repo" alone — there is no branch to look up there.)

- [ ] **Step 5: Refresh when focus changes**

In `setFocus`, the body begins:

```typescript
		focus = target;
		setStatus(ctx);
```

Change it to:

```typescript
		focus = target;
		setStatus(ctx);
		// Repaint from cache above, then reconcile the new target in background.
		refreshPr();
```

- [ ] **Step 6: Verify by hand in a real session**

```bash
cd /Users/joel/Code/hellos/main && git switch --detach origin/joel/ont-mount-constant && git switch -c pr-status-smoke origin/joel/ont-mount-constant 2>/dev/null; pi
```

Expected: within a second or two the footer's extension line shows `#26904 open ●` (glyph may differ), and clicking or cmd-clicking it opens `app.graphite.com/github/pr/equilibrium-energy/helios/26904`.
Then check a branch with no PR (`git switch main`, restart pi): no segment at all.
Clean up with `git switch main && git branch -D pr-status-smoke`.

- [ ] **Step 7: Run the full suite and typecheck**

```bash
cd ~/Code/pi-extensions/tests && npm test && cd .. && ./typecheck.sh
```

Expected: `ALL PASS` from each test file, then `typecheck: ok`.

- [ ] **Step 8: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/index.ts
git commit -m "Show the branch's PR in the worktree status segment"
```

---

### Task 5: Polling, idle suspension, and the bash trigger

Keeps the display live without leaving a timer running forever.

**Files:**
- Modify: `worktree/index.ts` (PR state block; `refreshPr`; `session_shutdown`; `input`; new `tool_result` and `user_bash` handlers)

**Interfaces:**
- Consumes: `refreshPr`, `prTarget`, `prKey`, `prCache`, `prErrors`, `prAvailable` (Task 4); `nextPollDelay`, `prState`, `matchesPrCommand`, `IDLE_SUSPEND_MS`, `BASH_TRIGGER_DELAY_MS` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Extend the imports and state**

Change the `./pr.ts` import added in Task 4 to:

```typescript
import {
	BASH_TRIGGER_DELAY_MS,
	formatPr,
	IDLE_SUSPEND_MS,
	matchesPrCommand,
	nextPollDelay,
	prState,
	STALE_MS,
} from "./pr.ts";
```

And add to the PR state block, after `let prFetching = false;`:

```typescript
	/** Pending poll. Holds no ctx: a captured one is stale after session replacement. */
	let prTimer: ReturnType<typeof setTimeout> | undefined;
	/** Pending post-submit refresh. */
	let prBashTimer: ReturnType<typeof setTimeout> | undefined;
	/** Last user input, for idle suspension. */
	let lastInputAt = Date.now();

	/** Cancel every pending PR timer. Idempotent. */
	const stopPrTimers = () => {
		if (prTimer) clearTimeout(prTimer);
		if (prBashTimer) clearTimeout(prBashTimer);
		prTimer = undefined;
		prBashTimer = undefined;
	};
```

- [ ] **Step 2: Re-arm the timer after each refresh**

Inside `refreshPr`'s async body, the `finally` block currently reads:

```typescript
			} finally {
				prFetching = false;
			}
```

Replace it with:

```typescript
			} finally {
				prFetching = false;
				schedulePoll();
			}
```

Then add `schedulePoll` immediately after `refreshPr`:

```typescript
	/**
	 * Arm the next poll, cadence chosen by what the last fetch found.
	 *
	 * A self-rescheduling timeout rather than an interval: the delay depends on
	 * the result just fetched. Sleeping sessions stop polling entirely — the
	 * next `input` refreshes and re-arms.
	 */
	const schedulePoll = () => {
		if (prTimer) clearTimeout(prTimer);
		prTimer = undefined;
		if (!prAvailable || Date.now() - lastInputAt > IDLE_SUSPEND_MS) return;

		const target = prTarget();
		if (!target) return;

		const cached = prCache.get(prKey(target));
		const delay =
			prErrors > 0
				? nextPollDelay({ status: "error", consecutiveErrors: prErrors })
				: cached?.lookup.status === "pr"
					? nextPollDelay({ status: "pr", state: prState(cached.lookup.pr) })
					: nextPollDelay({ status: "none" });
		if (delay === undefined) return;

		prTimer = setTimeout(() => {
			prTimer = undefined;
			refreshPr(true);
		}, delay);
		// Do not hold the process open for a status decoration.
		prTimer.unref?.();
	};
```

- [ ] **Step 3: Refresh on input, and cancel timers on shutdown**

The `input` handler currently reads:

```typescript
	// Reports stay up until the user does something else.
	pi.on("input", (_event, ctx) => {
		clearReport(ctx);
	});
```

Replace it with:

```typescript
	// Reports stay up until the user does something else.
	pi.on("input", (_event, ctx) => {
		clearReport(ctx);
		// Input also ends idle suspension: refresh if stale, then re-arm.
		lastInputAt = Date.now();
		refreshPr();
		if (!prTimer) schedulePoll();
	});
```

The `session_shutdown` handler currently reads:

```typescript
	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		if (!ctx.hasUI) return;
```

Add the timer cancellation as its first statement:

```typescript
	pi.on("session_shutdown", (_event, ctx) => {
		stopPrTimers();
		sessionCtx = undefined;
		if (!ctx.hasUI) return;
```

- [ ] **Step 4: Add the bash trigger**

Add these two handlers immediately after the existing `pi.on("input", …)` handler:

```typescript
	/**
	 * Refresh shortly after a command that may have created or moved a PR.
	 *
	 * Post-execution on purpose — `tool_call` fires before the push lands — and
	 * delayed, because GitHub needs a moment to create the PR and register its
	 * checks.
	 */
	const scheduleBashRefresh = (command: unknown) => {
		if (typeof command !== "string" || !matchesPrCommand(command)) return;
		if (prBashTimer) clearTimeout(prBashTimer);
		prBashTimer = setTimeout(() => {
			prBashTimer = undefined;
			refreshPr(true);
		}, BASH_TRIGGER_DELAY_MS);
		prBashTimer.unref?.();
	};

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		scheduleBashRefresh((event.input as { command?: unknown } | undefined)?.command);
	});

	pi.on("user_bash", (event) => {
		scheduleBashRefresh(event.command);
	});
```

Both handlers return `undefined`, which leaves the tool result and the bash execution untouched.

- [ ] **Step 5: Verify the timer discipline by hand**

```bash
cd ~/Code/pi-extensions && ./typecheck.sh && cd tests && npm test
```

Then, in a pi session on a branch with an open PR:
1. Confirm the segment appears.
2. Run `!git push` and confirm the segment refreshes within ~10s (watch for a CI glyph change to `●`).
3. Exit pi with `/exit` and confirm the process exits immediately — a leaked timer would delay it.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/index.ts
git commit -m "Keep the PR status live with adaptive polling"
```

---

### Task 6: Document it

**Files:**
- Modify: `worktree/README.md`
- Modify: `README.md` (the extensions table row for `worktree`)

**Interfaces:**
- Consumes: everything above. Produces: nothing.

- [ ] **Step 1: Add a section to `worktree/README.md`**

Append:

````markdown
## PR in the status bar

When the current branch has a pull request, the status segment shows it:

```
⑂ main (joel/ont-mount-constant) #26904 open ●    ← worktree focused
#26904 open ●                                     ← no focus
```

The PR text is an OSC 8 hyperlink to the Graphite PR page
(`app.graphite.com/github/pr/<owner>/<repo>/<number>`); cmd-click it in a
terminal that supports hyperlinks. The glyph is the CI rollup: `✓` all passed,
`✗` something failed, `●` still running, absent when there are no checks. The
state word is `open`, `draft`, `merged`, or `closed`.

Unfocused sessions show the PR alone, because pi's own footer line already
reads `<pwd> (<branch>)`.

Data comes from `gh pr view <branch>`, refreshed every 60s while the PR is open,
every 5 min when the branch has no PR, and never once it is merged or closed.
Polling suspends after 15 minutes without input and resumes on the next one. A
`gt submit`, `gh pr create`, or `git push` schedules a refresh 8s later so a new
PR appears promptly.

Everything fails silently: no `gh`, not logged in, no network, or a non-GitHub
remote simply means no PR text.
````

- [ ] **Step 2: Update the table row in the top-level `README.md`**

Change the `worktree` row to:

```markdown
| [`worktree`](worktree/README.md) | Manage git worktrees; optionally redirect the agent's tool calls into one without restarting the session. Shows the branch's PR in the status bar. |
```

- [ ] **Step 3: Commit**

```bash
cd ~/Code/pi-extensions
git add worktree/README.md README.md
git commit -m "Document the PR status display"
```

---

## Self-Review

**Spec coverage.** Display rules → Task 1. CI rollup → Task 1. Graphite host → Task 1. OSC 8 → Task 1. Unfocused rendering → Task 4 step 3. `gh` calls and caching of `nameWithOwner` → Tasks 3, 4. Cache keying and focus swap → Task 4. Fire-and-forget on `session_start` and focus change → Task 4. Poll cadence table → Task 2 (policy) and Task 5 (arming). Idle suspension → Task 5. Bash trigger → Tasks 2, 5. Single in-flight fetch, 10s timeout, discard on key change → Tasks 3, 4. Failure handling and silence → Tasks 3, 4. Timer discipline → Task 5. Files table → Tasks 1, 3, 4, 6. Out-of-scope items are absent, as intended.

**Type consistency.** `PullRequest` is defined in `pr.ts` (Task 1) and imported by `gh.ts` (Task 3). `PrLookup` is defined in `gh.ts` and consumed in `index.ts` (Task 4). `prState` returns the `PrState` that `nextPollDelay` accepts (Tasks 1, 2, 5). `GitRunner` comes from the existing `lib/git.ts`, and `pi` satisfies it (noted in Task 4 step 2).

**Known risk, accepted.** `prErrors` drives the backoff but is a single counter shared across branches; switching branches mid-backoff inherits the count. It self-clears on the first success, and the cost of being wrong is a delayed status refresh.
