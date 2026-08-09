# Worktree From An Existing Branch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/worktree checkout <branch> [name]`, creating a worktree for a branch that already exists — local, or remote with a tracking branch.

**Architecture:** A new `worktree/branches.ts` holds branch discovery and a pure resolver (`local | remote | ambiguous | none`, local always winning). `commands.ts` gains `doCheckout`, which resolves, fetches once only on a miss, and calls the existing `createWorktree` with one new optional field, `track`. Nothing about `new`, `remove`, `focus`, or the model-facing tool changes.

**Tech Stack:** TypeScript loaded through jiti (no build step), pi extension API, plain `node:test`-free assertion harness in `tests/harness.mjs`, real git in throwaway repos.

**Spec:** `docs/superpowers/specs/2026-08-09-worktree-checkout-design.md`

## Global Constraints

- No build step. `npm run check` (typecheck + tests) must pass at the end of every task. `typecheck.sh` resolves types out of the **globally installed** pi.
- Run a single file while iterating with `node tests/worktree/<file>.test.mjs`; the whole extension with `node tests/run-all.mjs worktree`.
- Tests use `tests/harness.mjs` (`assertions()`, `loadExt()`, `execRunner()`, `pexec`). Do not re-implement them.
- **Break every new test on purpose before trusting it.** Mutate the code under it, confirm it fails, revert. A test that still passes is decoration.
- Keep decision logic pure and in its own module; `index.ts` wires only. `focus.ts` and `select.ts` are the template.
- **Warn, don't throw**, on anything environmental: a failed fetch is a warning, never fatal.
- Guard UI on `ctx.hasUI`; every command path must work under `pi -p`, where a missing argument is an error, not a question.
- Existing convention on names: a **derived** name goes through `uniqueName` and gets `-2`; a name the **user typed** is never adjusted and fails loudly.
- The model's `worktree` tool is **not** extended in this plan.
- Commit after each task, message style `worktree: <lowercase summary>` (see `git log`).

---

### Task 1: The pure core of `branches.ts`

Parsing, resolution, naming, and picker labels. No I/O — this is where the test weight sits.

**Files:**
- Create: `worktree/branches.ts`
- Create: `tests/worktree/branches.test.mjs`

**Interfaces:**
- Consumes: `slugify` from `../lib/git.ts`.
- Produces:
  - `interface RemoteBranch { remote: string; name: string; full: string }`
  - `interface BranchList { local: string[]; remote: RemoteBranch[]; remotes: string[] }`
  - `const EMPTY_BRANCHES: BranchList`
  - `type BranchMatch = { kind: "local"; branch: string; shadows?: string } | { kind: "remote"; branch: string; full: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" }`
  - `parseBranchRefs(output: string, remotes: string[]): BranchList`
  - `resolveBranch(branches: BranchList, query: string): BranchMatch`
  - `checkoutName(branch: string, branchPrefix: string): string`
  - `defaultRemote(branches: BranchList, query?: string): string | undefined`
  - `branchOptions(branches: BranchList, checkedOut: Set<string>): { value: string; label: string }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/worktree/branches.test.mjs`:

```js
/**
 * Tests for worktree/branches.ts — the pure half.
 *
 *   node tests/worktree/branches.test.mjs
 *
 * No repo, no pi, no subprocesses. The cases that matter are the ones a naive
 * implementation gets wrong: a remote whose name contains a slash (git accepts
 * `git remote add a/b`), the `<remote>/HEAD` symref, and a local branch that
 * shadows a remote one — which must win, because it may hold unpushed commits.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { parseBranchRefs, resolveBranch, checkoutName, defaultRemote, branchOptions, EMPTY_BRANCHES } =
	await loadExt("worktree/branches.ts");

// ============================================ parseBranchRefs

{
	const refs = [
		"refs/heads/main",
		"refs/heads/joel/fix-parser",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
		"refs/remotes/origin/alice/hotfix",
		"refs/tags/v1",
	].join("\n");
	const list = parseBranchRefs(refs, ["origin"]);
	ok("parse: locals", JSON.stringify(list.local) === JSON.stringify(["main", "joel/fix-parser"]), JSON.stringify(list.local));
	ok("parse: remote HEAD dropped", !list.remote.some((r) => r.name === "HEAD"), JSON.stringify(list.remote));
	ok("parse: tags ignored", list.local.length === 2 && list.remote.length === 2);
	const hotfix = list.remote.find((r) => r.name === "alice/hotfix");
	ok("parse: slashed branch keeps its remote", hotfix?.remote === "origin" && hotfix?.full === "origin/alice/hotfix", JSON.stringify(hotfix));
	ok("parse: remotes carried through", JSON.stringify(list.remotes) === JSON.stringify(["origin"]));

	// git accepts `git remote add a/b`, so the first path segment is not the remote.
	const slashed = parseBranchRefs("refs/remotes/a/b/main\nrefs/remotes/a/b/HEAD", ["origin", "a/b"]);
	ok("parse: slash-containing remote name", slashed.remote.length === 1 && slashed.remote[0].remote === "a/b" && slashed.remote[0].name === "main", JSON.stringify(slashed.remote));
	ok("parse: unknown remote skipped", parseBranchRefs("refs/remotes/gone/main", ["origin"]).remote.length === 0);
	ok("parse: empty input", parseBranchRefs("", []).local.length === 0);
}

// ============================================ resolveBranch

const branches = parseBranchRefs(
	[
		"refs/heads/main",
		"refs/heads/joel/fix-parser",
		"refs/remotes/origin/main",
		"refs/remotes/origin/joel/fix-parser",
		"refs/remotes/origin/alice/hotfix",
		"refs/remotes/upstream/alice/hotfix",
		"refs/remotes/origin/solo",
	].join("\n"),
	["origin", "upstream"],
);

{
	const local = resolveBranch(branches, "main");
	ok("resolve: local branch", local.kind === "local" && local.branch === "main", JSON.stringify(local));
	ok("resolve: local records the remote it shadows", local.shadows === "origin/main", String(local.shadows));

	const qualified = resolveBranch(branches, "origin/alice/hotfix");
	ok("resolve: fully qualified remote", qualified.kind === "remote" && qualified.branch === "alice/hotfix" && qualified.full === "origin/alice/hotfix", JSON.stringify(qualified));

	const inferred = resolveBranch(branches, "solo");
	ok("resolve: remote inferred when unique", inferred.kind === "remote" && inferred.full === "origin/solo", JSON.stringify(inferred));

	const ambiguous = resolveBranch(branches, "alice/hotfix");
	ok("resolve: same name on two remotes is ambiguous", ambiguous.kind === "ambiguous", JSON.stringify(ambiguous));
	ok("resolve: ambiguity lists both", JSON.stringify(ambiguous.candidates?.sort()) === JSON.stringify(["origin/alice/hotfix", "upstream/alice/hotfix"]), JSON.stringify(ambiguous.candidates));

	// The unpushed-commits case: asking for the remote ref by name must still
	// land on the local branch rather than resetting anything to the remote.
	const shadowed = resolveBranch(branches, "origin/joel/fix-parser");
	ok("resolve: local wins over the remote ref that names it", shadowed.kind === "local" && shadowed.branch === "joel/fix-parser", JSON.stringify(shadowed));
	ok("resolve: shadow is reported", shadowed.shadows === "origin/joel/fix-parser", String(shadowed.shadows));

	ok("resolve: no match", resolveBranch(branches, "nope").kind === "none");
	ok("resolve: empty query", resolveBranch(branches, "   ").kind === "none");
	ok("resolve: refs/heads/ prefix tolerated", resolveBranch(branches, "refs/heads/main").kind === "local");
	ok("resolve: no branches at all", resolveBranch(EMPTY_BRANCHES, "main").kind === "none");
}

// ============================================ checkoutName

ok("name: branchPrefix stripped", checkoutName("joel/fix-parser", "joel/") === "fix-parser", checkoutName("joel/fix-parser", "joel/"));
ok("name: other owner stays attributed", checkoutName("alice/hotfix", "joel/") === "alice-hotfix", checkoutName("alice/hotfix", "joel/"));
ok("name: unprefixed branch flattened", checkoutName("renovate/lockfile", "joel/") === "renovate-lockfile");
ok("name: empty prefix", checkoutName("main", "") === "main");
ok("name: prefix only", checkoutName("joel/", "joel/") === "worktree", checkoutName("joel/", "joel/"));
ok("name: partial prefix is not stripped", checkoutName("joelx/thing", "joel/") === "joelx-thing");

// ============================================ defaultRemote

ok("remote: origin preferred", defaultRemote(branches) === "origin");
ok("remote: taken from the query", defaultRemote(branches, "upstream/alice/hotfix") === "upstream");
ok("remote: query with an unknown prefix falls back", defaultRemote(branches, "nope/thing") === "origin");
ok("remote: first when origin is absent", defaultRemote({ ...EMPTY_BRANCHES, remotes: ["fork", "other"] }) === "fork");
ok("remote: none configured", defaultRemote(EMPTY_BRANCHES) === undefined);
ok("remote: longest match wins", defaultRemote({ ...EMPTY_BRANCHES, remotes: ["a", "a/b"] }, "a/b/main") === "a/b");

// ============================================ branchOptions

{
	const options = branchOptions(branches, new Set(["main"]));
	const values = options.map((o) => o.value);
	ok("options: locals come first", values[0] === "main" && values[1] === "joel/fix-parser", JSON.stringify(values));
	ok("options: checked-out branch is marked", options[0].label.includes("checked out"), options[0].label);
	ok("options: remote shadowed by a local is omitted", !values.includes("origin/joel/fix-parser"), JSON.stringify(values));
	ok("options: distinct remotes offered", values.includes("origin/alice/hotfix") && values.includes("upstream/alice/hotfix"), JSON.stringify(values));
	ok("options: values are unique", new Set(values).size === values.length);
	ok("options: empty list", branchOptions(EMPTY_BRANCHES, new Set()).length === 0);
}

done();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/worktree/branches.test.mjs`
Expected: FAIL — cannot resolve `worktree/branches.ts`.

