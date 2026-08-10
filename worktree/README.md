# worktree

Git worktree management for pi, plus an opt-in "focus" mode that points the
agent at a worktree without restarting the session.

## Why focus mode exists

`ctx.cwd` is fixed for the life of a pi session — there is no API to move a
running session into another directory. So "switch to a worktree" is
implemented by rewriting tool inputs on the way in:

| Tool | Rewrite |
|---|---|
| `bash` | command is prefixed with `cd '<worktree>' \|\| exit 1` |
| `read` `write` `edit` `ls` `find` `grep` | relative `path` resolves against `<worktree>` |
| same | absolute `path` inside the *session's own* worktree is remapped across |
| same | `ls` / `find` / `grep` with no `path` default to `<worktree>` |

Anything else is left alone. Absolute paths outside the session worktree —
other worktrees, `/tmp`, system files — pass through untouched, so this is a
redirect, **not a sandbox**. Focus changes are announced to the model so it
knows where it is working.

Focus is written to the session transcript as a custom entry the moment it
changes, so it survives `/reload` and resume. On restore the worktree is
re-checked: if it was removed by another session, focus is cleared with a
warning rather than turning every `bash` call into `cd '<gone>' || exit 1`.
Focus is *not* inherited by a new session (`/new`).

All of that is covered by `tests/worktree/restore.test.mjs`. Note that a
slash-command-only `pi -p` run persists no transcript at all, so restore cannot
be observed by running `pi -p` twice — which looks exactly like the feature being
broken. Matching is also by exact path string: paths come from git and are
already resolved, but a hand-written `/var` vs `/private/var` will not match.

## Commands

```
/worktree                 interactive menu
/worktree list            worktrees for this repo, with dirty counts
/worktree new <name> [base]   create worktree + branch, then focus it
/worktree checkout <branch> [name]  worktree for an existing branch
/worktree focus <name>    redirect tool calls into a worktree
/worktree focus off       stop redirecting
/worktree remove <name>   remove a worktree (prompts about dirt and the branch)
/worktree prune           prune stale worktree metadata
/worktree config          show effective configuration and where it came from
```

`focus` and `remove` autocomplete worktree names. A name is matched by exact
path, directory name or branch first, then by unique prefix; an ambiguous
prefix is reported rather than resolved to whichever worktree git listed first.
In non-interactive mode (`pi -p`) only exact matches are accepted, since there
is no confirmation prompt.

Names are slugified, and quoting works, so `/worktree new "My Feature!"`
creates `my-feature`. The second token is the base ref, so an unquoted
multi-word name is an error rather than a mystery branch.

With no name, the prompt is prefilled with a suggestion: the newest thing you
asked for, reduced to up to three content words (`fix-parser-bug`), trimmed
to fit a 24-character cap, or an adjective–noun pair (`brave-otter`) when the
conversation has nothing to go on. Press Enter to take it, or type over it.
Short acknowledgements are skipped, so approving a plan and then running
`/worktree new` still names the work rather than the approval. A suggestion that
collides with an existing worktree or a branch checked out in one is offered as
`-2`; a branch that exists but is checked out nowhere is deliberately reused.
A name you type yourself is never adjusted, it fails.
Non-interactively (`pi -p`) the suggestion is used without asking, where the
command previously did nothing at all.

When focused, the footer shows `⑂ <name> (<branch>)`.

## An existing branch

`/worktree checkout <branch> [name]` is the counterpart to `new`: `new` makes a
branch, `checkout` takes one that exists. The argument is a local branch, a
fully qualified remote ref (`origin/alice/hotfix`), or a branch name that is
unambiguous across remotes. With no argument you get a picker; non-interactively
a branch name is required, as for `focus` and `remove`.

Resolution is local-first, and that is load-bearing: a local branch may hold
commits the remote does not, so `checkout origin/foo` with a local `foo` checks
out your `foo` untouched and says so, rather than resetting anything.

The network is touched only on a miss — one `git fetch` of the relevant remote,
then one retry. So the common case costs nothing and a branch pushed a minute
ago is still found. A stale remote-tracking ref is the accepted gap: it matches
immediately, so the worktree can start a few commits behind. A fetch that fails
is a warning, not an error.

The directory name drops the remote and `branchPrefix`, so with
`"branchPrefix": "joel/"`, `origin/joel/fix-parser` becomes `fix-parser` and
`origin/alice/hotfix` becomes `alice-hotfix`. A derived name that collides gets
`-2`; a name you pass yourself is never adjusted and fails instead. `autoFocus`
applies exactly as it does for `new`.

