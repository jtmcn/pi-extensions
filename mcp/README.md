# mcp

An MCP client for pi. Spawns configured **stdio** MCP servers, lists their
tools, and registers each one as a native pi tool.

pi omits MCP deliberately — its README says to "build an extension that adds
MCP support" if you want it. This is that extension.

## Configuration

`~/.pi/agent/mcp.json`, or `<project>/.pi/mcp.json` for a **trusted** project
(later wins, merged per server name). A server spec is an arbitrary command
line, which is why the project-local file is gated on trust.

```jsonc
{
  // How long the first turn waits for servers to finish connecting (default 10000).
  "startupTimeoutMs": 10000,

  // "servers" and "mcpServers" are both accepted, so a Claude Code / Cursor
  // block can be pasted in unchanged.
  "servers": {
    "gitnexus": {
      "command": "gitnexus",
      "args": ["mcp"],

      // Tool allow-list. STRONGLY recommended — see "Context cost" below.
      // Omit to expose every tool the server offers.
      "tools": ["query", "context", "impact", "trace"],

      "env": { "SOME_TOKEN": "..." },   // merged over the inherited environment
      "cwd": "/path/to/repo",           // defaults to the session cwd
      "timeoutMs": 120000,              // per request, default 60000
      "disabled": false
    }
  }
}
```

### Reusing an existing server list

`extends` reads the server map out of another JSON file, so one definition can
feed both pi and Claude Code:

```jsonc
{
  "extends": "~/.claude.json",
  "servers": {
    // Anything defined here overrides the inherited entry of the same name.
    "gitnexus": { "command": "gitnexus", "args": ["mcp"], "tools": ["query", "context"] }
  }
}
```

## Commands

```
/mcp            server status: state, tool count, tool names, last error
/mcp restart    re-read mcp.json, tear down every server and reconnect
```

`/mcp` waits for any handshake still in flight before reporting, bounded by
`startupTimeoutMs`, so it describes what is actually running rather than a
snapshot of "connecting". A server that never answers is reported as still
connecting once that budget is spent.

**`/mcp restart` re-reads the config**, so editing `mcp.json` and restarting
picks up servers you added, removed, or changed — no `/reload` or new session
needed. Malformed JSON is warned about and leaves the running servers alone.

## Tool naming

Tools are namespaced `<server>_<tool>` and sanitized to `[a-z0-9_]`, because
names collide across servers in practice ("query", "search"). Collisions after
sanitizing get a numeric suffix.

The suffix is decided per *connect cycle*, not per process. A reconnect has to
recompute the same names it computed last time, because rebinding (below) relies
on the name being stable: a renamed tool leaves the original with no handler,
permanently answering "not connected", and adds a second copy of every schema to
the tool list.

## Context cost

Every exposed tool's full JSON Schema is sent with each request. gitnexus alone
offers 17 tools; six servers of that size would dwarf the rest of the system
prompt. This is the strongest practical argument against MCP, so:

- set `tools` per server and list only what you actually use;
- the extension warns when a server exposes more than 8 tools with no
  allow-list;
- an allow-list entry matching no tool is reported rather than ignored, since a
  typo and a removed tool otherwise look identical.

## Behaviour worth knowing

- **Servers start on `session_start`, never at extension load.** pi's extension
  docs forbid background resources in the factory, which also runs for
  `--list-models` and `--help`. Getting this wrong leaks a child process per
  invocation.
- **`session_start` and `/mcp restart` share one start path.** Restart used to
  reconnect the in-memory server map, which only `session_start` ever populated:
  a server added to `mcp.json` mid-session was invisible, and `/mcp` answered
  "no servers configured" while naming the file that had just been edited
  correctly. Both paths now call the same loader.
- **"Nothing configured" distinguishes an absent file from an empty one**, and
  names the paths it read or looked for rather than hardcoding
  `~/.pi/agent/mcp.json`, which is wrong under `PI_CODING_AGENT_DIR`.
- **The first turn waits for connections**, bounded by `startupTimeoutMs`.
  Tools are advertised as part of the request, so a tool registered mid-turn is
  invisible until the next one — without the gate a fast first prompt races the
  handshake and the model reports no MCP tools. Servers that exceed the budget
  keep connecting in the background and their tools appear on a later turn.
- **Tools are registered once per process** and dispatch through a mutable
  handler map, so `/mcp restart`, `/reload` and forks rebind the existing tools
  instead of registering duplicates.
- **A closed server's tools answer rather than vanish.** pi has no way to
  unregister a tool, so a tool whose handler is gone returns "not connected. Run
  /mcp restart to retry" as ordinary tool output.
- **Tool failures come back as tool output, not exceptions.** MCP distinguishes
  `isError` (the tool ran and failed — prefixed `MCP tool error:` so the model
  can see it) from a JSON-RPC error (protocol-level). Transport failures such as
  a crash or timeout are also returned as text so the turn survives.
- **stderr is never parsed as protocol.** Servers log there freely (gitnexus
  does on every start); the last 20 lines are retained and attached to crash
  messages.
- **Non-JSON stdout lines are skipped**, since some servers print a banner
  before speaking protocol.
- **Server-initiated requests are refused** with `-32601`. We advertise no
  capabilities, and leaving a server waiting on a reply would hang it.

## Not supported

- **Remote servers** (Streamable HTTP / SSE, usually with OAuth). A `url` or
  `"type": "http"` entry is reported as unsupported rather than silently
  failing to spawn. This is the gap that keeps Claude.ai-managed connectors
  (Linear, Notion, Slack) out of pi.
- **Prompts and resources.** Tools are the overwhelming majority of the value;
  pi has its own prompt and resource systems.
- **Sampling and roots.** Both are server→client requests, which are refused.

## Implementation

```
client.ts   stdio JSON-RPC 2.0 client (spawn, NDJSON framing, timeouts, cancel)
config.ts   config loading, validation, trust boundary, extends
bridge.ts   pure MCP↔pi mappings: names, allow-list, schemas, content blocks
index.ts    lifecycle, tool registration, /mcp command
```

Zero dependencies. `@modelcontextprotocol/sdk` would pull in an HTTP server
stack for three JSON-RPC calls, this repo installs by `git clone` + symlink
with no `npm install` step, and the SDK's own dependency chain currently trips
pnpm's supply-chain trust check.

Raw JSON Schema from a server is passed to `pi.registerTool` via
`Type.Unsafe`. That is sound because pi forwards tool parameters to the
provider without running a TypeBox check over arguments — and it is the same
mechanism pi-ai uses for its own hand-written JSON Schema (`StringEnum`).

## Tests

```bash
cd ~/Code/pi-extensions
node tests/run-all.mjs mcp

# also smoke-test a real server
PI_TEST_MCP_COMMAND="gitnexus mcp" PI_TEST_MCP_CWD=/some/indexed/repo node tests/mcp/mcp.test.mjs
```

`tests/mcp/mcp.test.mjs` drives the extension through a fake `pi` (one
`extHarness` for every lifecycle case): reload without renaming tools, `/mcp
restart`, the `before_agent_start` startup gate and its timeout budget, the
allow-list warnings, `/mcp` status, and the difference between our own teardown
and a server that genuinely failed.

`tests/fixtures/fake-mcp-server.mjs` is deliberately awkward: it logs to stderr,
prints a non-JSON banner, paginates `tools/list`, returns `isError` for one
tool and a JSON-RPC error for another, sends the client a request, omits
`inputSchema` on a tool, and can hang or crash on demand.
