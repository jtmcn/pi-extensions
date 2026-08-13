# Delta-rendered diffs in pi

Render diffs with [delta](https://github.com/dandavison/delta) instead of pi's
built-in diff styling, in two places: the output of `git diff`-style bash
commands, and the diff pi paints for `edit`.

Display only. The model keeps receiving the plain unified diff, so nothing about
tool behaviour, result shapes, or token cost changes.

## Why

The user already runs `pager = delta` with `line-numbers` and a Dracula syntax
theme in git config. Two things in pi ignore that:

- Git disables its pager when stdout is not a TTY, so `git diff` run through the
  `bash` tool arrives as plain uncoloured text.
- Pi's own `edit` diffs use `renderDiff`, which colours `+`/`-` lines and
  highlights intra-line word changes, but does no syntax highlighting.

## Scope

In scope:

- `bash` results whose command is diff-producing.
- The settled diff for `edit`.

Out of scope, with reasons:

- **`write`.** It has no diff to render. `execute` returns `details: undefined`,
  and `formatWriteResult` emits only errors — the content preview lives in the
  call rendering, already syntax-highlighted. Nothing for delta to do.
- **Changing what the model sees.** Delta's ANSI would cost tokens and add noise
  to context for no benefit.
- **The pending `edit` preview.** See [Edit](#edit).
- **Side-by-side as a default.** Delta's `--side-by-side` inside pi's ~8-line
  collapsed preview is unreadable. Reachable through `args` for anyone who wants
  it.
- **A `/delta` slash command.** `enabled` in config covers it. This feature has
  no half that mutates the user's environment, so the usual "keep it away from
  the model" split does not apply.

## Constraints discovered in pi's implementation

These drove most of the design and are worth stating before the architecture.

1. **Render slots are inherited per slot.** An override that omits `renderCall`
   gets the built-in one. So a tool can be wrapped for rendering alone, leaving
   `execute` and the result shape exactly as they are.
2. **`createBashToolDefinition` and `createEditToolDefinition` are exported.**
   Wrapping means spreading a built-in definition and replacing render slots —
   not reimplementing a tool.
3. **`renderResult` is synchronous**, but receives `context.invalidate()`. That
   is what makes an async subprocess possible at all.
4. **For `edit`, the visible diff lives in the *call* component.** `renderCall`
   computes a preview; the built-in `renderResult` mutates that same component
   with the final diff via `setEditPreview` → `buildEditCallComponent`.
   `formatEditResult` only emits a diff into the result body when the final diff
   differs from the preview — the uncommon case. Overriding `renderResult` alone
   would therefore leave nearly every edit diff rendered built-in.
5. **`computeEditsDiff` is not exported.** Reproducing the pending preview means
   forking preview computation and its call-component bookkeeping
   (`preview`, `previewArgsKey`, `previewPending`, `settledError`,
   background-colour-by-state).
6. **`renderDiff` and `generateUnifiedPatch` are exported.** The fallback path
   can look exactly like pi does today.
7. **`getTextOutput` runs `stripAnsi()` over result content.** Substituting
   delta's output into a tool result's text is therefore impossible — pi destroys
   the escapes before styling. Delta output can only reach the screen from a
   component we own.
8. **`truncateToVisualLines` and `keyHint` are exported.** Pi styles bash output
   before truncating it, so `truncateToVisualLines` is ANSI-aware and delta's
   colours survive the collapsed preview. `BASH_PREVIEW_LINES = 5` and the
   duration format are *not* exported and must be pinned copies.
9. **`edit` results carry `details.patch`**, a standard unified patch with
   `diff --git` headers — the right input for delta, because it names the file
   and so enables syntax highlighting.
10. **`Container`/`Text` are not re-exported from the package entry**, but pi
    accepts duck-typed components — `{ render(width): string[], invalidate() }` —
    as both children (`bash.js` adds one) and render-slot returns.
    `dashboard/index.ts` already uses this shape. It also means a component learns
    the **real render width**, rather than guessing from `process.stdout.columns`.
11. **Calling `context.invalidate()` asynchronously is sanctioned.** The built-in
    bash renderer drives a `setInterval` that calls it once a second to update
    its elapsed-time line.
12. **Delta emits erase-in-line (`\x1b[0K`) sequences** to extend background
    colour to the width of the line. Inside a TUI-managed frame those must be
    stripped, along with carriage returns, or they clear frame content pi drew.

## Architecture

```
delta/
├── index.ts      wiring only: session_start reset, config load, wrap + register tools
├── config.ts     pure parse/validate of delta.json → Config + warnings[]
├── detect.ts     pure: isDiffCommand(command, extraPatterns) → boolean
├── cache.ts      pure: LRU keyed by hash:width:configVersion, positive + negative, in-flight set
├── run.ts        subprocess: probe() and run(text, width, cfg); spawn injected
├── shell.ts      pi's shellPath/shellCommandPrefix, read back out of settings.json
├── footer.ts     pure: splitBashFooter(text, details) → { body, footer }
├── ansi.ts       pure: sanitize(deltaOutput) — strip erase-in-line and CR (constraint 12);
│                 plain(toolText) — strip ANSI and CR the way pi's getTextOutput does
├── engine.ts     lookup(text, width, invalidate) → cached delta output or undefined; owns scheduling
├── body.ts       the diff body component: render(width) → lines, delta or fallback
├── bash-result.ts the forked bash result component: preview, expand, warnings, timing
└── README.md
```

`engine.ts`, `body.ts`, and `bash-result.ts` all take injected dependencies, so
they are testable with neither pi nor a real subprocess. `index.ts` does the
wiring only, matching `worktree/focus.ts` and `worktree/select.ts` as the
template.

### Bash: a forked result component

Because of constraint 7, delta output cannot travel through the result text.
`renderResult` checks `isDiffCommand(args.command)`; when it matches, it returns
our own component instead of pi's, and otherwise delegates to the built-in.

The fork reproduces what pi's bash result rendering does, using pi's own
exported helpers where they exist:

- collapsed preview via `truncateToVisualLines` with `BASH_PREVIEW_LINES = 5`
- the expand hint via `keyHint("app.tools.expand", "to expand")`, honouring
  `options.expanded`
- the `[Full output: … Truncated: …]` warning line, from `details`
- the `Took 1.2s` / `Elapsed 1.2s` timing line

Two of those are unexported copies (the preview line count and the duration
format). A test pins both against pi's current behaviour so an upgrade that
changes them fails loudly rather than drifting silently.

`footer.ts` splits pi's `[Showing lines … Full output: …]` footer off the output
before delta runs, exactly as pi does before styling, so delta never sees it and
the warning line is rendered from `details` instead.

### Edit

*As built.* `renderCall` returns a header only (`edit <path>`, no preview), and
`renderResult` does **not** paint: it updates the same component and returns an
empty one.

The reason is that pi keeps the two slots' components separate but shares one
`context.state` between them (`callRendererComponent` / `resultRendererComponent`
in `tool-execution.js`), and once a result exists it paints *both* into the same
container. A component built from `lastComponent` in the result slot therefore
never sees the call slot's component, and every settled edit shows its header
twice. So the one on-screen component lives in `context.state`, `renderResult`
mutates it with the delta-rendered `details.patch`, and returns `{ render: () =>
[] }`. pi's own `edit` solves it the same way (`state.callComponent`, mutated
from `renderResult`).

The consequence is that the delta-rendered diff appears in the *call* slot's
component, which is where pi puts its own edit diff too.

This drops the pending preview. The alternative — forking `computeEditsDiff` and
the call-component bookkeeping (constraint 5) so the pending view stays
byte-identical — was rejected: it is the part most likely to break on a pi
upgrade, and the preview only appears once tool arguments finish streaming, a
fraction of a second before the settled diff replaces it.

When delta is unavailable, the settled diff falls back to `renderDiff`
(constraint 6), which is what pi shows today.

### Lifecycle: cache and invalidate

Cache key: `hash(diffText) : width : configVersion`.

Both tools own their components, so width is always the real `render(width)`
argument. A resize re-renders at the new width, misses the cache, and re-runs
delta at the correct width.

- **Hit** — use delta's output.
- **Miss** — return the fallback rendering immediately, spawn delta in the
  background, then store the result and call `context.invalidate()` to repaint.
  In-flight keys are tracked, so repeated repaints of the same diff spawn one
  process, not many.
- **Failure** (timeout, nonzero exit, spawn error) — record a negative entry and
  do not repaint. This is load-bearing: without it, the next repaint from any
  cause would treat the key as a miss and spawn delta again, indefinitely.
- **Bounded** — LRU of ~64 entries.

Delta is invoked with the user's git config inherited (delta reads `[delta]`
itself), plus forced `--paging never` and `--width` — and nothing else: delta
already emits colour when its stdout is a pipe, which `run.test.mjs` checks
against the real binary. Config `args` are appended last so they win over both
gitconfig and defaults.

