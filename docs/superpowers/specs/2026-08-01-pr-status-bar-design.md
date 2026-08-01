# PR number in the pi status bar

**Date:** 2026-08-01
**Status:** approved, not yet implemented

## Problem

When working on a branch that has a pull request, pi's footer shows the branch
but not the PR. Finding the number means leaving the session for `gh pr view` or
a browser tab. The PR number, its state, and whether CI is green are the three
facts you want at a glance while working on a branch.

## Solution

Extend the existing `worktree` extension's footer segment with a PR suffix:

```
⑂ main (joel/ont-mount-constant) #26904 open ●
```

Only the `#26904 open ●` part is an OSC 8 hyperlink, pointing at the Graphite PR
page. The branch portion stays plain text.

## Why the `worktree` extension and not a new one

The footer segment must agree with itself: the PR shown has to be the PR of the
branch shown. The `worktree` extension can redirect the agent's tool calls into
a different worktree ("focus"), and its segment then displays that worktree's
branch — so PR display has to follow focus.

pi fires no event when one extension appends a custom entry, so a standalone
extension could only track focus by re-scanning the session transcript for
`worktree`'s private `worktree-focus` entry type on `input`/`turn_end`. That is
tighter coupling than sharing a module, dressed up as looser coupling. pi also
has no sanctioned extension-to-extension channel, so publishing focus through
a registered tool or a shared singleton would mean inventing one.

Inside `worktree`, focus is a live variable and `setStatus` already runs on every
focus change, so agreement is structural rather than maintained by hand.

## Display

| Element | Rule |
|---|---|
| Number | `#<number>` |
| State | `draft` when `isDraft`, else lowercased `state`: `open` / `merged` / `closed` |
| CI glyph | `✓` pass, `✗` fail, `●` pending; omitted when the check list is empty |
| Link | `https://app.graphite.com/github/pr/<owner>/<repo>/<number>` |

Nothing is appended — the segment is exactly what it is today — when the branch
has no PR, HEAD is detached, the directory is not a git repo, or the PR feature
has disabled itself (see Failure handling).

`app.graphite.com` is the host Graphite's own mergeability check emits in its
`detailsUrl`, which is why it is preferred over `app.graphite.dev`.

### CI rollup

`gh pr view --json statusCheckRollup` returns a *mixed* array with no
server-side rollup field: `CheckRun` entries (`status` + `conclusion`) and
`StatusContext` entries (`state`). The glyph is computed from all of them:

- **fail** — any `CheckRun.conclusion` in FAILURE, TIMED_OUT, CANCELLED,
  ACTION_REQUIRED, STARTUP_FAILURE, or any `StatusContext.state` in FAILURE,
  ERROR.
- **pending** — otherwise, any `CheckRun.status` in QUEUED, IN_PROGRESS,
  WAITING, PENDING, REQUESTED, or any `StatusContext.state` of PENDING.
- **pass** — otherwise.

Failure dominates pending, which dominates pass.

### Terminal support

Verified against pi's footer: `visibleWidth()` scores an OSC 8 sequence as 0,
`truncateToWidth()` preserves it, and the footer's `sanitizeStatusText()` strips
only `\r\n\t`, leaving ESC and BEL intact. The TUI emits an OSC 8 reset at the
end of every line, so the link cannot leak into adjacent content.

## Data acquisition

Two `gh` calls, both run with `cwd` set to the active worktree:

- `gh repo view --json nameWithOwner` — once per repo, cached for the session.
- `gh pr view <branch> --json number,state,isDraft,url,statusCheckRollup` —
  everything the display needs in one round trip (~0.5s measured).

## Refresh policy

**Cache.** A map keyed by `<repoRoot>\0<branch>`, holding
`{ fetchedAt, pr | "none", consecutiveErrors }`. The active key derives from the
focused worktree when focus is on, otherwise the session's own worktree.
Switching focus swaps the key and paints from cache immediately, then refreshes
in the background if stale.

**Triggers.**

- `session_start` and every focus change — fire-and-forget, never awaited, so
  startup is not delayed by a `gh` round trip.
- A `setInterval` timer, started lazily at the first refresh:

  | State | Cadence |
  |---|---|
  | open / draft | 60s |
  | merged / closed | stopped — terminal; revived only by a branch or focus change |
  | no PR | 5 min, so a newly created PR appears on its own |

- Idle suspension: after 15 minutes with no `input` event the timer stops. The
  next `input` refreshes immediately and restarts it.
- Bash trigger: a command matching `gt submit`, `gh pr create`, or `git push`
  schedules a refresh 8s later, so the number appears the moment you submit
  rather than up to 5 minutes later. Hooked on `tool_result` (agent bash) and
  `user_bash` (`!` commands). `tool_result` is post-execution — `tool_call`
  would fetch before the push had landed — and the 8s delay gives GitHub time
  to create the PR and register its checks. This is a heuristic on command
  text; missing a match only delays the update to the normal cadence.

**Concurrency.** One in-flight fetch at a time, 10s `exec` timeout. A result
whose key no longer matches the active key is discarded.

## Failure handling

All failures are silent — no notifications, ever. This is decoration.

- `gh` missing (ENOENT), unauthenticated, or a non-GitHub remote: the PR feature
  disables itself for the rest of the session.
- Transient errors: keep the last known value on screen, back off 60s → 2m →
  5m. After three consecutive failures with nothing cached, show no suffix.

## Timer discipline

`worktree/index.ts` already documents the footgun: a timer that captures a `ctx`
fires with a stale one after session replacement or shutdown. The interval
therefore captures no `ctx` and reads the module-scoped `sessionCtx`, which the
existing `session_shutdown` handler clears — extended to `clearInterval` as
well, idempotently. pi's extension guidance also forbids starting timers in the
factory; startup is deferred to the first refresh.

## Files

| File | Role |
|---|---|
| `worktree/pr.ts` | Pure, I/O-free: `rollupGlyph()`, `formatPr()`, `graphiteUrl()`, `hyperlink()`, `nextPollDelay()`. Follows the `focus.ts` / `select.ts` precedent. |
| `worktree/index.ts` | Wiring only: fetch, cache, timer, and the suffix inside the existing `setStatus`. |
| `tests/pr.test.mjs` | Table-driven tests over the pure functions, with `statusCheckRollup` fixtures captured from a real PR (mixed `CheckRun` + `StatusContext`). |
| `worktree/README.md` | A short "PR in the status bar" section. |

## Out of scope

- Any PR display outside the footer segment.
- A `/pr` command. The refresh triggers cover the cases a manual command would.
- Non-GitHub forges, and PRs for a branch in a repo other than `origin`'s.
