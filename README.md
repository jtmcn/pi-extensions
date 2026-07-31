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
├── tests/              test harness for the collection (jiti, plain node)
│   ├── package.json
│   └── worktree.test.mjs
└── worktree/           an extension (loaded via worktree/index.ts)
    ├── index.ts
    ├── config.ts
    ├── focus.ts
    ├── worktrees.ts
    └── README.md
```

Discovery only picks up `*.ts` and `*/index.ts` at the top level, so `lib/` and
`tests/` are safe as plain support directories.

## Extensions

| Name | What it does |
|---|---|
| [`worktree`](worktree/README.md) | Manage git worktrees; optionally redirect the agent's tool calls into one without restarting the session. |

## Conventions

Things worth keeping consistent as this grows:

- **Shared code goes in `lib/`.** Import it as `../lib/thing.ts` with the
  explicit `.ts` extension — jiti resolves it, and it matches pi's own style.
- **Keep the rewriting/decision logic pure.** `worktree/focus.ts` is a good
  template: no I/O, no pi types, trivially testable. The `index.ts` does the
  wiring, everything else stays a library.
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

There is no build step — pi loads TypeScript through jiti. To type check
manually:

```bash
cd ~/Code/pi-extensions
npx -p typescript@5.7 -p @types/node tsc --noEmit --strict \
  --module esnext --moduleResolution bundler --allowImportingTsExtensions \
  --skipLibCheck lib/*.ts worktree/*.ts
```

(Module paths resolve through the globally installed pi package.)

## Tests

```bash
cd tests && npm install && node worktree.test.mjs
```
