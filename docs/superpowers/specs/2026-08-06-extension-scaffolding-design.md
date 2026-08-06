# Scaling the repo for more extensions

## Problem

The layout (`<extension>/`, `lib/`, `tests/`) matches pi's discovery rules and
works. The tooling around it does not scale: adding an extension means
hand-editing a test script, copy-pasting ~60 lines of harness boilerplate, and
remembering to run two commands that nothing enforces.

Concretely, before this change:

- `typecheck.sh` included `$root/*/[!.]*.ts` — one level deep. A file at
  `mcp/sub/bad.ts` containing `export const x: number = "not a number"` passed
  `./typecheck.sh` with `typecheck: ok`. Verified, not theorized.
- `tests/package.json` chained five test files with `&&`, so the first failure
  aborted the rest and every new extension required editing the string.
- `resolvePiEntry()` and the `ok()` assertion helper were byte-identical in all
  five test files; the jiti alias block was near-identical.
- Test names did not identify their extension: `pr`, `gh`, and `pr-status` are
  all `worktree`.
- No single entry command, no CI, so both checks were optional in practice.
- No `AGENTS.md`, so the conventions an agent most needs sat in `README.md`
  where nothing directs it to look.

## Non-goals

- **Extracting a shared config loader.** `worktree/config.ts` and
  `mcp/config.ts` do implement the same defaults → global → trusted-project
  precedence pattern, but two copies is not enough evidence to fix the shared
  shape. Revisit at extension #3.
- **Migrating to `node:test`.** Real isolation and filtering are worth having
  eventually, but not at the cost of rewriting ~1600 lines of working tests to
  solve a problem (slow suites) that has not appeared.
- **Adding a linter.** `.editorconfig` pins whitespace; biome is not installed
  and nothing currently needs it. Note that `tests/pr.test.mjs` carries a
  vestigial `biome-ignore` comment with no biome in the repo.

## Design

### 1. Recursive typecheck

`typecheck.sh` includes `$root/**/*.ts` and excludes `**/node_modules/**`.
Nested extension files are checked instead of silently skipped.

Verification is a red-green cycle on the known failing case: `mcp/sub/bad.ts`
must make `./typecheck.sh` exit non-zero, and removing it must restore `ok`.

### 2. `tests/harness.mjs`

One module holding what the five files duplicated:

- `piEntry()` — `PI_DIST` override, else resolve `npm root -g`.
- `loadExt()` — a jiti importer with the pi, `typebox`, and `pi-ai` aliases
  pre-wired, including the nested-entry resolution jiti needs for packages
  installed next to pi rather than next to the tests.
- `assertions()` — returns `{ ok, done }`; `done` prints the summary and exits
  with the right code, replacing the copied tail.
- `execRunner()` — a real-subprocess runner in the shape `pi.exec` provides.
- `fakeRunner(result)` — a canned-result runner that records its calls.

Test-specific setup (tmp repo construction, scripted multi-call runners) stays
in the test that needs it. The harness absorbs only what was already identical.

### 3. Glob runner

`tests/run-all.mjs` discovers `**/*.test.mjs`, runs each as a child process,
and aggregates results. Consequences: one failing file no longer hides the
others, and a new extension's tests are picked up with no script edit.

### 4. Per-extension test directories

`tests/<extension>/<topic>.test.mjs`, so ownership is legible and the runner's
glob does the wiring:

    tests/harness.mjs
    tests/run-all.mjs
    tests/mcp/mcp.test.mjs
    tests/worktree/{worktree,pr,gh,pr-status}.test.mjs
    tests/fixtures/fake-mcp-server.mjs

### 5. One entry command

A private, dependency-free root `package.json`:

- `npm run typecheck` → `./typecheck.sh`
- `npm test` → install test deps, then `run-all.mjs`
- `npm run check` → both

### 6. CI

A GitHub Actions workflow installing pi globally (`typecheck.sh` resolves types
out of the global install) and running `npm run check` on push and PR. This is
the piece that makes the checks non-optional rather than remembered.

### 7. `AGENTS.md` and `.editorconfig`

`AGENTS.md` states the check commands, the layout rule, and the load-bearing
conventions, linking `README.md` for the full list. `.editorconfig` pins tabs
to match the existing files.

## Success criteria

- `./typecheck.sh` fails on a nested type error and passes without one.
- `npm run check` from the root runs both checks.
- The suite still reports **251 assertions across 5 files, 0 failures**
  (gh 31, mcp 67, pr-status 21, pr 43, worktree 89) — the pre-refactor baseline.
- `run-all.mjs` reports a non-zero exit and still runs every other file when one
  file fails.
- A new extension needs no edit to any test script.
