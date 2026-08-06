# Decomposing worktree/index.ts

## Problem

`worktree/index.ts` is 877 lines — the largest file in the repo and the one with
the entire bug history. `git log` on the PR status feature alone: "Fix PR status
generation-guard defects", "cancel pending PR timers at session_start before
reset", "re-read the branch before the error backoff", "Repaint the PR footer
when the displayed branch changes", "fix the gh lookups' failure
classification".

Two things drive that concentration of defects:

- **Twelve interdependent mutable variables** implementing single-flight,
  a generation guard, error backoff, idle suspension, and two timers, all in one
  closure alongside the command layer and the tool.
- **Nothing below the top is independently testable.** Every path reaches
  `pi.exec` or `ctx.ui` directly, so the only way in is a fake `pi`.
  `tests/worktree/pr-status.test.mjs` does exactly that and is valuable, but it
  is an integration test — it cannot cheaply enumerate the state machine.

By responsibility, the file is roughly: PR subsystem ~350 lines, command layer
~280, tool ~90, UI helpers ~60, wiring ~100.

## Design

### New modules

**`worktree/pr-monitor.ts`** — the PR subsystem as a factory:

```ts
createPrMonitor({
  runner,     // { exec } — the minimal shape lib/git.ts and gh.ts already take
  getTarget,  // () => { cwd, branch } | undefined
  getHead,    // () => string | undefined   (path of the displayed worktree)
  setBranch,  // (head, branch) => void     writes the re-read branch back
  paint,      // () => void                 repaint the footer
  hasUI,      // () => boolean
  now, setTimer, clearTimer,                // injectable clock for tests
}) => { refresh(force?), onInput(), onBashCommand(cmd), label(), dispose() }
```

All PR state becomes private to this closure. It takes a `runner` rather than
`pi`, so its tests need neither a fake `pi` nor the network: the branch re-read
is the only git call and it goes through the same injected runner.

**`worktree/ui.ts`** — `createUi(statusKey)` → `{ say, report, clearReport,
setStatus }`. `setStatus(ctx, parts)` takes a composed array instead of reaching
into `focus` and `prLabel`, which makes the print-mode fallbacks testable.

**`worktree/commands.ts`** — `createCommands(deps)` → `{ dispatch,
getArgumentCompletions }`, holding `resolveWorktree`, `showList`, and
`doNew` / `doFocus` / `doRemove` / `doConfig`.

**`worktree/tool.ts`** — `createWorktreeTool(deps)` returning the definition
handed to `pi.registerTool`.

**`worktree/session.ts`** — `createSession(...)` returning an object owning
`config`, `configSources`, `repo`, `focus`, `knownWorktrees`, the monitor,
`setFocus()`, and `dispose()`.

`index.ts` keeps event handlers and registration only, target ~150 lines.

### The one behaviour change

Correctness under session replacement currently rests on a **generation
counter**: `prGeneration` is bumped in `session_start`, captured per fetch, and
rechecked after every `await`. It exists only because the extension closure
outlives the session it serves.

With a per-session monitor that is disposed when the session is replaced, that
becomes `if (disposed) return` at the same await points: the same guarantee with
one concept instead of two, no `prGeneration += 1` to forget, and no ordering
hazard of the kind "cancel pending PR timers at session_start *before* reset" was
fixing — disposal cancels timers as part of teardown.

This is the only semantic change in the refactor.

## Sequencing

Each step is one commit, and `npm run check` gates every one.

1. **Extract `pr-monitor.ts`**, keeping the generation counter verbatim. A pure
   move: identical behaviour, identical test results.
2. **Extract `ui.ts`, `commands.ts`, `tool.ts`.** Pure moves.
3. **Introduce `session.ts`**, make the monitor per-session, replace the
   generation counter with disposal, and delete the hand-rolled reset block.

Steps 1 and 2 must not change behaviour; a moved test result means a mistake.
Step 3 is the only step that changes behaviour, so its tests are written first
and must fail before the change.

## Testing

- **`tests/worktree/pr-monitor.test.mjs`** (new): single-flight collapsing, the
  `prPending` re-run, error backoff, idle suspension, branch write-back,
  target-moved-during-fetch, and — added in step 3, red first — disposal
  mid-flight. Injected clock, no fake `pi`.
- **`tests/worktree/ui.test.mjs`** (new): the `hasUI` × `mode === "print"`
  matrix, currently untested despite being a written-down convention.
- **`tests/worktree/pr-status.test.mjs`** (unchanged): the integration test
  through a fake `pi`, and the safety net for the whole refactor. Deliberately
  not rewritten.

## Success criteria

- The 251-assertion baseline still passes at every step, plus the new tests.
- `index.ts` under ~200 lines; no worktree file over ~300.
- `pr-monitor.ts` has no import of `@earendil-works/pi-coding-agent` types beyond
  what it needs, and its tests construct no fake `pi`.
- Disposal, not a generation counter, is what makes a superseded fetch inert —
  demonstrated by a test that fails against the old mechanism.

## Non-goals

- Rewriting `pr-status.test.mjs`.
- Touching `lib/git.ts`, `focus.ts`, `select.ts`, `pr.ts`, or `gh.ts`, which are
  already pure and tested.
- The print-mode MCP teardown message (`mcp: gitnexus failed — client closed` on
  every `pi -p` run). Real, pre-existing, and a separate extension.
