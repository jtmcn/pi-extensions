# Startup Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pi's bland startup screen with a `dashboard` extension that renders a mascot, location, graphite stack, size-annotated skills grouped by source, and MCP server health.

**Architecture:** A new `dashboard` extension registers a custom header via `ctx.ui.setHeader()`. It derives skills, context files and prompts from data pi already hands extensions (`ctx.getSystemPrompt()`, `ctx.getCommands()`), and renders extension-contributed panels published through a new `lib/panels.ts` registry. `mcp` and `worktree` publish their own panels because only they know server health and stack position.

**Tech Stack:** TypeScript loaded through jiti (no build step), pi extension API, `node:fs/promises`, Node's test files as plain `.mjs` scripts driven by `tests/run-all.mjs`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-09-startup-dashboard-design.md`. Read it before Task 1.
- **`noUnusedLocals` and `noUnusedParameters` are on** (`typecheck.sh`). An
  unused import or constant fails the build. Prefix intentionally unused
  parameters with `_`.
- **`Component` is not exported from pi's package entry.** Declare component
  shapes inline. `VERSION`, `Theme`, `ExtensionAPI` and `ExtensionContext` are
  exported.
- **No build step.** Extensions are TypeScript loaded by jiti. Never add a bundler.
- **`npm run check` must pass** (typecheck + all tests) before every commit.
- **Typecheck resolves pi from the global install.** `typecheck.sh` is the only thing catching type errors.
- **Tabs, not spaces.** Every file in this repo is tab-indented. Match it.
- **Reset all session state in `session_start`.** Extension closures outlive their session.
- **Never touch a captured `ctx` from an async callback that can outlive the turn.** Header components close over `tui`, never `ctx`.
- **Guard UI on `ctx.mode === "tui"`** for `setHeader`; it is a no-op elsewhere and must not be called.
- **Warn, don't throw, on bad input.** Malformed system prompts, missing files and absent `gt` must degrade to a rendered line.
- **Break every new test on purpose before trusting it.** Mutate the code under test; if the test still passes, it is decoration.
- **Token estimate is `Math.round(bytes / 4)`** everywhere.
- **Bar glyphs are `▁▂▃▄▅▆▇█`**, scaled relative to the largest skill.
- **Column counts: 3 at width ≥ 120, 2 at ≥ 90, 1 below.**

## File Structure

| File | Responsibility |
|---|---|
| `lib/panels.ts` | Cross-extension panel registry. State on `globalThis`. |
| `dashboard/skills.ts` | Parse `<available_skills>` and `<project_instructions>` out of a system prompt. Derive a skill's scope from its path. |
| `dashboard/sizes.ts` | `fs.stat` skills, convert bytes to tokens, pick bar glyphs. |
| `dashboard/layout.ts` | Lay out cells into width-safe columns. Plain strings only — no ANSI. |
| `dashboard/mascot.ts` | The block-glyph pi logo. |
| `dashboard/render.ts` | Compose model + theme + width into collapsed and expanded line arrays. |
| `dashboard/index.ts` | Wiring: `session_start` → build model → `setHeader`; `/dashboard setup`. |
| `dashboard/README.md` | Extension docs. |
| `mcp/panel.ts` | Build and publish the MCP panel. |
| `worktree/panel.ts` | Build and publish location, dirty state and graphite stack. |
| `lib/git.ts` | Gains `aheadBehind()`. |
| `tests/fake-pi.mjs` | Gains `setHeader`, `getSystemPrompt`, `getCommands` on the fake ctx. |

**Why layout returns structured cells, not strings:** theme colors are invisible ANSI escapes that destroy width arithmetic. `layout.ts` works entirely in plain text and returns padded cells; `render.ts` applies color afterwards. Any design that colors first cannot guarantee "no line exceeds the width".

---

### Task 1: Panel registry

**Files:**
- Create: `lib/panels.ts`
- Test: `tests/dashboard/panels.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
```typescript
export interface Panel {
	id: string;
	owner: string;
	title: string;
	order: number;
	render(width: number): string[];
}
export function registerPanel(panel: Panel): void;
export function updatePanel(id: string): void;
export function resetPanels(owner: string): void;
export function listPanels(): Panel[];
export function subscribe(listener: () => void): () => void;
```

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/panels.test.mjs`:

```javascript
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const panels = await loadExt("lib/panels.ts");

const panel = (id, owner, order) => ({
	id,
	owner,
	title: id.toUpperCase(),
	order,
	render: () => [`${id} line`],
});

// Ordering
panels.resetPanels("a");
panels.resetPanels("b");
panels.registerPanel(panel("second", "a", 20));
panels.registerPanel(panel("first", "b", 10));
ok(
	"listPanels sorts by order",
	panels.listPanels().map((p) => p.id).join(",") === "first,second",
);

// resetPanels is scoped to one owner
panels.resetPanels("a");
ok(
	"resetPanels drops only that owner",
	panels.listPanels().map((p) => p.id).join(",") === "first",
);

// Re-registering the same id replaces rather than duplicates
panels.registerPanel(panel("first", "b", 10));
ok("re-register replaces", panels.listPanels().length === 1);

// Subscribers
let calls = 0;
const unsubscribe = panels.subscribe(() => calls++);
panels.updatePanel("first");
ok("updatePanel notifies", calls === 1);
panels.registerPanel(panel("third", "b", 30));
ok("registerPanel notifies", calls === 2);
panels.resetPanels("b");
ok("resetPanels notifies", calls === 3);
unsubscribe();
panels.updatePanel("first");
ok("unsubscribe stops notification", calls === 3);

// A throwing subscriber must not break the others
panels.resetPanels("b");
let reached = false;
const un1 = panels.subscribe(() => {
	throw new Error("boom");
});
const un2 = panels.subscribe(() => {
	reached = true;
});
panels.registerPanel(panel("x", "b", 1));
ok("a throwing subscriber does not stop the rest", reached);
un1();
un2();

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/panels.test.mjs`
Expected: FAIL — cannot resolve `lib/panels.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/panels.ts`:

```typescript
/**
 * A registry of panels the dashboard renders.
 *
 * The dashboard cannot know what a graphite stack is or whether an MCP server
 * connected — the extensions that own that knowledge push it here instead.
 *
 * State hangs off `globalThis` rather than module scope. Extensions are
 * separate top-level modules loaded by pi, and nothing promises they share a
 * module instance; a well-known symbol is true regardless.
 */

export interface Panel {
	/** Unique across all extensions. Re-registering an id replaces it. */
	id: string;
	/** The extension that owns it, so `resetPanels` can scope to one. */
	owner: string;
	/** Section heading, rendered as `[title]`. */
	title: string;
	/** Ascending. Ties break on id. */
	order: number;
	render(width: number): string[];
}

interface Registry {
	panels: Map<string, Panel>;
	listeners: Set<() => void>;
}

const KEY = Symbol.for("pi-extensions.panels");

function registry(): Registry {
	// Double cast: `globalThis` and an index signature do not overlap, so the
	// single-step version is an error rather than a widening.
	const host = globalThis as unknown as Record<symbol, unknown>;
	if (!host[KEY]) host[KEY] = { panels: new Map(), listeners: new Set() } satisfies Registry;
	return host[KEY] as Registry;
}

function notify(): void {
	for (const listener of registry().listeners) {
		// One extension's broken listener must not stop the others from painting.
		try {
			listener();
		} catch {}
	}
}

export function registerPanel(panel: Panel): void {
	registry().panels.set(panel.id, panel);
	notify();
}

/** Announce that a panel's `render` would now return something different. */
export function updatePanel(id: string): void {
	if (!registry().panels.has(id)) return;
	notify();
}

/**
 * Drop every panel one extension registered.
 *
 * Scoped to an owner because `session_start` fires once per extension, and the
 * first to run must not wipe panels the others already registered.
 */
export function resetPanels(owner: string): void {
	const { panels } = registry();
	for (const [id, panel] of panels) {
		if (panel.owner === owner) panels.delete(id);
	}
	notify();
}

export function listPanels(): Panel[] {
	return [...registry().panels.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
	const { listeners } = registry();
	listeners.add(listener);
	return () => listeners.delete(listener);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/dashboard/panels.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 5: Break it on purpose**

Change `resetPanels` to delete every panel regardless of owner (`panels.clear()`). Re-run: `resetPanels drops only that owner` must FAIL. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add lib/panels.ts tests/dashboard/panels.test.mjs
git commit -m "lib: add a cross-extension panel registry"
```

---

### Task 2: Parse skills and context files from the system prompt

**Files:**
- Create: `dashboard/skills.ts`
- Test: `tests/dashboard/skills.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
```typescript
export interface ParsedSkill {
	name: string;
	description: string;
	location: string;
}
export interface SkillsBlock {
	/** Whether the prompt contained an <available_skills> block at all. */
	present: boolean;
	skills: ParsedSkill[];
}
export function parseSkills(systemPrompt: string): SkillsBlock;
export function parseContextFiles(systemPrompt: string): string[];
export function skillScope(location: string): string;
```

**Note on `skillScope`:** the spec's mockup shows `pi-subagents@0.38.0`. This
returns `pi-subagents` with no version — the version costs a `package.json`
read per scope for a string nobody acts on. Update the spec mockup to match.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/skills.test.mjs`. The first block is the load-bearing one: it round-trips through **pi's own formatter**, so a pi upgrade that changes the format fails the suite instead of silently emptying the panel.

