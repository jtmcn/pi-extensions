# Delta Pager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `git diff`-style bash output and pi's `edit` diffs with the delta pager, display-only, falling back silently to pi's built-in rendering.

**Architecture:** A new `delta/` extension wraps pi's built-in `bash` and `edit` tool definitions, replacing only their render slots. Delta runs as an async subprocess; results are cached by `(diff, width, config)` and painted on a later repaint triggered by `context.invalidate()`. All decision logic lives in pure modules with injected dependencies; `index.ts` is wiring only.

**Tech Stack:** TypeScript loaded through jiti (no build step), pi extension API, `node:child_process`, delta ≥ 0.19, plain-node tests via `tests/harness.mjs`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-delta-pager-design.md`. Read it before Task 1.
- Display only. Never modify `result.content`; the model keeps receiving the plain diff.
- `write` is out of scope: its `execute` returns `details: undefined` and it has no diff.
- Imports of shared code use the explicit `.ts` extension (`./config.ts`), matching pi's style and jiti's resolution.
- Tabs for indentation, matching every existing file in this repo.
- Reset all session state in `session_start`.
- Never touch a captured `ctx` from an async callback that can outlive the turn; guard with a generation counter and `try/catch`.
- Warn, don't throw, on bad config.
- Guard UI calls on `ctx.hasUI`.
- Pinned copies of pi internals: `PREVIEW_LINES = 5`, `formatDuration` = `` `${(ms / 1000).toFixed(1)}s` ``. Both are pinned by tests in Task 9.
- Verification after every task: `npm run check` must pass before the final commit of that task.

---

### Task 1: `ansi.ts` — make delta's output safe for pi's frame

Delta extends background colours by emitting erase-in-line (`\x1b[0K`). Inside pi's TUI that erases frame content pi drew. This task is first because every later module that touches delta output depends on it.

**Files:**
- Create: `delta/ansi.ts`
- Test: `tests/delta/ansi.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `sanitize(text: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/ansi.test.mjs`:

```javascript
/**
 * Delta's output has to survive pi's frame. Everything stripped here is a
 * sequence that moves or erases, which pi's width accounting cannot see;
 * everything kept is colour, which is the entire point of the feature.
 *
 *   node tests/delta/ansi.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { sanitize } = await loadExt("delta/ansi.ts");

ok("erase-in-line with parameter stripped", sanitize("a\x1b[0Kb") === "ab", JSON.stringify(sanitize("a\x1b[0Kb")));
ok("bare erase-in-line stripped", sanitize("a\x1b[Kb") === "ab");
ok("erase-in-display stripped", sanitize("a\x1b[2Jb") === "ab");
ok("carriage return stripped", sanitize("a\rb") === "ab");
ok("colour preserved", sanitize("\x1b[31mred\x1b[0m") === "\x1b[31mred\x1b[0m");
ok(
	"24-bit background preserved",
	sanitize("\x1b[48;2;63;45;61mx\x1b[0m") === "\x1b[48;2;63;45;61mx\x1b[0m",
);
ok(
	"OSC 8 hyperlink preserved",
	sanitize("\x1b]8;;file:///x\x07t\x1b]8;;\x07") === "\x1b]8;;file:///x\x07t\x1b]8;;\x07",
);
ok("newlines preserved", sanitize("a\nb") === "a\nb");

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/ansi.test.mjs`
Expected: failure — the module does not exist, so the run throws `Cannot find module`.

- [ ] **Step 3: Write the implementation**

Create `delta/ansi.ts`:

```typescript
/**
 * Strip the parts of delta's output that a TUI frame cannot tolerate.
 *
 * Delta extends a background colour to the end of a line with erase-in-line
 * (`\x1b[0K`). In a terminal that paints the rest of the row; inside pi's frame
 * it erases whatever pi drew after us. Carriage returns are the same class of
 * problem: they move the cursor somewhere pi's width accounting does not model.
 *
 * Colour, including 24-bit colour, and OSC 8 hyperlinks are left alone — they
 * are the reason delta is here at all.
 */

/** CSI erase-in-line / erase-in-display, with or without a parameter. */
const ERASE = /\x1b\[[0-2]?[KJ]/g;

export function sanitize(text: string): string {
	return text.replace(ERASE, "").replace(/\r/g, "");
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/ansi.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Temporarily change `ERASE` to `/\x1b\[0K/g`, re-run, and confirm "bare erase-in-line stripped" and "erase-in-display stripped" fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/ansi.ts tests/delta/ansi.test.mjs
git commit -m "delta: strip erase sequences from delta output"
```

---

### Task 2: `detect.ts` — which commands produce a diff

**Files:**
- Create: `delta/detect.ts`
- Test: `tests/delta/detect.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isDiffCommand(command: string, extra?: readonly RegExp[]): boolean`
  - `compilePatterns(sources: readonly string[], warnings: string[]): RegExp[]`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/detect.test.mjs`:

```javascript
/**
 * The matcher decides whether a bash result gets recoloured, from the command
 * alone. Two failure modes matter and both are asserted here: missing a real
 * diff, and recolouring output that only mentions one.
 *
 *   node tests/delta/detect.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { isDiffCommand, compilePatterns } = await loadExt("delta/detect.ts");

const matches = [
	"git diff",
	"git diff HEAD~1",
	"git diff --cached",
	"git -c color.ui=always diff",
	"git -C /tmp/repo diff",
	"git show HEAD",
	"git log -p",
	"git log --patch -n2",
	"git stash show -p",
	"git range-diff main...HEAD",
	"diff -u a.txt b.txt",
	"diff -U3 a.txt b.txt",
	"git diff | head -50",
	"cd /tmp/repo && git diff",
	"git fetch; git diff origin/main",
	"git diff > /tmp/out.diff",
];
for (const command of matches) ok(`matches: ${command}`, isDiffCommand(command) === true);

const rejects = [
	"git diff --stat",
	"git diff --numstat",
	"git diff --name-only",
	"git diff --name-status",
	"git diff --shortstat",
	"git show --stat HEAD",
	"git log",
	"git log --oneline -20",
	"git stash show",
	"git status",
	"git difftool",
	"diff a.txt b.txt",
	'echo "git diff"',
	"rg 'diff --git' .",
	"cat some.patch",
	"",
	"   ",
];
for (const command of rejects) ok(`rejects: ${command || "(empty)"}`, isDiffCommand(command) === false);

// extraCommands is the escape hatch that makes command matching tolerable.
const extra = compilePatterns(["^jj\\s+diff"], []);
ok("extra pattern matches jj diff", isDiffCommand("jj diff", extra) === true);
ok("extra pattern still rejects jj log", isDiffCommand("jj log", extra) === false);
ok("extra pattern applies per segment", isDiffCommand("cd x && jj diff", extra) === true);
ok("summary flags beat extra patterns", isDiffCommand("jj diff --stat", extra) === false);

const warnings = [];
const compiled = compilePatterns(["(unclosed", "^ok"], warnings);
ok("invalid regex dropped", compiled.length === 1);
ok("invalid regex warns", warnings.length === 1 && warnings[0].includes("(unclosed"), JSON.stringify(warnings));

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/detect.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/detect.ts`:

```typescript
/**
 * Which bash commands produce a diff worth handing to delta.
 *
 * Matching the command, not the output: output that merely looks like a diff — a
 * heredoc, a `.patch` fixture, `rg 'diff --git'` — must not be recoloured, and
 * the command is the only signal available before the output exists. The cost is
 * that unusual tools need `extraCommands` in config.
 */

/** Flags that turn a diff command into a summary, which delta cannot render. */
const SUMMARY = /^--(stat|numstat|name-only|name-status|shortstat|compact-summary)(=|$)/;

/** Flags that make `git log` and `git stash show` emit a patch. */
const PATCH = /^(-[pu]|--patch|--unified(=|$)|-U\d*)$/;

/** git's own options precede the subcommand, and some of them take a value. */
const GIT_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--exec-path",
]);

/** Split a shell line into the commands it runs, ignoring how they are joined. */
export function segments(command: string): string[] {
	return command.split(/\|\||&&|[;|\n]/);
}

function tokens(segment: string): string[] {
	return segment.trim().split(/\s+/).filter(Boolean);
}

function subcommand(rest: string[]): { name: string | undefined; args: string[] } {
	let i = 0;
	while (i < rest.length) {
		const token = rest[i];
		if (GIT_OPTIONS_WITH_VALUE.has(token)) {
			i += 2;
			continue;
		}
		if (token.startsWith("-")) {
			i += 1;
			continue;
		}
		return { name: token, args: rest.slice(i + 1) };
	}
	return { name: undefined, args: [] };
}

function isBuiltinDiff(parts: string[]): boolean {
	const [first, ...rest] = parts;
	if (first === "git") {
		const { name, args } = subcommand(rest);
		if (name === "diff" || name === "show" || name === "range-diff") return true;
		if (name === "log") return args.some((arg) => PATCH.test(arg));
		if (name === "stash") return args[0] === "show" && args.slice(1).some((arg) => PATCH.test(arg));
		return false;
	}
	// Plain `diff` only emits a unified diff when asked to.
	if (first === "diff") return rest.some((arg) => PATCH.test(arg));
	return false;
}

export function isDiffCommand(command: string, extra: readonly RegExp[] = []): boolean {
	return segments(command).some((segment) => {
		const parts = tokens(segment);
		if (parts.length === 0) return false;
		if (parts.some((part) => SUMMARY.test(part))) return false;
		if (isBuiltinDiff(parts)) return true;
		return extra.some((pattern) => pattern.test(segment.trim()));
	});
}

/** Compile config patterns, warning about — and dropping — the invalid ones. */
export function compilePatterns(sources: readonly string[], warnings: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of sources) {
		try {
			compiled.push(new RegExp(source));
		} catch (error) {
			warnings.push(`extraCommands: ${source} is not a valid regex (${(error as Error).message})`);
		}
	}
	return compiled;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/detect.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Delete the `SUMMARY` guard line from `isDiffCommand`, re-run, and confirm the five `--stat`-family rejects fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/detect.ts tests/delta/detect.test.mjs
git commit -m "delta: match diff-producing bash commands"
```

---

### Task 3: `footer.ts` — keep pi's truncation footer away from delta

Pi appends `\n\n[Showing lines 1-50 of 900. Full output: /tmp/x]` to truncated bash output and strips it again before rendering, recognising it via `details`. Delta must never see it: it is prose, and delta would try to colour it as a diff.

**Files:**
- Create: `delta/footer.ts`
- Test: `tests/delta/footer.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BashDetails { truncation?: { truncated?: boolean; truncatedBy?: string; outputLines?: number; totalLines?: number }; fullOutputPath?: string }`
  - `splitBashFooter(text: string, details: BashDetails | undefined): { body: string; footer: string }`
  - `bashWarnings(details: BashDetails | undefined): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/footer.test.mjs`:

```javascript
/**
 * The footer split mirrors bash.js's own strip. If the two disagree, either
 * delta colours prose or the user loses the "full output" path.
 *
 *   node tests/delta/footer.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { splitBashFooter, bashWarnings } = await loadExt("delta/footer.ts");

const details = {
	truncation: { truncated: true, truncatedBy: "lines", outputLines: 50, totalLines: 900 },
	fullOutputPath: "/tmp/pi-bash-abc.txt",
};
const body = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b";
const footer = "\n\n[Showing lines 851-900 of 900. Full output: /tmp/pi-bash-abc.txt]";

const split = splitBashFooter(body + footer, details);
ok("body excludes footer", split.body === body, JSON.stringify(split.body));
ok("footer captured", split.footer === footer, JSON.stringify(split.footer));

const untruncated = splitBashFooter(body, undefined);
ok("no details: body unchanged", untruncated.body === body && untruncated.footer === "");

// A diff line can legitimately end in "]" — that alone must not look like a footer.
const endsWithBracket = "diff --git a/x b/x\n+const a = [1]";
const bracket = splitBashFooter(endsWithBracket, details);
ok("bracket without footer text is not a footer", bracket.body === endsWithBracket && bracket.footer === "");

// Truncation flagged but the footer already stripped upstream.
const noFooter = splitBashFooter(body, { truncation: { truncated: true }, fullOutputPath: "/tmp/x" });
ok("truncated but no footer present", noFooter.body === body && noFooter.footer === "");

// A footer-shaped block that names a different path is not ours.
const otherPath = `${body}\n\n[Showing lines 1-2 of 9. Full output: /tmp/other.txt]`;
const other = splitBashFooter(otherPath, details);
ok("footer naming another path is left alone", other.body === otherPath && other.footer === "");

ok(
	"warnings: path and line counts",
	JSON.stringify(bashWarnings(details)) ===
		JSON.stringify(["Full output: /tmp/pi-bash-abc.txt", "Truncated: showing 50 of 900 lines"]),
	JSON.stringify(bashWarnings(details)),
);
ok(
	"warnings: byte truncation has no line counts",
	JSON.stringify(bashWarnings({ truncation: { truncated: true, outputLines: 12 }, fullOutputPath: "/tmp/x" })) ===
		JSON.stringify(["Full output: /tmp/x", "Truncated: 12 lines shown"]),
);
ok("warnings: none without details", bashWarnings(undefined).length === 0);

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/footer.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/footer.ts`:

```typescript
/**
 * pi's bash truncation footer, split off and rendered separately.
 *
 * `bash.js` appends `[Showing lines … Full output: …]` to the output *text* and
 * strips it again at render time, recognising it from `details`. Delta must not
 * see it — it is prose, not diff — so this splits it the same way pi does, using
 * the same three conditions, and rebuilds the warning line from `details`.
 *
 * The warning wording follows pi's, minus its byte-limit variant: `formatSize`
 * and `DEFAULT_MAX_BYTES` are not exported, and inventing a size label that
 * disagrees with pi's would be worse than omitting it.
 */

export interface BashDetails {
	truncation?: {
		truncated?: boolean;
		truncatedBy?: string;
		outputLines?: number;
		totalLines?: number;
	};
	fullOutputPath?: string;
}

export function splitBashFooter(
	text: string,
	details: BashDetails | undefined,
): { body: string; footer: string } {
	const path = details?.fullOutputPath;
	if (details?.truncation?.truncated !== true || !path || !text.endsWith("]")) {
		return { body: text, footer: "" };
	}
	const start = text.lastIndexOf("\n\n[");
	if (start === -1 || !text.slice(start).includes(path)) {
		return { body: text, footer: "" };
	}
	return { body: text.slice(0, start).trimEnd(), footer: text.slice(start) };
}

/** The `[Full output: … Truncated: …]` line, as a list of parts. */
export function bashWarnings(details: BashDetails | undefined): string[] {
	const warnings: string[] = [];
	if (details?.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
	const truncation = details?.truncation;
	if (truncation?.truncated === true) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			warnings.push(`Truncated: ${truncation.outputLines} lines shown`);
		}
	}
	return warnings;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/footer.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Drop the `text.slice(start).includes(path)` condition, re-run, and confirm "footer naming another path is left alone" fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/footer.ts tests/delta/footer.test.mjs
git commit -m "delta: split pi's bash truncation footer from diff text"
```

---

### Task 4: `cache.ts` — LRU with negative entries and in-flight tracking

**Files:**
- Create: `delta/cache.ts`
- Test: `tests/delta/cache.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Entry = { kind: "ready"; text: string } | { kind: "failed" }`
  - `interface Cache { get(key): Entry | undefined; set(key, entry): void; inFlight(key): boolean; markInFlight(key): void; clearInFlight(key): void; reset(): void; size(): number }`
  - `createCache(limit?: number): Cache`
  - `cacheKey(text: string, width: number, version: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/cache.test.mjs`:

```javascript
/**
 * Three properties this cache must have, each of which prevents a specific
 * failure: eviction (unbounded growth), negative entries (respawning delta
 * forever on a failure), and in-flight tracking (one process per diff, not one
 * per repaint).
 *
 *   node tests/delta/cache.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createCache, cacheKey } = await loadExt("delta/cache.ts");

const key = (n) => cacheKey(`diff ${n}`, 80, "v1");

ok("key is stable", key(1) === key(1));
ok("key varies with text", key(1) !== key(2));
ok("key varies with width", cacheKey("d", 80, "v1") !== cacheKey("d", 100, "v1"));
ok("key varies with config version", cacheKey("d", 80, "v1") !== cacheKey("d", 80, "v2"));

const cache = createCache(3);
cache.set(key(1), { kind: "ready", text: "one" });
cache.set(key(2), { kind: "ready", text: "two" });
cache.set(key(3), { kind: "ready", text: "three" });
ok("stores up to the limit", cache.size() === 3);
ok("returns what was stored", cache.get(key(2))?.text === "two");

// key(2) was just read, so key(1) is now the least recently used.
cache.set(key(4), { kind: "ready", text: "four" });
ok("evicts to the limit", cache.size() === 3, String(cache.size()));
ok("evicts least recently used", cache.get(key(1)) === undefined);
ok("keeps recently read entry", cache.get(key(2))?.text === "two");

cache.set(key(5), { kind: "failed" });
ok("negative entry is retrievable", cache.get(key(5))?.kind === "failed");

ok("nothing in flight initially", cache.inFlight(key(6)) === false);
cache.markInFlight(key(6));
ok("in flight after marking", cache.inFlight(key(6)) === true);
cache.clearInFlight(key(6));
ok("not in flight after clearing", cache.inFlight(key(6)) === false);

cache.markInFlight(key(7));
cache.reset();
ok("reset clears entries", cache.size() === 0);
ok("reset clears in-flight", cache.inFlight(key(7)) === false);

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/cache.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/cache.ts`:

```typescript
/**
 * Rendered-diff cache.
 *
 * Three jobs, each guarding a specific failure:
 *   - bounded storage, so a long session does not grow forever;
 *   - negative entries, so a diff delta could not render is not retried on
 *     every repaint for the rest of the session;
 *   - in-flight keys, so N repaints of one diff spawn one process.
 */

import { createHash } from "node:crypto";

export type Entry = { kind: "ready"; text: string } | { kind: "failed" };

export interface Cache {
	get(key: string): Entry | undefined;
	set(key: string, entry: Entry): void;
	inFlight(key: string): boolean;
	markInFlight(key: string): void;
	clearInFlight(key: string): void;
	reset(): void;
	size(): number;
}

/**
 * Identity of a rendered diff: its text, the width it was laid out for, and the
 * config that produced it. A resize or a config edit must miss.
 */
export function cacheKey(text: string, width: number, version: string): string {
	return `${createHash("sha1").update(text).digest("hex")}:${width}:${version}`;
}

export function createCache(limit = 64): Cache {
	const entries = new Map<string, Entry>();
	const pending = new Set<string>();

	return {
		get(key) {
			const entry = entries.get(key);
			if (entry === undefined) return undefined;
			// Map iterates in insertion order, so deleting and re-inserting moves
			// this key to the end and keeps eviction least-recently-*used*.
			entries.delete(key);
			entries.set(key, entry);
			return entry;
		},
		set(key, entry) {
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > limit) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		inFlight: (key) => pending.has(key),
		markInFlight(key) {
			pending.add(key);
		},
		clearInFlight(key) {
			pending.delete(key);
		},
		reset() {
			entries.clear();
			pending.clear();
		},
		size: () => entries.size,
	};
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/cache.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Remove the delete/re-insert from `get`, re-run, and confirm "evicts least recently used" and "keeps recently read entry" fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/cache.ts tests/delta/cache.test.mjs
git commit -m "delta: add LRU cache with negative and in-flight entries"
```

---

### Task 5: `config.ts` — `delta.json`, global and project-local

**Files:**
- Create: `delta/config.ts`
- Test: `tests/delta/config.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DeltaConfig { enabled: boolean; command: string; args: string[]; timeoutMs: number; maxBytes: number; extraCommands: string[] }`
  - `DEFAULT_CONFIG: DeltaConfig`
  - `configVersion(config: DeltaConfig): string`
  - `loadConfig(options: { projectRoot: string; projectTrusted: boolean; agentDir?: string }): Promise<{ config: DeltaConfig; sources: string[]; warnings: string[]; version: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/config.test.mjs`:

```javascript
/**
 * Config resolution, including the two rules that are easy to get wrong: a
 * project file is only read in a trusted project, and a malformed file warns
 * instead of throwing (it would otherwise break session startup).
 *
 *   node tests/delta/config.test.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { loadConfig, configVersion, DEFAULT_CONFIG } = await loadExt("delta/config.ts");

const root = await mkdtemp(join(tmpdir(), "delta-config-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(join(project, ".pi"), { recursive: true });

const load = (projectTrusted) => loadConfig({ projectRoot: project, projectTrusted, agentDir });
const writeGlobal = (text) => writeFile(join(agentDir, "delta.json"), text);
const writeProject = (text) => writeFile(join(project, ".pi", "delta.json"), text);

const defaults = await load(false);
ok("defaults when no file exists", defaults.config.command === "delta" && defaults.config.enabled === true);
ok("defaults record no sources", defaults.sources.length === 0);
ok("defaults produce no warnings", defaults.warnings.length === 0);

await writeGlobal(JSON.stringify({ command: "/opt/homebrew/bin/delta", timeoutMs: 500 }));
const global = await load(false);
ok("global file applied", global.config.command === "/opt/homebrew/bin/delta" && global.config.timeoutMs === 500);
ok("unspecified keys keep defaults", global.config.maxBytes === DEFAULT_CONFIG.maxBytes);
ok("global source recorded", global.sources.length === 1 && global.sources[0].endsWith("agent/delta.json"));

await writeProject(JSON.stringify({ args: ["--side-by-side"], enabled: false }));
const untrusted = await load(false);
ok("untrusted project file ignored", untrusted.config.enabled === true && untrusted.config.args.length === 0);

const trusted = await load(true);
ok("trusted project file applied", trusted.config.enabled === false);
ok("project args applied", JSON.stringify(trusted.config.args) === '["--side-by-side"]');
ok("project file does not clobber global", trusted.config.command === "/opt/homebrew/bin/delta");
ok("both sources recorded", trusted.sources.length === 2, JSON.stringify(trusted.sources));

await writeProject("{ not json");
const broken = await load(true);
ok("malformed JSON warns", broken.warnings.length === 1, JSON.stringify(broken.warnings));
ok("malformed JSON falls back", broken.config.enabled === true);

await writeProject(JSON.stringify({ command: 5, args: "nope", timeoutMs: "soon", extraCommands: [7] }));
const badTypes = await load(true);
ok("type errors warn per field", badTypes.warnings.length === 4, JSON.stringify(badTypes.warnings));
ok("bad values do not clobber", badTypes.config.command === "/opt/homebrew/bin/delta");

ok("version is stable for equal config", configVersion(DEFAULT_CONFIG) === configVersion({ ...DEFAULT_CONFIG }));
ok(
	"version changes with args",
	configVersion(DEFAULT_CONFIG) !== configVersion({ ...DEFAULT_CONFIG, args: ["--side-by-side"] }),
);
ok("loaded config carries its version", trusted.version === configVersion(trusted.config));

await rm(root, { recursive: true, force: true });
done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/config.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/config.ts`:

```typescript
/**
 * Configuration for the delta extension.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. ~/.pi/agent/delta.json               (global)
 *   3. <projectRoot>/.pi/delta.json         (project-local, trusted projects only)
 *
 * `args` is appended to delta's argv after the flags this extension forces, so a
 * user setting beats both the defaults and their own git config.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface DeltaConfig {
	/** Master switch. When false, nothing is ever handed to delta. */
	enabled: boolean;
	/** The binary to run. */
	command: string;
	/** Extra delta arguments, appended last so they win. */
	args: string[];
	/** Per-invocation timeout. */
	timeoutMs: number;
	/** Diffs larger than this skip delta entirely. */
	maxBytes: number;
	/** Regex sources added to the bash command matcher, e.g. "^jj\\s+diff". */
	extraCommands: string[];
}

export const DEFAULT_CONFIG: DeltaConfig = {
	enabled: true,
	command: "delta",
	args: [],
	timeoutMs: 2000,
	maxBytes: 262_144,
	extraCommands: [],
};

export interface LoadConfigOptions {
	projectRoot: string;
	projectTrusted: boolean;
	/** Overridable so tests do not read the real ~/.pi/agent. */
	agentDir?: string;
}

export interface LoadedConfig {
	config: DeltaConfig;
	/** Config files found and applied, in precedence order. */
	sources: string[];
	/** Non-fatal problems: malformed JSON, bad field types. */
	warnings: string[];
	/** Identity of this config, for the render cache key. */
	version: string;
}

/** Short hash of the config, so a config edit invalidates cached renderings. */
export function configVersion(config: DeltaConfig): string {
	return createHash("sha1").update(JSON.stringify(config)).digest("hex").slice(0, 8);
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
	const candidates = [join(options.agentDir ?? getAgentDir(), "delta.json")];
	if (options.projectTrusted) {
		candidates.push(join(options.projectRoot, CONFIG_DIR_NAME, "delta.json"));
	}

	let config = { ...DEFAULT_CONFIG };
	const sources: string[] = [];
	const warnings: string[] = [];

	for (const file of candidates) {
		const raw = await readJson(file, warnings);
		if (!raw) continue;
		config = merge(config, raw, file, warnings);
		sources.push(file);
	}

	return { config, sources, warnings, version: configVersion(config) };
}

async function readJson(file: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`${file}: expected a JSON object`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		warnings.push(`${file}: invalid JSON (${(error as Error).message})`);
		return undefined;
	}
}

function merge(
	base: DeltaConfig,
	raw: Record<string, unknown>,
	file: string,
	warnings: string[],
): DeltaConfig {
	const next = { ...base };

	const bool = (key: "enabled") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "boolean") {
			warnings.push(`${file}: "${key}" must be a boolean`);
			return;
		}
		next[key] = value;
	};
	const str = (key: "command") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "string" || !value) {
			warnings.push(`${file}: "${key}" must be a non-empty string`);
			return;
		}
		next[key] = value;
	};
	const num = (key: "timeoutMs" | "maxBytes") => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			warnings.push(`${file}: "${key}" must be a positive number`);
			return;
		}
		next[key] = value;
	};
	const strings = (key: "args" | "extraCommands") => {
		const value = raw[key];
		if (value === undefined) return;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			warnings.push(`${file}: "${key}" must be an array of strings`);
			return;
		}
		next[key] = value as string[];
	};

	bool("enabled");
	str("command");
	num("timeoutMs");
	num("maxBytes");
	strings("args");
	strings("extraCommands");

	return next;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/config.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Push the project candidate unconditionally (drop the `projectTrusted` check), re-run, and confirm "untrusted project file ignored" fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/config.ts tests/delta/config.test.mjs
