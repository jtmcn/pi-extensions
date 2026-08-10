# A startup dashboard

Pi's opening screen is built in `interactive-mode.js`: a `builtInHeader`
(`pi v0.84.1`, two lines of keybinding hints, one line of onboarding prose)
followed by a separate `loadedResourcesContainer` holding `[Context]`,
`[Skills]`, `[Prompts]`, `[Extensions]`.

It is bland and it is uninformative, in specific ways:

- 35 skills render as one comma-separated wall that reflows across five lines,
  with superpowers, personal and package skills styled identically.
- `[Prompts]` overflows the terminal width.
- `[Extensions]` mixes four naming formats: `mcp`,
  `obra/superpowers:.pi/extensions/superpowers.ts`, `pi-subagents@0.38.0`,
  `worktree`.
- Nothing says where you are. Repo, branch and worktree appear only in the
  footer, and stack position nowhere.
- The three header lines are identical in every session forever.

This adds a `dashboard` extension that replaces the whole screen.

## What is on it

```
     █▌  █▌
  ██████████████
     ██    ██
     ██    ██
     ██    ██
  pi v0.84.1

  ~/Code/pi-extensions  ⑂ mellow-thicket        3 files dirty · ↑2
  ◯ pr-status (needs restack)
  ◉ main

[Skills]  35 · ~78k tok
  superpowers (12)
    brainstorming             ▅  dispatching-parallel-agents ▃  executing-plans  ▂
    receiving-code-review     ▃  requesting-code-review      ▂  subagent-driven  █
    systematic-debugging      ▅  test-driven-development     ▅  using-git-wor..  ▃
    using-superpowers         ▂  verification-before-compl.  ▂  writing-plans    ▄
  personal (22)
    ci-watch                  ▃  coordinator                 ▄  dagster-expert   ▅
    ...
  pi-subagents (1)
    pi-subagents              ▂

[MCP]  3 servers · 24 tools
  linear      ✓ 12    notion  ✓ 12    databricks  ✗ spawn failed — /mcp restart

[Context]  ~/Code/pi-extensions/AGENTS.md
[Prompts]  9 · /gather-context-and-clarify, /parallel-cleanup, +7 more
```

(The `...` under `personal (22)` is the mockup eliding rows, not a rendered
string.)

Nothing on the screen duplicates the status bar: no model, no thinking level,
no context percentage. Repo and branch appear only because the graphite stack
needs a root, and `3 files dirty · ↑2` is the part the footer does not carry.

`ctrl+o` expands, because pi runs `isExpandable(customHeader)` and calls
`setExpanded` on it. Expanded adds skill descriptions, the full prompt list,
full context paths and per-server MCP tool names.

## Owning the whole screen

`ctx.ui.setHeader(factory)` swaps a component into `headerContainer`
(`setExtensionHeader`, interactive-mode.js:1767). It does not touch
`loadedResourcesContainer`, so a custom header alone leaves the skills wall in
place below it. The only switch on the resource sections is the `quietStartup`
setting, which suppresses the built-in header and the resource listing
together — and `ExtensionContext` exposes no settings accessor, so the
extension cannot flip it at runtime.

So the dashboard requires `"quietStartup": true` in
`~/.pi/agent/settings.json`. `/dashboard setup` writes it; changing a user's
settings is exactly the kind of environment change that stays a slash command
rather than a tool. When the setting is off, the extension still renders and
warns once that pi's own sections are duplicating it.

Augmenting instead — a richer header above pi's unchanged sections — was
rejected: the skills wall is the main complaint and augmenting cannot touch it.

## Where the data comes from

Split by who knows what.

**Dashboard-owned**, from what pi hands every extension:

| Panel | Source |
|---|---|
| Skills | `ctx.getSystemPrompt()`, `<available_skills>` block |
| Context files | `ctx.getSystemPrompt()`, `<project_instructions path>` |
| Prompts | `ctx.getCommands()`, entries with `source: "prompt"` |
| Extensions | `ctx.getCommands()`, `sourceInfo` of entries with `source: "extension"` |
| Skill sizes | `fs.stat` on each skill's parsed `location` |

Extensions appear in the expanded view only. Collapsed, the list is four names
you already know; what you actually want from an extension — whether its
servers connected, which branch it put you on — is what its own panel says.

`ExtensionContext` has no resource loader, so the skills and context files pi
lists in its own sections are not directly available. The system prompt is the
only route — and it carries descriptions and absolute paths, which is strictly
more than the built-in listing shows.

**Extension-owned**, from extensions that already know:

| Panel | Publisher |
|---|---|
| MCP servers | `mcp` |
| Location, dirty state, graphite stack | `worktree` |

The dashboard does not know what a graphite stack is and does not shell out to
`gt`. It renders whatever has been registered.

## The panel contract

`lib/panels.ts`, a registry any extension in this repo can push into:

```typescript
registerPanel(id, { title, order, render: () => string[] })
updatePanel(id)
resetPanels(owner)   // drops every panel registered by one extension
```

`resetPanels` takes an owner rather than clearing everything, because
`session_start` fires once per extension and the first to run must not wipe
panels the others have already registered.

State hangs off `globalThis` under a single key, so it works however pi
instantiates extension modules — `lib/` is currently stateless and there is no
precedent for a shared module instance to rely on.

Each publishing extension calls `resetPanels(owner)` in its own
`session_start`. Extension closures outlive their session; `/new` and resume
re-fire it against a different transcript.

