# Working in this repo

A collection of pi extensions, loaded by symlinking this directory into pi's
discovery path. There is no build step — pi loads TypeScript through jiti.

## Checks

Run before claiming anything works:

```bash
npm run check      # typecheck + tests
npm run typecheck  # tsc --strict over lib/ and every extension
npm test           # all test files
```

Single file or extension while iterating:

```bash
node tests/run-all.mjs worktree      # everything under tests/worktree/
node tests/worktree/pr.test.mjs      # one file
```

`typecheck.sh` is the only thing that catches type errors, and it resolves
types out of the *globally installed* pi, so pi must be installed globally.

## Layout

```
lib/            shared helpers — NOT an extension (no index.ts, never loaded)
<name>/         an extension, loaded via <name>/index.ts
tests/          harness.mjs, fake-pi.mjs, run-all.mjs, tests/<extension>/*.test.mjs
docs/superpowers/{specs,plans}/
```

Discovery picks up `*.ts` and `*/index.ts` at the top level. **A new top-level
directory containing `index.ts` is loaded as an extension** — that is the whole
registration mechanism, and it means a scratch or template directory with an
`index.ts` in it will be loaded too. `lib/` and `tests/` are safe because they
have no `index.ts`.

## The `worktree` extension depends on jimothy

`worktree/` imports jimothy's worktree model over the `jimothy/worktrees`
subpath, so the two tools manage the same worktrees through the same code
instead of keeping a second implementation that agrees by coincidence.

The dependency is currently pinned at a jimothy **worktree**,
`/Users/joel/.jimothy/worktrees/jimothy/worktree-more-worktree`, not the main
checkout: the phase-1 work that publishes `jimothy/worktrees` is still an
unmerged PR, and the main checkout has no `dist/worktrees.js` until it lands.
This pin must be repointed at `/Users/joel/Code/jimothy` once that PR merges,
which also requires re-running `npm install` here: that is what rewrites both
`package-lock.json` and the `node_modules/jimothy` symlink to the new target,
editing `package.json` alone leaves both pointed at the old worktree.

Until the repoint happens, removing that worktree breaks every pi session that
loads this extension, and not just its worktree features: the import is at
module scope, so a missing target fails the whole module to load, taking
`/worktree`, focus, the PR monitor and the status segment down with it, not
only listing.

Two further preconditions, both of which fail confusingly when unmet:

- **jimothy's `dist/` is what is imported**, so `npm run build` in the
  dependency's checkout is required before a model change reaches a session,
  and `npm install` here must follow that build rather than precede it.
- **jimothy's own `node_modules` is part of this extension's runtime.** npm
  symlinks a `file:` dependency and never installs its dependencies, so a
  freshly cloned or cleaned jimothy breaks every session that loads this
  extension — with `Cannot find package 'proper-lockfile'`, which names
  jimothy's internals rather than the missing `npm install`.

Two rules about the lease a session takes at startup, both of which are silent
when broken:

- **The launcher variables are deleted at every `session_start`, and their
  meaning is remembered once per process.** `JIMOTHY_RUN_ID` and
  `JIMOTHY_WORKTREE` are removed from `process.env` before any tool call can
  spawn anything, because every subagent and every `pi` the model starts from
  bash inherits this environment — and one that kept them would retarget the
  live agent's lease onto its own pid, leaving the lease naming a dead process
  when it exited. What they said is kept on `globalThis`
  (`captureLauncherEnv`), not in the extension closure: `/new` re-runs the
  extension factory and `/reload` re-imports the module, so a replacement that
  read the environment again would find it already scrubbed, conclude there was
  no launcher, and release on its way out the delegated lease jimothy is still
  holding for a live run.
- **pi must stay a direct child of jimothy.** The retarget is guarded by
  `owner.pid === process.ppid`, so interposing a shell or a wrapper between
  jimothy and pi silently demotes every launched session to "held by a
  stranger" — prompt included.

Do **not** add `@earendil-works/*` to this collection's `package.json`. pi loads
extensions through jiti with an alias table that maps those specifiers onto the
*running* pi, and a local copy would be shadowed by that alias in some paths and
win in others.

## Adding an extension

1. `mkdir <name>` with an `index.ts` default-exporting the extension factory.
2. Keep decision logic in pure modules; `index.ts` does the wiring only.
   `worktree/focus.ts` and `worktree/select.ts` are the template.
3. Add `tests/<name>/<name>.test.mjs` importing `../harness.mjs` — no script to
   edit, `run-all.mjs` discovers it.
4. Write a `<name>/README.md` and add a row to the table in the root README.
5. `npm run check`.

## Conventions

The full list with reasoning is in [README.md](README.md#conventions). The ones
that have actually caused bugs here:

- **Reset all session state in `session_start`.** Extension closures outlive
  their session; `/new` and resume re-fire it against a different transcript.
- **Never touch a captured `ctx` from a timer or async callback that can
  outlive the turn.** It throws "extension ctx is stale" and takes down the
  process. Clear UI on `input` or `session_shutdown` instead.
- **Persist with `pi.appendEntry`, not `pi.sendMessage`.** A `nextTurn` message
  is in-memory only and is lost if the session reloads.
- **Guard UI on `ctx.hasUI`** and also write to stdout when `ctx.mode ===
  "print"`, or the feature is silent under `pi -p`.
- **Project-local config requires `ctx.isProjectTrusted()`.**
- **Warn, don't throw, on bad config.** Malformed JSON must not break startup.
- **Give the model the safe half of a feature.** Reversible/additive actions
  can be tools; anything that changes the user's environment stays a slash
  command.

## Testing notes

- `tests/harness.mjs` provides `assertions()`, `loadExt()`, `execRunner()`,
  `fakeRunner()`, and `pexec`. Import them rather than re-implementing.
- Prefer real behaviour over mocks where it is cheap: the tests run real git in
  throwaway repos and only script the network half.
- To test `index.ts` wiring, use `tests/fake-pi.mjs`: `createFakePi()` returns a
  `pi` to hand the factory plus `fire()`, `call()`, `command()`, and recorders
  for everything it paints, says, or persists. **`fire("session_start")` mints a
  fresh `ctx`, as pi does** — so a superseded session writing through its stale
  `ctx` is detectable. A harness that reuses one `ctx` silently cannot catch
  that, which is the most common real bug in this repo.
- Prefer injected dependencies to a fake `pi` where you can: `commands.ts`,
  `session.ts`, `pr-monitor.ts`, and `ui.ts` are all tested without one.
- **Break a new test on purpose before trusting it.** Six tests in this repo's
  history passed for the wrong reason and were only caught by mutating the code
  under them. If the mutation still passes, the test is decoration.
