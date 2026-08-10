# Telling herdr which branch pi is on

herdr's sidebar labels a space from its pane's `cwd` and derives the branch the
same way. In a bare-layout checkout — `~/Code/hellos/main`, the repo's own
convention — that reads `main` / `main`. It stays `main` when the session moves
to a feature branch, and it stays `main` when `/worktree focus` points pi at a
worktree, because focus never changes `ctx.cwd`: it rewrites tool inputs. So
herdr's most useful column is wrong precisely when several spaces are open and
telling them apart matters most.

pi already knows the answer. `pr-monitor` re-reads `symbolic-ref HEAD` of the
*displayed* worktree on every poll and writes it back through `setBranch`, and
`session.paint()` runs whenever that target moves. This reports the same string
to herdr.

## Behaviour

A pi session running under herdr reports its current branch to two surfaces:

| Surface | Call | Shown as |
|---|---|---|
| space sidebar row | `workspace report-metadata <ws> --source pi --token pi_branch=<branch>` | `$pi_branch` token |
| pane title | `pane report-metadata <pane> --source pi --title "π - <branch>"` | pane title / border |

"Current branch" means the branch pi displays: the focused worktree's branch
while focus is on, the session's own branch otherwise. Not a focus indicator —
an unfocused session that ran `git switch` stops saying `main` too. One rule,
and worktree focus is one of the things that changes its input.

The value has `config.branchPrefix` stripped: with `"branchPrefix": "joel/"`,
`joel/fix-parser` displays as `fix-parser`. The prefix is on every branch the
user creates and the sidebar is 18–36 columns wide. A branch under someone
else's prefix (`alice/hotfix`) is left alone. A detached HEAD clears both
surfaces rather than showing a SHA.

Nothing is reported when `HERDR_WORKSPACE_ID` / `HERDR_PANE_ID` are absent, and
nothing is reported when `ctx.hasUI` is false. A `pi -p` run borrows the user's
own shell pane for a few seconds, and `pr-monitor` does not poll without a
footer, so its branch would never refresh anyway.

### The consuming config

The token renders only if a row layout names it. In `~/.dotfiles`,
`templates/herdr-config.toml.template` gains:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$pi_branch", "git_status"]]
```

This *replaces* the built-in `branch` token rather than sitting beside it.
Keeping both is correct for spaces with no pi in them, but every pi space then
reads `fix-parser main +2`, which is both redundant and the first thing to
truncate. Spaces hosting a plain shell lose their branch row; the follow-up is a
fish hook reporting the same token from the prompt, out of scope here.

The space *label* is left alone. In a bare layout it is `basename(cwd)`, so it
still reads `main`; only `workspace rename` changes it, and that is persistent
user-visible state that would need saving and restoring on every session — a
worse failure mode than the one being fixed.

## Shape

```
worktree/session.ts   paint() → report(branch | undefined)   (injected sink)
lib/herdr.ts          createHerdrReporter({ runner, env, config })
worktree/index.ts     wires the reporter in; a no-op when not under herdr
```

`session.ts` does not learn that herdr exists. It calls an injected
`report(branch)` next to `ui.setStatus(...)` — the displayed branch, or
`undefined` for a detached HEAD, and `index.ts` decides what that
is — the shape the extension already uses for `ui`, `prMonitor` and the git
runner. `lib/herdr.ts` is a factory over an injected runner and an env object,
so its tests assert argv with no herdr installed and no socket.

The branch is never computed twice. `pr-monitor` reads it, `setBranch` stores
it, `paint` fans it out to the footer and to herdr.

### The CLI is picky

Measured against herdr 0.8.0, not documented upstream: the positional argument
comes **first**, and options take a space-separated value.

```
herdr workspace report-metadata wF --source pi --token pi_branch=fix-parser   ok
herdr workspace report-metadata --source pi --token pi_branch=x wF            "unknown option: wF"
herdr workspace report-metadata wF --source=pi                                "unknown option: --source=pi"
```

The token *value* is one `NAME=VALUE` argument, but `--source=pi` and
`--token=NAME=VALUE` are both rejected: the flag itself takes a space-separated
value. So the argv is asserted as an ordered array in the tests rather than by
substring.

## Lifecycle

Reports fire from `paint()` only: session start, focus set or cleared, and any
`HEAD` move `pr-monitor` observes. No new triggers and no new timers.

The reporter remembers the last reported branch and title and spawns nothing
when they are unchanged. `paint()` also runs on PR label changes, so without
this a 60s poll would fork two processes to repeat itself.

`session_shutdown` clears both surfaces (`--clear-token pi_branch`,
`--clear-title`).

**No TTL**, deliberately, though workspace tokens support one:

- 90s does not survive idle. `pr-monitor` suspends after 15 minutes without
  input, `paint()` stops with it, and an idle session's branch would disappear
  from the sidebar.
- Keeping it alive needs a heartbeat forking `herdr` every minute forever, for a
  decoration.
- The pane title has no TTL at all, so `kill -9` strands something either way.
  One rule beats two rules and a timer.

A normal quit is clean. After `kill -9` the stale value persists until the next
pi session in that space reports over it on its first paint.

## Failure

Fire-and-forget with a 2s timeout, single flight, errors swallowed. The first
failure — no `herdr` on `PATH`, dead socket, unknown workspace id — sets
`available = false` and the reporter goes inert for the session, the same shape
`pr-monitor` uses for a missing `gh`.

Nothing here touches `ctx`, so a spawn that settles after the session has been
replaced cannot paint through a stale one; `dispose()` sets a flag that is
checked before every write, so a retired session's reporter is silent.

### Known and not fixed

Workspace tokens are per space; panes are per session. Two pi sessions in one
space on different branches overwrite each other's token, and the sidebar shows
whichever painted last. Pane titles remain individually correct.

## Testing

`tests/worktree/herdr.test.mjs` — a `fakeRunner()` and an env object, no fake
`pi`, no socket, in the shape of `gh.test.mjs`. Discovered by `run-all.mjs`;
lib helpers are tested alongside their consumer here, as `lib/git.ts` is.

| Case | Assertion |
|---|---|
| argv shape | exact ordered argv, positional first, `--token pi_branch=<v>` |
| no herdr env | zero runner calls across several reports |
| prefix stripping | `joel/fix-parser` → `fix-parser`; `alice/hotfix` untouched |
| detached HEAD | clears both surfaces |
| dedupe | three identical reports → one call per surface; a changed branch → one more |
| failure disables | first call rejects → no further calls, nothing thrown |
| dispose | reports after `dispose()` spawn nothing |
| `hasUI` false | inert |
| shutdown | both clears issued |

One wiring test through `tests/fake-pi.mjs`: `session_start` under herdr env
reports; `/worktree focus <name>` reports the worktree's branch; a second
`session_start` proves the superseded session's reporter is disposed and silent.
A fresh `ctx` per `session_start`, as pi mints one.

Each test is then broken on purpose — argv order flipped, dedupe removed,
`disposed` check deleted — and must fail before it is trusted.

## Docs

`worktree/README.md` gains a short section next to "PR in the status bar", and
the root README table is unchanged: no new extension, no new command, no new
tool. The dotfiles change ships with its own note in that repo.
