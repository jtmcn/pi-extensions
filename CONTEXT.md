# pi extensions

A personal collection of pi extensions. Each extension adds slash commands,
tools, or UI to pi; the collection is loaded by symlinking this directory into
pi's discovery path and has no build step (pi runs the TypeScript via jiti).

## Language

### The unit of delivery

**Extension**:
A feature pi loads from a top-level `<name>/` directory whose `index.ts`
default-exports a factory. The unit of registration in this collection.
Excludes `lib/`, `tests/`, `docs/`, and any scratch folder — those have no
`index.ts` and are never loaded.
_Avoid_: "plugin", "app", "modifier", "module" for a loaded feature

**Index**: the wiring file of an extension. Only it default-exports the
factory; all decision logic lives in sibling modules. Never put behavior here.
_Avoid_: "shim", "entry", "bootstrap"

### Session lifecycle

**Session**: a pi session. Extension state is keyed to a session and has a
lifetime: on `session_start` the outgoing session is disposed and a new one is
built, so a field can never be left behind and a fetch/timer from the replaced
session cannot paint through a discardable context.
_Avoid_: "run", "invocation", "tabs"

**Stale** (a `ctx` is stale): a captured extension context that pi no longer
considers current — touching it from a timer or async callback that outlives
the turn throws and takes down the process.
_Avoid_: "stale ctx" as a synonym for "old data"; it specifically means the
context handle, not the data it wrapped

**Transcript**: the persisted record of what the session wrote. Entries survive
`/reload` and resume; a `nextTurn` message does not and is lost if the session
reloads.

**appendEntry** / **sendMessage**: the two ways to persist. `appendEntry` is
the durable, transcript-writing path. `sendMessage` is in-memory only and is
lost on reload — use what must survive.
_Avoid_: "persist" applied to `sendMessage`

### Worktree focus

**Worktree**: a git worktree, the isolated checkout a session can be redirected
into. Also the name of the extension that manages them.

**Focus**: the worktree extension's mode of redirecting a session _without_
moving `ctx.cwd` (which is fixed for a session's life) — `bash` commands get a
`cd` prefix and relative `read`/`write`/`edit`/`ls` paths resolve against the
focused worktree. A **redirect, not a sandbox**: absolute paths elsewhere pass
through untouched. Focus is announced to the model, written to the transcript
so it survives reload/resume, and is not inherited by a `/new` session.

**Focused** (a session is): actively redirecting into a worktree.

### Trust and surfaces

**Trusted project**: a project the user has marked trusted. Project-local
configuration is honored only when `ctx.isProjectTrusted()` is true — the same
boundary as the rest of pi's project config.

**Print mode**: the non-interactive `pi -p` surface. A feature that paints only
through the UI is silent here; anything worth surfacing must also write to
stdout when `ctx.mode === "print"`.

**hasUI**: the guard for whether this session has an interactive UI to paint
into. Check it before painting; also write to stdout in print mode.

### Agent seams

**Slash command**: an interactive `/command` — anything that changes the user's
environment. `Focus`, `remove`, and `checkout` live here.

**Tool**: a model-facing capability. Only reversible/additive actions are
tools; risky, environment-changing actions stay slash commands.

### Rendering

**delta** (the collection extension): a feature that renders diffs with the
external `delta` tool. Display only — the model still receives the plain
unified diff, so it costs the session no tokens and cannot confuse it.
_Avoid_: conflating the extension with the external `delta` binary it wraps;
use "the delta tool" for the binary.

## Notes

This context is an agent-engineering product: almost every term below names a
pi or git concept the extensions manipulate. General programming concepts
(branching, parsing, timeouts) are deliberately absent — they are not this
context's vocabulary.