Three alternatives were considered for MCP and rejected. Importing `mcp/config.ts`
from the dashboard gives configured servers but not reality — a server that
failed to spawn still looks fine. Inferring from `ctx.getAllTools()` works
because bridged tools only exist once a server connected, but the names are
`<server>_<tool>` sanitized (`mcp/bridge.ts:27`) and ambiguous when a server
name contains an underscore. `ToolInfo` carries `sourceInfo` but not the
`MCP: <server>` label, so it cannot group by server either. Only the extension
itself can say "spawn failed — /mcp restart".

## Async without the stale-ctx trap

`gt ls -s` takes ~0.4s, so it cannot block startup. `worktree` publishes a
pending stack panel immediately, runs `gt`, then calls `updatePanel`.

The header component closes over `tui` and `theme` from
`setHeader((tui, theme) => ...)` and **never over `ctx`**. A `gt` call that
outlives the turn would otherwise throw "extension ctx is stale" and take down
the process.

## Degrading honestly

- `ctx.mode !== "tui"` — no `setHeader` at all.
- `gt` absent, or the branch untracked (`Cannot perform this operation on
  untracked branch`, which is the state of every worktree this repo's own
  extension creates) — the panel says so in one line. Not an error, not empty.
- A skill's `location` missing on disk — no bar, no crash.
- `<available_skills>` present but nothing parsed — `[Skills] unavailable
  (pi format changed)`, never a silently empty section.

## Layout rules

- Bars scale relative to the largest skill, not absolutely. Absolute scaling
  renders 30 of 35 as `▁`.
- Size is SKILL.md bytes ÷ 4, the cost of `read`-ing the skill. Not the skill
  directory: `pi-subagents` is a 3 KB SKILL.md in a 96 KB directory, and the
  number should mean "what this costs me".
- Names truncate to their column. No line ever exceeds the terminal width;
  reflow is what makes today's wall unreadable.
- Three columns at 120 cells, two at 90, one below.

## Why not an inline image

`pi-tui`'s `detectCapabilities()` picks an image protocol from environment
variables alone: Kitty, Ghostty, WezTerm, Warp, iTerm2. `TERM_PROGRAM=Tabby`
falls through to `{ images: null }`, so a real image degrades to a
`[image/png ...]` placeholder in the terminal this is being built for.

The mascot is drawn with block glyphs, as
`examples/extensions/custom-header.ts` does. Half-block art from a real PNG
would also work — `COLORTERM=truecolor` — but costs 15-20 lines of vertical
space against a screen whose problem is that it wastes space.

## Layout of the code

```
lib/panels.ts          registry
dashboard/index.ts     wiring: session_start -> setHeader, /dashboard setup
dashboard/skills.ts    system prompt text -> Skill[]
dashboard/sizes.ts     paths -> bytes -> tokens -> bar glyph
dashboard/layout.ts    items + width -> columns
dashboard/mascot.ts    theme -> logo lines
dashboard/render.ts    (Model, theme, width) -> {collapsed, expanded}
mcp/panel.ts           builds and publishes the MCP panel
worktree/panel.ts      builds and publishes location and stack
```

Decision logic in pure modules, `index.ts` wiring only, following
`worktree/focus.ts` and `worktree/select.ts`.

## Tests

`tests/dashboard/`, discovered by `run-all.mjs`.

The load-bearing one: `formatSkillsForPrompt` is publicly exported from
`@earendil-works/pi-coding-agent` (`dist/index.d.ts:21`). `skills.test.mjs`
round-trips `Skill` objects through **pi's own formatter** and asserts the
parser recovers every name, description and path. Parsing the system prompt is
parsing a format pi never promised; when it changes, `npm run check` fails
rather than the panel quietly going blank.

- `skills.test.mjs` — the round-trip, XML-escaped names, absent block,
  malformed block.
- `sizes.test.mjs` — scaling relative to max, one skill, all-equal sizes,
  a missing file.
- `layout.test.mjs` — columns at 120/90/60 cells, truncation, and the
  invariant that no line exceeds the width.
- `panels.test.mjs` — register, update, subscriber notification, and that
  `resetPanels()` clears a previous session's panels.
- `render.test.mjs` — collapsed vs expanded, ordering, empty states.
- `wiring.test.mjs` — via `tests/fake-pi.mjs`: `mode !== "tui"` never calls
  `setHeader`; the `quietStartup` warning fires once; and a superseded
  session's late `gt` result does not paint. `fire("session_start")` mints a
  fresh `ctx`, which is the bug this repo keeps hitting.
- `mcp/panel.test.mjs` — connected, failed, disabled servers.
- `worktree/panel.test.mjs` — untracked-branch error, `gt` absent, and parsing
  a real `gt ls -s` stack.

`gt` is scripted through `fakeRunner()`; git stays real in throwaway repos.
Every test is broken on purpose before it is trusted.

## Not doing

- **Listing command-less extensions.** The expanded `[Extensions]` list comes
  from `getCommands()`, which sees only extensions that register a command. Completing the list means re-deriving pi's
  discovery rules across `~/.pi/agent/extensions`, `.pi/extensions` and package
  directories — the part most likely to drift, for a section of names nobody
  reads. Additive later if the gap annoys in practice.
- **Themes.** Pi lists them; nobody looks.
- **Anything already in the status bar.**
