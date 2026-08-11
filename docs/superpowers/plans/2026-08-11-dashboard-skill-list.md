# Complete Skill List and Name-Sized Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source the dashboard's skill list from `getCommands()` so `disable-model-invocation` skills stop vanishing, and size skill columns to the names rather than to the terminal.

**Architecture:** Two independent changes to the existing `dashboard` extension. Task 1 replaces the skills data source (`dashboard/skills.ts` parsing → `pi.getCommands()`), deleting `parseSkills` and its round-trip test. Task 2 changes column geometry in `dashboard/layout.ts`. Neither touches the panel registry, `mcp`, or `worktree`.

**Tech Stack:** TypeScript loaded through jiti (no build step), pi extension API, `.mjs` test files run by `tests/run-all.mjs`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-11-dashboard-skill-list-design.md`. Read it before Task 1.
- **No build step.** Never add a bundler.
- **`npm run check` must pass** before every commit. Baseline on this branch: 24 files, 870 assertions, 0 failures.
- **Tabs, not spaces.**
- **`typecheck.sh` sets `noUnusedLocals` and `noUnusedParameters`.** An unused import or constant fails the build.
- **`Component` is not exported from `@earendil-works/pi-coding-agent`.** `VERSION`, `Theme`, `getAgentDir`, `ExtensionAPI`, `ExtensionContext` are.
- **`getCommands()` is on `ExtensionAPI` (`pi`), not `ExtensionContext` (`ctx`).**
- **Break every new test on purpose before trusting it.** Mutate the code under test; if the test still passes, the test is decoration. Report per assertion, never in aggregate.
- **`MAX_LABEL = 40`, `MAX_COLUMNS = 6`, `GUTTER = 2`, `BAR_SUFFIX = 2`.**
- **The width invariant is absolute:** no rendered line may exceed the terminal width, at any width, with or without ANSI escapes.

## File Structure

| File | Change |
|---|---|
| `dashboard/skills.ts` | `parseSkills`/`SkillsBlock` deleted; gains `skillsFromCommands`. `parseContextFiles` and `skillScope` unchanged. |
| `dashboard/index.ts` | Skills come from `pi.getCommands()`; `skillsAvailable` dropped. |
| `dashboard/render.ts` | `skillsAvailable` and the `[Skills] unavailable` branch deleted. |
| `dashboard/layout.ts` | `columnCount(width)` → `columnCount(cells, width, indent)`; label width derived from the names. |
| `tests/dashboard/skills.test.mjs` | Round-trip test against `formatSkillsForPrompt` deleted; `skillsFromCommands` tests added. |
| `tests/dashboard/wiring.test.mjs` | Fixture gains a `disable-model-invocation` skill. |
| `tests/dashboard/layout.test.mjs` | Column geometry tests rewritten. |
| `tests/dashboard/render.test.mjs` | Assertions that depend on column geometry adjusted. |
| `dashboard/README.md` | Data-source paragraph and capture updated. |

---

### Task 1: Skills from `getCommands()`

**Files:**
- Modify: `dashboard/skills.ts`, `dashboard/index.ts`, `dashboard/render.ts`
- Test: `tests/dashboard/skills.test.mjs`, `tests/dashboard/wiring.test.mjs`, `tests/dashboard/render.test.mjs`

**Interfaces:**
- Consumes: `SlashCommandInfo` from pi (`{ name, description?, source, sourceInfo }`), `ParsedSkill` (unchanged shape), `measureSkills`, `skillScope`.
- Produces:
```typescript
export interface ParsedSkill {
	name: string;
	description: string;
	location: string;
}
export function skillsFromCommands(
	commands: readonly { name: string; description?: string; source: string; sourceInfo?: { path?: string } }[],
): ParsedSkill[];
```

The parameter is typed structurally rather than importing pi's `SlashCommandInfo`, so the test can pass plain objects without a pi import — the same reason `MascotTheme` is a narrow subset of pi's `Theme`.

- [ ] **Step 1: Write the failing test**

Replace the round-trip block at the top of `tests/dashboard/skills.test.mjs` (the one importing `formatSkillsForPrompt` via `piEntry`) with the following. Keep the existing `parseContextFiles` and `skillScope` blocks exactly as they are — they are unaffected.

```javascript
const { skillsFromCommands, parseContextFiles, skillScope } = await loadExt("dashboard/skills.ts");

const commands = [
	{
		name: "skill:brainstorming",
		description: "Explores intent before implementation",
		source: "skill",
		sourceInfo: { path: "/u/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md" },
	},
	{
		// disable-model-invocation: absent from the system prompt, present here.
		name: "skill:merge",
		description: "Commit, rebase, and merge the current branch.",
		source: "skill",
		sourceInfo: { path: "/u/.pi/agent/skills/merge/SKILL.md" },
	},
	{ name: "parallel-cleanup", description: "a prompt", source: "prompt", sourceInfo: { path: "/u/p.md" } },
	{ name: "worktree", description: "an extension", source: "extension", sourceInfo: { path: "/u/worktree/index.ts" } },
];

