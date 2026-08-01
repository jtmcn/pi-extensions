# pi extensions

Personal extension collection.

The repo lives at `~/Code/pi-extensions` and is symlinked into pi's discovery
path, so a plain `git clone` + one symlink sets up a new machine:

```bash
git clone <url> ~/Code/pi-extensions
ln -s ~/Code/pi-extensions ~/.pi/agent/extensions
```

pi follows the symlink and loads everything normally.

## Layout

```
extensions/
├── lib/                shared helpers — NOT an extension (no index.ts, never loaded)
│   └── git.ts          git plumbing: layout detection, worktree listing, dirt checks
├── mcp/                an extension (loaded via mcp/index.ts)
│   ├── index.ts
│   ├── client.ts
│   ├── config.ts
│   ├── bridge.ts
│   └── README.md
├── tests/              test harness for the collection (jiti, plain node)
│   ├── package.json
│   ├── fixtures/       fake servers etc. used by tests
│   ├── mcp.test.mjs
│   └── worktree.test.mjs
├── typecheck.sh        tsc over every extension (no build step otherwise)
└── worktree/           an extension (loaded via worktree/index.ts)
    ├── index.ts
    ├── config.ts
    ├── focus.ts
    ├── select.ts
    ├── worktrees.ts
    └── README.md
```

Discovery only picks up `*.ts` and `*/index.ts` at the top level, so `lib/` and
`tests/` are safe as plain support directories.

## Extensions

| Name | What it does |
|---|---|
| [`mcp`](mcp/README.md) | MCP client: spawn stdio MCP servers and expose their tools as native pi tools. |
| [`worktree`](worktree/README.md) | Manage git worktrees; optionally redirect the agent's tool calls into one without restarting the session. |

## Conventions

Things worth keeping consistent as this grows:

- **Shared code goes in `lib/`.** Import it as `../lib/thing.ts` with the
  explicit `.ts` extension — jiti resolves it, and it matches pi's own style.
- **Keep the rewriting/decision logic pure.** `worktree/focus.ts` and
  `worktree/select.ts` are the template: no I/O, no pi types, trivially
  testable. The `index.ts` does the wiring, everything else stays a library.
- **Reset all session state in `session_start`.** Extension closures outlive
  the session they were created for — `/new` and resume re-fire `session_start`
  against a different transcript. Anything not explicitly cleared leaks into
  the next session.
- **Persist state with `pi.appendEntry`, not `pi.sendMessage`.** A custom
  message sent with `deliverAs: "nextTurn"` is only queued in memory and is
  lost if the session reloads before the next prompt. Use an entry for the
  state and a message only to tell the model.
- **Never touch a captured `ctx` from a timer or async callback that can
  outlive the turn.** It throws "extension ctx is stale" after session
  replacement or shutdown and takes down the process. Clear UI on the `input`
  or `session_shutdown` event instead of `setTimeout`.
- **Guard UI on `ctx.hasUI`, and handle print mode.** `notify` / `setWidget`
  are no-ops when `hasUI` is false, so a command run under `pi -p` produces
  silence unless you also write to stdout when `ctx.mode === "print"`.
- **Project-local config requires `ctx.isProjectTrusted()`.** Read
  `~/.pi/agent/<name>.json` unconditionally; read `<project>/.pi/<name>.json`
  only when trusted.
- **Warn, don't throw, on bad config.** Collect warnings and fall back to
  defaults; a malformed JSON file should not break session startup.
- **Give the model the safe half of a feature.** Tools registered for the LLM
  should do reversible, additive things (create a worktree); state that changes
  the user's environment (focus) stays behind a slash command.

## Type checking

There is no build step — pi loads TypeScript through jiti — so this is the only
thing that catches type errors:

```bash
./typecheck.sh
```

It generates a tsconfig pointing at the globally installed pi package (whose
path differs per machine, which is why the config is not committed) and runs
`tsc --noEmit --strict` over `lib/` and every extension directory.

## Tests

```bash
cd tests && npm install && node worktree.test.mjs

# optionally exercise a real bare-layout checkout
PI_TEST_BARE_REPO=~/Code/hellos node worktree.test.mjs
```