- [ ] **Step 3: Write the implementation**

Create `worktree/branches.ts`:

```ts
/**
 * Branch discovery and resolution for `/worktree checkout`.
 *
 * Split the way `select.ts` is: parsing, resolution and naming are pure and
 * carry the tests, and the two git calls are thin wrappers over them.
 *
 * The rule that shapes everything here is that a local branch wins over a
 * remote one of the same name. A local branch can hold commits the remote does
 * not, so resolving to the remote would either lose them or need a reset this
 * command has no business performing.
 */

import { slugify } from "../lib/git.ts";

export interface RemoteBranch {
	/** Remote name, e.g. `origin`. May itself contain slashes. */
	remote: string;
	/** Branch name on the remote, e.g. `joel/fix-parser`. */
	name: string;
	/** Fully qualified short ref, e.g. `origin/joel/fix-parser`. */
	full: string;
}

export interface BranchList {
	local: string[];
	remote: RemoteBranch[];
	remotes: string[];
}

export const EMPTY_BRANCHES: BranchList = { local: [], remote: [], remotes: [] };

export type BranchMatch =
	/** `shadows` is the remote ref this local branch was preferred over. */
	| { kind: "local"; branch: string; shadows?: string }
	/** `branch` is the local branch to create; `full` is what it tracks. */
	| { kind: "remote"; branch: string; full: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" };

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";

/**
 * Parse `git for-each-ref --format=%(refname) refs/heads refs/remotes`.
 *
 * `remotes` is needed rather than splitting on the first path segment: git
 * accepts `git remote add a/b`, so `refs/remotes/a/b/main` is remote `a/b` on
 * branch `main`. Longest name first, so `a/b` is preferred over `a`.
 */
export function parseBranchRefs(output: string, remotes: string[]): BranchList {
	const ordered = [...remotes].sort((a, b) => b.length - a.length);
	const local: string[] = [];
	const remote: RemoteBranch[] = [];

	for (const line of output.split("\n")) {
		const ref = line.trim();
		if (ref.startsWith(HEADS)) {
			local.push(ref.slice(HEADS.length));
			continue;
		}
		if (!ref.startsWith(REMOTES)) continue;
		const rest = ref.slice(REMOTES.length);
		const name = ordered.find((candidate) => rest.startsWith(`${candidate}/`));
		if (!name) continue;
		const branch = rest.slice(name.length + 1);
		// `<remote>/HEAD` is a symref to a branch that is already in this list.
		if (!branch || branch === "HEAD") continue;
		remote.push({ remote: name, name: branch, full: `${name}/${branch}` });
	}

	return { local, remote, remotes: [...remotes] };
}

/** Resolve a user-supplied branch reference. Local branches win. */
export function resolveBranch(branches: BranchList, query: string): BranchMatch {
	const needle = query.trim().replace(/^refs\/heads\//, "");
	if (!needle) return { kind: "none" };

	const asLocal = (branch: string, shadows?: string): BranchMatch =>
		shadows ? { kind: "local", branch, shadows } : { kind: "local", branch };

	if (branches.local.includes(needle)) {
		const shadow = branches.remote.find((r) => r.name === needle) ?? branches.remote.find((r) => r.full === needle);
		return asLocal(needle, shadow?.full);
	}

	const byFull = branches.remote.find((r) => r.full === needle);
	if (byFull) {
		// `origin/foo` asked for by name, but a local `foo` exists: same rule.
		return branches.local.includes(byFull.name) ? asLocal(byFull.name, byFull.full) : { kind: "remote", branch: byFull.name, full: byFull.full };
	}

	const byName = branches.remote.filter((r) => r.name === needle);
	if (byName.length === 1) return { kind: "remote", branch: byName[0].name, full: byName[0].full };
	if (byName.length > 1) return { kind: "ambiguous", candidates: byName.map((r) => r.full) };
	return { kind: "none" };
}

/**
 * Directory name for a checked-out branch.
 *
 * Takes the *local* branch name — resolution has already stripped the remote.
 * Stripping `branchPrefix` keeps your own branches short while leaving someone
 * else's attributed, and reuses the rule `suggest.ts` already applies.
 */
export function checkoutName(branch: string, branchPrefix: string): string {
	const stripped = branchPrefix && branch.startsWith(branchPrefix) ? branch.slice(branchPrefix.length) : branch;
	return slugify(stripped);
}

/** The remote to fetch: the one named in the query, else origin, else the first. */
export function defaultRemote(branches: BranchList, query?: string): string | undefined {
	if (query) {
		const ordered = [...branches.remotes].sort((a, b) => b.length - a.length);
		const named = ordered.find((remote) => query.startsWith(`${remote}/`));
		if (named) return named;
	}
	return branches.remotes.includes("origin") ? "origin" : branches.remotes[0];
}

/**
 * Rows for the interactive picker: locals first, then remotes that no local
 * branch shadows — a shadowed one would resolve to the local branch anyway, so
 * offering both would be two labels for one outcome.
 */
export function branchOptions(branches: BranchList, checkedOut: Set<string>): { value: string; label: string }[] {
	const options = branches.local.map((branch) => ({
		value: branch,
		label: checkedOut.has(branch) ? `${branch} (checked out)` : branch,
	}));
	for (const remote of branches.remote) {
		if (branches.local.includes(remote.name)) continue;
		options.push({
			value: remote.full,
			label: checkedOut.has(remote.name) ? `${remote.full} (checked out)` : remote.full,
		});
	}
	return options;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/worktree/branches.test.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Break each new assertion group on purpose**

For each of the five sections, mutate `worktree/branches.ts`, confirm a FAIL, then revert:

- `parseBranchRefs`: change `ordered` to `[...remotes]` (unsorted) → the `a/b` case must fail.
- `parseBranchRefs`: drop the `branch === "HEAD"` guard → the HEAD case must fail.
- `resolveBranch`: check `byFull` before `branches.local.includes(needle)` → local-wins must fail.
- `checkoutName`: drop the `branch.startsWith(branchPrefix)` guard → the partial-prefix case must fail.
- `branchOptions`: remove the `branches.local.includes(remote.name)` skip → the shadowed-remote case must fail.

If a mutation still passes, the assertion is wrong — fix it before moving on.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add worktree/branches.ts tests/worktree/branches.test.mjs
git commit -m "worktree: resolve local and remote branches"
```

