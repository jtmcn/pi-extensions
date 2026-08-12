# ast-grep: rent before you build

Structural search — find code by AST shape rather than text — is the one search
capability neither `grep` nor `read` can fake. "Every `await` not inside a
`try`" is not a regex.

Two ways to get it: adopt the upstream [ast-grep MCP
server](https://github.com/ast-grep/ast-grep-mcp) through the `mcp` extension,
or write a native `ast-grep` tool here. We adopted the server **on trial**, with
the native tool deferred behind a decision this document exists to inform.

The trial costs a config edit. The build costs ~200 lines, tests, and a README
we maintain forever. Renting first is only sound if we write down what would
make us buy — hence this document.

## What was configured

`~/.pi/agent/mcp.json`, user scope (ast-grep is not project-specific):

```jsonc
{
  "servers": {
    "ast-grep": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/ast-grep/ast-grep-mcp@732c339c3812a44e9111e6c3aefec64894acd58f",
               "--with", "mcp[cli]<2", "ast-grep-server"],
      "tools": ["find_code", "find_code_by_rule", "dump_syntax_tree", "test_match_code_rule"]
    }
  }
}
```

Warm start 0.75s, well inside `startupTimeoutMs`. Tools arrive as
`ast_grep_find_code` and friends. All four are verified working: a relational
rule (`await $E` with `not: inside: try_statement`) correctly matched the bare
await and excluded the guarded one.

### Both deviations from upstream's README are forced

**`--with 'mcp[cli]<2'`.** Upstream's documented `uvx --from git+…` invocation
is broken as of this writing. `pyproject.toml` declares `mcp[cli]>=1.6.0` with
no upper bound; MCP Python SDK 2.0.0 moved `mcp.server.fastmcp`, so a fresh
resolve installs 2.0.0 and dies on `ModuleNotFoundError` before serving a single
request. Their `uv.lock` pins 1.6.0, which is why the *cloned* `uv --directory …
run main.py` path in the same README works and the `uvx` path does not.

**Pinned commit.** `uvx --from git+…` with no ref re-resolves `main` on every
cache miss, so upstream could change our tool surface without warning.

Both are maintenance we now carry — worth weighing against "zero maintenance",
which was the whole appeal of renting.

## The measurement

`main.py` is 418 lines of Python that shells out to the same `ast-grep` CLI
already on PATH (`run --pattern`, `scan --inline-rules --stdin`,
`run --debug-query=ast`). There is no capability upstream that we could not
reach with `spawn`. The only real axis of difference is **output shape**, so
that is what was measured, against this repo:

| query | MCP `find_code` | native shape | ratio |
|---|---|---|---|
| `pi.on($EVENT, $$$)` — matches whole handler bodies | ~2,734 tok | ~185 tok | **15x** |
| `listWorktrees($$$)` — single-line matches | ~184 tok | ~99 tok | ~1.9x |

"Native shape" is one line per match — `path:line:col  <first line, 120 char
cap>` — plus a match/file total, with full JSON in `details` where it costs no
context.

The MCP server returns each match as its **complete matched node**. For
`pi.on($EVENT, $$$)` that is eleven entire event handlers, 295 lines, to answer
a question the 12-line version answers as well. `max_results` bounds the number
of matches, never their size: one 200-line class match is 200 lines.

**The 1.9x row is the honest caveat.** On narrow, single-line patterns the
difference is ~85 tokens — noise. The gap only opens on queries matching large
nodes.

That caveat argues for native more than against it. Matching whole functions,
classes and handlers is precisely what justifies reaching for ast-grep at all;
if every query is a single-line call site, `grep` was already sufficient and
neither option earns its place.

## What decides it

Revisit after a week of real use. The question is **not** whether native is
cheaper per query — that is settled above. It is whether the queries where it is
cheaper actually happen.

Build the native tool if:

- structural queries over large nodes (functions, classes, handlers) are a
  recurring habit, not a novelty — that is where 15x lives and it scales with
  node size;
- the pinned-commit and `mcp[cli]<2` workarounds need touching again, or
  upstream breaks a second time;
- the ~1.7k tokens of permanent schema (4 tools, ~6.8KB) start mattering.

Keep renting if:

- ast-grep goes largely unused — then native is 200 lines of well-tested dead
  code, the worse outcome;
- usage stays on narrow patterns where the difference is ~85 tokens.

## If we build it

Search only, per the repo's "safe half" convention: `ast-grep` can rewrite, and
that stays out — `edit` already covers mutation with per-file review.

- **Params:** `pattern` and `rule` (mutually exclusive; `rule` is inline YAML via
  `--inline-rules`, which is the only reason to prefer this over `grep`),
  optional `lang`, optional `paths`. `--lang` is genuinely optional: ast-grep
  infers per file from the extension and matched TS across this repo unaided.
- **Output:** one line per match, ~100 match cap, ~200 char per-match
  truncation, multi-line matches collapsed to first line + `…`, explicit
  `(truncated, showing X of N)`. Structured JSON into `details`.
- **Fold in the debug tools.** These are upstream's best idea and were missing
  from the first native sketch. Without them the model writes a plausible
  pattern, gets zero matches, and cannot tell whether the code is absent or the
  pattern is wrong. Both are thin: `run --debug-query=ast` for the syntax tree,
  `scan --inline-rules --stdin` to test a rule against a snippet. Neither has an
  output-size problem.

A partial build is possible — the `mcp` allow-list means we could keep
`dump_syntax_tree` + `test_match_code_rule` from the server and write native
search only, aiming effort exactly at the 15x. Weigh that against keeping a
Python toolchain alive for two occasional debug calls.

## Frictions found while verifying

- **Language enum is case-sensitive.** `"TypeScript"`, not `"typescript"`. A
  lowercase call returns nothing useful rather than an error.
- Server logs INFO chatter and a pydantic `IncompleteFieldDefinitionWarning` to
  stderr; the `mcp` extension retains stderr without parsing it, so this is
  harmless.
- Upstream is explicitly "experimental".