git commit -m "delta: load delta.json config with trusted project override"
```

---

### Task 6: `run.ts` — the delta subprocess

**Files:**
- Create: `delta/run.ts`
- Test: `tests/delta/run.test.mjs`

**Interfaces:**
- Consumes: `sanitize` (Task 1), `DeltaConfig` (Task 5).
- Produces:
  - `interface SpawnResult { code: number | null; stdout: string; timedOut: boolean }`
  - `type SpawnFn = (command: string, args: string[], input: string, timeoutMs: number) => Promise<SpawnResult>`
  - `nodeSpawn: SpawnFn`
  - `interface Runner { available(): Promise<boolean>; render(text: string, width: number): Promise<string | undefined>; reset(): void }`
  - `createRunner(deps: { config: () => DeltaConfig; spawn?: SpawnFn }): Runner`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/run.test.mjs`:

```javascript
/**
 * The subprocess half. Failure modes are scripted through a fake spawn; the
 * happy path runs the real delta when it is installed, because "delta emits
 * colour when its stdout is a pipe" is an assumption about another program and
 * a fake cannot check it.
 *
 *   node tests/delta/run.test.mjs
 */

import { assertions, loadExt, pexec } from "../harness.mjs";

const { ok, skip, done } = assertions();
const { createRunner, nodeSpawn } = await loadExt("delta/run.ts");
const { DEFAULT_CONFIG } = await loadExt("delta/config.ts");

const PATCH = [
	"diff --git a/f.txt b/f.txt",
	"index 0000000..1111111 100644",
	"--- a/f.txt",
	"+++ b/f.txt",
	"@@ -1,3 +1,3 @@",
	" a",
	"-b",
	"+B",
	" c",
	"",
].join("\n");

// ---- scripted failures

const calls = [];
const fake = (result) => async (command, args, input, timeoutMs) => {
	calls.push({ command, args, input, timeoutMs });
	return result;
};

const config = () => ({ ...DEFAULT_CONFIG, args: ["--side-by-side"], timeoutMs: 250 });

const ok1 = createRunner({ config, spawn: fake({ code: 0, stdout: "\x1b[31mrendered\x1b[0m\n", timedOut: false }) });
ok("returns rendered output", (await ok1.render(PATCH, 80)) === "\x1b[31mrendered\x1b[0m");
ok("forces paging never", calls[0].args.slice(0, 2).join(" ") === "--paging never", JSON.stringify(calls[0].args));
ok("passes width", calls[0].args.includes("80"));
ok("config args come last", calls[0].args.at(-1) === "--side-by-side", JSON.stringify(calls[0].args));
ok("timeout comes from config", calls[0].timeoutMs === 250);
ok("diff is written to stdin", calls[0].input === PATCH);

const failed = createRunner({ config, spawn: fake({ code: 1, stdout: "half output", timedOut: false }) });
ok("nonzero exit yields nothing", (await failed.render(PATCH, 80)) === undefined);

const timedOut = createRunner({ config, spawn: fake({ code: null, stdout: "partial", timedOut: true }) });
ok("timeout yields nothing", (await timedOut.render(PATCH, 80)) === undefined);

const empty = createRunner({ config, spawn: fake({ code: 0, stdout: "   \n", timedOut: false }) });
ok("blank output yields nothing", (await empty.render(PATCH, 80)) === undefined);

const dirty = createRunner({ config, spawn: fake({ code: 0, stdout: "a\x1b[0Kb\n", timedOut: false }) });
ok("output is sanitized", (await dirty.render(PATCH, 80)) === "ab");

const probeCalls = [];
const probed = createRunner({
	config,
	spawn: async (command, args) => {
		probeCalls.push(args.join(" "));
		return { code: 0, stdout: "delta 0.19.2", timedOut: false };
	},
});
ok("available probes --version", (await probed.available()) === true && probeCalls[0] === "--version");
await probed.available();
ok("probe is memoized", probeCalls.length === 1, String(probeCalls.length));
probed.reset();
await probed.available();
ok("reset re-probes", probeCalls.length === 2);

const missing = createRunner({ config, spawn: fake({ code: null, stdout: "", timedOut: false }) });
ok("missing binary is unavailable", (await missing.available()) === false);

// ---- the real binary, when present

let deltaInstalled = true;
try {
	await pexec("delta", ["--version"]);
} catch {
	deltaInstalled = false;
}

if (!deltaInstalled) {
	skip("delta is not installed; skipping real-binary assertions");
} else {
	const real = createRunner({ config: () => ({ ...DEFAULT_CONFIG }) });
	ok("real delta is available", (await real.available()) === true);
	const rendered = await real.render(PATCH, 80);
	ok("real delta returns output", typeof rendered === "string" && rendered.length > 0);
	ok("real delta emits colour into a pipe", /\x1b\[[0-9;]*m/.test(rendered ?? ""));
	ok("real output carries no erase sequences", !/\x1b\[[0-2]?[KJ]/.test(rendered ?? ""));
	ok("real output mentions the file", (rendered ?? "").includes("f.txt"));
	const wide = await real.render(PATCH, 200);
	ok("width changes the rendering", wide !== rendered);

	const bogus = createRunner({ config: () => ({ ...DEFAULT_CONFIG, args: ["--not-a-flag"] }) });
	ok("bad args fall back to nothing", (await bogus.render(PATCH, 80)) === undefined);

	const absent = createRunner({ config: () => ({ ...DEFAULT_CONFIG, command: "delta-does-not-exist" }) });
	ok("absent binary is unavailable", (await absent.available()) === false);

	// A real timeout. `sh -c 'sleep 5'` ignores stdin and outlives the timeout;
	// the forced flags land after `-c sleep 5` as harmless positional parameters.
	const hang = createRunner({
		config: () => ({ ...DEFAULT_CONFIG, command: "sh", args: ["-c", "sleep 5"], timeoutMs: 100 }),
	});
	const started = Date.now();
	ok("hanging command times out", (await hang.render(PATCH, 80)) === undefined);
	ok("timeout is enforced quickly", Date.now() - started < 2000, `${Date.now() - started}ms`);
}

ok("nodeSpawn is the default", typeof nodeSpawn === "function");

done();
```