---

### Task 2: Branch listing and the lazy fetch

The two git calls behind Task 1's pure core.

**Files:**
- Modify: `worktree/branches.ts` (append)
- Modify: `tests/worktree/branches.test.mjs` (append a real-git section before `done()`)

**Interfaces:**
- Consumes: `parseBranchRefs` from Task 1; `git`, `gitOrThrow`, `GitRunner` from `../lib/git.ts`.
- Produces:
  - `listBranches(pi: GitRunner, projectRoot: string, signal?: AbortSignal): Promise<BranchList>`
  - `fetchRemote(pi: GitRunner, projectRoot: string, remote: string, signal?: AbortSignal): Promise<string | undefined>` — resolves to an error message, or `undefined` on success. It never rejects: a failed fetch is a warning.

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree/branches.test.mjs`, immediately before the final `done();`:

```js
// ====================================== integration: real git, two repos

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execRunner, pexec } from "../harness.mjs";

const { listBranches, fetchRemote } = await loadExt("worktree/branches.ts");
const runner = execRunner();

const root = await realpath(await mkdtemp(join(tmpdir(), "pi-branches-")));
const up = join(root, "up");
await pexec("git", ["init", "-q", "-b", "main", up]);
await pexec("git", ["config", "user.email", "test@example.com"], { cwd: up });
await pexec("git", ["config", "user.name", "Test"], { cwd: up });
await writeFile(join(up, "a.txt"), "hi\n");
await pexec("git", ["add", "-A"], { cwd: up });
await pexec("git", ["commit", "-qm", "init"], { cwd: up });
await pexec("git", ["branch", "alice/hotfix"], { cwd: up });

const down = join(root, "down");
await pexec("git", ["clone", "-q", up, down]);

{
	const list = await listBranches(runner, down);
	ok("list: local branch", list.local.includes("main"), JSON.stringify(list.local));
	ok("list: remote branch with a slash", list.remote.some((r) => r.full === "origin/alice/hotfix"), JSON.stringify(list.remote));
	ok("list: origin/HEAD is not a branch", !list.remote.some((r) => r.name === "HEAD"));
	ok("list: remotes", JSON.stringify(list.remotes) === JSON.stringify(["origin"]));
}

// A branch pushed after the clone: invisible until something fetches.
await pexec("git", ["branch", "later"], { cwd: up });
{
	const before = await listBranches(runner, down);
	ok("fetch: new branch invisible before fetching", !before.remote.some((r) => r.name === "later"));
	const error = await fetchRemote(runner, down, "origin");
	ok("fetch: succeeds quietly", error === undefined, String(error));
	const after = await listBranches(runner, down);
	ok("fetch: new branch visible after fetching", after.remote.some((r) => r.full === "origin/later"), JSON.stringify(after.remote));
}

{
	// An unreachable remote must produce a message, not a rejection.
	await pexec("git", ["remote", "add", "broken", join(root, "does-not-exist")], { cwd: down });
	const error = await fetchRemote(runner, down, "broken");
	ok("fetch: failure is reported, not thrown", typeof error === "string" && error.length > 0, String(error));
	ok("fetch: unknown remote is also just a message", typeof (await fetchRemote(runner, down, "nope")) === "string");
}

