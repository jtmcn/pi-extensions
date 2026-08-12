# /mcp restart re-reads the config

Adding the ast-grep server to `~/.pi/agent/mcp.json` mid-session, then running
`/mcp restart`, produced:

```
mcp: no servers configured (~/.pi/agent/mcp.json)
```

The file was correct. A fresh session connected it immediately:

```
mcp: ast-grep v1.29.0 [ready] 4 tools: ast_grep_dump_syntax_tree, …
```

So the command named the one file the user had already got right, and reported
absence rather than staleness.

## Restart reconnected the map, and only `session_start` filled it

`loadConfig` was called in exactly one place, the `session_start` handler. The
restart branch iterated what that handler had left behind:

```ts
if (args.trim() === "restart") {
    const cycle = beginCycle();
    closeAll();
    connecting = [];
    for (const state of servers.values()) {   // empty map stays empty
```

The session in question started before the file gained its server, so the map
was empty, restart reconnected nothing, and the status branch fell through to
`servers.size === 0`. Every mid-session config edit had the same shape: adding a
server did nothing, removing one left it running, and editing one kept the old
spec until `/reload`.

"Tear down every server and reconnect" is what the code did. It is not what
"restart" means to someone who has just edited a config file.

## One start path, shared

`startServers(ctx, cycle)` now loads the config, repopulates `servers`, and
connects. `session_start` and `/mcp restart` both call it; the caller keeps
`beginCycle()` and `closeAll()` because teardown differs between a fresh session
and a live one, and the cycle guards must compare against the caller's
generation.

Tool-name stability across a restart — the property the README calls
load-bearing, since a renamed tool leaves the original with no handler — is
preserved: names are derived from the config in iteration order, so an unchanged
config yields the same names. The pre-existing test that pins this (`restart:
tool names are unchanged`, `registers no duplicate tool`) now exercises the
reload path and still passes.

Two smaller consequences, both improvements:

- The failure `catch` differed between the paths; the shared one keeps
  `session_start`'s stronger version, which closes the dead client instead of
  leaving it attached to a `failed` state.
- `servers.clear()` stays in `session_start` as well as `startServers`, so a
  config load that throws cannot leave the previous session's servers reported
  as ready.

`configSources`/`configCandidates` deliberately have **no** reset in
`session_start`, against the repo's usual rule: `startServers` assigns both
before anything can read them, and a mutation test proved a reset there is dead
code no test can distinguish.

## Absent and empty are different states

`"mcp: no servers configured (~/.pi/agent/mcp.json)"` covered three situations —
no file, a file with no servers, and (via the bug) a file with servers that had
not been read. It also hardcoded a path that is wrong whenever
`PI_CODING_AGENT_DIR` is set, which is how the tests run.

`loadConfig` now returns `candidates` (locations considered) alongside `sources`
(files actually read), and the message picks:

- no file: `mcp: no config file — create <candidates>, then /mcp restart`
- file, no servers: `mcp: no servers in <sources> (/mcp restart re-reads it)`

`/mcp restart` with nothing configured reports the same thing rather than
`mcp: reconnecting`, which read as success while doing nothing.

## Tests

Five cases in `tests/mcp/mcp.test.mjs`, all written failing first (13 red
assertions, each reproducing the old strings). `extHarness` gained
`writeConfig()` and `configPath`, and accepts `servers === null` to leave the
file absent — the state that was previously indistinguishable from an empty one.

- a server added to the file connects on restart, registers its tools, and the
  new tool is callable
- a server removed from the file is gone from the status afterwards
- malformed JSON written mid-session warns instead of throwing
- restart with nothing configured does not claim to be reconnecting
- status tells an absent file from one declaring no servers, naming the path in
  both cases

### One of them was decoration

Mutation testing (`AGENTS.md`: break a new test on purpose) caught it. Deleting
`servers.clear()` from `startServers` — so removed servers linger — failed
**zero** assertions.

Cause: `closeAll()` sets `state.client = undefined`, so a lingering server
prints without the version that `state.client?.info?.version` supplies. The
status line became `fake [ready] …` and slipped past a `/fake v9\.9\.9/` check.
The assertion now matches the server *name* and additionally requires the
empty-config message, which fails under that mutation.

Mutation results after the fix: restart-no-longer-reloads 7 failures,
message-never-distinguishes 2, no-`servers.clear()` 2.
