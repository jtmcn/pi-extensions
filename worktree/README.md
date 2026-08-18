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
/worktree adopt [path]    take an existing (unmanaged) worktree into the registry
/worktree prune           prune stale worktree metadata
/worktree config          show effective configuration and where it came from
```

For the `/worktree` command, which worktrees exist is answered by jimothy's
registry, not by a raw `git worktree list`: one jimothy created or adopted is
shown under the name the registry gave it, with its status (held, provisioned,
or not), and anything else is listed too but labelled `unmanaged` — jimothy will
not provision, lease or remove it until it is adopted. `/worktree adopt [path]`
is what makes those rows actionable: it takes an existing worktree into the
registry in place (nothing moves), deriving its name from the directory unless
one is given, and records `branchCreated: false` so a later `/worktree remove`
never deletes a branch jimothy did not make. With no path and a UI it offers a
picker of the unmanaged worktrees, excluding the repository's main working tree
and any bare entry; without a UI a path is required, since there is no
transcript to derive one from as `new` does. A worktree that is already
managed, is the main working tree, is bare, or is on a detached HEAD is
refused — `WorktreeRecord.branch` is required, and every renderer and
`remove`'s branch logic assume it exists, so a detached worktree cannot be
adopted at all, not even readably. The repository's main working tree is one of
those unmanaged rows for a different reason: jimothy leaves it out of its own
listing because nothing it does applies to it, and this extension puts it back,
because it has always been listable and focusable — it is excluded from what
`/worktree adopt` offers and refused if named explicitly. The model's
`worktree` tool's `list` action renders through the same `describeKnown` this
command does, so the model and the user read the same spelling of the same
worktree — including the `unmanaged` label, the model's only cue that
`/worktree adopt` exists (the tool itself cannot adopt anything).

Reading the registry this way is not free of side effects: the reconciling read
behind `/worktree list`, `focus`, `remove`, `new`, `checkout` and `prune` takes
the registry's lock and rewrites `registry.json` at the repository's common
dir, so the first of those commands in any repository creates that file —
including for a user who has never run jimothy directly. Session start avoids
that cost by seeding completions from the lock-free snapshot instead, which
has no unmanaged half: in a repository with nothing jimothy manages, `focus
<tab>` offers only `off` and `remove <tab>` offers nothing until the first
`/worktree` command that lists refills the cache.

A session also takes jimothy's *lease* on the worktree it is going to write to,
at session start. The lease is the mechanism that stops two agents writing to
one worktree: a held worktree is shown as in use by `/worktree list` and by
jimothy's own picker, and jimothy refuses to remove one. The target is the
worktree this session will write to, which after a `/reload`, a resume or a fork
is the focus restored from the transcript and not the directory pi was started
in. A directory jimothy does not manage has no record, so there is nothing to
lease and nothing is said about it. A lease left behind by a crashed session
names a pid that is gone, and the next session reclaims it and says so — there is
no command to run for that.

A worktree held by a process that is still *alive* is a question rather than a
warning. The session asks — `Worktree "<name>" is in use by pi session <id>
(pid …, … ago)` — and offers **Quit** first, so quitting is the default, and
**Take over** second. Quit shuts pi down and leaves the other session's lease
exactly as it was; so does dismissing the dialog, because dismissal is not
consent to take somebody's worktree. Taking over breaks a lease whose holder is
still running, which is destructive to that session, so it names the run and pid
it displaced before acquiring the lease for this one.

The consent is to displace the run the question *named*. Answering takes seconds,
and in that time the holder can release and another live session acquire, so the
lease is re-read immediately before it is broken: if it changed hands the break
is abandoned and the situation is decided again from scratch — asking afresh
about the new holder, acquiring if it is now free, or warning. That happens at
most once, so a worktree changing hands under every question ends with the
session unleased rather than asking forever.

A session with no UI cannot ask, so it warns that the worktree is in use, says it
is continuing without a lease, and carries on. That is deliberately the wrong
side of the one-agent-at-a-time rule: a prompt is impossible in a `pi -p` run,
such a run is bounded and usually read-only, and killing a scripted run is worse
than the warning. It is also the row a pi started by another pi lands on.

When jimothy launched pi itself it took the lease before pi existed, and the
session moves that lease onto its own pid rather than acquiring a second one,
keeping jimothy's run id so jimothy's own release still matches. The handoff is
recognised by parentage — the lease's owner has to be this process's parent — so
pi must stay a direct child of jimothy for it to work.

The worktree jimothy leased is not always the one the session will write to: a
resumed session restores focus from its transcript, so jimothy can hold A while
the agent's target is B. The session then holds *two* leases — the launcher's,
retargeted onto its own pid so a killed launcher cannot strand it, and the one
it is writing to, acquired under its own run id. The launcher's other worktree
is only ever retargeted: it is never acquired, never prompted about and never
warned about, because every other situation — free, stale, a stranger — belongs
to the worktree the agent actually writes to, and a question at startup about a
directory the user did not choose is worse than silence. The retarget happens
*before* the target is acquired, which is what makes the failure case right: if
the target turns out to be held by a stranger the focus is dropped and the agent
falls back to the directory pi was started in, which is the launcher's worktree,
and that one is held. On the way out the two part company by provenance — the
one the session took is released, the launcher's is left for jimothy.

A lease this session took is released when the session ends, whatever ended it —
`/reload`, `/new`, a fork, or quitting outright — because the runId decides who
gives it back, not how it was obtained: even a lease this session only *adopted*
(a hand-launched pi that reloaded and met its own lease under its own pid, with
no launcher anywhere) is still this session's to release. A lease its launcher
took, and only retargeted onto this process, is left alone: jimothy's own
`finally` releases that one under the same run id, and a session that released
it here would let jimothy's later release unlock a worktree someone else has
since taken. A session killed outright releases nothing, and leaves a lease
naming a pid that is now dead — which the next session to open that worktree
reclaims, and says so.

Releasing unconditionally, on every reason rather than only on the terminal
quit, means a `/reload` or `/fork` briefly leaves the worktree unleased: the
outgoing session gives it back before the replacement acquires it fresh, and
for that one event-loop turn nothing here holds the name. A session that loses
that race is told, exactly as it would be for any other stranger's lease — not
left to continue silently against a worktree it no longer holds.

**Focus moves the lease.** Focus is precisely "where this agent now writes", so
`/worktree focus B` is a transition rather than an assignment: B is acquired
*first*, and only then does focus move and A go back. If B cannot be held —
a live stranger, and the user declines to take over, or no UI to ask with —
focus does not move at all, and nothing is quit: the session stays exactly where
it was, which is the difference between this and the same question at session
start. `/worktree focus off` is the same transition in reverse, so a session's
own worktree is reacquired before the focused one is released, and focus is kept
when it cannot be.

A is not released at the moment focus moves. Focus is applied at `tool_call`
time, so a call already in flight is still writing into A; the release is
deferred to `agent_settled` (or done at once when the agent is idle), and the
queue is drained by the session ending too, since `/reload` ends a session
without ending the process. A's lease goes back whatever its provenance —
unlike shutdown, a transition means the agent has *left* that worktree, which is
exactly when jimothy wants it back, and `releaseLease` is guarded by run id so
an early release cannot unlock a worktree somebody else has taken. The cost,
named so it is not rediscovered as a bug: pi's own cwd is still A, so a user
typing into the terminal is working in a worktree the session no longer holds.

A focused worktree that has *disappeared* — removed by another session, or by
`jimothy wt rm` in another terminal — is noticed by the next transition and
dropped, with its lease. Without that the session goes on redirecting every tool
call into a directory that no longer exists, and the error names a path the user
never typed.

None of this is fatal. A registry that cannot be read, or a lock another process
is holding, is reported as a warning; the session still starts, still focuses,
and still monitors a PR. A transition is the exception that proves it: one that
cannot read the lease is refused rather than made unleased, because staying put
costs nothing.

The listing also shows less than the old `git worktree list`-based renderer
did: jimothy's git entries carry no detached-HEAD short sha and no `(locked)` /
`(prunable)` flags, so a worktree git considers prunable — one deleted by hand,
for instance — now looks healthy in `/worktree list`.

`focus` and `remove` autocomplete worktree names. A name is matched by exact
path, name or branch first, then by unique prefix; an ambiguous prefix is
reported rather than resolved to whichever worktree git listed first. In
non-interactive mode (`pi -p`) only exact matches are accepted, since there is
no confirmation prompt.

`/worktree new` creates through jimothy's registry and then provisions, so the
worktree lands under jimothy's `baseDir` on `${branchPrefix}<name>` —
`jimothy/spike` by default — and gets jimothy's `link` and `copy` entries plus a
package install if the checkout has a lockfile. That is deliberately jimothy's
convention and not this extension's: one model means one convention, which is
why this extension no longer has a `path` or a `branchPrefix` of its own. The install is
narrated line by line rather than reported once at the end, because it is the
one step here that can take minutes.

A create the registry refuses — a name already taken, an illegal one — is
reported and nothing is left behind: `create` rolls back its own attempt. A
*provisioning* failure is reported too, but the worktree is kept: the checkout is
real work and an install is retryable, so it is not destroyed for a registry that
was unreachable or a lockfile that would not resolve.

The base ref is the second token, then jimothy's `defaultBase`, then the
repository's default branch. An unquoted multi-word name is therefore an error
rather than a mystery branch — and a name is no longer slugified for you:
`/worktree new "My Feature!"` is refused rather than quietly becoming
`my-feature`, because silently renaming what someone typed is worse than saying
no. `checkout`'s explicit name is refused the same way, for the same reason —
see below.

With no name, the prompt is prefilled with a suggestion. The transcript half
stays here — only pi has one: the newest thing you asked for, reduced to up to
three content words (`fix-parser-bug`), or an adjective–noun pair
(`brave-otter`) when the conversation has nothing to go on. Short
acknowledgements are skipped, so approving a plan and then running `/worktree
new` still names the work rather than the approval. Turning that *seed* into a
name that is legal and free is `registry.suggestName`, because only the registry
knows what is taken — a record, a worktree git reports, or any branch, with
jimothy's prefix stripped so `jimothy/foo` occupies `foo`. A collision is offered
as `-2`. Press Enter to take it, or type over it; a name you type yourself is
never adjusted, it fails. Non-interactively (`pi -p`) the suggestion is used
without asking, where the command previously did nothing at all.

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

The directory name drops the remote and jimothy's `branchPrefix` — set in
`jimothy.config.json`, which is the only `branchPrefix` there is now — so with
it set to `"joel/"`, `origin/joel/fix-parser` becomes `fix-parser` and
`origin/alice/hotfix` becomes `alice-hotfix`. A name you pass yourself is never
adjusted and fails instead if it is illegal or already taken.

For an ordinary existing local branch, a derived name colliding with `-2` is not
an edge case but the normal outcome: `checkout feature`'s directory-name seed is
derived from `feature` itself, and `registry.suggestName`'s taken-set already
contains every branch in the repo (stripped of jimothy's prefix) — including the
very branch being checked out — so it always looks taken and the directory lands
in `feature-2`, not `feature`, even though nothing else has that name. This is a
known wart in jimothy's `suggestName`, not a choice made here; a later change is
expected to fix it on the jimothy side, and the suffix this documents will
change when it does. `autoFocus` applies exactly as it does for `new`.

The model's `worktree` tool deliberately does not expose this. With auto-focus
on, checking out an existing branch could put the model to work directly on a
shared branch instead of a scratch one, so it stays a user decision — like
`focus` and `remove`.

## Removing a worktree

`/worktree remove <name>` is a `Registry.remove`, so what it accepts is a name
the registry knows. A worktree jimothy did not create has no record and is now
refused — `unmanaged` in the listing means unmanaged here too, where the
extension's own git-level removal used to delete it anyway. The refusal names
the route back: `/worktree adopt <path>` first, then remove it.

The two confirmations are two different questions, and neither leaks into the
other. The first is about *files*: `<n> uncommitted file(s) will be lost` is what
maps to git's `--force`, and it says nothing about whether another agent is
working in that worktree. That is the *lease's* question, and a lease held by
anyone else refuses the removal outright and names the holder — no confirmation
about uncommitted work can break it. The one lease that is not an obstacle is
this session's own, on a worktree it is focused on: that one is released first,
which is not the same as breaking it. The second confirmation is the branch,
deleted with `-d`, so a branch holding commits that exist nowhere else is kept
and said so, even though jimothy's own default would force-delete a branch it
created; the worktree is gone either way.

Removing the focused worktree clears focus through the same transition `/worktree
focus off` uses, so the session reacquires its own worktree instead of pointing
at a directory that no longer exists. A kept branch is not an exception: the
worktree is gone, so focus is cleared and the listings are refreshed exactly as
they are on the plain success, and the message reports what happened — the
worktree removed, the branch kept — rather than a failed removal. Whether the
worktree is still on disk is what tells the two apart.

A removal that really does fail — a live lease, another jimothy mid-operation —
leaves the worktree standing, and the lease released above is taken back. An
ordinary acquire, so a stranger who took it in the window between the release and
the failure keeps it; that is the one case where the session ends up holding
nothing, and it says so instead of leaving it to be discovered.

## Tool

The model gets a `worktree` tool with `action: "list" | "create"`. It can spin
up an isolated worktree for a parallel experiment. `create` goes through the
same `createAndProvision` as `/worktree new`: a record in jimothy's registry,
then jimothy's own provisioning — `link`/`copy` entries plus a package install
when the checkout has a lockfile — so a worktree the model makes is
indistinguishable from one a person made with `/worktree new`. A name is
optional; without one `registry.suggestName` generates one, the same as an
empty prompt does for `/worktree new`. A **provisioning** failure does not fail
the tool call: the worktree is real and usable, the failure is retryable, and
the result text says both what was created and that setup failed.

`create` focuses the new worktree when `autoFocus` is on (the default), so the
model keeps working where it just landed instead of threading an absolute path
through every later call. The footer shows the focus and `/worktree focus off`
undoes it. Set `"autoFocus": false` for the old behaviour, where the tool only
returns the path. Focus now moves through the same transition every other door
uses, which can refuse a destination held by a live stranger — a tool call has
no UI to prompt with, so the result says focus could not move rather than
claiming the model is working somewhere it was refused. The tool still cannot
focus an *existing* worktree or check out an *existing* branch — switching
between worktrees, and starting work on a branch that already exists, stay
user decisions.

`postCreate` is **not** run by the tool any more: provisioning is jimothy's,
and jimothy has no `postCreate` equivalent (a later phase may add one). This
extension no longer has a create or remove of its own at all — `new`,
`checkout`, `remove` and the tool all go through jimothy's registry — and the
config keys that used to drive the old implementation are gone with it. A
leftover one in your `worktree.json` is warned about at startup and names where
the setting lives now.

## Layouts

The project root is derived from `git rev-parse --git-common-dir`, so all three
layouts are recognised — which is what makes this extension work from a linked
worktree or a bare checkout at all:

```
repo/.git/              ordinary repo
repo/.git (file)        linked worktree      -> resolved to the main repo root
proj/.bare + proj/main  bare layout          -> resolved to proj/
```

Where a *new* worktree lands is not this extension's decision: it is jimothy's
`baseDir`, per repository, for `new`, `checkout` and the model's tool alike.

## Configuration

Later files win:

1. built-in defaults
2. `~/.pi/agent/worktree.json`
3. `<projectRoot>/.pi/worktree.json` — **trusted projects only**

```jsonc
{
  // Focus a newly created worktree automatically — both `/worktree new` and the
  // model's `worktree` tool.
  "autoFocus": true,

  // Remap absolute paths under the session worktree while focused.
  "remapAbsolutePaths": true
}
```

That is the whole file. Everything about *making* a worktree is jimothy's, in
`jimothy.config.json` at the repository root:

| was here | now |
| --- | --- |
| `path` | jimothy's `baseDir` |
| `branchPrefix` | jimothy's `branchPrefix` (default `jimothy/`) |
| `defaultBase` | jimothy's `defaultBase` |
| `copyFiles` | jimothy's `copy` — **files only**, so a directory entry has to be listed file by file |
| `postCreate` | **nothing.** jimothy has no equivalent, so a worktree made through this extension does not run it |

Each of those keys still in a `worktree.json` produces a startup warning naming
its replacement. The last two rows are why the warning does not claim an
upgrade: `copyFiles` took directories and `copy` does not, and a `postCreate`
step simply stops happening.

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
herdr pane report-metadata $HERDR_PANE_ID --source pi --title "π - <branch>" --token pi_branch=<branch>
```