await rm(root, { recursive: true, force: true });
```

Move the `import` lines to the top of the file when you paste this — the existing imports are already there, so extend them rather than duplicating (`assertions`, `loadExt`, `execRunner`, `pexec` all come from `../harness.mjs`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/worktree/branches.test.mjs`
Expected: FAIL — `listBranches is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `worktree/branches.ts`, and extend the import at the top to `import { git, type GitRunner, gitOrThrow, slugify } from "../lib/git.ts";`:

```ts
/** All local and remote-tracking branches, plus the configured remote names. */
export async function listBranches(pi: GitRunner, projectRoot: string, signal?: AbortSignal): Promise<BranchList> {
	const remotes = (await gitOrThrow(pi, ["remote"], projectRoot, { signal }))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const refs = await gitOrThrow(
		pi,
		["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
		projectRoot,
		{ signal },
	);
	return parseBranchRefs(refs, remotes);
}

/**
 * Fetch one remote. Returns an error message, or undefined on success.
 *
 * Non-throwing by construction: the caller resolves branches without the
 * network in the common case, so a fetch failure degrades to "not found" rather
 * than taking the command down.
 */
export async function fetchRemote(
	pi: GitRunner,
	projectRoot: string,
	remote: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await git(pi, ["fetch", remote], projectRoot, { signal });
	if (result.code === 0) return undefined;
	return (result.stderr || result.stdout).trim() || `git fetch ${remote} failed (exit ${result.code})`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/worktree/branches.test.mjs`
Expected: `ALL PASS`.

- [ ] **Step 5: Break the new assertions on purpose**

- In `fetchRemote`, `return undefined` unconditionally → the failure assertions must fail.
- In `listBranches`, pass `[]` instead of `remotes` to `parseBranchRefs` → the remote-branch assertions must fail.

Revert both.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add worktree/branches.ts tests/worktree/branches.test.mjs
git commit -m "worktree: list branches and fetch on demand"
```

---

### Task 3: `track` support in `createWorktree`

**Files:**
- Modify: `worktree/worktrees.ts` (`CreateOptions`, `CreateResult`, `createWorktree`)
- Modify: `tests/worktree/worktree.test.mjs` (append a section before the final `done()`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateOptions.track?: string` (a remote-tracking ref such as `origin/foo`, mutually exclusive with `base`) and `CreateResult.track?: string` (set only when the `--track -b` path ran).

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree/worktree.test.mjs`, before the final `done();`:

```js
// ================================= create: tracking an existing remote branch

{
	const pair = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-track-")));
	const upstream = join(pair, "upstream");
	await pexec("git", ["init", "-q", "-b", "main", upstream]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: upstream });
	await pexec("git", ["config", "user.name", "Test"], { cwd: upstream });
	await writeFile(join(upstream, "a.txt"), "hi\n");
	await pexec("git", ["add", "-A"], { cwd: upstream });
	await pexec("git", ["commit", "-qm", "init"], { cwd: upstream });
	await pexec("git", ["branch", "alice/hotfix"], { cwd: upstream });
	await pexec("git", ["branch", "shadowed"], { cwd: upstream });

	const down = join(pair, "down");
	await pexec("git", ["clone", "-q", upstream, down]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: down });
	await pexec("git", ["config", "user.name", "Test"], { cwd: down });
	const trackCfg = { ...config.DEFAULT_CONFIG, branchPrefix: "joel/", copyFiles: [] };

	const tracked = await worktrees.createWorktree(runner, {
		name: "alice-hotfix",
		branch: "alice/hotfix",
		track: "origin/alice/hotfix",
		config: trackCfg,
		projectRoot: down,
		sourceWorktree: down,
	});
	ok("track: local branch created", tracked.createdBranch === true && tracked.branch === "alice/hotfix");
	ok("track: reported on the result", tracked.track === "origin/alice/hotfix", String(tracked.track));
	ok("track: no base was resolved", tracked.base === undefined, String(tracked.base));
	const upstreamRef = (await pexec("git", ["config", "branch.alice/hotfix.merge"], { cwd: down })).stdout.trim();
	ok("track: upstream configured", upstreamRef === "refs/heads/alice/hotfix", upstreamRef);
	ok("track: checked out at the worktree", (await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tracked.path })).stdout.trim() === "alice/hotfix");

	// A local branch that already exists must be used as it stands: it may hold
	// commits the remote does not, and `track` must not cause a reset.
	await pexec("git", ["branch", "shadowed", "origin/shadowed"], { cwd: down });
	const wtForCommit = join(pair, "tmp-wt");
	await pexec("git", ["worktree", "add", "-q", wtForCommit, "shadowed"], { cwd: down });
	await pexec("git", ["commit", "-qm", "unpushed", "--allow-empty"], { cwd: wtForCommit });
	const head = (await pexec("git", ["rev-parse", "shadowed"], { cwd: down })).stdout.trim();
	await pexec("git", ["worktree", "remove", wtForCommit], { cwd: down });

	const shadowed = await worktrees.createWorktree(runner, {
		name: "shadowed",
		branch: "shadowed",
		track: "origin/shadowed",
		config: trackCfg,
		projectRoot: down,
		sourceWorktree: down,
	});
	ok("track: existing local branch is reused, not recreated", shadowed.createdBranch === false);
	ok("track: no tracking reported when the local branch won", shadowed.track === undefined, String(shadowed.track));
	ok("track: unpushed commit survives", (await pexec("git", ["rev-parse", "shadowed"], { cwd: down })).stdout.trim() === head);

	await rejects(
		"track: base and track together are rejected",
		() =>
			worktrees.createWorktree(runner, {
				name: "both",
				branch: "both",
				base: "main",
				track: "origin/main",
				config: trackCfg,
				projectRoot: down,
				sourceWorktree: down,
			}),
		/mutually exclusive/,
	);
	await rejects(
		"track: unknown remote ref rejected",
		() =>
			worktrees.createWorktree(runner, {
				name: "ghost",
				branch: "ghost",
				track: "origin/ghost",
				config: trackCfg,
				projectRoot: down,
				sourceWorktree: down,
			}),
		/does not exist/,
	);

	await rm(pair, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/worktree/worktree.test.mjs`
Expected: FAIL on `track: reported on the result` (and the two `rejects` cases), because `track` is currently ignored.

- [ ] **Step 3: Write the implementation**

In `worktree/worktrees.ts`, add to `CreateOptions` after `base`:

```ts
	/**
	 * Remote-tracking ref to branch from, e.g. `origin/foo`. Mutually exclusive
	 * with `base`: a tracked branch has its start point already. Ignored when
	 * the local branch already exists, which is deliberate — that branch may
	 * hold unpushed commits.
	 */
	track?: string;
```

Add to `CreateResult` after `base`:

```ts
	/** The remote ref the new branch tracks, when one was used. */
	track?: string;
```

Add the guard next to the existing branch validation:

```ts
	const branch = options.branch.trim();
	if (!branch) throw new Error("Branch name is required");
	if (options.track && options.base) throw new Error("base and track are mutually exclusive");
```

Replace the create block:

```ts
	let base: string | undefined;
	let track: string | undefined;
	if (existing) {
		await gitOrThrow(pi, ["worktree", "add", target, branch], projectRoot, { signal });
	} else if (options.track) {
		track = options.track;
		if (!(await refExists(pi, track, projectRoot))) {
			throw new Error(`Remote branch "${track}" does not exist`);
		}
		await gitOrThrow(pi, ["worktree", "add", "--track", "-b", branch, target, track], projectRoot, { signal });
	} else {
		base = options.base ?? config.defaultBase ?? (await defaultBranch(pi, projectRoot));
		if (base && !(await refExists(pi, base, projectRoot))) {
			throw new Error(`Base ref "${base}" does not exist`);
		}
		const args = ["worktree", "add", "-b", branch, target];
		if (base) args.push(base);
		await gitOrThrow(pi, args, projectRoot, { signal });
	}
```

And the return:

```ts
	return { path: target, branch, base, track, createdBranch: !existing, copied, warnings, postCreate };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/worktree/worktree.test.mjs`
Expected: `ALL PASS`. Then `node tests/run-all.mjs worktree` to confirm nothing else regressed.

- [ ] **Step 5: Break the new assertions on purpose**

- Delete the `if (existing)` arm's precedence by testing `options.track` first → `track: existing local branch is reused` and `unpushed commit survives` must fail.
- Remove the `refExists` check on `track` → `unknown remote ref rejected` must fail (git's own error will differ from `/does not exist/`; confirm the assertion actually catches it).

Revert both.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add worktree/worktrees.ts tests/worktree/worktree.test.mjs
git commit -m "worktree: create a worktree tracking a remote branch"
```

---

### Task 4: `/worktree checkout`

**Files:**
- Modify: `worktree/commands.ts` (`SUBCOMMANDS`, `Commands`, `createCommands`, `dispatch`)
- Modify: `tests/worktree/commands.test.mjs` (extend `makeRepo`, add a section)

**Interfaces:**
- Consumes: `resolveBranch`, `checkoutName`, `defaultRemote`, `branchOptions`, `listBranches`, `fetchRemote`, `EMPTY_BRANCHES`, `type BranchList` from `./branches.ts`; `CreateResult` from `./worktrees.ts`; `tokenize` from `./select.ts`; `uniqueName` from `./suggest.ts`.
- Produces: `Commands.setKnownBranches(branches: BranchList): void` (wired in Task 5) and the `checkout` / `co` subcommands.

- [ ] **Step 1: Write the failing test**

In `tests/worktree/commands.test.mjs`, replace `makeRepo` with a version that can also build a clone, keeping the existing signature working:

```js
/** A repo on `main` plus linked worktrees for each requested branch. */
async function makeRepo(branches = ["exp"]) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	const paths = {};
	for (const branch of branches) {
		paths[branch] = join(dir, "wt", branch);
		await pexec("git", ["worktree", "add", "-q", "-b", branch, paths[branch]], { cwd: dir });
	}
	return { dir, paths };
}

/**
 * An upstream repo plus a clone of it, for the remote half of `checkout`.
 * `remoteOnly` branches are created upstream *after* the clone, so the clone
 * cannot see them without fetching.
 */
async function makeClone({ shared = [], remoteOnly = [] } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-clone-")));
	const upstream = join(root, "upstream");
	await pexec("git", ["init", "-q", "-b", "main", upstream]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: upstream });
	await pexec("git", ["config", "user.name", "Test"], { cwd: upstream });
	await writeFile(join(upstream, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: upstream });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: upstream });
	for (const branch of shared) await pexec("git", ["branch", branch], { cwd: upstream });
	const dir = join(root, "down");
	await pexec("git", ["clone", "-q", upstream, dir]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	for (const branch of remoteOnly) await pexec("git", ["branch", branch], { cwd: upstream });
	return { root, upstream, dir };
}
```

Give `setup()` a runner that records git calls, so "fetched exactly once" is assertable. Replace `runner: execRunner(),` in `setup` with:

```js
	const gitCalls = [];
	const real = execRunner();
	const runner = {
		exec: (command, args, options) => {
			gitCalls.push(args.join(" "));
			return real.exec(command, args, options);
		},
	};
```

pass `runner` to `createCommands`, and add `gitCalls` to the returned object.

Then add this section before the final `done();`:

```js
// ==================================================== checkout

{
	const { dir, paths } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/", autoFocus: true } });
	await pexec("git", ["branch", "joel/local-work"], { cwd: dir });

	await t.commands.dispatch(info, t.ctx, "checkout joel/local-work");
	const created = join(dir, ".claude/worktrees/local-work");
	ok("checkout: local branch checked out", await exists(created), t.messages().join(" | "));
	ok("checkout: branchPrefix stripped from the directory", (await exists(created)) === true);
	ok("checkout: focused", t.focusCalls.at(-1)?.path === created, JSON.stringify(t.focusCalls.at(-1)));
	ok("checkout: no fetch when it resolved locally", !t.gitCalls.some((c) => c.startsWith("fetch")), JSON.stringify(t.gitCalls));

	await t.commands.dispatch(info, t.ctx, "checkout exp");
	ok(
		"checkout: a branch checked out elsewhere is refused with the path",
		t.errors().at(-1)?.includes(paths.exp) && t.errors().at(-1)?.includes("/worktree focus"),
		String(t.errors().at(-1)),
	);

	await t.commands.dispatch(info, t.ctx, "checkout no-such-branch");
	ok("checkout: unknown branch errors", t.errors().at(-1)?.includes("no branch matching"), String(t.errors().at(-1)));

	await rm(dir, { recursive: true, force: true });
}

{
	// The remote half, with a branch that only exists upstream: resolving must
	// miss, fetch once, and then succeed.
	const { root, dir } = await makeClone({ shared: ["alice/hotfix"], remoteOnly: ["pushed-later"] });
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/", autoFocus: false } });

	await t.commands.dispatch(info, t.ctx, "checkout origin/alice/hotfix");
	const hotfix = join(dir, ".claude/worktrees/alice-hotfix");
	ok("checkout: remote branch checked out", await exists(hotfix), t.messages().join(" | "));
	ok("checkout: tracking reported", t.messages().at(-1)?.includes("tracking origin/alice/hotfix"), String(t.messages().at(-1)));
	const upstreamRef = (await pexec("git", ["config", "branch.alice/hotfix.merge"], { cwd: dir })).stdout.trim();
	ok("checkout: upstream configured", upstreamRef === "refs/heads/alice/hotfix", upstreamRef);

	const before = t.gitCalls.filter((c) => c.startsWith("fetch")).length;
	await t.commands.dispatch(info, t.ctx, "checkout pushed-later");
	const fetches = t.gitCalls.filter((c) => c.startsWith("fetch")).length - before;
	ok("checkout: a miss fetches exactly once", fetches === 1, String(fetches));
	ok("checkout: found after fetching", await exists(join(dir, ".claude/worktrees/pushed-later")), t.messages().join(" | "));

	await rm(root, { recursive: true, force: true });
}

{
	// Non-interactive: no argument is an error, never a prompt.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ hasUI: false });
	await t.commands.dispatch(info, t.ctx, "checkout");
	ok("checkout: no argument without a UI is an error", t.errors().at(-1)?.includes("required"), String(t.errors().at(-1)));
	ok("checkout: nothing was created", t.prompts.select.length === 0);
	await rm(dir, { recursive: true, force: true });
}

{
	// Interactive picker, and the marking of a branch already checked out.
	const { dir } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ select: (labels) => labels.find((l) => l.startsWith("main")) });
	await t.commands.dispatch(info, t.ctx, "checkout");
	const labels = t.prompts.select.at(-1)?.labels ?? [];
	ok("checkout: picker lists branches", labels.some((l) => l.startsWith("exp")), JSON.stringify(labels));
	ok("checkout: checked-out branches are marked", labels.find((l) => l.startsWith("exp"))?.includes("checked out"), JSON.stringify(labels));
	ok("checkout: picking the session's own branch is refused", t.errors().at(-1)?.includes("already checked out"), String(t.errors().at(-1)));
	await rm(dir, { recursive: true, force: true });
}

