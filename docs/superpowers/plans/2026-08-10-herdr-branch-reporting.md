# herdr Branch Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi session running inside herdr reports the branch it is actually working on — the focused worktree's branch, or the session's own — so herdr's sidebar and pane title stop saying `main`.

**Architecture:** A new `lib/herdr.ts` factory turns "the displayed branch" into two `herdr` CLI calls. `worktree/session.ts` calls it as an injected sink from `paint()`, which already runs whenever the displayed branch moves; `worktree/index.ts` builds the reporter per session and clears it at shutdown. No new timers, no new polling, no new commands or tools.

**Tech Stack:** TypeScript loaded by pi through jiti (no build step), Node's `node:test`-free assertion harness in `tests/harness.mjs`, real `git` in throwaway repos, `herdr` 0.8.0 CLI.

**Design spec:** `docs/superpowers/specs/2026-08-10-herdr-branch-reporting-design.md`

## Global Constraints

- No new top-level directory. A directory with an `index.ts` becomes a loaded extension; this feature is `lib/herdr.ts` plus wiring inside `worktree/`.
- `npm run check` (typecheck + all tests) must pass before every commit. `typecheck.sh` resolves pi's types from the **globally installed** pi.
- Tabs for indentation, matching every existing file in the repo.
- The herdr CLI argument order is load-bearing: **positional first**, then `--flag value` as separate argv entries. `--source=pi` and `--token=NAME=VALUE` are rejected by herdr. The token value itself is one `NAME=VALUE` argument.
- Source id is `pi`; workspace token name is `pi_branch`; pane title format is `π - <branch>`.
- Never touch `ctx` from anything that can outlive the turn. Nothing in `lib/herdr.ts` receives a `ctx` at all — keep it that way.
- Reset all session state in `session_start`; a replaced session's reporter must be disposed, exactly as its PR monitor is.
- Every new test must be broken on purpose and seen to fail before it is trusted.

---

### Task 1: `lib/herdr.ts` — the reporter

**Files:**
- Create: `lib/herdr.ts`
- Create: `tests/worktree/herdr.test.mjs`

**Interfaces:**
- Consumes: `GitRunner` from `lib/git.ts` (`exec(command, args, options) => Promise<ExecResult>`).
- Produces:
  - `HERDR_TIMEOUT_MS: number` (2000)
  - `herdrTarget(env: Record<string, string | undefined>): HerdrTarget | undefined` where `HerdrTarget = { workspaceId: string; paneId: string }`
  - `createHerdrReporter(options: { runner: GitRunner; target: HerdrTarget; branchPrefix?: string }): HerdrReporter`
  - `HerdrReporter = { report(branch: string | undefined): void; clear(): Promise<void>; dispose(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/worktree/herdr.test.mjs`:

