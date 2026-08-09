# A worktree from an existing branch

`createWorktree` already checks out an existing branch — `branchExists` decides
between `git worktree add <path> <branch>` and `git worktree add -b <branch>`.
But the only branch name it can ever be handed is `${branchPrefix}${slugify(name)}`,
built by `/worktree new` and by the model's tool. So an existing branch is
reachable only when its name happens to match that template, and a remote branch
is not reachable at all.

This adds `/worktree checkout <branch> [name]`: a worktree for a branch that
already exists, local or remote.

## Behaviour

```
/worktree checkout joel/fix-parser        existing local branch
/worktree checkout origin/alice/hotfix    remote branch, fully qualified
/worktree checkout alice/hotfix           remote branch, remote inferred
/worktree checkout joel/fix-parser docs   explicit directory name
/worktree checkout                        pick from a list (interactive only)
```

`new` keeps meaning "a new branch" and `checkout` means "a branch that exists".
Overloading `new` was the alternative and is rejected: its semantics are already
careful — suggested names, uniqueness applied to generated names only — and
making the same words mean two things depending on repo state would let a
typo'd new name silently check out a stale branch that it prefix-matched.

`autoFocus` applies, exactly as for `new`. Removal, pruning and focus are
unchanged.

The model's `worktree` tool is **not** extended. With `autoFocus` on,
`checkout main` would put the model to work directly on a shared branch rather
than a scratch one, and nobody has asked for it. `create` (a new branch) stays
the safe half. Adding an optional `branch` parameter later is a small change if
the need appears.

## Resolving the branch

A query resolves against a cached list of local branches and remote-tracking
branches, from one `git for-each-ref refs/heads refs/remotes` plus one
`git remote`. `origin/HEAD` is dropped — it is a symref to a branch already in
the list.

`git remote` is not redundant. Remote names may contain slashes (`git remote add
a/b` is accepted), so `refs/remotes/a/b/main` is remote `a/b`, branch `main`, and
splitting on the first segment would silently mis-parse it. The remote is the
longest configured remote name that prefixes the ref.

| query | resolution |
|---|---|
| matches a local branch | local |
| matches `<remote>/<name>` exactly | remote |
| matches `<name>` on exactly one remote | remote |
| matches `<name>` on several remotes | ambiguous — error listing them |
| matches nothing | fetch, then retry once |

Local wins over remote: a query that names both a local branch and a remote one
takes the local branch, because that is the branch the user has been working on.

**The fetch is lazy.** Resolving hits the network only on a miss: one
`git fetch <default remote>`, then the list is rebuilt and the query retried
once. The common case — a branch you already have a ref for — costs nothing, and
a branch pushed a minute ago is still found. Always fetching up front was the
alternative; it charges every checkout for the uncommon case.

A fetch that fails is a warning, not an error: the local half of the feature
works offline. A query that still resolves to nothing after the retry is an
error naming the branch, and mentioning the fetch failure when there was one.

The known gap, accepted: a remote-tracking ref that exists but is stale resolves
immediately, so a worktree can start a few commits behind after someone else
pushed. Fixing it means fetching every time, which is the cost this rule exists
to avoid.

## Creating it

Three cases reach `createWorktree`:

| resolution | git |
|---|---|
| local `foo` | `worktree add <path> foo` — already implemented |
| remote `origin/foo`, no local `foo` | `worktree add --track -b foo <path> origin/foo` |
| remote `origin/foo`, local `foo` exists | resolves as local: `worktree add <path> foo` |

The third row follows from local-wins, and matters: a local branch may hold
unpushed commits, so this must never reset it to the remote. The result message
says which case ran, so "checked out your local `foo`, which is not the same as
`origin/foo`" is visible rather than silent.

`createWorktree` gains one optional field, `track?: string`. When it is set and
the branch does not exist locally, the `--track -b` form runs and `defaultBase`
resolution is skipped entirely — a tracked branch has its start point already.
`base` and `track` are mutually exclusive; `checkout` never passes `base`.

A branch already checked out in another worktree hits the existing
`Branch "x" is already checked out at <path>` error, which is the right
outcome. The message gains a `— /worktree focus <name>` hint. No confirm
prompt: a prompt here would need a non-interactive fallback for a case that has
a one-line answer.

## Naming the directory

`checkoutName(branch, branchPrefix)`: strip `branchPrefix` when present, then
`slugify`.

Resolution has already stripped the remote — it reports the *local* branch name
to create or check out — so `checkoutName` takes that name and strips only
`branchPrefix`, then slugifies.

| resolved branch | `branchPrefix` | directory |
|---|---|---|
| `joel/fix-parser` (from `origin/joel/fix-parser`) | `joel/` | `fix-parser` |
| `alice/hotfix` (from `origin/alice/hotfix`) | `joel/` | `alice-hotfix` |
| `renovate/lockfile` | `joel/` | `renovate-lockfile` |

Your own branches read short; everyone else's stay attributed. This is not a new
rule: `suggest.ts` already strips `branchPrefix` when deciding which names are
taken, and this reuses it.

Collisions follow the existing convention exactly. A **derived** name goes
through `uniqueName` and becomes `fix-parser-2`. A name passed explicitly as
`[name]` is never adjusted — it fails loudly in `createWorktree`, as it does for
`new`.

## The picker and completions

`/worktree checkout` with no argument and `ctx.hasUI` shows `ctx.ui.select` over
the branch list: locals first, then remotes, with branches already checked out
marked and not selectable. With no argument and no UI it is an error, matching
`focus` and `remove` — there is no prompt to fall back on.

Completion after `checkout ` offers branch names from a `knownBranches` cache,
seeded beside the existing worktree cache at `session_start` and refreshed after
a create or remove. Completions run on every keystroke, so they never shell out,
same as the worktree-name completions today.

## Structure

One new module, split the way `select.ts` is — pure decisions separate from I/O:

```
worktree/branches.ts
  listBranches(runner, projectRoot)   one for-each-ref -> {local, remote}
  resolveBranch(branches, query)      pure: local | remote | ambiguous | none
  checkoutName(branch, branchPrefix)  pure
```

`commands.ts` gains `doCheckout` and its entry in `SUBCOMMANDS`. `worktrees.ts`
gains the optional `track`. `index.ts` seeds the branch cache. Nothing else
moves.

## Testing

`tests/worktree/branches.test.mjs`, new: `resolveBranch` across all five rows of
the resolution table including local-wins and multi-remote ambiguity,
`checkoutName` across the naming table, and ref parsing including a
slash-containing remote and a dropped `HEAD` symref.

`tests/worktree/worktree.test.mjs`, extended, with real git in throwaway repos —
a second repo cloned so `origin/…` refs are real:

- a local branch is checked out, not recreated
- a remote branch produces a local branch with tracking configured
- a local branch that shadows a remote one is used unmodified, unpushed commit intact
- a branch checked out elsewhere fails with the path in the message
- a miss triggers exactly one fetch and then resolves (fake runner, counting calls)
- a fetch that fails leaves the error about the branch, plus the warning

Each test is to be broken on purpose before it is trusted, per the repo's
testing note.