const skills = skillsFromCommands(commands);
ok("only skill commands become skills", skills.length === 2);
ok("strips the skill: prefix", skills[0].name === "brainstorming");
ok("keeps the description", skills[0].description === "Explores intent before implementation");
ok("uses sourceInfo.path as the location", skills[0].location.endsWith("brainstorming/SKILL.md"));
ok(
	"includes a skill the model cannot invoke",
	skills.some((s) => s.name === "merge"),
);
ok("preserves order", skills.map((s) => s.name).join(",") === "brainstorming,merge");
ok("empty input yields no skills", skillsFromCommands([]).length === 0);
ok("a skill with no sourceInfo is dropped", skillsFromCommands([{ name: "skill:x", source: "skill" }]).length === 0);
ok(
	"a missing description becomes empty, not undefined",
	skillsFromCommands([{ name: "skill:y", source: "skill", sourceInfo: { path: "/y/SKILL.md" } }])[0].description === "",
);
ok("scope still derives from the location", skillScope(skills[1].location) === "personal");
```

Delete the `piEntry` import if nothing else in the file uses it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/skills.test.mjs`
Expected: FAIL — `skillsFromCommands` is not a function.

- [ ] **Step 3: Implement `skillsFromCommands` and delete `parseSkills`**

In `dashboard/skills.ts`: delete `parseSkills`, `SkillsBlock`, the `SKILL_BLOCK`/`SKILL_ENTRY` regexes, and `unescapeXml` if nothing else uses it. Keep `ParsedSkill`, `parseContextFiles`, `CONTEXT_PATH`, and `skillScope`. Replace the file's header comment, which currently explains the system-prompt approach, with the reason for the new one. Then add:

```typescript
/** The shape of `pi.getCommands()` entries this module needs. */
interface SkillCommand {
	name: string;
	description?: string;
	source: string;
	sourceInfo?: { path?: string };
}

/**
 * The loaded skills, from `pi.getCommands()`.
 *
 * Not from the system prompt: `formatSkillsForPrompt` drops every skill with
 * `disable-model-invocation: true` (`core/skills.js:258`), so parsing the
 * prompt silently hid the skills you invoke by name. `getCommands()` reports
 * the resource loader's list unfiltered, and `sourceInfo.path` is the skill's
 * SKILL.md — which is what `measureSkills` and `skillScope` need.
 */
export function skillsFromCommands(commands: readonly SkillCommand[]): ParsedSkill[] {
	const skills: ParsedSkill[] = [];
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const location = command.sourceInfo?.path;
		// A skill we cannot locate cannot be measured or scoped; listing it
		// without either would be worse than omitting it.
		if (!location) continue;
		skills.push({
			name: command.name.replace(/^skill:/, ""),
			description: command.description ?? "",
			location,
		});
	}
	return skills;
}
```

- [ ] **Step 4: Wire it in `dashboard/index.ts`**

Replace the skills half of the model build. `parseSkills` and the `prompt`-derived `parsed` variable go; `parseContextFiles(prompt)` stays.

```typescript
		const commands = pi.getCommands();
		const skills = skillsFromCommands(commands);
```

and in the model:

```typescript
			skills: await measureSkills(skills),
```

Update the import line and the file's header comment, which currently says skills come from the system prompt.

**Delete `skillsAvailable` rather than always passing `true`.** It existed to
report "pi changed the prompt format and we parsed nothing" — a state that
cannot arise from a typed API that either returns skill entries or does not.
Keeping the field would leave `render.ts`'s `[Skills] unavailable (pi format
changed)` branch permanently unreachable in production while a test kept it
alive, which is precisely the dead-branch pattern this repo's reviews flag.
Remove the field from `DashboardModel`, remove the branch from `renderSkills`,
and remove the three `skillsAvailable` usages plus the `unparseable skills say
so` assertion from `tests/dashboard/render.test.mjs`. Zero skills already
renders no `[Skills]` section, which is the honest outcome.

- [ ] **Step 5: Add a hidden skill to the wiring fixture**

In `tests/dashboard/wiring.test.mjs`, the `commands` fixture already returns a `source: "skill"` entry. Add a second one representing a `disable-model-invocation` skill — present in `getCommands()` and **absent from the `systemPrompt` fixture** — then assert it reaches the screen:

```javascript
ok("renders a skill the system prompt omits", lines.includes("merge"));
```

Write the second skill's `SKILL.md` to the temp dir like the first, so `measureSkills` can stat it and the count is real.

- [ ] **Step 6: Run the tests**

Run: `node tests/dashboard/skills.test.mjs && node tests/dashboard/wiring.test.mjs`
Expected: every assertion prints `ok`, both files end `ALL PASS`. No `FAIL` lines.

- [ ] **Step 7: Break it on purpose, twice**

First: make `skillsFromCommands` filter on `command.source === "prompt"` instead of `"skill"`. Re-run: `only skill commands become skills` and `renders a skill the system prompt omits` must FAIL. Revert.

Second — the regression guard for the bug this task fixes: revert `dashboard/index.ts` to source skills from the system prompt (`parseSkills(prompt).skills`, restoring the function temporarily if needed). Re-run: `renders a skill the system prompt omits` must FAIL, because the fixture's hidden skill is deliberately absent from the `systemPrompt` fixture. Revert.

Report both outputs. If either mutation does not produce a failure, that is a finding — report it rather than papering over it.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run check
git add dashboard/skills.ts dashboard/index.ts tests/dashboard/skills.test.mjs tests/dashboard/wiring.test.mjs
git commit -m "dashboard: list every skill, including the ones the model cannot invoke"
```