### Failure and absence

- Missing binary: probed once per session (`delta --version`), warned once, then
  disabled for the rest of the session.
- Everything else: silent fallback to pi's built-in rendering.
- No TUI (`pi -p`): render slots are not used, so delta never runs. The warning
  is guarded on `ctx.hasUI`.

### Stale-ctx safety

The async completion calls `context.invalidate()` — precisely the hazard the
repo's conventions warn about. The in-flight map and a session generation token
both reset in `session_start`. A completion whose generation no longer matches is
dropped without touching the callback, and the call is defensive regardless.

### Accepted limitations

- **A resize shows the fallback rendering briefly** while delta re-runs at the
  new width.
- **Two pinned copies of pi internals** (`BASH_PREVIEW_LINES = 5`, the duration
  format), guarded by a test rather than by hope.
- **Oversized diffs skip delta.** Above `maxBytes` (default 256 KB) the built-in
  rendering is used, so a huge `git show` cannot burn a subprocess and CPU for
  output that appears as eight collapsed lines.

## Config

`~/.pi/agent/delta.json`, plus `<project>/.pi/delta.json` when
`ctx.isProjectTrusted()`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `command` | `"delta"` | Binary to run |
| `args` | `["--minus-style", "syntax normal", "--plus-style", "syntax normal"]` | Appended last, so these override gitconfig. The default suppresses delta's line-level background fills, which clash with pi's `toolSuccessBg` frame; `"args": []` restores banded rendering. |
| `timeoutMs` | `2000` | Per-invocation timeout |
| `maxBytes` | `262144` | Skip delta above this input size |
| `extraCommands` | `[]` | Regex sources added to the bash matcher |

