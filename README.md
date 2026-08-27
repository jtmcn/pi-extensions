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
├── AGENTS.md           checks, layout rules, and the load-bearing conventions
├── package.json        private; exists only to give the checks one entry point
├── lib/                shared helpers — NOT an extension (no index.ts, never loaded)
│   └── git.ts          git plumbing: layout detection, worktree listing, dirt checks
├── delta/              an extension (loaded via delta/index.ts)
│   ├── index.ts
│   ├── ansi.ts
│   ├── bash-result.ts
│   ├── body.ts
│   ├── cache.ts
│   ├── config.ts
│   ├── detect.ts
│   ├── engine.ts
│   ├── footer.ts
│   ├── render-rules.ts
│   ├── run.ts
│   ├── shell.ts
│   └── README.md
├── tests/              test harness for the collection (jiti, plain node)
│   ├── package.json
│   ├── harness.mjs     assertions, extension loading, fake runners
│   ├── fake-pi.mjs     a fake `pi` for testing index.ts wiring
│   ├── run-all.mjs     discovers and runs every **/*.test.mjs
│   ├── fixtures/       fake servers etc. used by tests
│   └── worktree/
│       ├── gh.test.mjs
│       ├── pr.test.mjs
│       ├── pr-status.test.mjs
│       └── worktree.test.mjs
├── typecheck.sh        tsc over every extension (no build step otherwise)
└── worktree/           an extension (loaded via worktree/index.ts)
    ├── index.ts
    ├── branches.ts
    ├── config.ts
    ├── focus.ts
    ├── gh.ts
    ├── pr.ts
    ├── select.ts
    ├── worktrees.ts
    └── README.md
```

Discovery only picks up `*.ts` and `*/index.ts` at the top level, so `lib/` and
`tests/` are safe as plain support directories. The flip side: any new top-level
directory with an `index.ts` in it *is* an extension, including a scratch or
template one.

Tests live in `tests/<extension>/` and are discovered by glob, so adding an
extension means adding a directory and a test file — no script to edit.

## Extensions

| Name | What it does |
| --- | --- |
| [`dashboard`](dashboard/README.md) | Startup screen: mascot, location and Graphite stack, loaded skills grouped by source with size bars, and MCP server health. Run `/dashboard setup` once to suppress pi's built-in listing. |
| [`delta`](delta/README.md) | Renders `git diff` output and `edit` diffs with the delta pager instead of pi's built-in diff styling. |
| [`worktree`](worktree/README.md) | Manage git worktrees; optionally redirect the agent's tool calls into one without restarting the session. Shows the branch's PR in the status bar. |

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

## Checks

```bash
npm run check      # typecheck + tests — run this before committing
npm run typecheck
npm test
```

CI runs `npm run check` on every push and pull request
([.github/workflows/check.yml](.github/workflows/check.yml)); it installs pi
globally first, because that is where both checks resolve pi from.

### Type checking

There is no build step — pi loads TypeScript through jiti — so `./typecheck.sh`
is the only thing that catches type errors. It generates a tsconfig pointing at
the globally installed pi package (whose path differs per machine, which is why
the config is not committed) and runs `tsc --noEmit --strict` recursively over
`lib/` and every extension directory.

The glob is recursive deliberately. It was once `*/[!.]*.ts`, and because
tsconfig glob syntax has no character classes, that pattern matched *nothing* —
the script reported success while checking a single file.

### Tests

```bash
npm test                             # everything
node tests/run-all.mjs worktree      # one extension
node tests/worktree/pr.test.mjs      # one file
```

One failing file does not stop the others. Optional extras:

```bash
# exercise a real bare-layout checkout
PI_TEST_BARE_REPO=~/Code/hellos node tests/worktree/worktree.test.mjs
```

New test files import `tests/harness.mjs` for assertions, extension loading, and
fake runners rather than re-implementing them, and `tests/fake-pi.mjs` when they
need to drive an `index.ts` through real events.
