# dashboard

Replaces pi's built-in startup header with a screen that shows where you are,
what skills are loaded and what they cost to read, and whatever other extensions
in this collection want to report.

## What the screen shows

```
     █▌  █▌
  ██████████████
     ██    ██
     ██    ██
     ██    ██
  pi v0.84.1

[Location]
  ~/Code/pi-extensions  ⑂ mellow-thicket  · 3 files dirty · ↑2
  ◉ mellow-thicket
  ◯ dashboard-task-9
  ◯ main

[MCP]
  2 servers · 15 tools
  filesystem    ✓ 12
  brave-search  ✓ 3

[Skills]  7 · ~15k tok if all read
  superpowers (6)
    brainstorming                       ▆  finish-pr                           █  finish-stack                        ▅
    merge                               ▄  open-pr                             ▃  rebase                              ▃
  personal (1)
    coordinator                         ▄

[Context]  /Users/joel/Code/pi-extensions/AGENTS.md
[Prompts]  2 · /parallel-cleanup, /review
```

Press `ctrl+o` to expand. The skills list gains descriptions; skills are sorted
alphabetically within each scope group. The bar glyph is relative to the largest
skill in the session, so the tallest bar always reaches `█` regardless of
absolute size.

Expanded view:

```
[Skills]  7 · ~15k tok if all read
  superpowers (6)
    brainstorming ▆
      explores intent before coding
    finish-pr █
      finish a PR for peer review
    finish-stack ▅
      finish a graphite stack
    merge ▄
      merge a PR
    open-pr ▃
      open a PR
    rebase ▃
      rebase a branch
  personal (1)
    coordinator ▄
      orchestrate multiple worktree agents

[Context]
  /Users/joel/Code/pi-extensions/AGENTS.md
[Prompts]
  /parallel-cleanup
  /review
[Extensions]
  worktree, mcp
```

*Capture produced by calling `renderDashboard` directly with real panels from
`mcpPanelLines` and `locationLines` — not hand-drawn.*

## The `quietStartup` requirement

pi's own `[Context]/[Skills]/[Prompts]/[Extensions]` listing lives in a
separate container that `setHeader` cannot reach. The only switch that suppresses
it is the `quietStartup` setting in `~/.pi/agent/settings.json`. Until that is
set, pi shows both screens on startup, and the dashboard notifies you once to
run `/dashboard setup`.

Run once to write the setting:

```
/dashboard setup
```

Then restart pi. After that, the dashboard is the only thing on screen.

The command leaves every other key in `settings.json` untouched. If the file
cannot be parsed, it refuses to overwrite it and reports why — the user's entire
configuration lives there and a rewrite would silently discard it.

## Skills data and format stability

Skills come from the system prompt, not from any extension API. `skills.ts`
parses the `<available_skills>` block that pi injects; `sizes.ts` `stat`-s the
SKILL.md files to estimate tokens.

That format is internal to pi and not a public contract. If it changes, the
skills panel degrades gracefully: a block pi changed the shape of shows
`[Skills]  unavailable (pi format changed)` rather than an error or empty
screen. `tests/dashboard/skills.test.mjs` round-trips through pi's exported
`formatSkillsForPrompt`, so a format change fails the test suite before it
silently empties the panel in production.

## Publishing a panel

Any extension can contribute a section. Register it once during `session_start`,
and the dashboard picks it up automatically:

```typescript
import { registerPanel, resetPanels } from "../lib/panels.ts";

pi.on("session_start", async (_event, ctx) => {
	// Clear this extension's panels before re-registering, so a /new or resume
	// does not accumulate duplicates.
	resetPanels("my-extension");

	const lines = await fetchMyData(ctx);
	registerPanel({
		id: "my-extension.main",
		owner: "my-extension",
		title: "My Panel",
		order: 10,          // lower order renders higher on the screen
		render: (width) => lines,
	});
});
```

Two invariants the `Panel` contract requires: `render` must not throw (a
throwing panel takes the whole header down), and `render` must return plain text
with no ANSI escape sequences (the caller clips lines to width using visible
column counts).

Panels are stored in `globalThis` via a well-known symbol, so the registry
survives across module instances — it works even if the extension and the
dashboard happen to load from different module graphs.

If your data updates asynchronously (a network call, a timer), call
`updatePanel(id)` when it changes; the dashboard repaints without re-calling
`session_start`.

## Known gap: command-less extensions

The `[Extensions]` section (visible in expanded mode) lists extensions that
registered at least one slash command. Extensions that only register tools, or
that only listen to events, do not appear there. This is a limitation of what
`pi.getCommands()` returns, not a deliberate design choice.

## Files

```
dashboard/index.ts      wiring only: event handlers and the /dashboard command
dashboard/skills.ts     recover loaded skills from the system prompt
dashboard/sizes.ts      estimate what each skill costs to read
dashboard/layout.ts     multi-column rows that never wrap
dashboard/render.ts     the screen itself — pure, easily testable
dashboard/mascot.ts     the block-glyph pi mascot
dashboard/settings.ts   write quietStartup to the pi agent settings file
lib/panels.ts           shared registry for extension-contributed panels
```

## Tests

```bash
cd ~/Code/pi-extensions
node tests/run-all.mjs dashboard     # this extension only
npm test                             # the whole collection
```

Seven files under `tests/dashboard/`. `settings.test.mjs` tests the settings
writer against a real temp file, including the guard against overwriting a
corrupt config. `wiring.test.mjs` drives `index.ts` through a fake `pi` with
real sessions and real skill sizes, checking collapse/expand, panel updates,
the superseded-session invariant, and command routing.