---

### Task 2: Columns sized to the names

**Files:**
- Modify: `dashboard/layout.ts`
- Test: `tests/dashboard/layout.test.mjs`, and `tests/dashboard/render.test.mjs` where assertions depend on column geometry

**Interfaces:**
- Consumes: `Cell`, `truncate`, `visibleWidth`, `truncateVisible` (all unchanged).
- Produces:
```typescript
export function columnCount(cells: readonly Cell[], width: number, indent: number): number;
export function layoutRows(cells: Cell[], width: number, indent: number): LaidOutCell[][];
```

`columnCount`'s signature changes: column count now depends on the labels, not on the terminal alone. `layoutRows` keeps its signature.

- [ ] **Step 1: Write the failing test**

In `tests/dashboard/layout.test.mjs`, replace the `columnCount(120) === 3` style assertions with geometry that follows the names. Keep every width-invariant assertion, including the wide-label sweep — those still hold and must keep detecting.

The expected values below were computed against the formula in Step 3 and are
exact — do not adjust them to match a different implementation.

```javascript
const short = [...Array(9).keys()].map((i) => ({ label: `sk-${i}`, bar: "▄" }));           // 4 chars
const typical = [...Array(9).keys()].map((i) => ({ label: `skill-number-${i}`, bar: "▄" })); // 14 chars
const longish = [...Array(9).keys()].map((i) => ({ label: `${i}`.padEnd(35, "x"), bar: "▄" })); // 35 chars

// Column count follows the names, not the terminal alone.
ok("short names pack more columns than long ones", columnCount(short, 183, 4) > columnCount(longish, 183, 4));
ok("short at 183 hits the cap", columnCount(short, 183, 4) === 6);
ok("longish at 183 fits four", columnCount(longish, 183, 4) === 4);
ok("typical at 120 fits six", columnCount(typical, 120, 4) === 6);
ok("longish at 120 fits three", columnCount(longish, 120, 4) === 3);
ok("never exceeds MAX_COLUMNS", columnCount(short, 400, 4) === 6);
ok("one column when cramped", columnCount(longish, 40, 4) === 1);
ok("empty input still yields a column", columnCount([], 120, 4) === 1);

// The bug: a bar must sit one space after its label, not 45.
const rows = layoutRows(typical, 183, 4);
const gap = rows[0][0].label.length - "skill-number-0".length;
ok("label is not padded far beyond the longest name", gap === 0, `gap was ${gap}`);
ok("bar follows its own label", `${rows[0][0].label} ${rows[0][0].bar}`.endsWith("skill-number-0 ▄"));

// One pathological name must not starve the rest.
const long = [{ label: "x".repeat(120), bar: "█" }, ...typical];
const cappedRows = layoutRows(long, 183, 4);
ok("a very long name is capped, not honoured", cappedRows[0][0].label.length === 40);
ok("the long row still fits", (" ".repeat(4) + cappedRows[0].map((c) => `${c.label} ${c.bar}`).join("  ")).length <= 183);

// The width invariant, unchanged, at the widths that matter.
// The tightest case is longish at 40: one column, a 34-char label, exactly 40.
for (const width of [183, 120, 90, 60, 40]) {
	for (const cells of [short, typical, longish, long]) {
		const laid = layoutRows(cells, width, 4);
		const longest = Math.max(
			...laid.map((row) => " ".repeat(4) + row.map((c) => `${c.label} ${c.bar}`).join("  ")).map((l) => l.length),
		);
		ok(`no line exceeds ${width}`, longest <= width, `longest was ${longest}`);
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard/layout.test.mjs`
Expected: FAIL — `columnCount` still takes only a width, and the padding gap at 183 is ~45.