The model's `worktree` tool deliberately does not expose this. With auto-focus
on, checking out an existing branch could put the model to work directly on a
shared branch instead of a scratch one, so it stays a user decision — like
`focus` and `remove`.

## Tool

The model gets a `worktree` tool with `action: "list" | "create"`. It can spin
up an isolated worktree for a parallel experiment.

`create` focuses the new worktree when `autoFocus` is on (the default), so the
model keeps working where it just landed instead of threading an absolute path
through every later call. The footer shows the focus and `/worktree focus off`
undoes it. Set `"autoFocus": false` for the old behaviour, where the tool only
returns the path. The tool still cannot focus an *existing* worktree or check
out an *existing* branch — switching between worktrees, and starting work on a
branch that already exists, stay user decisions.

Note that `create` runs the configured `postCreate` command, so a model tool
call can execute the project's setup command. `postCreate` therefore only comes
from `~/.pi/agent/worktree.json` or from a **trusted** project's
`.pi/worktree.json` — the same trust boundary as the rest of pi's project
config.

## Layouts

The project root is derived from `git rev-parse --git-common-dir`, so all three
layouts work and new worktrees always land in the right place:

```
repo/.git/              ordinary repo          -> repo/<config.path>
repo/.git (file)        linked worktree        -> main repo root/<config.path>
proj/.bare + proj/main  bare layout            -> proj/<config.path>
```

## Configuration

Later files win:

1. built-in defaults
2. `~/.pi/agent/worktree.json`
3. `<projectRoot>/.pi/worktree.json` — **trusted projects only**

```jsonc
{
  // Where worktrees go. Relative to the project root. "{name}" is substituted;
  // without it the name is appended. The default matches the Claude Code
  // convention so both agents find the same worktrees in a shared checkout.
  "path": ".claude/worktrees",

  // Prepended to branch names created by /worktree new.
  "branchPrefix": "joel/",

  // Copied from the current worktree into a new one. Useful for gitignored
  // local config that a fresh checkout would be missing.
  "copyFiles": [".env", ".env.local"],

  // Shell command run inside a newly created worktree. Executed via `bash -lc`,
  // including when the model creates a worktree through the tool.
  "postCreate": "npm install",

  // Focus a newly created worktree automatically — both `/worktree new` and the
  // model's `worktree` tool.
  "autoFocus": true,

  // Remap absolute paths under the session worktree while focused.
  "remapAbsolutePaths": true,

  // Start point for new branches. Defaults to origin/HEAD, then main/master.
  "defaultBase": "main"
}
```

## PR in the status bar

When the current branch has a pull request, the status segment shows it:

```
⑂ main (joel/ont-mount-constant) #26904 open ●    ← worktree focused
#26904 open ●                                     ← no focus
```

The PR text is an OSC 8 hyperlink to the Graphite PR page
(`app.graphite.com/github/pr/<owner>/<repo>/<number>`); cmd-click it in a
terminal that supports hyperlinks. The glyph is the CI rollup: `✓` all passed,
`✗` something failed, `●` still running, absent when there are no checks. The
state word is `open`, `draft`, `merged`, or `closed`.

Unfocused sessions show the PR alone, because pi's own footer line already
reads `<pwd> (<branch>)`.

