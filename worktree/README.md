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

## Commands

```
/worktree                 interactive menu
/worktree list            worktrees for this repo, with dirty counts
/worktree new <name> [base]   create worktree + branch, then focus it
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

When focused, the footer shows `⑂ <name> (<branch>)`.

## Tool

The model gets a `worktree` tool with `action: "list" | "create"`. It can spin
up an isolated worktree for a parallel experiment.

`create` focuses the new worktree when `autoFocus` is on (the default), so the
model keeps working where it just landed instead of threading an absolute path
through every later call. The footer shows the focus and `/worktree focus off`
undoes it. Set `"autoFocus": false` for the old behaviour, where the tool only
returns the path. The tool still cannot focus an *existing* worktree — switching
between worktrees stays a user decision.

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

## Files

```
lib/git.ts             shared git helpers (used by other extensions too)
worktree/index.ts      command, focus state, footer status, tool
worktree/config.ts     config loading and path templating
worktree/focus.ts      tool-input rewriting (pure, heavily tested)
worktree/select.ts     argument parsing and name matching (pure)
worktree/worktrees.ts  create / remove / prune
```

## Tests

```bash
cd ~/Code/pi-extensions/tests
npm install
node worktree.test.mjs
```

Runs against throwaway repos in `$TMPDIR`, covering both plain and bare
layouts, plus pure-function tests for focus rewriting, argument parsing, name
matching and config precedence. Set `PI_TEST_BARE_REPO` to also check a real
bare-layout checkout on this machine.