Note on that last case: `config.args` are appended after the forced flags, so the
argv is `sh --paging never --width 80 -c 'sleep 5'`. `sh` accepts that (the `-c`
still wins), which is why it hangs rather than exiting on a bad flag.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/run.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/run.ts`:

```typescript
/**
 * Running delta.
 *
 * Spawned without a shell: the command comes from config and the input is a
 * diff, so there is nothing a shell would add except a way to misparse it.
 *
 * Everything that can go wrong — missing binary, nonzero exit, timeout, empty
 * output — resolves to `undefined` rather than throwing. The caller's job is to
 * fall back to pi's rendering, and there is no failure here it should treat
 * differently.
 */

import { spawn } from "node:child_process";
import { sanitize } from "./ansi.ts";
import type { DeltaConfig } from "./config.ts";

export interface SpawnResult {
	code: number | null;
	stdout: string;
	timedOut: boolean;
}

export type SpawnFn = (
	command: string,
	args: string[],
	input: string,
	timeoutMs: number,
) => Promise<SpawnResult>;

export const nodeSpawn: SpawnFn = (command, args, input, timeoutMs) =>
	new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "", timedOut: false });
			return;
		}

		let stdout = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, timedOut });
		};

		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		// A missing binary surfaces here, not as a throw from spawn().
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
		// delta can exit before it has read the whole diff; that EPIPE is expected.
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});