```javascript
/**
 * Tests for reporting pi's branch to herdr (lib/herdr.ts).
 *
 *   cd tests && npm install && node worktree/herdr.test.mjs
 *
 * No subprocesses and no herdr: a fake runner records argv. The argv is
 * asserted as an ordered array on purpose — herdr 0.8.0 rejects `--source=pi`
 * and requires the positional first, so a "contains pi_branch" assertion would
 * pass against a command herdr refuses to run.
 */

import { assertions, fakeRunner, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createHerdrReporter, herdrTarget, HERDR_TIMEOUT_MS } = await loadExt("lib/herdr.ts");

const TARGET = { workspaceId: "wF", paneId: "wF:p1" };

/** Reports are fire-and-forget; give the microtasks a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A runner that records calls and answers each with a scripted result. */
function scriptedRunner(results = []) {
	const calls = [];
	let index = 0;
	return {
		calls,
		async exec(command, args, options = {}) {
			calls.push({ command, args, options });
			const result = results[Math.min(index++, results.length - 1)] ?? {};
			return { stdout: "", stderr: "", code: 0, killed: false, ...result };
		},
	};
}

// ============================================================ target from env

{
	ok("target: needs both ids", herdrTarget({ HERDR_WORKSPACE_ID: "wF" }) === undefined);
	ok("target: no herdr, no target", herdrTarget({}) === undefined);
	const target = herdrTarget({ HERDR_WORKSPACE_ID: "wF", HERDR_PANE_ID: "wF:p1" });
	ok("target: reads both ids", target?.workspaceId === "wF" && target?.paneId === "wF:p1");
}

// ==================================================================== argv

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("fix-parser");
	await settle();

	ok("argv: one call per surface", runner.calls.length === 2, JSON.stringify(runner.calls));
	ok("argv: runs herdr", runner.calls.every((call) => call.command === "herdr"));
	ok(
		"argv: workspace token, positional first",
		JSON.stringify(runner.calls[0]?.args) ===
			JSON.stringify([
				"workspace",
				"report-metadata",
				"wF",
				"--source",
				"pi",
				"--token",
				"pi_branch=fix-parser",
			]),
		JSON.stringify(runner.calls[0]?.args),
	);
	ok(
		"argv: pane title, positional first",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify(["pane", "report-metadata", "wF:p1", "--source", "pi", "--title", "π - fix-parser"]),
		JSON.stringify(runner.calls[1]?.args),
	);
	ok("argv: passes a timeout", runner.calls[0]?.options.timeout === HERDR_TIMEOUT_MS);
}

// ========================================================== prefix stripping

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET, branchPrefix: "joel/" });
	reporter.report("joel/fix-parser");
	await settle();
	ok("prefix: the user's own prefix is dropped", runner.calls[0]?.args.includes("pi_branch=fix-parser"), JSON.stringify(runner.calls[0]?.args));
	ok("prefix: the title drops it too", runner.calls[1]?.args.includes("π - fix-parser"));
}

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET, branchPrefix: "joel/" });
	reporter.report("alice/hotfix");
	await settle();
	ok("prefix: someone else's branch is untouched", runner.calls[0]?.args.includes("pi_branch=alice/hotfix"), JSON.stringify(runner.calls[0]?.args));
}

// ============================================================= detached HEAD

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report(undefined);
	await settle();
	ok(
		"detached: clears the token",
		JSON.stringify(runner.calls[0]?.args) ===
			JSON.stringify(["workspace", "report-metadata", "wF", "--source", "pi", "--clear-token", "pi_branch"]),
		JSON.stringify(runner.calls[0]?.args),
	);
	ok(
		"detached: clears the title",
		JSON.stringify(runner.calls[1]?.args) ===
			JSON.stringify(["pane", "report-metadata", "wF:p1", "--source", "pi", "--clear-title"]),
		JSON.stringify(runner.calls[1]?.args),
	);
}

// =================================================================== dedupe

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	reporter.report("main");
	reporter.report("main");
	await settle();
	ok("dedupe: an unchanged branch costs nothing", runner.calls.length === 2, `${runner.calls.length} calls`);

	reporter.report("other");
	await settle();
	ok("dedupe: a changed branch reports once", runner.calls.length === 4, `${runner.calls.length} calls`);
}

// ======================================================== failure disables

{
	const runner = scriptedRunner([{ code: 1, stderr: "unknown workspace\n" }]);
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	const afterFailure = runner.calls.length;
	reporter.report("other");
	reporter.report("third");
	await settle();
	ok("failure: the reporter goes inert", runner.calls.length === afterFailure, `${runner.calls.length} vs ${afterFailure}`);
}

{
	const runner = { async exec() { throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }); } };
	const reporter = createHerdrReporter({ runner, target: TARGET });
	let threw = false;
	try {
		reporter.report("main");
		await settle();
	} catch {
		threw = true;
	}
	ok("failure: a missing herdr binary throws nothing", threw === false);
}

// ==================================================================== clear

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	await reporter.clear();
	ok("clear: issues both clears", runner.calls.length === 4, `${runner.calls.length} calls`);
	ok("clear: clears the token", runner.calls[2]?.args.includes("--clear-token") && runner.calls[2]?.args.includes("pi_branch"), JSON.stringify(runner.calls[2]?.args));
	ok("clear: clears the title", runner.calls[3]?.args.includes("--clear-title"), JSON.stringify(runner.calls[3]?.args));
}

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	await reporter.clear();
	ok("clear: nothing reported, nothing to clear", runner.calls.length === 0, JSON.stringify(runner.calls));
}

// ================================================================== dispose

{
	const runner = fakeRunner();
	const reporter = createHerdrReporter({ runner, target: TARGET });
	reporter.report("main");
	await settle();
	const before = runner.calls.length;
	reporter.dispose();
	reporter.report("other");
	await settle();
	ok("dispose: a retired reporter is silent", runner.calls.length === before, `${runner.calls.length} vs ${before}`);
}

done();
```

- [ ] **Step 2: Run the test and watch it fail for the right reason**

```bash
cd ~/Code/pi-extensions && node tests/worktree/herdr.test.mjs
```