{
	// An explicit name is used verbatim; a derived one gets uniquified.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/" } });
	await pexec("git", ["branch", "joel/thing"], { cwd: dir });
	await pexec("git", ["branch", "other/thing"], { cwd: dir });
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing custom-dir");
	ok("checkout: explicit name is used verbatim", await exists(join(dir, ".claude/worktrees/custom-dir")), t.messages().join(" | "));
	await t.commands.dispatch(info, t.ctx, "checkout other/thing");
	ok("checkout: derived name is other-thing", await exists(join(dir, ".claude/worktrees/other-thing")), t.messages().join(" | "));
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing a b");
	ok("checkout: extra arguments rejected", t.errors().at(-1)?.includes("unexpected extra arguments"), String(t.errors().at(-1)));
	await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/worktree/commands.test.mjs`
Expected: FAIL — `unknown subcommand "checkout"`.

- [ ] **Step 3: Write the implementation**

In `worktree/commands.ts`:

Extend the imports:

```ts
import {
	type BranchList,
	branchOptions,
	checkoutName,
	defaultRemote,
	EMPTY_BRANCHES,
	fetchRemote,
	listBranches,
	resolveBranch,
} from "./branches.ts";
import { matchWorktree, parseNewArgs, tokenize } from "./select.ts";
import { type CommandRunner, type CreateResult, createWorktree, pruneWorktrees, removeWorktree } from "./worktrees.ts";
```

Add the subcommand row after `new`:

```ts
	{ value: "checkout", label: "checkout <branch>", description: "Create a worktree for an existing branch" },
```

Add to the `Commands` interface:

```ts
	/** Seed the branch cache used by `checkout` completions. */
	setKnownBranches: (branches: BranchList) => void;
```

Inside `createCommands`, next to `let known: Worktree[] = []`:

```ts
	/** Branch names for `checkout` completions; refreshed opportunistically. */
	let knownBranches: BranchList = EMPTY_BRANCHES;

	const refreshBranches = async (info: RepoInfo): Promise<BranchList> => {
		knownBranches = await listBranches(runner, info.projectRoot);
		return knownBranches;
	};
```

Extract the taken-name set that `suggest` currently builds inline, so `checkout` uses the same rule:

```ts
	/**
	 * Directory names that are already spoken for.
	 *
	 * Worktree directory names and currently checked-out branches, with
	 * `branchPrefix` stripped so `joel/foo` occupies `foo`. Cannot see a stray
	 * non-worktree directory or a branch checked out nowhere — those still fall
	 * back to createWorktree's error.
	 */
	const takenNames = (worktrees: Worktree[]): Set<string> => {
		const prefix = getConfig().branchPrefix;
		const taken = new Set<string>();
		for (const wt of worktrees) {
			taken.add(basename(wt.path));
			if (wt.branch) taken.add(wt.branch.startsWith(prefix) ? wt.branch.slice(prefix.length) : wt.branch);
		}
		return taken;
	};
```

and rewrite `suggest`'s body to use it:

```ts
	const suggest = async (info: RepoInfo, ctx: ExtensionContext): Promise<string> => {
		const taken = takenNames(await refresh(info));
		return uniqueName(suggestName(messageTexts(ctx.sessionManager.getBranch())), (name) => taken.has(name));
	};
```

Extract the result reporting `doNew` ends with, so both creators say the same things in the same order:

```ts
	/** The one place a finished create is described. `extra` goes after the branch. */
	const reportCreated = (ctx: ExtensionContext, result: CreateResult, extra: string[] = []) => {
		const parts = [`created ${basename(result.path)} on ${result.branch}`, ...extra];
		if (result.copied.length) parts.push(`copied ${result.copied.join(", ")}`);
		for (const warning of result.warnings) parts.push(warning);
		if (result.postCreate && result.postCreate.code !== 0) {
			parts.push(`postCreate failed (exit ${result.postCreate.code})`);
		}
		const degraded = result.warnings.length > 0 || Boolean(result.postCreate?.code);
		say(ctx, parts.join("; "), degraded ? "warning" : "info");
	};
```

In `doNew`, replace everything from `const parts = [...]` through the `say(ctx, parts.join("; "), …)` line with:

```ts
			reportCreated(ctx, result, result.base ? [`from ${result.base}`] : []);
```

Add `doCheckout` after `doNew`:

```ts
	/**
	 * `/worktree checkout <branch> [name]` — a worktree for a branch that exists.
	 *
	 * Resolution is local-first and the fetch is lazy: the network is touched
	 * only when nothing matches, so the common case costs nothing and a branch
	 * pushed a minute ago is still found. A fetch that fails is a warning; the
	 * local half of this command works offline.
	 */
	const doCheckout = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const [queryArg, explicitName, ...extra] = tokenize(args);
		if (extra.length > 0) {
			say(ctx, `unexpected extra arguments: ${extra.join(" ")} (quote names containing spaces)`, "error");
			return;
		}

		let branches = await refreshBranches(info);
		const worktrees = await refresh(info);
		const checkedOut = new Map<string, Worktree>();
		for (const wt of worktrees) if (wt.branch) checkedOut.set(wt.branch, wt);

		let query = queryArg;
		if (!query) {
			if (!ctx.hasUI) {
				say(ctx, "a branch name is required in non-interactive mode", "error");
				return;
			}
			const options = branchOptions(branches, new Set(checkedOut.keys()));
			if (options.length === 0) {
				say(ctx, "no branches found", "warning");
				return;
			}
			const labels = options.map((option) => option.label);
			const choice = await ctx.ui.select("Check out which branch?", labels);
			if (!choice) return;
			query = options[labels.indexOf(choice)].value;
		}

		let match = resolveBranch(branches, query);
		let fetchError: string | undefined;
		if (match.kind === "none") {
			const remote = defaultRemote(branches, query);
			if (remote) {
				say(ctx, `fetching ${remote} …`, "info");
				fetchError = await fetchRemote(runner, info.projectRoot, remote);
				branches = await refreshBranches(info);
				match = resolveBranch(branches, query);
			}
		}

		if (match.kind === "ambiguous") {
			say(ctx, `"${query}" matches several remotes: ${match.candidates.join(", ")}`, "error");
			return;
		}
		if (match.kind === "none") {
			say(ctx, `no branch matching "${query}"${fetchError ? ` (fetch failed: ${fetchError})` : ""}`, "error");
			return;
		}
		if (fetchError) say(ctx, `fetch failed: ${fetchError}`, "warning");

		const occupied = checkedOut.get(match.branch);
		if (occupied) {
			say(
				ctx,
				`"${match.branch}" is already checked out at ${occupied.path} — /worktree focus ${basename(occupied.path)}`,
				"error",
			);
			return;
		}

		// A derived name may be adjusted; a name the user typed must not be.
		const taken = takenNames(worktrees);
		const name = explicitName ?? uniqueName(checkoutName(match.branch, getConfig().branchPrefix), (n) => taken.has(n));
		const slug = slugify(name);
		const target = worktreePath(getConfig(), info.projectRoot, slug);

		say(ctx, `creating ${target} …`, "info");
		try {
			const result = await createWorktree(runner, {
				name: slug,
				branch: match.branch,
				track: match.kind === "remote" ? match.full : undefined,
				config: getConfig(),
				projectRoot: info.projectRoot,
				sourceWorktree: info.worktreeRoot,
			});
			await refresh(info);
			await refreshBranches(info);

			const extras: string[] = [];
			if (result.track) extras.push(`tracking ${result.track}`);
			if (match.kind === "local" && match.shadows) extras.push(`using the local branch, not ${match.shadows}`);
			reportCreated(ctx, result, extras);

			if (getConfig().autoFocus) setFocus(ctx, { path: result.path, branch: result.branch });
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};
```

Add the dispatch case after `new`/`add`:

```ts
			case "checkout":
			case "co":
				return doCheckout(info, ctx, rest);
```

And extend the returned object:

```ts
	return {
		dispatch,
		getArgumentCompletions,
		setKnown: (worktrees) => {
			known = worktrees;
		},
		setKnownBranches: (branches) => {
			knownBranches = branches;
		},
	};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/worktree/commands.test.mjs`
Expected: `ALL PASS`. Then `node tests/run-all.mjs worktree`.

- [ ] **Step 5: Break the new assertions on purpose**

- Fetch unconditionally instead of only on `match.kind === "none"` → "no fetch when it resolved locally" must fail.
- Drop the `occupied` guard → the two "already checked out" assertions must fail.
- Use `checkoutName(...)` for `explicitName` too → "explicit name is used verbatim" must fail.
- Return `say(ctx, …)` for the missing-argument case only when `ctx.hasUI` → the non-interactive assertion must fail.

Revert each.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add worktree/commands.ts tests/worktree/commands.test.mjs
git commit -m "worktree: add /worktree checkout for existing branches"
```

---

### Task 5: Completions and session wiring

**Files:**
- Modify: `worktree/commands.ts` (`getArgumentCompletions`)
- Modify: `worktree/index.ts` (session_start seeding and reset)
- Modify: `tests/worktree/commands.test.mjs` (append)

**Interfaces:**
- Consumes: `Commands.setKnownBranches` from Task 4; `listBranches`, `EMPTY_BRANCHES` from `./branches.ts`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree/commands.test.mjs`, before the final `done();`:

```js
// ==================================================== completions

{
	const t = setup();
	t.commands.setKnownBranches({
		local: ["main", "joel/fix-parser"],
		remote: [{ remote: "origin", name: "alice/hotfix", full: "origin/alice/hotfix" }],
		remotes: ["origin"],
	});
	const all = t.commands.getArgumentCompletions("checkout ");
	ok("completions: locals offered", all?.some((i) => i.value === "checkout main"), JSON.stringify(all));
	ok("completions: remotes offered by full ref", all?.some((i) => i.value === "checkout origin/alice/hotfix"), JSON.stringify(all));
	const filtered = t.commands.getArgumentCompletions("checkout joel/");
	ok("completions: filtered by prefix", filtered?.length === 1 && filtered[0].value === "checkout joel/fix-parser", JSON.stringify(filtered));
	ok("completions: no match yields null", t.commands.getArgumentCompletions("checkout zzz") === null);
	ok("completions: subcommand itself still completes", t.commands.getArgumentCompletions("che")?.some((i) => i.value === "checkout"), JSON.stringify(t.commands.getArgumentCompletions("che")));
	ok("completions: unrelated subcommand unaffected", t.commands.getArgumentCompletions("prune x") === null);

	t.commands.setKnownBranches({ local: [], remote: [], remotes: [] });
	ok("completions: cleared cache offers nothing", t.commands.getArgumentCompletions("checkout ") === null);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/worktree/commands.test.mjs`
Expected: FAIL — `checkout ` returns `null` because only `focus` and `remove` complete arguments today.

- [ ] **Step 3: Write the implementation**

In `worktree/commands.ts`, replace the body of `getArgumentCompletions` after the subcommand branch with:

```ts
		const [sub, ...rest] = parts;
		const needle = rest.join(" ");

		if (sub === "checkout" || sub === "co") {
			const values = [...knownBranches.local, ...knownBranches.remote.map((branch) => branch.full)];
			const items = values
				.filter((value) => value.startsWith(needle))
				.map((value) => ({ value: `${sub} ${value}`, label: `${sub} ${value}` }));
			return items.length ? items : null;
		}

		if (sub !== "focus" && sub !== "remove") return null;
		const names = known.filter((wt) => !wt.bare).map((wt) => basename(wt.path));
		if (sub === "focus") names.unshift("off");
		const items = names
			.filter((n) => n.startsWith(needle))
			.map((n) => ({ value: `${sub} ${n}`, label: `${sub} ${n}` }));
		return items.length ? items : null;
```

In `worktree/index.ts`, extend the import from `./branches.ts`:

```ts
import { EMPTY_BRANCHES, listBranches } from "./branches.ts";
```

Reset the cache alongside the worktree cache in `session_start` (the `commands.setKnown([]);` at the top of the handler):

```ts
		commands.setKnown([]);
		commands.setKnownBranches(EMPTY_BRANCHES);
```

And seed it in the same guarded block:

```ts
		try {
			commands.setKnown(await listWorktrees(pi, repo.projectRoot));
			commands.setKnownBranches(await listBranches(pi, repo.projectRoot));
		} catch {
			commands.setKnown([]);
			commands.setKnownBranches(EMPTY_BRANCHES);
		}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/worktree/commands.test.mjs`, then `node tests/run-all.mjs worktree`
Expected: `ALL PASS` in both.

- [ ] **Step 5: Break the new assertions on purpose**

- Filter with `includes` instead of `startsWith` → "filtered by prefix" must fail.
- Return `items` instead of `items.length ? items : null` → "no match yields null" must fail.

Revert both.

- [ ] **Step 6: Manual check in a real session**

```bash
cd ~/Code/pi-extensions
git branch scratch/checkout-demo
pi -p "/worktree checkout scratch/checkout-demo"
```

Expected: a worktree at `.claude/worktrees/checkout-demo`, and a `created … on scratch/checkout-demo` line. Clean up:

```bash
git worktree remove .claude/worktrees/checkout-demo && git branch -d scratch/checkout-demo
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add worktree/commands.ts worktree/index.ts tests/worktree/commands.test.mjs
git commit -m "worktree: complete branch names for checkout"
```

---

### Task 6: Documentation and final verification

**Files:**
- Modify: `worktree/README.md`
- Modify: `README.md` (the `lib/` + layout tree near the top; verify whether the extension table row needs anything)

**Interfaces:**
- Consumes: everything above. Produces: nothing.

- [ ] **Step 1: Update `worktree/README.md`**

In the Commands block, add after the `new` line:

```
/worktree checkout <branch> [name]  worktree for an existing branch
```

Add a section after the paragraphs about `new`'s name suggestion:

```markdown
## An existing branch

`/worktree checkout <branch> [name]` is the counterpart to `new`: `new` makes a
branch, `checkout` takes one that exists. The argument is a local branch, a
fully qualified remote ref (`origin/alice/hotfix`), or a branch name that is
unambiguous across remotes. With no argument you get a picker; non-interactively
a branch name is required, as for `focus` and `remove`.

Resolution is local-first, and that is load-bearing: a local branch may hold
commits the remote does not, so `checkout origin/foo` with a local `foo` checks
out your `foo` untouched and says so, rather than resetting anything.

The network is touched only on a miss — one `git fetch` of the relevant remote,
then one retry. So the common case costs nothing and a branch pushed a minute
ago is still found. A stale remote-tracking ref is the accepted gap: it matches
immediately, so the worktree can start a few commits behind. A fetch that fails
is a warning, not an error.

The directory name drops the remote and `branchPrefix`, so with
`"branchPrefix": "joel/"`, `origin/joel/fix-parser` becomes `fix-parser` and
`origin/alice/hotfix` becomes `alice-hotfix`. A derived name that collides gets
`-2`; a name you pass yourself is never adjusted and fails instead. `autoFocus`
applies exactly as it does for `new`.

The model's `worktree` tool deliberately does not expose this. With auto-focus
on, checking out an existing branch could put the model to work directly on a
shared branch instead of a scratch one, so it stays a user decision — like
`focus` and `remove`.
```

In the Tool section, change "The tool still cannot focus an *existing* worktree" paragraph's final sentence to also note it cannot check out an existing branch:

```markdown
The tool still cannot focus an *existing* worktree or check out an *existing*
branch — switching between worktrees, and starting work on a branch that already
exists, stay user decisions.
```

In the Files block, add:

```
worktree/branches.ts     branch listing, resolution and naming (pure + two git calls)
```

In the Tests section, replace "Ten files under `tests/worktree/`" with "Eleven files under `tests/worktree/`" and add a sentence:

```markdown
`branches.test.mjs` covers resolution and naming as pure functions — local-wins,
multi-remote ambiguity, a slash-containing remote name — plus `listBranches` and
`fetchRemote` against a real clone, including a branch pushed after the clone
that only a fetch can reveal.
```

- [ ] **Step 2: Update the root `README.md`**

Add `branches.ts` to the `worktree/` file tree listing (around line 43-50), keeping alphabetical order with the existing entries. Read the extension table row at line 67 and leave it alone unless it enumerates subcommands — it describes the extension in one sentence, which is still accurate.

- [ ] **Step 3: Verify the whole collection**

```bash
npm run check
```

Expected: typecheck clean, every test file `ALL PASS`.

- [ ] **Step 4: Review the diff against the spec**

```bash
git diff main --stat
git log --oneline main..HEAD
```

Confirm each spec section has a commit: resolution and fetch (Task 1-2), creation (Task 3), naming and command (Task 4), picker and completions (Task 5), docs (Task 6).

- [ ] **Step 5: Commit**

```bash
git add README.md worktree/README.md
git commit -m "docs: document /worktree checkout"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| `/worktree checkout <branch> [name]` surface, `new` unchanged | 4 |
| Tool not extended | none needed; asserted by omission, documented in 6 |
| Resolution table, local-wins, ambiguity | 1 |
| `git remote` + longest-prefix parse, `HEAD` dropped | 1 |
| Lazy fetch, one retry, failure is a warning | 2 (mechanism), 4 (policy) |
| Three creation cases, `track`, `base`/`track` exclusivity | 3 |
| Naming, `uniqueName` for derived, typed names fail | 1 (rule), 4 (application) |
| Picker, checked-out marking, non-interactive error | 1 (labels), 4 (behaviour) |
| Completions, cache seeded at `session_start` | 5 |
| Structure: `branches.ts`, `commands.ts`, `worktrees.ts`, `index.ts` | 1-5 |
| Testing list | 1-5, one bullet per named case |

**Placeholders:** none — every step carries the code it needs.

**Type consistency:** `BranchMatch.branch` is the *local* branch name in both the `local` and `remote` variants, which is what `createWorktree({ branch })` wants and what `checkoutName` takes; `full` is only ever the remote ref, passed as `track`. `BranchList` is the single type shared by `listBranches`, `setKnownBranches`, `branchOptions`, `resolveBranch`, and `defaultRemote`. `CreateResult.track` mirrors `CreateOptions.track` and is `undefined` whenever `createdBranch` is `false`.