- [ ] **Step 3: Implement**

In `dashboard/layout.ts`, add the two caps beside the existing constants:

```typescript
/** One pathological name must not starve every other column. */
const MAX_LABEL = 40;
/** A very wide terminal should not become a wall of narrow columns. */
const MAX_COLUMNS = 6;
```

Replace `columnCount` and the geometry at the top of `layoutRows`:

```typescript
/** Width of the longest label, capped so one outlier cannot starve the rest. */
function labelWidthFor(cells: readonly Cell[]): number {
	const longest = Math.max(...cells.map((cell) => cell.label.length));
	return Math.max(1, Math.min(longest, MAX_LABEL));
}

/**
 * How many columns fit.
 *
 * Derived from the names rather than from the terminal alone: dividing a wide
 * terminal into a fixed three columns padded every name to a third of the
 * screen, so a bar sat up to 45 spaces from the name it belonged to and read
 * as belonging to the next column.
 */
export function columnCount(cells: readonly Cell[], width: number, indent: number): number {
	if (cells.length === 0) return 1;
	const cellWidth = labelWidthFor(cells) + BAR_SUFFIX;
	const fit = Math.floor((width - indent + GUTTER) / (cellWidth + GUTTER));
	return Math.max(1, Math.min(MAX_COLUMNS, fit));
}
```

and in `layoutRows`, replace the first three geometry lines with:

```typescript
	const columns = columnCount(cells, width, indent);
	const available = width - indent - GUTTER * (columns - 1);
	// Honour the names, but never overflow the row.
	const labelWidth = Math.max(1, Math.min(labelWidthFor(cells), Math.floor(available / columns) - BAR_SUFFIX));
```

The rest of `layoutRows` is unchanged.

> **Superseded by `adcbf3a`:** the `available` arithmetic above and the
> mutation in Step 6 that targets `- GUTTER * (columns - 1)` are both inert
> once `columnCount` sizes the columns to fit. The shipped implementation
> dropped `available` entirely. If re-executing this plan, mutate
> `columnCount`’s denominator (`cellWidth + GUTTER`) instead.

- [ ] **Step 4: Update `render.test.mjs` where it assumes three columns**

Run `node tests/dashboard/render.test.mjs` and fix any assertion that encoded the old geometry (for example one expecting a specific number of rendered rows at width 120). Do not weaken a width-invariant assertion to make it pass — if one fails, the geometry is wrong, not the assertion.

- [ ] **Step 5: Run the tests**

Run: `node tests/dashboard/layout.test.mjs && node tests/dashboard/render.test.mjs`
Expected: every assertion prints `ok`, both end `ALL PASS`.

- [ ] **Step 6: Break it on purpose, twice**

First — the invariant that has caught real bugs twice: delete the `- GUTTER * (columns - 1)` term from `available`. Re-run: at least one `no line exceeds` assertion must FAIL. Revert.

Second: remove the `Math.min(longest, MAX_LABEL)` cap so a pathological name is honoured in full. Re-run: `a very long name is capped, not honoured` must FAIL, and check whether any width assertion also fails. Revert.

Report both outputs.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run check
git add dashboard/layout.ts tests/dashboard/layout.test.mjs tests/dashboard/render.test.mjs
git commit -m "dashboard: size skill columns to the names, not the terminal"
```

---

### Task 3: Documentation

**Files:**
- Modify: `dashboard/README.md`

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1 and 2.
- Produces: nothing importable.

- [ ] **Step 1: Correct the data-source paragraph**

`dashboard/README.md` currently says skills are parsed from the system prompt and warns that a pi upgrade can change that format. That is no longer true, and the reason for the change is worth recording: the prompt omits `disable-model-invocation` skills, so the list was incomplete. Say where skills come from now (`getCommands()`, a declared type) and drop the format-drift warning.

- [ ] **Step 2: Regenerate the screen capture**

The README's capture shows the old three-column geometry. Regenerate it exactly as the previous capture was produced: a throwaway node script that imports `renderDashboard` through jiti (as `tests/harness.mjs` does with `loadExt`), with a realistic model, and paste the real output. Delete the script afterwards.

- [ ] **Step 3: Commit**

```bash
npm run check
git add dashboard/README.md
git commit -m "docs: dashboard reads skills from getCommands"
```

---

## Final verification

- [ ] `npm run check` passes from a clean tree.
- [ ] In a real `pi` session, `[Skills]` counts every skill pi's own listing shows — including `merge`, `open-pr`, `rebase` and `worktree` — and the token total rises accordingly.
- [ ] At a wide terminal each bar sits one space after its name, in more than three columns.
- [ ] Narrowing the terminal re-columnizes without wrapping.