Data comes from `gh pr list --head <branch> --state all`, refreshed every 60s
while the PR is open, every 5 min when the branch has no PR, and never once it is
merged or closed. (`gh pr view <branch>` would be shorter, but its argument is
parsed as a PR number first, so a branch named `1234` would show PR #1234.) When
a reused branch has several PRs, the open one wins, else the newest.
Polling suspends after 15 minutes without input and resumes on the next one. A
`gt submit`, `gh pr create`, or `git push` schedules a refresh 8s later so a new
PR appears promptly.

Everything fails silently: no `gh`, not logged in, no network, or a non-GitHub
remote simply means no PR text.

## herdr

[herdr](https://herdr.dev) labels a space from its pane's `cwd` and derives the
branch the same way, so a bare-layout checkout (`~/Code/hellos/main`) reads
`main` — and keeps reading `main` after `git switch`, and after `/worktree
focus`, since focus never changes `cwd`.

When pi runs inside herdr with a UI, the branch on the footer is also reported
to it, on every paint:

```
herdr workspace report-metadata $HERDR_WORKSPACE_ID --source pi --token pi_branch=<branch>
herdr pane report-metadata $HERDR_PANE_ID --source pi --title "π - <branch>"
```

The value is the branch pi displays — the focused worktree's, else the
session's — with `branchPrefix` stripped, since it is on every branch you make
and the sidebar is 18–36 columns wide. A detached HEAD clears both rather than
showing a SHA. Unchanged branches cost nothing: the reporter dedupes, so the
60s PR poll does not fork a process to repeat itself.

The token renders only if a row layout names it:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$pi_branch", "git_status"]]
```

That replaces herdr's built-in `branch` token. Keeping both is correct for
spaces with no pi in them, but every pi space then reads `fix-parser main`.

Nothing is reported outside herdr, or under `pi -p`. The first failure — no
`herdr` on `PATH`, a dead socket — switches it off for the session, like a
missing `gh`. `session_shutdown` clears both surfaces; a `kill -9` leaves the
last value on screen until the next pi session in that space reports over it.

Two known gaps: workspace tokens are per space, so two pi sessions in one space
show whichever painted last (pane titles stay right), and the space *label* is
left alone — it is `basename(cwd)`, and only `workspace rename` changes it,
which is persistent state a crash would strand.

## Files

```
lib/git.ts               shared git helpers (used by other extensions too)
lib/herdr.ts             reporting the displayed branch to herdr (pure + one CLI)
worktree/index.ts        wiring only: event handlers and registration
worktree/session.ts      per-session state, focus, and the session's monitor
worktree/pr-monitor.ts   the PR status state machine
worktree/commands.ts     /worktree and its completions
worktree/tool.ts         the model-facing tool
worktree/ui.ts           notifications, reports, status segment
worktree/config.ts       config loading and path templating
worktree/branches.ts     branch listing, resolution and naming (pure + two git calls)
worktree/focus.ts        tool-input rewriting (pure, heavily tested)
worktree/select.ts       argument parsing and name matching (pure)
worktree/suggest.ts      the generated name offered by `new` (pure)
worktree/worktrees.ts    create / remove / prune
worktree/pr.ts           PR display formatting and poll cadence (pure)
worktree/gh.ts           the gh calls behind the PR status display
```

The shape to preserve: `index.ts` wires, `session.ts` owns state with a
lifetime, and everything else is a factory over injected dependencies. A session
is never *reset* — `session_start` disposes the outgoing one and builds a new
one, so a field cannot be left behind, and a fetch or timer belonging to a
replaced session cannot paint through a `ctx` that pi has since made stale.

## Tests

```bash
cd ~/Code/pi-extensions
node tests/run-all.mjs worktree     # this extension only
npm test                            # the whole collection
```

Thirteen files under `tests/worktree/`. `worktree.test.mjs` runs against throwaway
repos in `$TMPDIR`, covering both plain and bare layouts, plus pure-function
tests for focus rewriting, argument parsing, name matching and config
precedence. Set `PI_TEST_BARE_REPO` to also check a real bare-layout checkout on
this machine. `branches.test.mjs` covers resolution and naming as pure
functions — local-wins, multi-remote ambiguity, a slash-containing remote
name — plus `listBranches` and `fetchRemote` against a real clone, including a
branch pushed after the clone that only a fetch can reveal. `pr.test.mjs`,
`gh.test.mjs`, and `suggest.test.mjs` cover the PR display and its `gh` calls,
and name suggestion; all pure or fake-runner tests with no network or
subprocesses.
`pr-monitor.test.mjs`, `session.test.mjs`, and `ui.test.mjs` cover the three
extracted units directly, with injected runners and clocks and no fake `pi` at
all — single flight, the pending re-run, backoff, idle suspension, disposal,
focus persistence, and the `hasUI` × print matrix.

`herdr.test.mjs` covers the reporter as a fake-runner unit — argv order, prefix
stripping, deduping, and the first-failure switch-off — and
`herdr-wiring.test.mjs` covers when a reporter exists at all: under herdr, with
a UI, cleared at shutdown.

`restore.test.mjs` covers restoring focus from the transcript through a fake
`pi` with real git: the last entry winning, a cleared entry meaning unfocused,
and a worktree removed by another session being dropped with a warning.

`pr-status.test.mjs` remains the integration test: it drives `index.ts` through a
fake `pi` with real git in a throwaway repo and scripted `gh`, asserting the
branch re-read and repaint, the error backoff, the `hasUI` gate, and that a
session replaced mid-fetch never paints through its stale `ctx`. It builds a
fresh `ctx` per `session_start`, as pi does, because sharing one would hide that
last class of bug entirely.