```javascript
import { assertions, loadExt, piEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { parseSkills, parseContextFiles, skillScope } = await loadExt("dashboard/skills.ts");
const { formatSkillsForPrompt } = await import(await piEntry());

// --- Round-trip against pi's own formatter ---
const fixtures = [
	{
		name: "brainstorming",
		description: "Explores user intent & requirements <before> \"work\"",
		filePath: "/Users/x/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md",
		disableModelInvocation: false,
	},
	{
		name: "coordinator",
		description: "Orchestrate multiple worktree agents.",
		filePath: "/Users/x/.pi/agent/skills/coordinator/SKILL.md",
		disableModelInvocation: false,
	},
];
const prompt = `You are pi.${formatSkillsForPrompt(fixtures)}\n\nMore prompt.`;
const parsed = parseSkills(prompt);

ok("round-trip: block detected", parsed.present);
ok("round-trip: every skill recovered", parsed.skills.length === 2);
ok("round-trip: names", parsed.skills.map((s) => s.name).join(",") === "brainstorming,coordinator");
ok(
	"round-trip: XML entities decoded",
	parsed.skills[0].description === 'Explores user intent & requirements <before> "work"',
);
ok("round-trip: locations", parsed.skills[1].location === fixtures[1].filePath);

// --- Degradation ---
ok("no block: not present", parseSkills("plain prompt").present === false);
ok("no block: no skills", parseSkills("plain prompt").skills.length === 0);
const truncated = "<available_skills>\n  <skill>\n    <name>half</name>";
ok("malformed block: present", parseSkills(truncated).present === true);
ok("malformed block: yields nothing", parseSkills(truncated).skills.length === 0);

// --- Scope derivation ---
const scopes = [
	["/Users/x/.pi/agent/git/github.com/obra/superpowers/skills/a/SKILL.md", "superpowers"],
	["/Users/x/.pi/agent/npm/node_modules/pi-subagents/skills/a/SKILL.md", "pi-subagents"],
	["/Users/x/.pi/agent/npm/node_modules/@scope/pkg/skills/a/SKILL.md", "@scope/pkg"],
	["/Users/x/.pi/agent/skills/a/SKILL.md", "personal"],
	["/Users/x/Code/proj/.pi/skills/a/SKILL.md", "project"],
];
for (const [path, expected] of scopes) {
	ok(`scope: ${expected}`, skillScope(path) === expected, `got ${skillScope(path)}`);
}

// --- Context files ---
const withContext = `
<project_context>
<project_instructions path="/Users/x/Code/proj/AGENTS.md">
# Working here
</project_instructions>
<project_instructions path="/Users/x/Code/proj/CLAUDE.md">
more
</project_instructions>
</project_context>`;
const files = parseContextFiles(withContext);
ok("context: both files", files.length === 2);
ok("context: first path", files[0] === "/Users/x/Code/proj/AGENTS.md");
ok("context: none when absent", parseContextFiles("nothing here").length === 0);

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/skills.test.mjs`
Expected: FAIL — cannot resolve `dashboard/skills.ts`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/skills.ts`:

```typescript
/**
 * Recover the loaded skills and context files from the system prompt.
 *
 * `ExtensionContext` exposes no resource loader, so what pi lists in its own
 * startup sections is not directly available. The system prompt is the only
 * route — and it carries descriptions and absolute paths, which is more than
 * the built-in listing shows.
 *
 * This parses a format pi never promised. `tests/dashboard/skills.test.mjs`
 * round-trips through pi's exported `formatSkillsForPrompt` so a format change
 * fails the suite rather than silently emptying the panel.
 */

export interface ParsedSkill {
	name: string;
	description: string;
	location: string;
}

export interface SkillsBlock {
	/** Whether the prompt contained an `<available_skills>` block at all. */
	present: boolean;
	skills: ParsedSkill[];
}

const SKILL_BLOCK = /<available_skills>([\s\S]*?)<\/available_skills>/;
const SKILL_ENTRY = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
const CONTEXT_PATH = /<project_instructions\s+path="([^"]*)"/g;

/** Inverse of pi's `escapeXml`. Order matters: `&amp;` must go last. */
function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export function parseSkills(systemPrompt: string): SkillsBlock {
	const block = SKILL_BLOCK.exec(systemPrompt);
	// An unterminated block still means pi tried: report present so the caller
	// can say "unavailable" rather than "no skills".
	const present = block !== null || systemPrompt.includes("<available_skills>");
	if (!block) return { present, skills: [] };

	const skills: ParsedSkill[] = [];
	SKILL_ENTRY.lastIndex = 0;
	for (const match of block[1].matchAll(SKILL_ENTRY)) {
		skills.push({
			name: unescapeXml(match[1].trim()),
			description: unescapeXml(match[2].trim()),
			location: unescapeXml(match[3].trim()),
		});
	}
	return { present, skills };
}

export function parseContextFiles(systemPrompt: string): string[] {
	const paths: string[] = [];
	CONTEXT_PATH.lastIndex = 0;
	for (const match of systemPrompt.matchAll(CONTEXT_PATH)) {
		if (match[1]) paths.push(match[1]);
	}
	return paths;
}

/**
 * Group label for a skill, derived from where it lives.
 *
 * Package installs are checked before git checkouts because a package can be
 * vendored inside one.
 */
