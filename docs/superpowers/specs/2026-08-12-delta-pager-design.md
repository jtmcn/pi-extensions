# Delta-rendered diffs in pi

Render diffs with [delta](https://github.com/dandavison/delta) instead of pi's
built-in diff styling, in two places: the output of `git diff`-style bash
commands, and the diff pi paints for `edit` and `write`.

Display only. The model keeps receiving the plain unified diff, so nothing about
tool behaviour, result shapes, or token cost changes.

## Why

The user already runs `pager = delta` with `line-numbers` and a Dracula syntax
theme in git config. Two things in pi ignore that:

- Git disables its pager when stdout is not a TTY, so `git diff` run through the
  `bash` tool arrives as plain uncoloured text.
- Pi's own `edit`/`write` diffs use `renderDiff`, which colours `+`/`-` lines and
  highlights intra-line word changes, but does no syntax highlighting.

## Scope

In scope:

- `bash` results whose command is diff-producing.
- The settled diff for `edit` and `write`.

Out of scope, with reasons:

- **Changing what the model sees.** Delta's ANSI would cost tokens and add noise
  to context for no benefit.
- **The pending `edit` preview.** See [Edit and write](#edit-and-write).
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
2. **`createBashToolDefinition`, `createEditToolDefinition`, and
   `createWriteToolDefinition` are exported.** Wrapping means spreading a
   built-in definition and replacing render slots — not reimplementing a tool.
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
7. **Pi's bash result rendering already styles output before truncating it**, so
   `truncateToVisualLines` is ANSI-aware and pre-coloured text survives the
   collapsed preview.
8. **`edit` results carry `details.patch`**, a standard unified patch with
   `diff --git` headers — the right input for delta, because it names the file
   and so enables syntax highlighting.

## Architecture

```
delta/
├── index.ts      wiring only: session_start reset, config load, wrap + register tools
├── config.ts     pure parse/validate of delta.json → Config + warnings[]
├── detect.ts     pure: isDiffCommand(command, extraPatterns) → boolean
├── cache.ts      pure: LRU keyed by hash:width:configVersion, positive + negative, in-flight set
├── run.ts        subprocess: probe() and run(text, width, cfg); spawn injected
├── footer.ts     pure: splitBashFooter(text, details) → { body, footer }
├── render.ts     the render slots, from injected { cache, run, fallback } — no pi import
└── README.md
```

`render.ts` owns the decision logic behind injected dependencies, so it is
testable with neither pi nor a real subprocess. `index.ts` does the wiring only,
matching `worktree/focus.ts` and `worktree/select.ts` as the template.

### Bash: text substitution

`renderResult` checks `isDiffCommand(args.command)`. When delta output for that
text is available, it calls the **built-in** `renderResult` with a result whose
output text is delta's rendering. Everything pi provides is preserved: the
collapsed preview and expand hint, ANSI-aware visual truncation, the truncation
warning line, and the `Took 1.2s` timing line.

The one wrinkle: pi strips its own `[Showing lines … Full output: …]` footer
using `details`. `footer.ts` splits that footer off before delta runs and
re-appends it afterwards, so pi's stripping logic still matches.

### Edit and write

`renderCall` returns a header only (`edit <path>`, no preview). `renderResult`
paints the header plus the delta-rendered `details.patch`.

This drops the pending preview. The alternative — forking `computeEditsDiff` and
the call-component bookkeeping (constraint 5) so the pending view stays
byte-identical — was rejected: it is the part most likely to break on a pi
upgrade, and the preview only appears once tool arguments finish streaming, a
fraction of a second before the settled diff replaces it.

When delta is unavailable, the settled diff falls back to `renderDiff`
(constraint 6), which is what pi shows today.

### Lifecycle: cache and invalidate

Cache key: `hash(diffText) : width : configVersion`.

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
itself), plus forced `--paging never`, forced colour, and `--width`. Config
`args` are appended last so they win over both gitconfig and defaults.

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

- **Resize does not re-layout.** Width comes from `process.stdout.columns` when
  delta runs. Existing diffs keep their original layout and pi wraps them, the
  way real pager scrollback behaves.
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
| `args` | `[]` | Appended last, so these override gitconfig |
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
- **`footer.test.mjs`** — footer split/re-append round-trips; output that
  legitimately ends in `]` with no footer; truncation details present but footer
  absent.
- **`cache.test.mjs`** — LRU eviction, width change producing a miss, negative
  entries preventing respawn, in-flight de-duplication.
- **`render.test.mjs`** — with a fake runner: first call returns fallback and
  schedules exactly one run; a later call returns delta output; the failure path
  returns fallback forever and never respawns; oversized input never reaches the
  runner.
- **`run.test.mjs`** — against real delta when it is on `PATH`, skipped
  otherwise; timeout and nonzero-exit paths driven by a fake binary.
- **`delta.test.mjs`** — `fake-pi.mjs` wiring: the three tools register; a
  superseded session's late delta completion does not write through the stale
  `ctx`; a missing binary warns exactly once.

Every test gets broken on purpose before being trusted.

## Documentation

`delta/README.md`, plus a row in the root README's extension table.
