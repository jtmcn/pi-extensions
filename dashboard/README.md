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
  ~/Code/pi-extensions  ⑂ dashboard-skill-list  · 2 files dirty
  ◉ dashboard-skill-list
  ◯ main

[MCP]
  2 servers · 15 tools
  filesystem    ✓ 12
  brave-search  ✓ 3

[Skills]  22 · ~43k tok if all read
  superpowers (14)
    brainstorming                  ▃  dispatching-parallel-agents    ▂  executing-plans                ▁
    finishing-a-development-branch ▃  receiving-code-review          ▂  requesting-code-review         ▁
    subagent-driven-development    █  systematic-debugging           ▃  test-driven-development        ▃
    using-git-worktrees            ▂  using-superpowers              ▁  verification-before-completion ▂
    writing-plans                  ▂  writing-skills                 █
  personal (7)
    coordinator  ▃  finish-pr    ▅  finish-stack ▂  merge        ▁  open-pr      ▁  rebase       ▁
    worktree     ▂
  pi-subagents (1)
    pi-subagents ▁

[Context]  /Users/joel/Code/pi-extensions/AGENTS.md
[Prompts]  2 · /parallel-cleanup, /review
```

Press `ctrl+o` to expand. The skills list gains descriptions; skills are sorted
alphabetically within each scope group. The bar glyph is relative to the largest
skill in the session, so the tallest bar always reaches `█` regardless of
absolute size.

Expanded view:

```
[Skills]  22 · ~43k tok if all read
  superpowers (14)
    brainstorming ▃
      explore intent before implementation
    dispatching-parallel-agents ▂
      run agents in parallel
    executing-plans ▁
      execute a structured plan
    finishing-a-development-branch ▃
      finish a development branch
    receiving-code-review ▂
      receive a code review gracefully
    requesting-code-review ▁
      request a code review
    subagent-driven-development █
      build with subagents
    systematic-debugging ▃
      debug methodically
    test-driven-development ▃
      write tests first
    using-git-worktrees ▂
      work with git worktrees
    using-superpowers ▁
      invoke skills correctly
    verification-before-completion ▂
      verify before claiming done
    writing-plans ▂
      write implementation plans
    writing-skills █
      write a skill file
  personal (7)
    coordinator ▃
      orchestrate multiple worktree agents
    finish-pr ▅
      finish a PR for peer review
    finish-stack ▂
      finish a graphite stack
    merge ▁
      commit, rebase, and merge
    open-pr ▁
      open a PR
    rebase ▁
      rebase a branch
    worktree ▂
      manage worktrees
  pi-subagents (1)
    pi-subagents ▁
      dispatch pi subagents

[Context]
  /Users/joel/Code/pi-extensions/AGENTS.md
[Prompts]
  /parallel-cleanup
  /review
[Extensions]
  dashboard, mcp, worktree
```

*Capture produced by calling `renderDashboard` directly with real skill files
stat'd from `~/.pi/agent/` and static panels matching the Location and MCP
extensions — not hand-drawn.*

## The `quietStartup` requirement

pi's own `[Context]/[Skills]/[Prompts]/[Extensions]` listing lives in a
separate container that `setHeader` cannot reach. The only switch that suppresses
it is the `quietStartup` setting in `getAgentDir()/settings.json` (honouring
`PI_CODING_AGENT_DIR`; typically `~/.pi/agent/settings.json`). Until that is
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

## Skills data source

Skills come from `pi.getCommands()`, not the system prompt. The reason matters:
the system-prompt approach used `formatSkillsForPrompt` internally, which drops
every skill whose frontmatter has `disable-model-invocation: true`. On a real
machine that silently hid four skills — `merge`, `open-pr`, `rebase`, and
`worktree` — exactly the ones you invoke by name rather than ask the model to
invoke. `getCommands()` returns the resource loader's list unfiltered, so the
count on the dashboard matches what pi's own skill listing shows.

`sourceInfo.path` on each command entry points at the skill's SKILL.md file,
which is what `sizes.ts` stats and what `skillScope` uses to place the skill in
a group. Because `getCommands()` is a declared type in pi's `.d.ts` rather than
free-form prompt text, there is no format-drift risk: a breaking change would
surface as a TypeScript error before it could silently empty the panel.

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
dashboard/skills.ts     skills from pi.getCommands(), context files from the system prompt
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