export interface Runner {
	/** Whether the configured binary exists and runs. Memoized per session. */
	available(): Promise<boolean>;
	/** Delta's rendering of `text` at `width`, or undefined on any failure. */
	render(text: string, width: number): Promise<string | undefined>;
	/** Forget the availability probe. Called on session_start. */
	reset(): void;
}

/** Delta's own minimum useful width; narrower terminals get this instead. */
const MIN_WIDTH = 20;

export function createRunner(deps: { config: () => DeltaConfig; spawn?: SpawnFn }): Runner {
	const run = deps.spawn ?? nodeSpawn;
	let probe: Promise<boolean> | undefined;

	return {
		available() {
			// One probe per session: PATH does not change under us, and a missing
			// binary must not cost a process per diff.
			probe ??= run(deps.config().command, ["--version"], "", 2000).then((result) => result.code === 0);
			return probe;
		},
		async render(text, width) {
			const config = deps.config();
			const args = [
				"--paging",
				"never",
				"--width",
				String(Math.max(MIN_WIDTH, Math.floor(width))),
				// User args last so they beat both these flags and git config.
				...config.args,
			];
			const result = await run(config.command, args, text, config.timeoutMs);
			if (result.timedOut || result.code !== 0) return undefined;
			const output = sanitize(result.stdout).replace(/\n+$/, "");
			return output.trim() ? output : undefined;
		},
		reset() {
			probe = undefined;
		},
	};
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/run.test.mjs`
Expected: `ALL PASS` (with no `skip` line on this machine — delta 0.19.2 is installed)

- [ ] **Step 5: Break it on purpose**

Move `...config.args` before `"--paging"`, re-run, and confirm "config args come last" fails. Then make `render` return `sanitize(result.stdout)` regardless of `result.code`, and confirm "nonzero exit yields nothing" fails. Restore both.

- [ ] **Step 6: Commit**

```bash
git add delta/run.ts tests/delta/run.test.mjs
git commit -m "delta: run delta as a subprocess with timeout and fallbacks"
```

---

### Task 7: `engine.ts` — scheduling, caching, and the stale-session guard

**Files:**
- Create: `delta/engine.ts`
- Test: `tests/delta/engine.test.mjs`

**Interfaces:**
- Consumes: `Cache`, `cacheKey` (Task 4), `DeltaConfig` (Task 5), `Runner` (Task 6).
- Produces:
  - `interface Engine { lookup(text: string, width: number, invalidate: () => void): string | undefined; reset(): void }`
  - `createEngine(deps: { cache: Cache; runner: Runner; config: () => DeltaConfig; version: () => string; onUnavailable?: () => void }): Engine`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/engine.test.mjs`:

```javascript
/**
 * The engine is the only place that decides when delta runs. Each assertion
 * here corresponds to a way this can go wrong in a live session: a render loop
 * spawning a process per frame, a failure retried forever, a warning repeated
 * per diff, or a completed run painting through the ctx of a session that has
 * already been replaced.
 *
 *   node tests/delta/engine.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createEngine } = await loadExt("delta/engine.ts");
const { createCache } = await loadExt("delta/cache.ts");
const { DEFAULT_CONFIG } = await loadExt("delta/config.ts");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A runner whose answers and call log the test controls. */
const fakeRunner = ({ output = "DELTA", available = true } = {}) => {
	const calls = [];
	return {
		calls,
		available: async () => available,
		render: async (text, width) => {
			calls.push({ text, width });
			return typeof output === "function" ? output(text, width) : output;
		},
		reset: () => {},
	};
};

const build = (overrides = {}) => {
	const cache = createCache(8);
	const runner = overrides.runner ?? fakeRunner();
	const unavailable = [];
	const engine = createEngine({
		cache,
		runner,
		config: () => ({ ...DEFAULT_CONFIG, ...overrides.config }),
		version: () => overrides.version?.() ?? "v1",
		onUnavailable: () => unavailable.push(Date.now()),
	});
	return { engine, runner, cache, unavailable };
};

// ---- the basic two-phase lookup

{
	const { engine, runner } = build();
	const repaints = [];
	ok("first lookup is a miss", engine.lookup("patch", 80, () => repaints.push(1)) === undefined);
	await settle();
	ok("delta ran once", runner.calls.length === 1, String(runner.calls.length));
	ok("repaint requested", repaints.length === 1, String(repaints.length));
	ok("second lookup is a hit", engine.lookup("patch", 80, () => repaints.push(2)) === "DELTA");
	ok("a hit does not re-run delta", runner.calls.length === 1);
	ok("a hit does not repaint", repaints.length === 1);
}

// ---- one process per diff, however many repaints

{
	const { engine, runner } = build();
	for (let i = 0; i < 5; i++) engine.lookup("patch", 80, () => {});
	await settle();
	ok("repeated misses spawn one run", runner.calls.length === 1, String(runner.calls.length));
}

// ---- width and config are part of identity

{
	const { engine, runner } = build();
	engine.lookup("patch", 80, () => {});
	await settle();
	engine.lookup("patch", 120, () => {});
	await settle();
	ok("a new width re-runs delta", runner.calls.length === 2, String(runner.calls.length));
	ok("width is passed through", runner.calls[1].width === 120);
}

// ---- failures are remembered

{
	const { engine, runner } = build({ runner: fakeRunner({ output: undefined }) });
	const repaints = [];
	ok("failed lookup is a miss", engine.lookup("patch", 80, () => repaints.push(1)) === undefined);
	await settle();
	ok("failure does not repaint", repaints.length === 0, String(repaints.length));
	for (let i = 0; i < 3; i++) {
		ok(`failure stays a miss (${i})`, engine.lookup("patch", 80, () => {}) === undefined);
		await settle();
	}
	ok("failure is not retried", runner.calls.length === 1, String(runner.calls.length));
}

// ---- guards that never reach the runner

{
	const { engine, runner } = build({ config: { enabled: false } });
	engine.lookup("patch", 80, () => {});
	await settle();
	ok("disabled never runs delta", runner.calls.length === 0);
}

{
	const { engine, runner } = build({ config: { maxBytes: 8 } });
	engine.lookup("a much longer diff than eight bytes", 80, () => {});
	await settle();
	ok("oversized input never runs delta", runner.calls.length === 0);
}

{
	const { engine, runner } = build();
	engine.lookup("", 80, () => {});
	await settle();
	ok("empty input never runs delta", runner.calls.length === 0);
}

// ---- missing binary warns once per session

{
	const { engine, unavailable } = build({ runner: fakeRunner({ available: false }) });
	engine.lookup("one", 80, () => {});
	await settle();
	engine.lookup("two", 80, () => {});
	await settle();
	ok("unavailable warns once", unavailable.length === 1, String(unavailable.length));
	engine.reset();
	engine.lookup("three", 80, () => {});
	await settle();
	ok("a new session warns again", unavailable.length === 2, String(unavailable.length));
}

// ---- a superseded session must not be painted through
//
// This is the bug class the repo conventions exist for: `invalidate` belongs to
// a ctx that throws once its session is replaced.

{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const runner = {
		available: async () => true,
		render: async () => {
			await gate;
			return "DELTA";
		},
		reset: () => {},
	};
	const { engine } = build({ runner });
	let painted = 0;
	engine.lookup("patch", 80, () => {
		painted += 1;
		throw new Error("extension ctx is stale");
	});
	engine.reset(); // the session is replaced while delta is still running
	release();
	await settle();
	ok("stale session is not painted", painted === 0, String(painted));
}

// ---- a throwing invalidate must not escape

{
	const { engine } = build();
	engine.lookup("patch", 80, () => {
		throw new Error("extension ctx is stale");
	});
	let crashed = false;
	process.once("unhandledRejection", () => {
		crashed = true;
	});
	await settle();
	ok("a throwing repaint is swallowed", crashed === false);
}

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/engine.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/engine.ts`:

```typescript
/**
 * When delta runs, and what the renderer sees while it has not answered yet.
 *
 * `lookup` is called from a synchronous render, so it can only ever return what
 * is already cached. On a miss it schedules delta and asks for a repaint when
 * the answer arrives. Everything else here exists to stop that loop from
 * misbehaving:
 *
 *   - in-flight keys, so a component rendered five times spawns one process;
 *   - negative entries, so a failure is not retried on every later frame;
 *   - a generation counter, so a run that finishes after its session was
 *     replaced never touches the stale `invalidate` — that throws "extension
 *     ctx is stale" and takes the process down.
 */

import { type Cache, cacheKey } from "./cache.ts";
import type { DeltaConfig } from "./config.ts";
import type { Runner } from "./run.ts";

export interface Engine {
	/**
	 * Delta's rendering of `text` at `width` if it is ready, otherwise undefined
	 * with a run scheduled. `invalidate` is called once, later, if that run
	 * produces something and the session is still current.
	 */
	lookup(text: string, width: number, invalidate: () => void): string | undefined;
	/** Drop all session state: cache, probe, warning, and in-flight runs. */
	reset(): void;
}

export interface EngineDeps {
	cache: Cache;
	runner: Runner;
	config: () => DeltaConfig;
	version: () => string;
	/** Called at most once per session when the binary is missing. */
	onUnavailable?: () => void;
}

export function createEngine(deps: EngineDeps): Engine {
	let generation = 0;
	let warned = false;

	return {
		lookup(text, width, invalidate) {
			const config = deps.config();
			if (!config.enabled || !text) return undefined;
			// A huge diff is shown as a handful of collapsed lines, so rendering it
			// in full would spend a subprocess on output nobody reads.
			if (Buffer.byteLength(text, "utf-8") > config.maxBytes) return undefined;

			const key = cacheKey(text, width, deps.version());
			const entry = deps.cache.get(key);
			if (entry?.kind === "ready") return entry.text;
			if (entry?.kind === "failed") return undefined;
			if (deps.cache.inFlight(key)) return undefined;

			deps.cache.markInFlight(key);
			const started = generation;

			void (async () => {
				let output: string | undefined;
				try {
					if (await deps.runner.available()) {
						output = await deps.runner.render(text, width);
					} else if (!warned) {
						warned = true;
						deps.onUnavailable?.();
					}
				} catch {
					output = undefined;
				}

				deps.cache.clearInFlight(key);
				// The negative entry is what stops the next frame from starting this
				// run over again, for the rest of the session.
				deps.cache.set(key, output === undefined ? { kind: "failed" } : { kind: "ready", text: output });

				if (started !== generation || output === undefined) return;
				try {
					invalidate();
				} catch {
					// The component outlived its session. Nothing to repaint.
				}
			})();

			return undefined;
		},
		reset() {
			generation += 1;
			warned = false;
			deps.cache.reset();
			deps.runner.reset();
		},
	};
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/engine.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Three mutations, one at a time:
1. Remove the `started !== generation` check → "stale session is not painted" must fail.
2. Change the failure path to `if (output !== undefined) deps.cache.set(...)` → "failure is not retried" must fail.
3. Remove `deps.cache.markInFlight(key)` → "repeated misses spawn one run" must fail.

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add delta/engine.ts tests/delta/engine.test.mjs
git commit -m "delta: schedule delta runs with cache, warn-once, and session guard"
```

---

### Task 8: `body.ts` — the diff body component

The component pi paints for a diff: delta's rendering when available, pi's own `renderDiff` until then.

**Files:**
- Create: `delta/body.ts`
- Test: `tests/delta/body.test.mjs`

**Interfaces:**
- Consumes: `Engine` (Task 7).
- Produces:
  - `interface DiffBody { render(width: number): string[]; invalidate(): void; set(patch: string | undefined, diff: string | undefined): void }`
  - `createDiffBody(deps: { engine: Engine; fallback: (diff: string) => string; invalidate: () => void }): DiffBody`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/body.test.mjs`:

```javascript
/**
 * The diff body is what the user actually looks at. Two things matter: it never
 * shows nothing while delta is still thinking, and it asks the engine for the
 * width it was really given.
 *
 *   node tests/delta/body.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createDiffBody } = await loadExt("delta/body.ts");

/** An engine whose answer the test flips, recording the widths it was asked for. */
const fakeEngine = () => {
	const widths = [];
	let answer;
	return {
		widths,
		ready: (text) => {
			answer = text;
		},
		lookup: (_text, width) => {
			widths.push(width);
			return answer;
		},
		reset: () => {},
	};
};

const engine = fakeEngine();
const body = createDiffBody({
	engine,
	fallback: (diff) => `PI:${diff}`,
	invalidate: () => {},
});

body.set("PATCH", "DIFF");

ok("falls back before delta answers", JSON.stringify(body.render(80)) === '["","PI:DIFF"]', JSON.stringify(body.render(80)));
ok("asks for the width it was given", engine.widths.at(-1) === 80, String(engine.widths.at(-1)));

engine.ready("DELTA LINE 1\nDELTA LINE 2");
ok(
	"uses delta once available",
	JSON.stringify(body.render(80)) === '["","DELTA LINE 1","DELTA LINE 2"]',
	JSON.stringify(body.render(80)),
);

body.render(120);
ok("a resize asks at the new width", engine.widths.at(-1) === 120);

const noPatch = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {} });
noPatch.set(undefined, "DIFF");
ok("no patch still renders pi's diff", JSON.stringify(noPatch.render(80)) === '["","PI:DIFF"]');