Expected: it fails to even load — `Cannot find module .../lib/herdr.ts`. Not a passing run, and not an assertion failure.

- [ ] **Step 3: Write `lib/herdr.ts`**

```typescript
/**
 * Reporting pi's branch to herdr, the terminal workspace manager.
 *
 * herdr labels a space from its pane's cwd and derives the branch the same way.
 * In a bare layout (`proj/.bare` + `proj/main`) that reads `main`, and it keeps
 * reading `main` when the session moves to a feature branch — and when
 * `/worktree focus` points pi at a worktree, since focus rewrites tool inputs
 * rather than changing `cwd`. pi knows the real answer; this hands it over.
 *
 * A factory over an injected runner, with no `ctx` anywhere: a report that
 * settles after its session was replaced must be incapable of painting through
 * a stale context.
 *
 * The CLI's argument shape is measured against herdr 0.8.0, not documented
 * upstream: the positional comes FIRST and flags take a space-separated value.
 * `herdr workspace report-metadata --source pi ... wF` fails with "unknown
 * option: wF", and `--source=pi` fails with "unknown option: --source=pi".
 * The token value is a single `NAME=VALUE` argument.
 */

import type { GitRunner } from "./git.ts";

/** Cap on a single herdr call. It is a local socket; this is a wedged-socket guard. */
export const HERDR_TIMEOUT_MS = 2_000;

/** Source id on every report, so herdr scopes what we set to us. */
const SOURCE = "pi";

/** Workspace metadata token the sidebar row layout renders as `$pi_branch`. */
const BRANCH_TOKEN = "pi_branch";

export interface HerdrTarget {
	workspaceId: string;
	paneId: string;
}

/**
 * herdr's ids for the pane pi is running in, or undefined when pi is not
 * running under herdr. Both are needed: the branch goes to the workspace, the
 * title to the pane.
 */
export function herdrTarget(env: Record<string, string | undefined>): HerdrTarget | undefined {
	const workspaceId = env.HERDR_WORKSPACE_ID;
	const paneId = env.HERDR_PANE_ID;
	if (!workspaceId || !paneId) return undefined;
	return { workspaceId, paneId };
}

export interface HerdrReporterOptions {
	runner: GitRunner;
	target: HerdrTarget;
	/**
	 * Stripped from the branch before display. It is on every branch the user
	 * creates and the sidebar is 18–36 columns wide.
	 */
	branchPrefix?: string;
}

export interface HerdrReporter {
	/** Report the branch pi is displaying; undefined means detached HEAD. */
	report: (branch: string | undefined) => void;
	/** Remove what this session reported. Awaited at shutdown, then inert. */
	clear: () => Promise<void>;
	/** Retire the reporter: later reports do nothing. */
	dispose: () => void;
}

export function createHerdrReporter(options: HerdrReporterOptions): HerdrReporter {
	const { runner, target } = options;
	const branchPrefix = options.branchPrefix ?? "";

	/** Last branch actually sent, so an unchanged paint costs nothing. */
	let last: string | undefined;
	/** Whether anything has been sent at all; `undefined` is a real value. */
	let sent = false;
	/** One call at a time; a report arriving mid-flight is remembered, not dropped. */
	let busy = false;
	let pending: { branch: string | undefined } | undefined;
	/** Cleared by the first failure: no herdr, dead socket, unknown workspace. */
	let available = true;
	let disposed = false;

	const display = (branch: string | undefined): string | undefined =>
		branch && branchPrefix && branch.startsWith(branchPrefix) ? branch.slice(branchPrefix.length) : branch;

	/** Run herdr. False on any failure, including a runner that throws. */
	const run = async (args: string[]): Promise<boolean> => {
		try {
			const result = await runner.exec("herdr", args, { timeout: HERDR_TIMEOUT_MS });
			return result.code === 0 && !result.killed;
		} catch {
			return false;
		}
	};

	const workspaceArgs = (value: string | undefined): string[] => [
		"workspace",
		"report-metadata",
		target.workspaceId,
		"--source",
		SOURCE,
		...(value ? ["--token", `${BRANCH_TOKEN}=${value}`] : ["--clear-token", BRANCH_TOKEN]),
	];

	const paneArgs = (value: string | undefined): string[] => [
		"pane",
		"report-metadata",
		target.paneId,
		"--source",
		SOURCE,
		...(value ? ["--title", `π - ${value}`] : ["--clear-title"]),
	];

	const send = async (branch: string | undefined): Promise<void> => {
		const value = display(branch);
		// Sequential, not Promise.all: two writes to the same socket for one
		// decoration, and the second is pointless once the first has failed.
		const workspaceOk = await run(workspaceArgs(value));
		const paneOk = workspaceOk && (await run(paneArgs(value)));
		if (!workspaceOk || !paneOk) {
			available = false;
			return;
		}
		last = branch;
		sent = true;
	};

	const report = (branch: string | undefined): void => {
		if (disposed || !available) return;
		if (sent && last === branch) return;
		if (busy) {
			pending = { branch };
			return;
		}
		busy = true;
		void (async () => {
			try {
				await send(branch);
			} finally {
				busy = false;
				const next = pending;
				pending = undefined;
				if (next) report(next.branch);
			}
		})();
	};

	const clear = async (): Promise<void> => {
		// Nothing was reported, so there is nothing of ours on screen to remove.
		// Note the absence of an `available` check: a session that reported once and
		// failed later still has a stale branch on screen, and the clear is cheap.
		if (!sent) {
			disposed = true;
			return;
		}
		// Retire first: a paint racing shutdown must not re-report after the clear.
		disposed = true;
		pending = undefined;
		await run(workspaceArgs(undefined));
		await run(paneArgs(undefined));
	};

	return {
		report,
		clear,
		dispose: () => {
			disposed = true;
			pending = undefined;
		},
	};
}
```