The value is the branch pi displays — the focused worktree's, else the
session's — with jimothy's `branchPrefix` stripped, since it is on every branch
jimothy makes and the sidebar is 18–36 columns wide. A session whose jimothy
model could not be opened strips nothing: a slightly longer branch on a sidebar
is not a reason to fail a session. A detached HEAD clears both rather than
showing a SHA. Unchanged branches cost nothing: the reporter dedupes, so the
60s PR poll does not fork a process to repeat itself.

What keeps the value current is the PR monitor's HEAD re-read, which runs on
every poll and on input — including in a session where `gh` is unavailable and
nothing is polling, so a `git switch` there still reaches herdr on the next
prompt.

Two reports, because herdr's two sidebar panels read different metadata: Space
rows can only name workspace tokens, Agent rows only pane ones. The pane token
rides along on the command the title already needed, so the Agents panel costs
no extra process. It is also per *pane*, so unlike the workspace token it stays
correct when two pi sessions share a space.

Neither renders unless a row layout names it:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$pi_branch", "git_status"]]

[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["$pi_branch"]]
```

In the Space rows that replaces herdr's built-in `branch` token. Keeping both is
correct for spaces with no pi in them, but every pi space then reads
`fix-parser main`. The Agent rows shown here drop the built-in `agent` name for
the branch; keep `agent` in the second row if you run several kinds of agent and
need to tell them apart.

The Agents panel cannot be turned off in herdr 0.8.0 — `rows = []` empties it but
it keeps its share of the sidebar — so filling it is the only way to reclaim
that space.

Nothing is reported outside herdr, or under `pi -p`. The first failure — no
`herdr` on `PATH`, a dead socket — switches it off for the session, like a
missing `gh`. `session_shutdown` clears both surfaces; a `kill -9` leaves the
last value on screen until the next pi session in that space reports over it.

Commands are queued per surface within a pi process, so `/new` cannot leave the
retiring session's already-spawned write on screen: it lands first and the new
session's lands last. The cost is that the new session's first report waits for
that one command, which a wedged socket caps at roughly seven seconds (a 2s
timeout plus pi's SIGTERM/SIGKILL grace). Reports are fire-and-forget, so
nothing in the session waits with it.

Two known gaps: workspace tokens are per space, so two pi sessions in one space
show whichever painted last (pane titles stay right), and the space *label* is
left alone — it is `basename(cwd)`, and only `workspace rename` changes it,
which is persistent state a crash would strand.

## Files

```
lib/git.ts               shared git helpers (used by other extensions too)
lib/herdr.ts             reporting the displayed branch to herdr (pure + one CLI)
worktree/index.ts        wiring only: event handlers and registration
worktree/session.ts      per-session state, focus, held leases, and the monitor
worktree/jimothy.ts      jimothy's worktree model: registry, deps, repo info
worktree/lease.ts        the lease decision table, and the launcher's identity (pure)
worktree/take-lease.ts   the lease handshake: acquiring, retargeting, prompting
worktree/transition.ts   moving focus, and the lease with it
worktree/pr-monitor.ts   the PR status state machine
worktree/commands.ts     /worktree and its completions
worktree/tool.ts         the model-facing tool
worktree/ui.ts           notifications, reports, status segment
worktree/config.ts       config loading, and the warnings for keys that moved to jimothy
worktree/branches.ts     branch listing, resolution and naming (pure + two git calls)
worktree/focus.ts        tool-input rewriting (pure, heavily tested)
worktree/select.ts       argument parsing and name matching (pure)
worktree/suggest.ts      the transcript-derived name seed `new` offers (pure)
worktree/worktrees.ts    `git worktree prune` — all that is left of the old implementation
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
a UI, cleared at shutdown, following a `git switch` with `gh` unavailable, and a
session replaced mid-report whose late write must not land on the new one's.

`restore.test.mjs` covers restoring focus from the transcript through a fake
`pi` with real git: the last entry winning, a cleared entry meaning unfocused,
and a worktree removed by another session being dropped with a warning.

`pr-status.test.mjs` remains the integration test: it drives `index.ts` through a
fake `pi` with real git in a throwaway repo and scripted `gh`, asserting the
branch re-read and repaint, the error backoff, the `hasUI` gate, and that a
session replaced mid-fetch never paints through its stale `ctx`. It builds a
fresh `ctx` per `session_start`, as pi does, because sharing one would hide that
last class of bug entirely.