export function skillScope(location: string): string {
	const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(location);
	if (pkg) return pkg[1];

	const git = /\/git\/[^/]+\/[^/]+\/([^/]+)\//.exec(location);
	if (git) return git[1];

	if (location.includes("/agent/skills/")) return "personal";
	return "project";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/dashboard/skills.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 5: Break it on purpose**

Delete the `.replace(/&amp;/g, "&")` line from `unescapeXml`. Re-run: `round-trip: XML entities decoded` must FAIL. Revert.

- [ ] **Step 6: Update the spec mockup**

In `docs/superpowers/specs/2026-08-09-startup-dashboard-design.md`, change `pi-subagents@0.38.0 (1)` to `pi-subagents (1)`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add dashboard/skills.ts tests/dashboard/skills.test.mjs docs/superpowers/specs/2026-08-09-startup-dashboard-design.md
git commit -m "dashboard: parse skills and context files from the system prompt"
```

---

### Task 3: Measure skills and pick bar glyphs

**Files:**
- Create: `dashboard/sizes.ts`
- Test: `tests/dashboard/sizes.test.mjs`

**Interfaces:**
- Consumes: `ParsedSkill` from `dashboard/skills.ts`.
- Produces:
```typescript
export interface SizedSkill extends ParsedSkill {
	/** undefined when the file could not be stat'd. */
	tokens: number | undefined;
}
export function measureSkills(skills: ParsedSkill[]): Promise<SizedSkill[]>;
export function barGlyph(tokens: number | undefined, max: number): string;
export function totalTokens(skills: SizedSkill[]): number;
export function formatTokens(tokens: number): string;
```

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/sizes.test.mjs`. Real files in a temp dir — stat is cheap and mocking it would test the mock.

```javascript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { measureSkills, barGlyph, totalTokens, formatTokens } = await loadExt("dashboard/sizes.ts");

const dir = await mkdtemp(join(tmpdir(), "dash-sizes-"));
const write = async (name, bytes) => {
	const path = join(dir, `${name}.md`);
	await writeFile(path, "x".repeat(bytes));
	return { name, description: "", location: path };
};

const big = await write("big", 28000);
const small = await write("small", 2400);
const missing = { name: "missing", description: "", location: join(dir, "nope.md") };

const sized = await measureSkills([big, small, missing]);
ok("measures bytes as tokens", sized[0].tokens === 7000);
ok("measures the small one", sized[1].tokens === 600);
ok("missing file yields undefined", sized[2].tokens === undefined);
ok("preserves order", sized.map((s) => s.name).join(",") === "big,small,missing");
ok("total ignores unmeasurable", totalTokens(sized) === 7600);

// Bars scale relative to max, never absolutely.
ok("largest is full", barGlyph(7000, 7000) === "█");
ok("smallest is not empty", barGlyph(600, 7000) === "▁");
ok("midpoint is mid-scale", barGlyph(3500, 7000) === "▄");
ok("unmeasurable renders blank", barGlyph(undefined, 7000) === " ");
ok("zero max does not divide by zero", barGlyph(0, 0) === " ");
ok("all bars are one column wide", [...Array(9).keys()].every((i) => barGlyph(i * 875, 7000).length === 1));

ok("formats sub-thousand", formatTokens(600) === "600");
ok("formats thousands", formatTokens(78000) === "78k");
ok("formats with one decimal", formatTokens(7600) === "7.6k");

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/sizes.test.mjs`
Expected: FAIL — cannot resolve `dashboard/sizes.ts`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/sizes.ts`:

```typescript
/**
 * What each skill costs to load.
 *
 * Size is SKILL.md alone, not the skill directory: `read`-ing the skill is what
 * you pay, and a 3 KB SKILL.md inside a 96 KB directory should not read as
 * expensive.
 */

import { stat } from "node:fs/promises";
import type { ParsedSkill } from "./skills.ts";

export interface SizedSkill extends ParsedSkill {
	/** undefined when the file could not be stat'd. */
	tokens: number | undefined;
}

/** Eight levels, so a bar is always exactly one column wide. */
const GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export async function measureSkills(skills: ParsedSkill[]): Promise<SizedSkill[]> {
	return Promise.all(
		skills.map(async (skill) => {
			try {
				const info = await stat(skill.location);
				return { ...skill, tokens: Math.round(info.size / 4) };
			} catch {
				// A skill listed in the prompt but gone from disk is odd, not fatal.
				return { ...skill, tokens: undefined };
			}
		}),
	);
}

/**
 * Relative to the largest skill, not to an absolute scale.
 *
 * Absolute scaling renders 30 of 35 skills as `▁` and tells you nothing.
 */
export function barGlyph(tokens: number | undefined, max: number): string {
	if (tokens === undefined || max <= 0) return " ";
	const level = Math.ceil((tokens / max) * GLYPHS.length);
	return GLYPHS[Math.min(GLYPHS.length - 1, Math.max(0, level - 1))];
}

export function totalTokens(skills: SizedSkill[]): number {
	return skills.reduce((sum, skill) => sum + (skill.tokens ?? 0), 0);
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const thousands = tokens / 1000;
	return thousands >= 10 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/dashboard/sizes.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 5: Break it on purpose**

Change `barGlyph` to scale against a constant (`const max = 10000`) instead of the argument. Re-run: `largest is full` must FAIL. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add dashboard/sizes.ts tests/dashboard/sizes.test.mjs
git commit -m "dashboard: measure skill sizes and scale bars"
```

---

### Task 4: Width-safe column layout

**Files:**
- Create: `dashboard/layout.ts`
- Test: `tests/dashboard/layout.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
```typescript
export interface Cell {
	label: string;
	bar: string;
}
export interface LaidOutCell {
	/** Padded and truncated to the column width. */
	label: string;
	bar: string;
}
export function columnCount(width: number): number;
export function layoutRows(cells: Cell[], width: number, indent: number): LaidOutCell[][];
export function truncate(value: string, max: number): string;
```

**Why this returns cells rather than strings:** `render.ts` colors the label and
the bar differently. Colors are invisible ANSI escapes; if layout emitted
colored strings, no later step could compute a true width. Layout stays plain,
color comes after.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/layout.test.mjs`:

```javascript
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { columnCount, layoutRows, truncate } = await loadExt("dashboard/layout.ts");

ok("three columns when wide", columnCount(120) === 3);
ok("three columns when wider", columnCount(200) === 3);
ok("two columns at 90", columnCount(90) === 2);
ok("two columns at 119", columnCount(119) === 2);
ok("one column below 90", columnCount(60) === 1);
ok("one column when absurdly narrow", columnCount(10) === 1);

ok("truncate leaves short values alone", truncate("abc", 10) === "abc");
ok("truncate marks elision", truncate("abcdefghij", 5) === "abcd…");
ok("truncate respects the max exactly", truncate("abcdefghij", 5).length === 5);
ok("truncate handles max of 1", truncate("abcdefghij", 1).length === 1);

const cells = [...Array(7).keys()].map((i) => ({ label: `skill-number-${i}`, bar: "▄" }));

const wide = layoutRows(cells, 120, 4);
ok("wide: three per row", wide[0].length === 3);
ok("wide: every cell placed", wide.flat().length === 7);
ok("wide: last row is short", wide.at(-1).length === 1);
ok("wide: reading order is left to right", wide[0][1].label.startsWith("skill-number-1"));

const narrow = layoutRows(cells, 60, 4);
ok("narrow: one per row", narrow.every((row) => row.length === 1));

// The invariant the old screen violated.
for (const [label, width] of [["120", 120], ["90", 90], ["60", 60], ["40", 40]]) {
	const rows = layoutRows(cells, width, 4);
	const longest = Math.max(
		...rows.map((row) => " ".repeat(4) + row.map((c) => `${c.label} ${c.bar}`).join("  ")).map((line) => line.length),
	);
	ok(`no line exceeds width ${label}`, longest <= width, `longest was ${longest}`);
}

// Long names must be truncated, not wrapped.
const long = [{ label: "a-very-long-skill-name-that-will-not-fit-anywhere", bar: "█" }];
const cramped = layoutRows(long, 40, 4);
ok("long names truncate", cramped[0][0].label.includes("…"));
ok("truncated line still fits", (" ".repeat(4) + `${cramped[0][0].label} ${cramped[0][0].bar}`).length <= 40);

ok("empty input yields no rows", layoutRows([], 120, 4).length === 0);

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/layout.test.mjs`
Expected: FAIL — cannot resolve `dashboard/layout.ts`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/layout.ts`:

```typescript
/**
 * Columns that never wrap.
 *
 * Pi's built-in skills listing is one comma-separated run that reflows across
 * five lines, which is exactly why it is unreadable. Everything here truncates
 * to fit instead.
 *
 * Plain strings only — no theme, no ANSI. Colors are zero-width escapes that
 * make width arithmetic lie, so `render.ts` applies them after layout.
 */

export interface Cell {
	label: string;
	bar: string;
}

export interface LaidOutCell {
	/** Padded and truncated to the column width. */
	label: string;
	bar: string;
}

/** Space between adjacent columns. */
const GUTTER = 2;
/** A label, a space, and a one-column bar. */
const BAR_SUFFIX = 2;

export function columnCount(width: number): number {
	if (width >= 120) return 3;
	if (width >= 90) return 2;
	return 1;
}

export function truncate(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "…";
	return `${value.slice(0, max - 1)}…`;
}

export function layoutRows(cells: Cell[], width: number, indent: number): LaidOutCell[][] {
	if (cells.length === 0) return [];

	const columns = columnCount(width);
	const available = width - indent - GUTTER * (columns - 1);
	// At least one character of label, however cramped the terminal.
	const labelWidth = Math.max(1, Math.floor(available / columns) - BAR_SUFFIX);

	const rows: LaidOutCell[][] = [];
	for (let i = 0; i < cells.length; i += columns) {
		const row = cells.slice(i, i + columns).map((cell) => ({
			label: truncate(cell.label, labelWidth).padEnd(labelWidth),
			bar: cell.bar,
		}));
		// The final cell of a row carries no trailing padding: a padded last
		// column pushes the line past `width` for no visible gain.
		const last = row[row.length - 1];
		if (last) last.label = last.label.trimEnd();
		rows.push(row);
	}
	return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/dashboard/layout.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 5: Break it on purpose**

Remove the `- GUTTER * (columns - 1)` term from `available`. Re-run: at least one `no line exceeds width` assertion must FAIL. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add dashboard/layout.ts tests/dashboard/layout.test.mjs
git commit -m "dashboard: lay skills out in width-safe columns"
```

---

### Task 5: Mascot and screen composition

**Files:**
- Create: `dashboard/mascot.ts`, `dashboard/render.ts`
- Test: `tests/dashboard/render.test.mjs`

**Interfaces:**
- Consumes: `SizedSkill`, `barGlyph`, `totalTokens`, `formatTokens`, `skillScope`, `layoutRows`, `Panel`.
- Produces:
```typescript
// mascot.ts
export interface MascotTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}
export function mascotLines(theme: MascotTheme, version: string): string[];

// render.ts
export interface DashboardModel {
	version: string;
	skills: SizedSkill[];
	/** false => the block was present but unparseable. */
	skillsAvailable: boolean;
	contextFiles: string[];
	prompts: string[];
	extensions: string[];
	panels: Panel[];
}
export interface Rendered {
	collapsed: string[];
	expanded: string[];
}
export function renderDashboard(model: DashboardModel, theme: MascotTheme, width: number): Rendered;
```

`MascotTheme` is the subset of pi's `Theme` this code uses. Depending on the
narrow shape keeps the render tests free of a pi import and makes the fake
theme two lines.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/render.test.mjs`:

```javascript
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { renderDashboard } = await loadExt("dashboard/render.ts");
const { mascotLines } = await loadExt("dashboard/mascot.ts");

/** Identity theme: colors are invisible in a terminal but not in an assertion. */
const theme = { fg: (_color, text) => text, bold: (text) => text };

const skill = (name, location, tokens) => ({ name, description: `does ${name}`, location, tokens });
const model = {
	version: "0.84.1",
	skillsAvailable: true,
	skills: [
		skill("brainstorming", "/u/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md", 2500),
		skill("writing-plans", "/u/.pi/agent/git/github.com/obra/superpowers/skills/writing-plans/SKILL.md", 1700),
		skill("coordinator", "/u/.pi/agent/skills/coordinator/SKILL.md", 1900),
	],
	contextFiles: ["/u/Code/proj/AGENTS.md"],
	prompts: ["/one", "/two", "/three"],
	extensions: ["worktree", "mcp"],
	panels: [
		{ id: "mcp", owner: "mcp", title: "MCP", order: 20, render: () => ["  linear ✓ 12"] },
	],
};

const out = renderDashboard(model, theme, 120);
const collapsed = out.collapsed.join("\n");
const expanded = out.expanded.join("\n");

ok("shows the version", collapsed.includes("0.84.1"));
ok("draws the mascot", collapsed.includes("█"));
ok("skills heading carries the count", /\[Skills\][^\n]*3/.test(collapsed));
ok("skills heading carries the total", /\[Skills\][^\n]*6\.1k/.test(collapsed));
ok("groups by scope", collapsed.includes("superpowers (2)") && collapsed.includes("personal (1)"));
ok("shows skill names", collapsed.includes("brainstorming"));
ok("shows a bar", /brainstorming\s+█/.test(collapsed));
ok("renders registered panels", collapsed.includes("[MCP]") && collapsed.includes("linear ✓ 12"));
ok("collapsed hides descriptions", !collapsed.includes("does brainstorming"));
ok("expanded shows descriptions", expanded.includes("does brainstorming"));
ok("collapsed elides prompts", /\[Prompts\][^\n]*\+1 more/.test(collapsed));
ok("expanded lists every prompt", expanded.includes("/three"));
ok("collapsed hides extensions", !collapsed.includes("[Extensions]"));
ok("expanded lists extensions", expanded.includes("[Extensions]") && expanded.includes("worktree"));
ok("shows context files", collapsed.includes("AGENTS.md"));

// Width invariant, with the identity theme so lengths are real.
for (const width of [120, 90, 60]) {
	const rendered = renderDashboard(model, theme, width);
	const longest = Math.max(...[...rendered.collapsed, ...rendered.expanded].map((l) => l.length));
	ok(`no rendered line exceeds ${width}`, longest <= width, `longest was ${longest}`);
}

// Degradation
const broken = renderDashboard({ ...model, skillsAvailable: false, skills: [] }, theme, 120);
ok("unparseable skills say so", broken.collapsed.join("\n").includes("unavailable"));
const empty = renderDashboard(
	{ version: "1", skills: [], skillsAvailable: true, contextFiles: [], prompts: [], extensions: [], panels: [] },
	theme,
	120,
);
ok("no skills omits the section", !empty.collapsed.join("\n").includes("[Skills]"));
ok("empty model still draws the mascot", empty.collapsed.join("\n").includes("█"));

// Panels render in order
const ordered = renderDashboard(
	{
		...model,
		panels: [
			{ id: "b", owner: "x", title: "BEE", order: 30, render: () => ["  bee"] },
			{ id: "a", owner: "x", title: "AY", order: 10, render: () => ["  ay"] },
		],
	},
	theme,
	120,
);
ok("panels render in order", ordered.collapsed.join("\n").indexOf("[AY]") < ordered.collapsed.join("\n").indexOf("[BEE]"));

ok("mascot is stable", mascotLines(theme, "1.2.3").join("\n").includes("1.2.3"));

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/render.test.mjs`
Expected: FAIL — cannot resolve `dashboard/render.ts`.

- [ ] **Step 3: Write the mascot**

Create `dashboard/mascot.ts`:

```typescript
/**
 * The pi mascot, drawn with block glyphs.
 *
 * Not an inline image: `pi-tui`'s `detectCapabilities()` picks an image
 * protocol from environment variables alone, and terminals outside its
 * allowlist (Tabby among them) degrade a real image to a text placeholder.
 * Block glyphs render everywhere.
 */

export interface MascotTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const BLOCK = "█";
const PUPIL = "▌";

export function mascotLines(theme: MascotTheme, version: string): string[] {
	const blue = (text: string) => theme.fg("accent", text);
	const eye = `${BLOCK}${theme.fg("dim", PUPIL)}`;
	const leg = `     ${blue(BLOCK.repeat(2))}    ${blue(BLOCK.repeat(2))}`;
	return [
		`     ${eye}  ${eye}`,
		`  ${blue(BLOCK.repeat(14))}`,
		leg,
		leg,
		leg,
		`  ${theme.bold(theme.fg("accent", "pi"))}${theme.fg("dim", ` v${version}`)}`,
	];
}
```

- [ ] **Step 4: Write the renderer**

Create `dashboard/render.ts`:

```typescript
/**
 * Compose the startup screen.
 *
 * Pure: a model, a theme and a width in, two arrays of lines out. Everything
 * that needs the filesystem, git or pi happens before this is called, so the
 * whole screen is testable without a session.
 */

import { layoutRows } from "./layout.ts";
import { type MascotTheme, mascotLines } from "./mascot.ts";
import type { Panel } from "../lib/panels.ts";
import { barGlyph, formatTokens, type SizedSkill, totalTokens } from "./sizes.ts";
import { skillScope } from "./skills.ts";

export type { MascotTheme };

export interface DashboardModel {
	version: string;
	skills: SizedSkill[];
	/** false when the prompt held a skills block this could not parse. */
	skillsAvailable: boolean;
	contextFiles: string[];
	prompts: string[];
	extensions: string[];
	panels: Panel[];
}

export interface Rendered {
	collapsed: string[];
	expanded: string[];
}

const INDENT = 4;
const PROMPT_PREVIEW = 2;

function heading(theme: MascotTheme, title: string, detail?: string): string {
	const label = theme.fg("mdHeading", `[${title}]`);
	return detail ? `${label}  ${theme.fg("dim", detail)}` : label;
}

/** Preserve first-seen order so scopes do not shuffle between sessions. */
function groupByScope(skills: SizedSkill[]): Map<string, SizedSkill[]> {
	const groups = new Map<string, SizedSkill[]>();
	for (const skill of skills) {
		const scope = skillScope(skill.location);
		const bucket = groups.get(scope);
		if (bucket) bucket.push(skill);
		else groups.set(scope, [skill]);
	}
	for (const bucket of groups.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
	return groups;
}

function renderSkills(model: DashboardModel, theme: MascotTheme, width: number, expanded: boolean): string[] {
	if (!model.skillsAvailable) {
		return [heading(theme, "Skills", "unavailable (pi format changed)")];
	}
	if (model.skills.length === 0) return [];

	const total = totalTokens(model.skills);
	const max = Math.max(...model.skills.map((s) => s.tokens ?? 0));
	const lines = [
		heading(theme, "Skills", `${model.skills.length} · ~${formatTokens(total)} tok if all read`),
	];

	for (const [scope, skills] of groupByScope(model.skills)) {
		lines.push(theme.fg("muted", `  ${scope} (${skills.length})`));
		if (expanded) {
			for (const skill of skills) {
				const bar = barGlyph(skill.tokens, max);
				lines.push(`${" ".repeat(INDENT)}${skill.name} ${theme.fg("accent", bar)}`);
				lines.push(theme.fg("dim", `${" ".repeat(INDENT + 2)}${skill.description}`.slice(0, width)));
			}
			continue;
		}
		const cells = skills.map((skill) => ({ label: skill.name, bar: barGlyph(skill.tokens, max) }));
		for (const row of layoutRows(cells, width, INDENT)) {
			const rendered = row.map((cell) => `${cell.label} ${theme.fg("accent", cell.bar)}`).join("  ");
			lines.push(`${" ".repeat(INDENT)}${rendered}`);
		}
	}
	return lines;
}

export function renderDashboard(model: DashboardModel, theme: MascotTheme, width: number): Rendered {
	const build = (expanded: boolean): string[] => {
		const lines = [...mascotLines(theme, model.version), ""];

		for (const panel of model.panels) {
			lines.push(heading(theme, panel.title));
			lines.push(...panel.render(width));
			lines.push("");
		}

		const skills = renderSkills(model, theme, width, expanded);
		if (skills.length > 0) lines.push(...skills, "");

		if (model.contextFiles.length > 0) {
			if (expanded) {
				lines.push(heading(theme, "Context"));
				for (const file of model.contextFiles) lines.push(theme.fg("dim", `  ${file}`));
			} else {
				lines.push(heading(theme, "Context", model.contextFiles.join(", ")));
			}
		}

		if (model.prompts.length > 0) {
			if (expanded) {
				lines.push(heading(theme, "Prompts"));
				for (const prompt of model.prompts) lines.push(theme.fg("dim", `  ${prompt}`));
			} else {
				const shown = model.prompts.slice(0, PROMPT_PREVIEW);
				const rest = model.prompts.length - shown.length;
				const summary = `${model.prompts.length} · ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
				lines.push(heading(theme, "Prompts", summary));
			}
		}

		// Extensions are four names you already know; only worth the room when
		// the screen is already expanded.
		if (expanded && model.extensions.length > 0) {
			lines.push(heading(theme, "Extensions"));
			lines.push(theme.fg("dim", `  ${model.extensions.join(", ")}`));
		}

		// Truncation here is the last line of defence: a panel is free to
		// return anything, and the header must never wrap.
		return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
	};

	return { collapsed: build(false), expanded: build(true) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/dashboard/render.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 6: Break it on purpose**

Delete the final `lines.map(...)` truncation in `renderDashboard` **and** widen `layoutRows`'s label width by 10. Re-run: a `no rendered line exceeds` assertion must FAIL. Revert both.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add dashboard/mascot.ts dashboard/render.ts tests/dashboard/render.test.mjs
git commit -m "dashboard: compose the startup screen"
```

---

### Task 6: Wire the extension

**Files:**
- Create: `dashboard/index.ts`
- Modify: `tests/fake-pi.mjs` (add `setHeader`, `getSystemPrompt`, `getCommands`)
- Test: `tests/dashboard/wiring.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: a default-exported extension factory. `dashboard/index.ts` exports nothing else.

- [ ] **Step 1: Extend the fake pi**

In `tests/fake-pi.mjs`, add two options to `createFakePi`'s destructured
parameter object, next to `entries`:

```javascript
	systemPrompt = "",
	commands: commandInfos = () => [],
```

Inside `makeCtx`, add to `own`: `headers: []`. Then add to the `ctx` object,
after `sessionManager`:

```javascript
			getSystemPrompt: () => systemPrompt,
			getCommands: () => commandInfos(),
```

and inside `ctx.ui`, after `notify`:

```javascript
				setHeader: (factory) => {
					own.headers.push(factory);
					headers.push(factory);
				},
```

Declare `const headers = [];` beside `const statuses = [];`, and add `headers`
to the returned object beside `statuses`. Finally add a helper to the returned
object, beside `status`:

```javascript
		/** Render the most recently set header at a given width. */
		header: (width = 120) => {
			const factory = headers.at(-1);
			if (!factory) return undefined;
			const theme = { fg: (_color, text) => text, bold: (text) => text };
			return factory({ requestRender() {}, invalidate() {} }, theme);
		},
```

- [ ] **Step 2: Write the failing test**

Create `tests/dashboard/wiring.test.mjs`:

```javascript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";
import { createFakePi } from "../fake-pi.mjs";

const { ok, done } = assertions();
const extension = (await loadExt("dashboard/index.ts")).default;
const panels = await loadExt("lib/panels.ts");

const dir = await mkdtemp(join(tmpdir(), "dash-wiring-"));
const skillPath = join(dir, "SKILL.md");
await writeFile(skillPath, "x".repeat(4000));

const systemPrompt = `You are pi.

<available_skills>
  <skill>
    <name>brainstorming</name>
    <description>explores intent</description>
    <location>${skillPath}</location>
  </skill>
</available_skills>

<project_context>
<project_instructions path="${join(dir, "AGENTS.md")}">
rules
</project_instructions>
</project_context>`;

const commands = () => [
	{ name: "worktree", source: "extension", sourceInfo: { path: "/x/worktree/index.ts", source: "worktree", scope: "user", origin: "top-level" } },
	{ name: "parallel-cleanup", source: "prompt", sourceInfo: { path: "/x/p.md", source: "user", scope: "user", origin: "top-level" } },
	{ name: "brainstorming", source: "skill", sourceInfo: { path: skillPath, source: "user", scope: "user", origin: "top-level" } },
];

const harness = (overrides = {}) =>
	createFakePi({ cwd: dir, mode: "tui", systemPrompt, commands, ...overrides });

// --- Renders in a TUI ---
{
	panels.resetPanels("dashboard");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const header = h.header(120);
	ok("sets a header", header !== undefined);
	const lines = header.render(120).join("\n");
	ok("renders skills", lines.includes("brainstorming"));
	ok("renders a bar", /brainstorming\s+[▁▂▃▄▅▆▇█]/.test(lines));
	ok("renders context", lines.includes("AGENTS.md"));
	ok("renders prompts", lines.includes("/parallel-cleanup"));
	ok("skill commands are not prompts", !lines.includes("/brainstorming"));
	ok("header is expandable", typeof header.setExpanded === "function");
	header.setExpanded(true);
	ok("expanded shows descriptions", header.render(120).join("\n").includes("explores intent"));
}

// --- Non-TUI modes never set a header ---
for (const mode of ["print", "json", "rpc"]) {
	const h = harness({ mode, hasUI: false });
	extension(h.pi);
	await h.fire("session_start");
	ok(`mode ${mode} sets no header`, h.headers.length === 0);
}

// --- A superseded session must not paint ---
{
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const first = h.contexts.at(-1);
	const paintsBefore = first.own.headers.length;
	await h.fire("session_start");
	await h.settle();
	ok("second session gets its own header", h.contexts.at(-1).own.headers.length === 1);
	ok("first session never paints again", first.own.headers.length === paintsBefore);
}

// --- Panel updates repaint without touching ctx ---
{
	panels.resetPanels("dashboard");
	panels.resetPanels("test");
	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	const header = h.header(120);
	ok("no panel yet", !header.render(120).join("\n").includes("[LATE]"));
	panels.registerPanel({
		id: "late",
		owner: "test",
		title: "LATE",
		order: 5,
		render: () => ["  arrived"],
	});
	ok("late panel appears", header.render(120).join("\n").includes("arrived"));
	header.dispose?.();
	panels.resetPanels("test");
}

// --- A skills block pi changed the shape of ---
{
	const h = harness({ systemPrompt: "<available_skills>\n<thing/>\n</available_skills>" });
	extension(h.pi);
	await h.fire("session_start");
	ok("unparseable block degrades", h.header(120).render(120).join("\n").includes("unavailable"));
}

done();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node tests/dashboard/wiring.test.mjs`
Expected: FAIL — cannot resolve `dashboard/index.ts`.

- [ ] **Step 4: Write the implementation**

Create `dashboard/index.ts`:

```typescript
/**
 * Startup dashboard for pi.
 *
 * Replaces pi's built-in startup header with a screen that says where you are,
 * what skills are loaded and what they cost, and whatever the other extensions
 * in this collection have to report.
 *
 * Requires `"quietStartup": true` in `~/.pi/agent/settings.json`, because pi's
 * own resource listing lives in a container `setHeader` cannot reach and only
 * that setting suppresses it. `/dashboard setup` writes it.
 *
 * This file is wiring only:
 *
 *   skills.ts   what pi loaded, recovered from the system prompt
 *   sizes.ts    what each skill costs to read
 *   layout.ts   columns that never wrap
 *   render.ts   the screen itself
 *   ../lib/panels.ts   what other extensions contribute
 *
 * The one rule to preserve: **the header component must never close over
 * `ctx`.** Panels update asynchronously, and a repaint that reached a
 * superseded context would throw "extension ctx is stale" and take pi down.
 * The component closes over `tui` and a module-level model instead.
 */

import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { listPanels, subscribe } from "../lib/panels.ts";
import { type DashboardModel, renderDashboard } from "./render.ts";
import { measureSkills } from "./sizes.ts";
import { parseContextFiles, parseSkills } from "./skills.ts";

export default function (pi: ExtensionAPI) {
	/**
	 * The current screen's data, replaced wholesale on every `session_start`.
	 *
	 * The header component reads this rather than capturing a model, so a
	 * repaint triggered by a late panel update always renders current data.
	 */
	let model: DashboardModel | undefined;

	pi.on("session_start", async (_event, ctx) => {
		model = undefined;
		if (ctx.mode !== "tui") return;

		const prompt = ctx.getSystemPrompt();
		const parsed = parseSkills(prompt);
		const commands = ctx.getCommands();

		model = {
			version: VERSION,
			skills: await measureSkills(parsed.skills),
			skillsAvailable: !parsed.present || parsed.skills.length > 0,
			contextFiles: parseContextFiles(prompt),
			prompts: commands.filter((c) => c.source === "prompt").map((c) => `/${c.name}`),
			extensions: [
				...new Set(
					commands
						.filter((c) => c.source === "extension")
						.map((c) => c.sourceInfo?.source || c.name),
				),
			].sort(),
			panels: [],
		};

		ctx.ui.setHeader((tui, theme) => {
			let expanded = false;
			// Repaint when a panel arrives or changes. `tui` outlives the turn
			// safely; `ctx` would not.
			const unsubscribe = subscribe(() => tui.requestRender());
			// Typed structurally rather than as pi's `Component`: that type comes
			// from pi-tui and is not re-exported from the package entry.
			const component: {
				render(width: number): string[];
				invalidate(): void;
				setExpanded(value: boolean): void;
				dispose(): void;
			} = {
				render(width: number): string[] {
					if (!model) return [];
					const rendered = renderDashboard({ ...model, panels: listPanels() }, theme, width);
					return expanded ? rendered.expanded : rendered.collapsed;
				},
				invalidate() {},
				setExpanded(value: boolean) {
					expanded = value;
				},
				dispose() {
					unsubscribe();
				},
			};
			return component;
		});
	});

	pi.on("session_shutdown", () => {
		model = undefined;
	});
}
```

**Two type notes, both of which will bite otherwise:**

1. The component is assigned to a typed `const` before being returned.
   Returning the object literal directly triggers TypeScript's excess property
   check against pi's declared `Component & { dispose?(): void }` return type,
   because `setExpanded` is not in it — pi detects that method structurally at
   runtime (`isExpandable`, interactive-mode.js:75).
2. `Component` itself is **not** exported from
   `@earendil-works/pi-coding-agent`; it is a pi-tui type. Declare the shape
   inline as above rather than importing it. `VERSION` and `Theme` *are*
   exported (`dist/index.d.ts:2` and `:29`), and `Theme` satisfies the
   `MascotTheme` shape structurally, so no cast is needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/dashboard/wiring.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 6: Break it on purpose**

Change the header factory to capture `const panelsAtStart = listPanels()` and
render those instead of calling `listPanels()` each time. Re-run: `late panel
appears` must FAIL. Revert.

Then remove the `if (ctx.mode !== "tui") return;` guard. Re-run: the three
`sets no header` assertions must FAIL. Revert.

- [ ] **Step 7: Typecheck, run everything, commit**

```bash
npm run check
git add dashboard/index.ts tests/fake-pi.mjs tests/dashboard/wiring.test.mjs
git commit -m "dashboard: wire the extension"
```

---

### Task 7: MCP panel

**Files:**
- Create: `mcp/panel.ts`
- Modify: `mcp/index.ts`
- Test: `tests/mcp/panel.test.mjs`

**Interfaces:**
- Consumes: `registerPanel`, `resetPanels` from `lib/panels.ts`. Not
  `updatePanel` — re-registering an id already notifies subscribers, and an
  unused import fails `noUnusedLocals`.
- Produces:
```typescript
export interface ServerStatus {
	name: string;
	state: "connecting" | "connected" | "failed" | "disabled";
	toolCount: number;
	/** Present when state is "failed". */
	detail?: string;
}
export function mcpPanelLines(servers: ServerStatus[], width: number): string[];
export function publishMcpPanel(servers: ServerStatus[]): void;
export function clearMcpPanel(): void;
```

**The four states mirror `mcp/index.ts`'s existing `ServerState.status`
(`"connecting" | "ready" | "failed" | "disabled"`) so the mapping is a rename,
not a translation.** `connecting` matters: servers connect in parallel without
blocking startup, so the dashboard paints before they have answered.

- [ ] **Step 1: Read the existing extension**

Read `mcp/index.ts` in full, paying attention to `ServerState` (line ~62), the
`session_start` handler, and the `generation` / `cycle` guard. The publish
calls hang off those.

- [ ] **Step 2: Write the failing test**

Create `tests/mcp/panel.test.mjs`:

```javascript
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { mcpPanelLines, publishMcpPanel, clearMcpPanel } = await loadExt("mcp/panel.ts");
const panels = await loadExt("lib/panels.ts");

const servers = [
	{ name: "linear", state: "connected", toolCount: 12 },
	{ name: "notion", state: "connected", toolCount: 12 },
	{ name: "databricks", state: "failed", toolCount: 0, detail: "spawn failed" },
	{ name: "old", state: "disabled", toolCount: 0 },
	{ name: "slow", state: "connecting", toolCount: 0 },
];

const lines = mcpPanelLines(servers, 120);
const text = lines.join("\n");
ok("shows connected servers", text.includes("linear"));
ok("shows tool counts", text.includes("12"));
ok("marks connected", text.includes("✓"));
ok("marks failed", text.includes("✗"));
ok("explains a failure", text.includes("spawn failed"));
ok("suggests the fix", text.includes("/mcp restart"));
ok("shows disabled servers", text.includes("old") && text.includes("disabled"));
ok("shows connecting servers", text.includes("slow") && text.includes("connecting"));
ok("only connected servers contribute tool counts", text.includes("24 tools"));
ok("header counts every server", text.includes("5 servers"));
ok("no line exceeds width", Math.max(...lines.map((l) => l.length)) <= 120);
ok("narrow width still fits", Math.max(...mcpPanelLines(servers, 60).map((l) => l.length)) <= 60);
ok("no servers yields no lines", mcpPanelLines([], 120).length === 0);

// Registry integration
panels.resetPanels("mcp");
publishMcpPanel(servers);
const registered = panels.listPanels().filter((p) => p.owner === "mcp");
ok("registers one panel", registered.length === 1);
ok("panel is titled MCP", registered[0].title === "MCP");
ok("panel renders the servers", registered[0].render(120).join("\n").includes("linear"));

publishMcpPanel([{ name: "linear", state: "connected", toolCount: 3 }]);
ok("republishing replaces rather than duplicates", panels.listPanels().filter((p) => p.owner === "mcp").length === 1);
ok("republishing shows new data", panels.listPanels().find((p) => p.owner === "mcp").render(120).join("\n").includes("3"));

clearMcpPanel();
ok("clear removes the panel", panels.listPanels().filter((p) => p.owner === "mcp").length === 0);

done();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node tests/mcp/panel.test.mjs`
Expected: FAIL — cannot resolve `mcp/panel.ts`.

- [ ] **Step 4: Write the implementation**

Create `mcp/panel.ts`:

```typescript
/**
 * What the dashboard shows for MCP.
 *
 * The dashboard could infer connected servers from tool names, but a server
 * that failed to spawn exposes no tools and would simply be missing. Only this
 * extension knows the difference between "not configured" and "died on
 * startup, run /mcp restart".
 */

import { registerPanel, resetPanels } from "../lib/panels.ts";

const OWNER = "mcp";
const PANEL_ID = "mcp";

export interface ServerStatus {
	name: string;
	state: "connected" | "failed" | "disabled";
	toolCount: number;
	/** Present when state is "failed". */
	detail?: string;
}

function describe(server: ServerStatus): string {
	if (server.state === "connected") return `✓ ${server.toolCount}`;
	if (server.state === "disabled") return "· disabled";
	if (server.state === "connecting") return "… connecting";
	return `✗ ${server.detail ?? "failed"} — /mcp restart`;
}

export function mcpPanelLines(servers: ServerStatus[], width: number): string[] {
	if (servers.length === 0) return [];

	const connected = servers.filter((s) => s.state === "connected");
	const tools = connected.reduce((sum, s) => sum + s.toolCount, 0);
	const nameWidth = Math.max(...servers.map((s) => s.name.length));

	const lines = [`  ${servers.length} servers · ${tools} tools`];
	for (const server of servers) {
		lines.push(`  ${server.name.padEnd(nameWidth)}  ${describe(server)}`);
	}
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

export function publishMcpPanel(servers: ServerStatus[]): void {
	registerPanel({
		id: PANEL_ID,
		owner: OWNER,
		title: "MCP",
		order: 20,
		render: (width) => mcpPanelLines(servers, width),
	});
}

export function clearMcpPanel(): void {
	resetPanels(OWNER);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/mcp/panel.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 6: Publish from the extension**

In `mcp/index.ts`, add the import beside the existing `./bridge.ts` one:

```typescript
import { clearMcpPanel, publishMcpPanel, type ServerStatus } from "./panel.ts";
```

Add this helper inside `mcpExtension`, next to `closeAll`:

```typescript
	/**
	 * Push current server state to the dashboard.
	 *
	 * Called from every point that changes it. Reaching the dashboard through
	 * the panel registry rather than a `ctx` is deliberate: connects land
	 * asynchronously and a superseded context would throw.
	 */
	function publishPanel(): void {
		const statuses: ServerStatus[] = [...servers.values()].map((state) => ({
			name: state.name,
			state:
				state.status === "ready"
					? "connected"
					: state.status === "connecting"
						? "connecting"
						: state.status,
			toolCount: state.toolNames.length,
			...(state.error ? { detail: state.error.split("\n")[0] } : {}),
		}));
		if (statuses.length === 0) clearMcpPanel();
		else publishMcpPanel(statuses);
	}
```

Then call it from four places:

1. In `session_start`, immediately after `servers.clear()`, add
   `clearMcpPanel();` — the session-state reset this repo requires.
2. In `session_start`, after the `for (const [name, server] of
   Object.entries(config.servers))` loop that populates `servers`, add
   `publishPanel();` so the screen shows `… connecting` right away.
3. In the `connecting.push(connect(...).catch(...))` handler, add
   `publishPanel();` as the last statement inside the `catch` body (after the
   existing `warn(...)` call), and add a `.then(() => publishPanel())` to the
   same chain so a success repaints too:

```typescript
			connecting.push(
				connect(state, ctx, cycle)
					.then(() => {
						if (cycle === generation) publishPanel();
					})
					.catch((error: Error) => {
						// ... existing body unchanged ...
						publishPanel();
					}),
			);
```

4. In `session_shutdown`, add `clearMcpPanel();` beside `closeAll()`.

The `cycle === generation` guard on the success path matches the one the
existing `catch` already uses: a handshake from a superseded cycle must not
repaint the dashboard with state the new cycle has replaced.

Finally, in the `/mcp restart` branch of the `mcp` command handler, call
`publishPanel()` after the reconnect completes so a retry is reflected without
restarting pi.

- [ ] **Step 7: Verify the wiring by hand**

```bash
npm run check
```

Then, in a terminal with MCP servers configured, run `pi` and confirm the `[MCP]`
section lists them. Run `/mcp restart` and confirm the section updates without
a restart of pi.

- [ ] **Step 8: Break it on purpose**

In `mcp/panel.ts`, make `describe` return `✓ ${server.toolCount}` for every
state. Re-run `node tests/mcp/panel.test.mjs`: `marks failed`, `explains a
failure` and `suggests the fix` must FAIL. Revert.

- [ ] **Step 9: Commit**

```bash
git add mcp/panel.ts mcp/index.ts tests/mcp/panel.test.mjs
git commit -m "mcp: publish server health to the dashboard"
```

---

### Task 8: Location and graphite stack panel

**Files:**
- Create: `worktree/panel.ts`
- Modify: `worktree/index.ts`, `lib/git.ts`
- Test: `tests/worktree/panel.test.mjs`

**Interfaces:**
- Consumes: `GitRunner` from `lib/git.ts`; `registerPanel`, `resetPanels` from
  `lib/panels.ts`. `worktree/index.ts` additionally uses `countDirty` and the
  new `aheadBehind`. Import nothing you do not use: `typecheck.sh` sets
  `noUnusedLocals` and `noUnusedParameters`.
- Produces:
```typescript
// lib/git.ts
export function aheadBehind(pi: GitRunner, cwd: string): Promise<{ ahead: number; behind: number } | undefined>;

// worktree/panel.ts
export interface StackEntry {
	branch: string;
	current: boolean;
	note?: string;
}
export type StackState =
	| { kind: "pending" }
	| { kind: "stack"; entries: StackEntry[] }
	| { kind: "untracked"; branch: string }
	| { kind: "unavailable" };
export function parseStack(stdout: string): StackEntry[];
export function readStack(pi: GitRunner, cwd: string, branch: string | undefined): Promise<StackState>;
export function locationLines(location: LocationInfo, stack: StackState, width: number): string[];
export interface LocationInfo {
	path: string;
	branch?: string;
	dirty: number;
	ahead?: number;
	behind?: number;
}
export function publishLocationPanel(location: LocationInfo, stack: StackState): void;
export function clearLocationPanel(): void;
```

- [ ] **Step 1: Write the failing test**

Create `tests/worktree/panel.test.mjs`:

```javascript
import { assertions, fakeRunner, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { parseStack, readStack, locationLines, publishLocationPanel, clearLocationPanel } =
	await loadExt("worktree/panel.ts");
const panels = await loadExt("lib/panels.ts");

// --- Parsing real `gt ls -s` output ---
const simple = parseStack("◯  pr-status (needs restack)\n◉  main\n");
ok("parses both branches", simple.length === 2);
ok("reads branch names", simple[0].branch === "pr-status");
ok("marks the current branch", simple[1].current === true && simple[0].current === false);
ok("keeps the note", simple[0].note === "needs restack");

// Graphite draws tree characters for branching stacks.
const tree = parseStack("◯    eric/docs (frozen)\n│ ◉  joel/feature\n◯─┘  main\n");
ok("parses a branching stack", tree.length === 3);
ok("strips tree glyphs from names", tree[1].branch === "joel/feature");
ok("finds the current branch in a tree", tree[1].current === true);
ok("ignores blank lines", parseStack("\n\n◉  main\n").length === 1);

// --- readStack degrades ---
const untracked = await readStack(
	fakeRunner({ code: 1, stderr: "ERROR: Cannot perform this operation on untracked branch feat.\n" }),
	"/repo",
	"feat",
);
ok("untracked branch is its own state", untracked.kind === "untracked");
ok("untracked carries the branch", untracked.branch === "feat");

const absent = await readStack(
	{ async exec() { throw new Error("ENOENT"); } },
	"/repo",
	"main",
);
ok("missing gt is unavailable", absent.kind === "unavailable");

const failed = await readStack(fakeRunner({ code: 1, stderr: "not a graphite repo" }), "/repo", "main");
ok("other failures are unavailable", failed.kind === "unavailable");

const good = await readStack(fakeRunner({ code: 0, stdout: "◉  main\n" }), "/repo", "main");
ok("success yields a stack", good.kind === "stack" && good.entries.length === 1);

// --- Rendering ---
const location = { path: "~/Code/proj", branch: "feature", dirty: 3, ahead: 2, behind: 0 };
const rendered = locationLines(location, good, 120).join("\n");
ok("shows the path", rendered.includes("~/Code/proj"));
ok("shows the branch", rendered.includes("feature"));
ok("shows dirty count", rendered.includes("3 files dirty"));
ok("shows ahead", rendered.includes("↑2"));
ok("hides behind when zero", !rendered.includes("↓"));
ok("renders the stack", rendered.includes("main"));

const clean = locationLines({ path: "~/p", branch: "b", dirty: 0 }, good, 120).join("\n");
ok("clean tree says nothing about dirt", !clean.includes("dirty"));

ok(
	"pending stack says so",
	locationLines(location, { kind: "pending" }, 120).join("\n").includes("…"),
);
ok(
	"untracked explains the fix",
	locationLines(location, { kind: "untracked", branch: "feat" }, 120).join("\n").includes("gt track"),
);
ok(
	"unavailable stack renders no stack lines",
	locationLines(location, { kind: "unavailable" }, 120).join("\n").split("\n").length === 1,
);

for (const width of [120, 80, 40]) {
	const lines = locationLines(location, good, width);
	ok(`no line exceeds ${width}`, Math.max(...lines.map((l) => l.length)) <= width);
}

// --- Registry integration ---
panels.resetPanels("worktree");
publishLocationPanel(location, { kind: "pending" });
const first = panels.listPanels().filter((p) => p.owner === "worktree");
ok("registers one panel", first.length === 1);
ok("panel sorts before MCP", first[0].order < 20);
publishLocationPanel(location, good);
ok("republishing replaces", panels.listPanels().filter((p) => p.owner === "worktree").length === 1);
ok("republished panel shows the stack", panels.listPanels()[0].render(120).join("\n").includes("main"));
clearLocationPanel();
ok("clear removes it", panels.listPanels().filter((p) => p.owner === "worktree").length === 0);

done();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/worktree/panel.test.mjs`
Expected: FAIL — cannot resolve `worktree/panel.ts`.

- [ ] **Step 3: Add `aheadBehind` to lib/git.ts**

Append to `lib/git.ts`:

```typescript
/**
 * Commits ahead of and behind the upstream branch.
 *
 * `undefined` when there is no upstream — a branch nobody has pushed is the
 * common case in a fresh worktree, not an error.
 */
export async function aheadBehind(
	pi: GitRunner,
	cwd: string,
): Promise<{ ahead: number; behind: number } | undefined> {
	const result = await git(pi, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
	if (result.code !== 0) return undefined;
	const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
	return { ahead, behind };
}
```

- [ ] **Step 4: Write the panel**

Create `worktree/panel.ts`:

```typescript
/**
 * Where you are, for the dashboard.
 *
 * The dashboard does not know what a graphite stack is and should not shell out
 * to `gt`. This extension already owns repo layout, so it owns this too.
 *
 * `gt ls -s` takes roughly 0.4s, which is too long to block startup: the panel
 * publishes `pending` immediately and republishes when the answer lands.
 */

import { type GitRunner } from "../lib/git.ts";
import { registerPanel, resetPanels } from "../lib/panels.ts";

const OWNER = "worktree";
const PANEL_ID = "location";

export interface StackEntry {
	branch: string;
	current: boolean;
	note?: string;
}

export type StackState =
	| { kind: "pending" }
	| { kind: "stack"; entries: StackEntry[] }
	| { kind: "untracked"; branch: string }
	| { kind: "unavailable" };

export interface LocationInfo {
	path: string;
	branch?: string;
	dirty: number;
	ahead?: number;
	behind?: number;
}

/**
 * Parse `gt ls -s`.
 *
 * Lines look like `◉  main` or `│ ◯  joel/feature (needs restack)`. The filled
 * circle marks the current branch; the tree glyphs before it are drawing, not
 * data.
 */
export function parseStack(stdout: string): StackEntry[] {
	const entries: StackEntry[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const match = /([◉◯])\s*[─┘│]*\s+(\S+)(?:\s+\((.+)\))?\s*$/.exec(line);
		if (!match) continue;
		entries.push({
			branch: match[2],
			current: match[1] === "◉",
			...(match[3] ? { note: match[3] } : {}),
		});
	}
	return entries;
}

export async function readStack(
	pi: GitRunner,
	cwd: string,
	branch: string | undefined,
): Promise<StackState> {
	let result: Awaited<ReturnType<GitRunner["exec"]>>;
	try {
		result = await pi.exec("gt", ["ls", "-s"], { cwd });
	} catch {
		// gt is not installed. Not every repo uses graphite; say nothing.
		return { kind: "unavailable" };
	}

	if (result.code !== 0) {
		const message = `${result.stderr}${result.stdout}`;
		// The common case in a worktree this extension created: the branch is
		// real but graphite has never been told about it.
		if (/untracked branch/i.test(message) && branch) return { kind: "untracked", branch };
		return { kind: "unavailable" };
	}

	const entries = parseStack(result.stdout);
	return entries.length > 0 ? { kind: "stack", entries } : { kind: "unavailable" };
}

export function locationLines(location: LocationInfo, stack: StackState, width: number): string[] {
	const facts: string[] = [];
	if (location.dirty > 0) facts.push(`${location.dirty} files dirty`);
	if (location.ahead) facts.push(`↑${location.ahead}`);
	if (location.behind) facts.push(`↓${location.behind}`);

	const head = [
		`  ${location.path}`,
		location.branch ? `⑂ ${location.branch}` : "",
		facts.length > 0 ? `· ${facts.join(" · ")}` : "",
	]
		.filter(Boolean)
		.join("  ");

	const lines = [head];
	if (stack.kind === "pending") lines.push("  reading stack…");
	else if (stack.kind === "untracked") lines.push(`  not in a graphite stack (gt track ${stack.branch})`);
	else if (stack.kind === "stack") {
		for (const entry of stack.entries) {
			const glyph = entry.current ? "◉" : "◯";
			lines.push(`  ${glyph} ${entry.branch}${entry.note ? ` (${entry.note})` : ""}`);
		}
	}
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

export function publishLocationPanel(location: LocationInfo, stack: StackState): void {
	registerPanel({
		id: PANEL_ID,
		owner: OWNER,
		title: "Location",
		order: 10,
		render: (width) => locationLines(location, stack, width),
	});
}

export function clearLocationPanel(): void {
	resetPanels(OWNER);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/worktree/panel.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 6: Publish from the extension**

In `worktree/index.ts`'s `session_start` handler:

1. Import: `import { clearLocationPanel, publishLocationPanel, readStack } from "./panel.ts";` and add `aheadBehind` and `countDirty` to the existing `../lib/git.ts` import.
2. Call `clearLocationPanel()` at the top, next to `replaceSession(undefined)`.
3. After `repo` resolves and before the `gt` call, publish the fast half:

```typescript
		const location = {
			path: repo.worktreeRoot ?? ctx.cwd,
			branch: repo.branch,
			dirty: await countDirty(pi, ctx.cwd),
			...((await aheadBehind(pi, ctx.cwd)) ?? {}),
		};
		publishLocationPanel(location, { kind: "pending" });
```

4. Then start the slow half without awaiting it, and **without touching `ctx`
   in the callback** — `publishLocationPanel` reaches the dashboard through the
   registry, never through a context:

```typescript
		void readStack(pi, ctx.cwd, repo.branch).then((stack) => {
			publishLocationPanel(location, stack);
		});
```

5. In `session_shutdown`, call `clearLocationPanel()` next to `ui.clearAll(ctx)`.

- [ ] **Step 7: Break it on purpose**

In `worktree/panel.ts`, make `readStack` return `{ kind: "unavailable" }` for
every non-zero exit (delete the `untracked branch` branch). Re-run: `untracked
branch is its own state` and `untracked carries the branch` must FAIL. Revert.

- [ ] **Step 8: Verify by hand and commit**

```bash
npm run check
```

Run `pi` in `~/Code/pi-extensions` (a graphite-tracked branch — expect a stack)
and in a worktree created by `/worktree new` (an untracked branch — expect the
`gt track` line, not an error).

```bash
git add lib/git.ts worktree/panel.ts worktree/index.ts tests/worktree/panel.test.mjs
git commit -m "worktree: publish location and graphite stack to the dashboard"
```

---

### Task 9: Setup command and documentation

**Files:**
- Create: `dashboard/README.md`
- Modify: `dashboard/index.ts`, `README.md`
- Test: `tests/dashboard/wiring.test.mjs` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: a `/dashboard` slash command. No new exports.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard/wiring.test.mjs`, before `done()`:

```javascript
// --- /dashboard setup ---
{
	const { mkdtemp, readFile, writeFile, mkdir } = await import("node:fs/promises");
	const settingsDir = join(await mkdtemp(join(tmpdir(), "dash-settings-")), "agent");
	await mkdir(settingsDir, { recursive: true });
	const settingsPath = join(settingsDir, "settings.json");
	await writeFile(settingsPath, JSON.stringify({ theme: "dark" }, null, "\t"));
	process.env.PI_DASHBOARD_SETTINGS = settingsPath;

	const h = harness();
	extension(h.pi);
	await h.fire("session_start");
	ok("registers the command", h.commands.has("dashboard"));

	await h.command("dashboard", "setup");
	const written = JSON.parse(await readFile(settingsPath, "utf8"));
	ok("sets quietStartup", written.quietStartup === true);
	ok("preserves other settings", written.theme === "dark");
	ok("reports success", h.messages().some((m) => m.includes("quietStartup")));

	await h.command("dashboard", "setup");
	ok("running twice is safe", JSON.parse(await readFile(settingsPath, "utf8")).quietStartup === true);

	await writeFile(settingsPath, "{ not json");
	await h.command("dashboard", "setup");
	ok("malformed settings warn rather than throw", h.notices.some((n) => n.level === "warning"));
	ok("malformed settings are not overwritten", (await readFile(settingsPath, "utf8")) === "{ not json");

	delete process.env.PI_DASHBOARD_SETTINGS;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/wiring.test.mjs`
Expected: FAIL on `registers the command`.

- [ ] **Step 3: Add the command**

In `dashboard/index.ts`, add imports:

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
```

and register the command inside the factory, after the event handlers:

```typescript
	/** Overridable so the test does not write to the real settings file. */
	const settingsPath = (): string =>
		process.env.PI_DASHBOARD_SETTINGS ?? join(homedir(), ".pi", "agent", "settings.json");

	pi.registerCommand("dashboard", {
		description: "Set up the startup dashboard",
		handler: async (args, ctx) => {
			if (args.trim() !== "setup") {
				ctx.ui.notify("usage: /dashboard setup", "info");
				return;
			}

			const path = settingsPath();
			let settings: Record<string, unknown>;
			try {
				settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			} catch (error) {
				// Never clobber a settings file we could not read: the user's
				// whole configuration is in there.
				ctx.ui.notify(`could not read ${path}: ${String(error)}`, "warning");
				return;
			}

			settings.quietStartup = true;
			await writeFile(path, `${JSON.stringify(settings, null, "\t")}\n`);
			ctx.ui.notify(`quietStartup enabled in ${path}. Restart pi to see the dashboard alone.`, "info");
		},
	});
```

**Why a command and not automatic:** writing to a user's settings file changes
their environment. This repo's convention gives the model the reversible half
of a feature and keeps environment changes behind an explicit slash command.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/dashboard/wiring.test.mjs`
Expected: every assertion prints `ok`, and the file ends `ALL PASS`. No `FAIL` lines.

- [ ] **Step 5: Break it on purpose**

Change the `catch` to `settings = {}` instead of returning. Re-run:
`malformed settings are not overwritten` must FAIL. Revert.

- [ ] **Step 6: Write `dashboard/README.md`**

Cover, in this order: what the screen shows (paste a real capture, not the
plan's mockup); the `quietStartup` requirement and `/dashboard setup`; that
`ctrl+o` expands; where skills data comes from and that a pi upgrade can change
that format; how another extension publishes a panel, with a code sample using
`registerPanel`/`resetPanels`; and the known gap that command-less extensions
are not listed. Match the voice of `worktree/README.md` — read it first.

- [ ] **Step 7: Add a row to the root README table**

In `README.md`, add `dashboard` to the extension table, one line, matching the
existing column format.

- [ ] **Step 8: Full check and commit**

```bash
npm run check
```

Expected: typecheck clean, every test file `PASS`, `ALL PASS`.

```bash
git add dashboard/index.ts dashboard/README.md README.md tests/dashboard/wiring.test.mjs
git commit -m "dashboard: add /dashboard setup and document the extension"
```

---

## Final verification

- [ ] `npm run check` passes from a clean tree.
- [ ] `pi` in `~/Code/pi-extensions` shows: mascot, location with the graphite
      stack, skills grouped by source with bars, `[MCP]` if servers are
      configured, context and prompts.
- [ ] `ctrl+o` expands to descriptions and full lists, and collapses back.
- [ ] Resizing the terminal narrower re-columnizes and never wraps a line.
- [ ] `pi -p "hello"` produces no dashboard output and no errors.
- [ ] With `quietStartup` unset, pi shows both screens — confirming
      `/dashboard setup` is what suppresses the built-in one.