- [ ] **Step 4: Run the test and see it pass**

```bash
cd ~/Code/pi-extensions && node tests/worktree/herdr.test.mjs
```

Expected: `ALL PASS`.

- [ ] **Step 5: Break the test on purpose, three ways**

Make each mutation, run the test, confirm a FAIL line naming the right assertion, then revert it:

1. In `workspaceArgs`, move the positional last: `["workspace", "report-metadata", "--source", SOURCE, target.workspaceId, ...]` → "argv: workspace token, positional first" must fail.
2. In `report`, delete the `if (sent && last === branch) return;` line → "dedupe: an unchanged branch costs nothing" must fail.
3. In `dispose`, delete `disposed = true;` → "dispose: a retired reporter is silent" must fail.

If any mutation still passes, the test is decoration — fix the test before continuing.

- [ ] **Step 6: Typecheck and commit**

```bash
cd ~/Code/pi-extensions && npm run typecheck && node tests/run-all.mjs worktree
git add lib/herdr.ts tests/worktree/herdr.test.mjs
git commit -m "herdr: report a branch to herdr's workspace and pane metadata"
```

---

### Task 2: `worktree/session.ts` reports the displayed branch

**Files:**
- Modify: `worktree/session.ts` (`SessionOptions`, `createSession`, `paint`)
- Modify: `tests/worktree/session.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 directly — the sink is a plain function, so `session.ts` never imports `lib/herdr.ts`.
- Produces: `SessionOptions.report?: (branch: string | undefined) => void`, called from `paint()` with the displayed branch: `focus ? focus.branch : repo?.branch`.

- [ ] **Step 1: Write the failing test**

Add to `tests/worktree/session.test.mjs`. First extend `setup()` to capture reports — replace the existing `const session = createSession({ pi, ui, ctx, repo });` block so it reads:

```javascript
	const ctx = { cwd: "/proj/main", hasUI, mode: "interactive" };
	const reported = [];
	const session = createSession({ pi, ui, ctx, repo, report: (branch) => reported.push(branch) });
	return { session, ctx, entries, messages, statuses, reported };
}
```

Then append this section before `done();`:

```javascript
// ===================================================== reporting the branch