const nothing = createDiffBody({ engine, fallback: (diff) => `PI:${diff}`, invalidate: () => {} });
nothing.set(undefined, undefined);
ok("nothing to show renders no lines", JSON.stringify(nothing.render(80)) === "[]");

ok("invalidate is callable", (() => { body.invalidate(); return true; })());

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/body.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/body.ts`:

```typescript
/**
 * The diff body pi paints, in delta's rendering or pi's own.
 *
 * Shaped as a pi TUI component: `render(width)` returns lines, and `width` is
 * the real render width, which is how a resize gets delta re-run at the size it
 * will actually be displayed at.
 *
 * `patch` is a standard unified patch (delta needs the `diff --git` header to
 * know the filename and pick a grammar); `diff` is pi's display diff, which is
 * all `renderDiff` accepts. Both come from the same tool result.
 */

import type { Engine } from "./engine.ts";

export interface DiffBody {
	render(width: number): string[];
	invalidate(): void;
	set(patch: string | undefined, diff: string | undefined): void;
}

export interface DiffBodyDeps {
	engine: Engine;
	/** pi's `renderDiff`, used until delta answers and whenever it cannot. */
	fallback: (diff: string) => string;
	/** Ask pi to repaint this tool row. */
	invalidate: () => void;
}

export function createDiffBody(deps: DiffBodyDeps): DiffBody {
	let patch: string | undefined;
	let diff: string | undefined;

	return {
		set(nextPatch, nextDiff) {
			patch = nextPatch;
			diff = nextDiff;
		},
		invalidate() {
			// Nothing is cached here; the engine owns the cache.
		},
		render(width) {
			const rendered = patch ? deps.engine.lookup(patch, width, deps.invalidate) : undefined;
			const text = rendered ?? (diff ? deps.fallback(diff) : undefined);
			if (!text) return [];
			// The leading blank line matches pi's own Spacer before a diff.
			return ["", ...text.split("\n")];
		},
	};
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/body.test.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Break it on purpose**

Change `render` to return `[]` when `rendered` is undefined, re-run, and confirm "falls back before delta answers" fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/body.ts tests/delta/body.test.mjs
git commit -m "delta: add the diff body component with pi fallback"
```

---

### Task 9: `bash-result.ts` — the forked bash result component

Pi's `getTextOutput` strips ANSI from result content, so delta output can only reach the screen from a component we own. This reproduces what pi's bash result rendering does, using pi's exported helpers where they exist, and pins the two constants that are not exported.

**Files:**
- Create: `delta/bash-result.ts`
- Test: `tests/delta/bash-result.test.mjs`

**Interfaces:**
- Consumes: `Engine` (Task 7), `bashWarnings` (Task 3).
- Produces:
  - `PREVIEW_LINES: 5`
  - `formatDuration(ms: number): string`
  - `interface BashResultInput { body: string; warnings: string[]; expanded: boolean; timing?: { label: string; ms: number } }`
  - `interface BashResult { render(width: number): string[]; invalidate(): void; update(input: BashResultInput): void }`
  - `createBashResult(deps: { engine: Engine; theme: ThemeLike; fallback: (text: string) => string; invalidate: () => void; truncate: TruncateFn; expandHint: () => string }): BashResult`
  - `interface ThemeLike { fg(color: string, text: string): string }`
  - `type TruncateFn = (text: string, maxLines: number, width: number) => { visualLines: string[]; skippedCount: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/bash-result.test.mjs`:

```javascript
/**
 * The forked bash result rendering.
 *
 * Two of the values it reproduces are not exported by pi (the 5-line preview
 * and the duration format), so this file pins them against pi's own bash
 * renderer: if an upgrade changes either, these assertions fail instead of the
 * rendering quietly drifting.
 *
 *   node tests/delta/bash-result.test.mjs
 */

import { assertions, loadExt, piEntry } from "../harness.mjs";
import { readFile } from "node:fs/promises";

const { ok, done } = assertions();
const { createBashResult, PREVIEW_LINES, formatDuration } = await loadExt("delta/bash-result.ts");

const theme = { fg: (color, text) => `<${color}>${text}` };
const hintFor = (skipped) => `<hint:${skipped}>`;
const truncate = (text, maxLines) => {
	const lines = text.split("\n");
	return {
		visualLines: lines.slice(-maxLines),
		skippedCount: Math.max(0, lines.length - maxLines),
	};
};

const build = ({ ready } = {}) => {
	const widths = [];
	const engine = {
		lookup: (_text, width) => {
			widths.push(width);
			return ready;
		},
		reset: () => {},
	};
	const component = createBashResult({
		engine,
		theme,
		fallback: (text) => `PI(${text})`,
		invalidate: () => {},
		truncate,
		expandHint: hintFor,
	});
	return { component, widths };
};

// ---- collapsed and expanded

{
	const { component } = build({ ready: "1\n2\n3\n4\n5\n6\n7" });
	component.update({ body: "diff", warnings: [], expanded: false });
	const collapsed = component.render(80);
	ok("collapsed keeps PREVIEW_LINES lines", collapsed.filter((l) => /^\d$/.test(l)).length === 5, JSON.stringify(collapsed));
	ok("collapsed shows the expand hint", collapsed.includes("<hint:2>"), JSON.stringify(collapsed));
	ok("hint carries the skipped count", collapsed.includes("<hint:2>"));
	ok("collapsed keeps the last lines", collapsed.at(-1) === "7");

	component.update({ body: "diff", warnings: [], expanded: true });
	const expanded = component.render(80);
	ok("expanded shows every line", expanded.filter((l) => /^\d$/.test(l)).length === 7);
	ok("expanded has no hint", !expanded.some((l) => l.startsWith("<hint")));
}

// ---- short output needs no hint

{
	const { component } = build({ ready: "1\n2" });
	component.update({ body: "diff", warnings: [], expanded: false });
	ok("no hint when nothing was skipped", !component.render(80).some((l) => l.startsWith("<hint")));
}

// ---- fallback, warnings, timing

{
	const { component, widths } = build({ ready: undefined });
	component.update({
		body: "diff text",
		warnings: ["Full output: /tmp/x", "Truncated: showing 5 of 90 lines"],
		expanded: true,
		timing: { label: "Took", ms: 1234 },
	});
	const lines = component.render(100);
	ok("falls back to pi's styling", lines.some((l) => l.includes("PI(diff text)")), JSON.stringify(lines));
	ok(
		"warning line matches pi's format",
		lines.some((l) => l === "<warning>[Full output: /tmp/x. Truncated: showing 5 of 90 lines]"),
		JSON.stringify(lines),
	);
	ok("timing line present", lines.some((l) => l === "<muted>Took 1.2s"), JSON.stringify(lines));
	ok("engine asked at the render width", widths.at(-1) === 100);
}

// ---- empty output renders nothing but the extras

{
	const { component } = build({ ready: undefined });
	component.update({ body: "", warnings: [], expanded: false });
	ok("no body renders no lines", JSON.stringify(component.render(80)) === "[]");
}

// ---- the pinned copies

ok("formatDuration matches pi's format", formatDuration(1234) === "1.2s" && formatDuration(500) === "0.5s");

const source = await readFile((await piEntry()).replace(/index\.js$/, "core/tools/bash.js"), "utf-8");
ok(
	"PREVIEW_LINES still matches pi's BASH_PREVIEW_LINES",
	source.includes(`const BASH_PREVIEW_LINES = ${PREVIEW_LINES};`),
	"pi changed BASH_PREVIEW_LINES; update delta/bash-result.ts",
);
ok(
	"duration format still matches pi's formatDuration",
	source.includes("return `${(ms / 1000).toFixed(1)}s`;"),
	"pi changed formatDuration; update delta/bash-result.ts",
);

done();
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/bash-result.test.mjs`
Expected: failure — module missing.

- [ ] **Step 3: Write the implementation**

Create `delta/bash-result.ts`:

```typescript
/**
 * A stand-in for pi's bash result rendering, for diff commands only.
 *
 * Substituting delta's output into the tool result is not possible: pi's
 * `getTextOutput` runs `stripAnsi` over result content before styling it. So for
 * a diff command this component replaces pi's, and has to reproduce what pi's
 * does — collapsed preview, expand hint, truncation warning, timing.
 *
 * `PREVIEW_LINES` and `formatDuration` are copies of unexported values in pi's
 * `bash.js`. `tests/delta/bash-result.test.mjs` reads pi's source and fails if
 * either changes, so the divergence is caught rather than discovered.
 *
 * One deliberate difference from pi: no `setInterval` ticking the elapsed-time
 * line. pi refreshes it once a second from a timer; a diff command finishes in
 * milliseconds, and a timer that outlives its session is the single most
 * dangerous thing an extension can hold.
 */

import type { Engine } from "./engine.ts";

/** Pinned copy of pi's `BASH_PREVIEW_LINES` (core/tools/bash.js). */
export const PREVIEW_LINES = 5;

/** Pinned copy of pi's `formatDuration` (core/tools/bash.js). */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export interface ThemeLike {
	fg(color: string, text: string): string;
}

export type TruncateFn = (
	text: string,
	maxLines: number,
	width: number,
) => { visualLines: string[]; skippedCount: number };

export interface BashResultInput {
	/** The diff text, with pi's truncation footer already split off. */
	body: string;
	/** Parts of the `[…]` warning line, from `bashWarnings`. */
	warnings: string[];
	expanded: boolean;
	timing?: { label: string; ms: number };
}

export interface BashResult {
	render(width: number): string[];
	invalidate(): void;
	update(input: BashResultInput): void;
}

export interface BashResultDeps {
	engine: Engine;
	theme: ThemeLike;
	/** pi's per-line `toolOutput` styling, used until delta answers. */
	fallback: (text: string) => string;
	invalidate: () => void;
	/** pi's `truncateToVisualLines`, injected so tests need no TUI. */
	truncate: TruncateFn;
	/** pi's expand hint, which needs the keybinding registry. */
	expandHint: (skipped: number) => string;
}

export function createBashResult(deps: BashResultDeps): BashResult {
	let input: BashResultInput = { body: "", warnings: [], expanded: false };

	return {
		update(next) {
			input = next;
		},
		invalidate() {
			// The engine owns the cache; nothing to drop here.
		},
		render(width) {
			const lines: string[] = [];
			const rendered = input.body ? deps.engine.lookup(input.body, width, deps.invalidate) : undefined;
			const text = rendered ?? (input.body ? deps.fallback(input.body) : "");

			if (text) {
				if (input.expanded) {
					lines.push("", ...text.split("\n"));
				} else {
					const preview = deps.truncate(text, PREVIEW_LINES, width);
					lines.push("");
					if (preview.skippedCount > 0) lines.push(deps.expandHint(preview.skippedCount));
					lines.push(...preview.visualLines);
				}
			}

			if (input.warnings.length > 0) {
				lines.push(deps.theme.fg("warning", `[${input.warnings.join(". ")}]`));
			}
			if (input.timing) {
				lines.push(deps.theme.fg("muted", `${input.timing.label} ${formatDuration(input.timing.ms)}`));
			}

			return lines;
		},
	};
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/bash-result.test.mjs`
Expected: `ALL PASS`

Note: the test asserts `component.render(80)` returns `[]` for empty body — with no warnings and no timing that holds, because the `if (text)` block is skipped.

- [ ] **Step 5: Break it on purpose**

Change `PREVIEW_LINES` to `4`, re-run, and confirm both the collapsed-line-count assertion and the pinning assertion fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add delta/bash-result.ts tests/delta/bash-result.test.mjs
git commit -m "delta: fork pi's bash result rendering for diff commands"
```

---

### Task 10: `index.ts` — wiring, docs, and the manual smoke test

**Files:**
- Create: `delta/index.ts`
- Create: `delta/README.md`
- Modify: `README.md` (extension table, layout tree)
- Test: `tests/delta/delta.test.mjs`

**Interfaces:**
- Consumes: every module from Tasks 1–9.
- Produces: the extension factory, `export default function deltaExtension(pi: ExtensionAPI): void`

- [ ] **Step 1: Write the failing test**

Create `tests/delta/delta.test.mjs`:

```javascript
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
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("delta/index.ts")).default;

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
	ok("two contexts were minted", h.contexts.length === 2);
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tests/delta/delta.test.mjs`
Expected: failure — `delta/index.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `delta/index.ts`:

```typescript
/**
 * Delta-rendered diffs for pi.
 *
 * Wraps two built-in tools for *rendering only*: `execute`, `parameters`, and
 * prompt metadata are the built-in definition's, spread through untouched, so
 * the model sees no difference and result shapes are unchanged. What changes is
 * the component pi paints.
 *
 * Why a wrapper at all: pi resolves each render slot as
 * `extensionDefinition.renderX ?? builtInDefinition.renderX`, and there is no
 * renderer-only registration API. Registering a tool named `bash` is the only
 * way to reach that slot — which means an extension that routes bash somewhere
 * else (containers, SSH) must not be combined with this one. `enabled: false` in
 * `delta.json` is the escape hatch.
 *
 * `write` is not wrapped: it has no diff. Its `execute` returns
 * `details: undefined` and its result renders only errors.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	renderDiff,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { createBashResult } from "./bash-result.ts";
import { createDiffBody } from "./body.ts";
import { createCache } from "./cache.ts";
import { configVersion, DEFAULT_CONFIG, type DeltaConfig, loadConfig } from "./config.ts";
import { compilePatterns, isDiffCommand } from "./detect.ts";
import { createEngine } from "./engine.ts";
import { bashWarnings, splitBashFooter } from "./footer.ts";
import { createRunner } from "./run.ts";

/** Minimal shape of the theme pi hands a renderer. */
interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Minimal shape of the render context pi hands a renderer. */
interface RenderContext {
	args: Record<string, unknown> | undefined;
	cwd: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	isError: boolean;
	lastComponent: unknown;
	executionStarted: boolean;
}

export default function deltaExtension(pi: ExtensionAPI): void {
	let config: DeltaConfig = { ...DEFAULT_CONFIG };
	let version = configVersion(DEFAULT_CONFIG);
	let patterns: RegExp[] = [];
	/** The live session, for the one notice this extension can emit. */
	let session: ExtensionContext | undefined;

	const cache = createCache();
	const runner = createRunner({ config: () => config });
	const engine = createEngine({
		cache,
		runner,
		config: () => config,
		version: () => version,
		onUnavailable: () => {
			const ctx = session;
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.notify(
					`delta: ${config.command} is not on PATH; using pi's built-in diff rendering.`,
					"warning",
				);
			} catch {
				// The session was replaced between scheduling and this callback.
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Everything below is per-session: a resumed or forked session re-fires
		// this against a different transcript and must not inherit state.
		session = ctx;
		engine.reset();

		const loaded = await loadConfig({ projectRoot: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		config = loaded.config;
		version = loaded.version;

		const warnings = [...loaded.warnings];
		patterns = compilePatterns(config.extraCommands, warnings);
		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(`delta: ${warning}`, "warning");
			else if (ctx.mode === "print") process.stdout.write(`delta: ${warning}\n`);
		}
	});

	pi.on("session_shutdown", () => {
		session = undefined;
	});

	// ---- bash: our own result component, for diff commands only ------------

	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...bash,
		renderResult(result, options, theme, context) {
			const command = String((context.args as { command?: unknown } | undefined)?.command ?? "");
			// Errors keep pi's rendering: the text is a message, not a diff.
			if (context.isError || !isDiffCommand(command, patterns)) {
				return bash.renderResult!(result, options, theme, context);
			}

			const state = context.state as { startedAt?: number; endedAt?: number };
			if (!options.isPartial) state.endedAt ??= Date.now();

			const details = result.details as Parameters<typeof bashWarnings>[0];
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n")
				.trim();
			const { body } = splitBashFooter(text, details);

			const component =
				(context.lastComponent as ReturnType<typeof createBashResult> | undefined) ??
				createBashResult({
					engine,
					theme,
					fallback: (value) =>
						value
							.split("\n")
							.map((line) => theme.fg("toolOutput", line))
							.join("\n"),
					invalidate: context.invalidate,
					truncate: (value, maxLines, width) => truncateToVisualLines(value, maxLines, width),
					// Same wording as pi's own hint (bash.js), minus its width clamp:
					// the hint is short enough that truncating it never applies.
					expandHint: (skipped) =>
						`${theme.fg("muted", `... (${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				});

			component.update({
				body,
				warnings: bashWarnings(details),
				expanded: options.expanded,
				timing:
					state.startedAt === undefined
						? undefined
						: {
								label: options.isPartial ? "Elapsed" : "Took",
								ms: (state.endedAt ?? Date.now()) - state.startedAt,
							},
			});
			return component;
		},
	});

	// ---- edit: header while pending, delta diff once settled ---------------

	const edit = createEditToolDefinition(process.cwd());

	/** `edit <path>`, in pi's colours. */
	const header = (args: Record<string, unknown> | undefined, theme: RenderTheme, cwd: string): string => {
		const raw = String(args?.path ?? args?.file_path ?? "");
		const display = raw.startsWith(`${cwd}/`) ? raw.slice(cwd.length + 1) : raw || "...";
		return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", display)}`;
	};

	interface EditComponent {
		render(width: number): string[];
		invalidate(): void;
		head: string;
		body: ReturnType<typeof createDiffBody>;
		/** Set once the result lands, so a later renderCall cannot wipe the diff. */
		settled: boolean;
		error?: string;
	}

	const editComponent = (context: RenderContext, theme: RenderTheme): EditComponent => {
		const existing = context.lastComponent as EditComponent | undefined;
		if (existing) return existing;
		const body = createDiffBody({
			engine,
			fallback: (diff) => renderDiff(diff),
			invalidate: context.invalidate,
		});
		const component: EditComponent = {
			head: "",
			body,
			settled: false,
			invalidate() {},
			render(width: number): string[] {
				if (component.error !== undefined) {
					return [component.head, "", theme.fg("error", component.error)];
				}
				return [component.head, ...body.render(width)];
			},
		};
		return component;
	};

	pi.registerTool({
		...edit,
		// No preview: computing one means forking pi's unexported computeEditsDiff,
		// and it would only be visible for the moment between the arguments
		// finishing and the edit landing.
		renderCall(args, theme, context) {
			const component = editComponent(context as unknown as RenderContext, theme);
			component.head = header(args as Record<string, unknown>, theme, context.cwd);
			// pi re-renders the call slot while arguments stream, and can render it
			// again after the result. Clearing unconditionally would blank a settled
			// diff, so the flag is what keeps the applied diff on screen.
			if (!component.settled) component.body.set(undefined, undefined);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const component = editComponent(context as unknown as RenderContext, theme);
			component.head = header(context.args as Record<string, unknown>, theme, context.cwd);
			component.settled = true;
			if (context.isError) {
				component.error = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n");
				component.body.set(undefined, undefined);
				return component;
			}
			const details = result.details as { diff?: string; patch?: string } | undefined;
			component.error = undefined;
			component.body.set(details?.patch, details?.diff);
			return component;
		},
	});
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `node tests/delta/delta.test.mjs`
Expected: `ALL PASS`

Fix real problems the test surfaces rather than loosening it. Three are likely:

1. The exact `keyHint` id — confirm `app.tools.expand` against `core/tools/bash.js`.
2. Render-slot typing. `bash`/`edit` definitions are generic over their `details`
   type, so an object literal spread may not accept a hand-written slot. If `tsc`
   objects, name the slot type instead of restating it:
   ```typescript
   type BashSlots = typeof bash;
   const renderResult: NonNullable<BashSlots["renderResult"]> = (result, options, theme, context) => { /* ... */ };
   pi.registerTool({ ...bash, renderResult });
   ```
3. Duck-typed components must satisfy pi-tui's `Component`, which requires both
   `render(width)` and `invalidate()`. Omitting `invalidate` typechecks in some
   positions and crashes at theme-change time; every component here defines it.

- [ ] **Step 5: Run the whole suite and the typechecker**

```bash
node tests/run-all.mjs delta
npm run check
```

Expected: every `tests/delta/*.test.mjs` passes and `tsc --strict` is clean.

- [ ] **Step 6: Manual smoke test — the only thing that proves the feature works**

Nothing above renders to a real terminal. In a shell:

```bash
pi
```

Then, inside pi, verify each of these:

1. Ask it to run `git diff` on a repo with changes → the diff is syntax-highlighted in delta's style, respecting your `[delta]` git config (line numbers, Dracula).
2. Press the expand key on that result → the full diff, still delta-styled.
3. Ask it to run `git diff --stat` → plain pi rendering, no delta.
4. Ask it to run `echo hello` → unchanged, with its `Took 0.0s` line.
5. Ask it to edit a file → the settled diff is delta-styled; the header reads `edit <path>`.
6. Resize the terminal → diffs re-layout to the new width.
7. `PATH= pi` (or set `command` to a nonexistent binary in `~/.pi/agent/delta.json`) → one warning, and pi's built-in diffs everywhere.
8. Check that no startup warning about overriding built-in tools appears; if one does, note it in the README as expected noise.

Record anything that differs from pi's stock rendering beyond the diff colours; that is the acceptance criterion for this task.

- [ ] **Step 7: Write `delta/README.md`**

```markdown
# delta

Renders diffs with [delta](https://github.com/dandavison/delta) instead of pi's
built-in diff styling:

- `bash` results whose command produces a diff (`git diff`, `git show`,
  `git log -p`, `git stash show -p`, `diff -u`, plus anything you add through
  `extraCommands`)
- the diff pi paints when the `edit` tool applies a change

Display only: the model still receives the plain unified diff, so this costs no
tokens and cannot confuse it with escape codes.

Delta reads its own settings from the `[delta]` section of your git config, so
diffs in pi look like diffs in your pager. This extension only forces
`--paging never` and the width.

## Requirements

`delta` on `PATH`. Without it you get pi's built-in rendering and one warning per
session.

## Config

`~/.pi/agent/delta.json`, or `<project>/.pi/delta.json` in a trusted project:

```json
{
  "enabled": true,
  "command": "delta",
  "args": [],
  "timeoutMs": 2000,
  "maxBytes": 262144,
  "extraCommands": ["^jj\\s+diff"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `command` | `"delta"` | Binary to run |
| `args` | `[]` | Extra delta flags, appended last so they win over git config |
| `timeoutMs` | `2000` | Per-invocation timeout |
| `maxBytes` | `262144` | Diffs larger than this skip delta |
| `extraCommands` | `[]` | Regexes added to the bash command matcher |

## How it works, and what that costs

Pi has no renderer-only extension point, so this registers tools named `bash` and
`edit` that spread pi's built-in definitions and replace only the render slots.
Execution, schemas, and prompt metadata are pi's, untouched.

Two consequences worth knowing:

- **Do not combine it with an extension that routes `bash` elsewhere** (a
  container or SSH router). Both register the same name and the last one wins.
  Set `enabled: false`, or don't load this extension, in that setup.
- **`edit` shows no pending preview.** Pi computes that preview with an
  unexported helper; reproducing it would be a fork that breaks on upgrades. You
  see `edit <path>` while the edit is in flight and the delta diff once it lands.

Delta runs asynchronously, so a diff appears in pi's own styling for one frame
before delta's rendering replaces it. Results are cached per diff, width, and
config; a resize re-renders at the new width.

`write` is not touched: it has no diff to render.
```

- [ ] **Step 8: Add the extension to the root README**

In `README.md`, add to the extension table, keeping alphabetical order (before `mcp`):

```markdown
| [`delta`](delta/README.md) | Renders `git diff` output and `edit` diffs with the delta pager instead of pi's built-in diff styling. |
```

And add to the layout tree after the `lib/` block:

```
├── delta/              an extension (loaded via delta/index.ts)
│   ├── index.ts
│   ├── ansi.ts
│   ├── bash-result.ts
│   ├── body.ts
│   ├── cache.ts
│   ├── config.ts
│   ├── detect.ts
│   ├── engine.ts
│   ├── footer.ts
│   └── README.md
```

- [ ] **Step 9: Final verification**

```bash
npm run check
```

Expected: typecheck clean, every test file passing.

- [ ] **Step 10: Commit**

```bash
git add delta/index.ts delta/README.md README.md tests/delta/delta.test.mjs
git commit -m "delta: wire the extension and document it"
```

---

## Self-review notes

Spec coverage check, section by section:

| Spec section | Task |
|---|---|
| Bash forked result component | 9, 10 |
| Edit header + settled delta diff (E1) | 10 |
| Cache and invalidate lifecycle | 4, 7 |
| Negative entries, in-flight de-dup | 4, 7 |
| Width from `render(width)` | 8, 9 |
| Failure and absence, warn once | 6, 7, 10 |
| Stale-ctx safety | 7, 10 |
| Oversized diffs skip delta | 7 |
| Config incl. project trust | 5 |
| Command matching + `extraCommands` | 2 |
| Delta ANSI sanitizing | 1 |
| Footer split, warning line | 3 |
| Pinned pi constants | 9 |
| Documentation | 10 |

Two things this plan cannot verify automatically, both handled in Task 10 Step 6: that delta's escapes survive pi's real frame, and that no override warning appears at startup. Both are cheap to check by eye and expensive to fake.