Malformed JSON warns and falls back to defaults; it must not break session
startup.

## Command matching

The command string is split on `&&`, `||`, `;`, and `|`, and any segment may
match — so `git diff | head -50` is still delta'd.

Matches: `git diff`, `git show`, `git log` with `-p`/`-u`/`--patch`,
`git stash show -p`, `diff -u`/`-U`.

Excludes: `--stat`, `--numstat`, `--name-only`, `--name-status`, `--shortstat`.
Those are not diffs and delta would mangle them.

`extraCommands` is the escape hatch for `jj diff` and anything else, which is
what makes command matching (rather than sniffing output shape) tolerable.

## Tests

`tests/delta/`:

- **`detect.test.mjs`** — matcher table: plain commands, pipelines, `&&` chains,
  every `--stat`-family exclusion, `extraCommands` for `jj diff`, and non-diff
  commands that merely mention diffs (`echo "git diff"`, `rg 'diff --git'`).
- **`footer.test.mjs`** — footer split against real `bash` results captured from
  pi; output that legitimately ends in `]` with no footer; truncation details
  present but footer absent.
- **`ansi.test.mjs`** — erase-in-line and CR stripped; colour and OSC 8 escapes
  preserved; asserted against real delta output captured as a fixture.
- **`cache.test.mjs`** — LRU eviction, width change producing a miss, negative
  entries preventing respawn, in-flight de-duplication.
- **`engine.test.mjs`** — with a fake runner: first call returns fallback and
  schedules exactly one run; a later call returns delta output; the failure path
  returns fallback forever and never respawns; oversized input never reaches the
  runner; `enabled: false` never reaches the runner.
- **`body.test.mjs`** — the diff body component: fallback lines before delta
  arrives, delta lines after, a width change re-querying at the new width.
- **`bash-result.test.mjs`** — the fork: collapsed to 5 lines with the expand
  hint, full output when `options.expanded`, warning line from `details`, timing
  line for both partial and settled results. Pins `BASH_PREVIEW_LINES` and the
  duration format against pi's own rendering so an upgrade that changes either
  fails here.
- **`run.test.mjs`** — against real delta when it is on `PATH`, skipped
  otherwise; timeout and nonzero-exit paths driven by a fake binary.
- **`shell.test.mjs`** — settings resolution against temp files: global, project
  overriding it, project ignored when untrusted, and malformed or wrongly typed
  settings ignored rather than thrown.
- **`delta.test.mjs`** — `fake-pi.mjs` wiring: `bash` and `edit` register; a
  superseded session's late delta completion does not write through the stale
  `ctx`; a missing binary warns exactly once; config warnings surface as notices.

Every test gets broken on purpose before being trusted.

## Documentation

`delta/README.md`, plus a row in the root README's extension table.