{
	const h = setup();
	h.session.paint(h.ctx);
	ok("report: an unfocused session reports its own branch", h.reported.at(-1) === "main", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	ok("report: focus reports the worktree's branch", h.reported.at(-1) === "feature/x", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, undefined);
	ok("report: clearing focus goes back to the session's branch", h.reported.at(-1) === "main", JSON.stringify(h.reported));

	h.session.setFocus(h.ctx, { path: "/proj/detached" });
	ok("report: a detached worktree reports nothing to show", h.reported.at(-1) === undefined, JSON.stringify(h.reported));
}

{
	const h = setup();
	const before = h.reported.length;
	h.session.dispose();
	h.session.paint(h.ctx);
	ok("report: a disposed session reports nothing", h.reported.length === before, JSON.stringify(h.reported));
}

{
	const h = setup({ noRepo: true });
	h.session.paint(h.ctx);
	ok("report: outside a repo there is no branch to report", h.reported.at(-1) === undefined && h.reported.length === 1, JSON.stringify(h.reported));
}
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd ~/Code/pi-extensions && node tests/worktree/session.test.mjs
```

Expected: FAIL on "report: an unfocused session reports its own branch" (and the rest of the new section) because `createSession` ignores `report`.

- [ ] **Step 3: Implement**

In `worktree/session.ts`, add to `SessionOptions` after `configSources`:

```typescript
	/**
	 * Called with the branch the session displays, whenever it is painted.
	 *
	 * A plain function rather than a herdr dependency: `session.ts` owns state
	 * with a lifetime, and what consumes that state is `index.ts`'s business.
	 */
	report?: (branch: string | undefined) => void;
```

In `createSession`, alongside the other option defaults:

```typescript
	const report = options.report ?? (() => {});
```

And at the end of `paint`, after `ui.setStatus(target, parts);`:

```typescript
		// The branch on screen, not the session's: while focused, the footer and
		// herdr both show the focused worktree's branch. Undefined is a real
		// value here — a detached HEAD clears rather than showing a SHA.
		report(focus ? focus.branch : repo?.branch);
```

- [ ] **Step 4: Run the test and see it pass**

```bash
cd ~/Code/pi-extensions && node tests/worktree/session.test.mjs
```

Expected: `ALL PASS`.

- [ ] **Step 5: Break it on purpose**

Change the new line to `report(repo?.branch);` (ignoring focus), run the test, and confirm "report: focus reports the worktree's branch" fails. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
cd ~/Code/pi-extensions && npm run check
git add worktree/session.ts tests/worktree/session.test.mjs
git commit -m "worktree: report the displayed branch through an injected sink"
```

---

### Task 3: wire the reporter into `worktree/index.ts`

**Files:**
- Modify: `worktree/index.ts` (imports, `replaceSession`, `session_start`, `session_shutdown`)
- Create: `tests/worktree/herdr-wiring.test.mjs`

**Interfaces:**
- Consumes: `createHerdrReporter`, `herdrTarget`, `HerdrReporter` from `lib/herdr.ts` (Task 1); `SessionOptions.report` from `worktree/session.ts` (Task 2).
- Produces: nothing further tasks build on.

- [ ] **Step 1: Write the failing test**

Create `tests/worktree/herdr-wiring.test.mjs`:

```javascript
/**
 * Tests for the herdr wiring in worktree/index.ts.
 *
 *   cd tests && npm install && node worktree/herdr-wiring.test.mjs
 *
 * lib/herdr.ts is unit tested in herdr.test.mjs; what is wired here is when a
 * reporter exists at all — under herdr, with a UI — and that shutdown takes
 * what it reported back off screen. Real git in a throwaway repo, herdr
 * intercepted.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;

const gitOk = { code: 0, stdout: "", stderr: "", killed: false };

/** A repo with one commit on `feature/one`. */
async function makeRepo() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-")));
	await pexec("git", ["init", "-q", "-b", "feature/one"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

/** Wait until `predicate` holds; reports are fire-and-forget. */
const until = async (predicate, timeoutMs = 5_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
};

function harness(cwd, { hasUI = true } = {}) {
	const herdrCalls = [];
	const h = createFakePi({
		cwd,
		hasUI,
		exec: async (command, args) => {
			// gh is not the subject here; answer it so no PR text is fetched.
			if (command === "gh") return { ...gitOk, stdout: "[]" };
			if (command !== "herdr") return undefined;
			herdrCalls.push(args);
			return gitOk;
		},
	});
	extension(h.pi);
	return { ...h, herdrCalls };
}

const repo = await makeRepo();
const saved = { ws: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID };

// ============================================ under herdr, the branch is sent

{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const h = harness(repo);
	await h.fire("session_start");
	const reported = await until(() => h.herdrCalls.some((args) => args.includes("pi_branch=feature/one")));
	ok("wiring: the session's branch reaches herdr", reported, JSON.stringify(h.herdrCalls));
	ok(
		"wiring: the workspace id comes from the environment",
		h.herdrCalls[0]?.[2] === "wT",
		JSON.stringify(h.herdrCalls[0]),
	);
	ok(
		"wiring: the pane title is reported too",
		h.herdrCalls.some((args) => args[0] === "pane" && args.includes("π - feature/one")),
		JSON.stringify(h.herdrCalls),
	);

	const before = h.herdrCalls.length;
	await h.fire("session_shutdown", { reason: "quit" });
	ok(
		"wiring: shutdown clears the token",
		h.herdrCalls.slice(before).some((args) => args.includes("--clear-token")),
		JSON.stringify(h.herdrCalls.slice(before)),
	);
	ok(
		"wiring: shutdown clears the title",
		h.herdrCalls.slice(before).some((args) => args.includes("--clear-title")),
		JSON.stringify(h.herdrCalls.slice(before)),
	);
}

// ================================================= not under herdr, and no UI

{
	process.env.HERDR_WORKSPACE_ID = "";
	process.env.HERDR_PANE_ID = "";
	const h = harness(repo);
	await h.fire("session_start");
	await new Promise((resolve) => setTimeout(resolve, 100));
	ok("wiring: outside herdr nothing is reported", h.herdrCalls.length === 0, JSON.stringify(h.herdrCalls));
}

{
	process.env.HERDR_WORKSPACE_ID = "wT";
	process.env.HERDR_PANE_ID = "wT:p1";
	const h = harness(repo, { hasUI: false });
	await h.fire("session_start");
	await new Promise((resolve) => setTimeout(resolve, 100));
	ok("wiring: no UI means no reporting", h.herdrCalls.length === 0, JSON.stringify(h.herdrCalls));
}

process.env.HERDR_WORKSPACE_ID = saved.ws ?? "";
process.env.HERDR_PANE_ID = saved.pane ?? "";
await rm(repo, { recursive: true, force: true });
done();
```

- [ ] **Step 2: Run it and verify it fails**

```bash
cd ~/Code/pi-extensions && node tests/worktree/herdr-wiring.test.mjs
```

Expected: FAIL on "wiring: the session's branch reaches herdr" — `index.ts` builds no reporter yet.

- [ ] **Step 3: Implement the wiring**

In `worktree/index.ts`, add the import next to the other `lib` import:

```typescript
import { createHerdrReporter, type HerdrReporter, herdrTarget } from "../lib/herdr.ts";
```

Add beside the `session` declaration:

```typescript
	/**
	 * The current session's herdr reporter, if pi is running under herdr with a
	 * UI. Retired with the session it belongs to, so a replaced session cannot
	 * keep reporting a branch nobody is looking at.
	 */
	let reporter: HerdrReporter | undefined;
```

The `reporter?.dispose()` added below is defence in depth and has no test of its
own, deliberately: the only caller of a reporter is its own session's `paint`,
and a replaced session is already disposed and cannot paint. Do not delete it on
those grounds — it is what keeps that true if a second caller ever appears.

Replace `replaceSession` with:

```typescript
	const replaceSession = (next: WorktreeSession | undefined, nextReporter?: HerdrReporter) => {
		session?.dispose();
		reporter?.dispose();
		session = next;
		reporter = nextReporter;
		return next;
	};
```

Add below it:

```typescript
	/**
	 * A reporter for this session, or undefined.
	 *
	 * Gated on `hasUI` deliberately: a `pi -p` run borrows the user's own shell
	 * pane for a few seconds, and the PR monitor does not poll without a footer,
	 * so a reported branch would never refresh anyway.
	 */
	const makeReporter = (ctx: ExtensionContext, branchPrefix: string): HerdrReporter | undefined => {
		if (!ctx.hasUI) return undefined;
		const target = herdrTarget(process.env);
		return target ? createHerdrReporter({ runner: pi, target, branchPrefix }) : undefined;
	};
```

In `session_start`, the no-repo path becomes:

```typescript
		if (!repo) {
			// Still a session, just not one that can do anything: the status segment
			// needs clearing either way.
			const noRepoReporter = makeReporter(ctx, "");
			replaceSession(
				createSession({ pi, ui, ctx, repo: undefined, report: (branch) => noRepoReporter?.report(branch) }),
				noRepoReporter,
			)?.paint(ctx);
			return;
		}
```

and the main path:

```typescript
		const nextReporter = makeReporter(ctx, loaded.config.branchPrefix);
		const active = replaceSession(
			createSession({
				pi,
				ui,
				ctx,
				repo,
				config: loaded.config,
				configSources: loaded.sources,
				report: (branch) => nextReporter?.report(branch),
			}),
			nextReporter,
		);
```

Finally make the shutdown handler async and clear before retiring:

```typescript
	pi.on("session_shutdown", async (event, ctx) => {
		const focus = session?.focus;
		// Focus on the session's own worktree never redirected anything, so its path
		// is just the cwd the user already has.
		const redirected = focus && focus.path !== session?.repo?.worktreeRoot;
		if (event.reason === "quit" && focus && redirected) {
			ui.farewell(ctx, [
				`worktree: ${basename(focus.path)}${focus.branch ? ` (${focus.branch})` : ""}`,
				`  cd ${focus.path}`,
			]);
		}
		// Awaited, not fire-and-forget: pi may exit the moment this returns, and a
		// half-spawned clear leaves a dead session's branch on herdr's sidebar.
		// Workspace tokens are reported without a TTL, so nothing expires them.
		await reporter?.clear();
		replaceSession(undefined);
		ui.clearAll(ctx);
	});
```

- [ ] **Step 4: Run it and see it pass**

```bash
cd ~/Code/pi-extensions && node tests/worktree/herdr-wiring.test.mjs
```

Expected: `ALL PASS`.

- [ ] **Step 5: Break it on purpose**

Delete the `if (!ctx.hasUI) return undefined;` line in `makeReporter`, run the test, confirm "wiring: no UI means no reporting" fails. Then restore it, remove `await reporter?.clear();` from the shutdown handler, and confirm the two shutdown assertions fail. Revert both.

- [ ] **Step 6: Full check and commit**

```bash
cd ~/Code/pi-extensions && npm run check
git add worktree/index.ts tests/worktree/herdr-wiring.test.mjs
git commit -m "worktree: wire the herdr reporter into the session lifecycle"
```

---

### Task 4: documentation

**Files:**
- Modify: `worktree/README.md` (new section after "PR in the status bar"; the `Files` and `Tests` blocks)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Add the section**

Insert into `worktree/README.md` immediately before the `## Files` heading:

````markdown
## herdr

[herdr](https://herdr.dev) labels a space from its pane's `cwd` and derives the
branch the same way, so a bare-layout checkout (`~/Code/hellos/main`) reads
`main` — and keeps reading `main` after `git switch`, and after `/worktree
focus`, since focus never changes `cwd`.

When pi runs inside herdr with a UI, the branch on the footer is also reported
to it, on every paint:

```
herdr workspace report-metadata $HERDR_WORKSPACE_ID --source pi --token pi_branch=<branch>
herdr pane report-metadata $HERDR_PANE_ID --source pi --title "π - <branch>"
```

The value is the branch pi displays — the focused worktree's, else the
session's — with `branchPrefix` stripped, since it is on every branch you make
and the sidebar is 18–36 columns wide. A detached HEAD clears both rather than
showing a SHA. Unchanged branches cost nothing: the reporter dedupes, so the
60s PR poll does not fork a process to repeat itself.

The token renders only if a row layout names it:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$pi_branch", "git_status"]]
```

That replaces herdr's built-in `branch` token. Keeping both is correct for
spaces with no pi in them, but every pi space then reads `fix-parser main`.

Nothing is reported outside herdr, or under `pi -p`. The first failure — no
`herdr` on `PATH`, a dead socket — switches it off for the session, like a
missing `gh`. `session_shutdown` clears both surfaces; a `kill -9` leaves the
last value on screen until the next pi session in that space reports over it.

Two known gaps: workspace tokens are per space, so two pi sessions in one space
show whichever painted last (pane titles stay right), and the space *label* is
left alone — it is `basename(cwd)`, and only `workspace rename` changes it,
which is persistent state a crash would strand.
````

- [ ] **Step 2: Update the two lists in the same file**

In the `## Files` block, add after the `lib/git.ts` line:

```
lib/herdr.ts             reporting the displayed branch to herdr (pure + one CLI)
```

In the `## Tests` block, change "Eleven files under `tests/worktree/`" to "Thirteen files under `tests/worktree/`" and add this sentence at the end of that paragraph:

```
`herdr.test.mjs` covers the reporter as a fake-runner unit — argv order, prefix
stripping, deduping, and the first-failure switch-off — and
`herdr-wiring.test.mjs` covers when a reporter exists at all: under herdr, with
a UI, cleared at shutdown.
```

- [ ] **Step 3: Verify the counts are honest**

```bash
cd ~/Code/pi-extensions && ls tests/worktree/*.test.mjs | wc -l
```

Expected: `13`. If not, fix the number in the README rather than the shell.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/pi-extensions && npm run check
git add worktree/README.md
git commit -m "docs: document herdr branch reporting"
```

---

### Task 5: the consuming row layout, in `~/.dotfiles`

This task is in a **different repository** (`~/.dotfiles`), which generates
`~/.config/herdr/config.toml` from a template through `theme-switch`. Editing
the deployed file directly is wrong: it is a stow symlink and regeneration
overwrites it.

**Files:**
- Modify: `~/.dotfiles/templates/herdr-config.toml.template`
- Modify: `~/.dotfiles/tests/generators/test_herdr_generator.py`

**Interfaces:**
- Consumes: the `pi_branch` workspace token reported in Task 1.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `~/.dotfiles/tests/generators/test_herdr_generator.py`:

```python
def test_space_rows_show_pi_reported_branch(herdr_generator, catppuccin, tmp_path):
    """The sidebar's branch must come from pi, not from the pane's cwd.

    herdr's built-in `branch` token is derived from the workspace's cwd. In a
    bare layout (`proj/.bare` + `proj/main`) that reads `main` forever: it does
    not follow `git switch`, and it cannot follow pi's `/worktree focus`, which
    rewrites tool inputs rather than changing cwd.

    pi's worktree extension reports the branch it is really on as the
    `pi_branch` workspace metadata token, which renders as `$pi_branch`. This
    replaces the built-in rather than sitting beside it: keeping both is correct
    for spaces with no pi in them, but makes every pi space read
    "fix-parser main" in an 18-36 column sidebar.
    """
    herdr_generator.output_path = tmp_path / "config.toml"
    parsed = tomllib.loads(herdr_generator.generate(catppuccin).read_text())

    rows = parsed["ui"]["sidebar"]["spaces"]["rows"]
    assert rows == [["state_icon", "workspace"], ["$pi_branch", "git_status"]]
    assert "branch" not in rows[1], "the cwd-derived built-in must not be kept alongside"
```

- [ ] **Step 2: Run it and verify it fails**

```bash
cd ~/.dotfiles && python -m pytest tests/generators/test_herdr_generator.py -k pi_reported_branch -v
```

Expected: FAIL with a `KeyError` on `sidebar` — the template has no such table.

- [ ] **Step 3: Edit the template**

In `~/.dotfiles/templates/herdr-config.toml.template`, immediately after the
`[ui]` block (`show_agent_labels_on_pane_borders = true`) and before
`[ui.toast]`, insert:

```toml
# The sidebar's branch, reported by pi rather than derived from the pane's cwd.
#
# herdr's built-in `branch` token reads the workspace's cwd, so a bare-layout
# checkout (proj/.bare + proj/main) shows "main" permanently: it does not follow
# `git switch`, and it cannot follow pi's `/worktree focus`, which rewrites tool
# inputs instead of changing cwd. pi's worktree extension reports the branch it
# is actually on as the `pi_branch` token; see pi-extensions/worktree/README.md.
#
# $pi_branch REPLACES the built-in rather than joining it. Keeping both is
# correct for spaces with no pi in them, but every pi space then reads
# "fix-parser main" in a sidebar that is 18-36 columns wide. The cost is that a
# plain shell space shows no branch at all until a fish-side reporter exists.
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$pi_branch", "git_status"]]
```

- [ ] **Step 4: Run the test and see it pass**

```bash
cd ~/.dotfiles && python -m pytest tests/generators/test_herdr_generator.py -v
```

Expected: the whole file passes, including the existing keybinding tests.

- [ ] **Step 5: Break it on purpose**

Change the template's row to `["$pi_branch", "branch", "git_status"]`, rerun,
and confirm the new test fails on the "must not be kept alongside" assertion.
Revert.

- [ ] **Step 6: Deploy and verify against a live herdr**

```bash
cd ~/.dotfiles && theme-switch switch "$(cat ~/.config/dotfiles/theme)"
herdr config check
herdr server reload-config
```

Then, in a pi session running inside herdr, confirm the sidebar entry for this
space shows the current branch, and that `/worktree focus <name>` changes it:

```bash
herdr api snapshot | python3 -c "import json,sys; print([w for w in json.load(sys.stdin)['result']['snapshot']['workspaces'] if w['workspace_id']==__import__('os').environ['HERDR_WORKSPACE_ID']])"
```

Expected: a `tokens` object containing `pi_branch` with the branch you are on.

- [ ] **Step 7: Commit**

```bash
cd ~/.dotfiles && git add templates/herdr-config.toml.template tests/generators/test_herdr_generator.py
git commit -m "herdr: take the sidebar branch from pi, not from cwd"
```
