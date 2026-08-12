# delta

Renders diffs with [delta](https://github.com/dandavison/delta) instead of pi's
built-in diff styling:

- `bash` results whose command produces a diff (`git diff`, `git show`,
  `git log -p`, `git stash show -p`, `diff -u`, plus anything you add through
  `extraCommands`)
- the diff pi paints when the `edit` tool applies a change

Display only: the model still receives the plain unified diff, so this costs no
tokens and cannot confuse it with escape codes.

Delta reads its own settings from the `[delta]` section of your git config, so
diffs in pi look like diffs in your pager. This extension only forces
`--paging never` and the width.

## Requirements

`delta` on `PATH`. Without it you get pi's built-in rendering and one warning per
session.

## Config

`~/.pi/agent/delta.json`, or `<project>/.pi/delta.json` in a trusted project:

```json
{
  "enabled": true,
  "command": "delta",
  "args": [],
  "timeoutMs": 2000,
  "maxBytes": 262144,
  "extraCommands": ["^jj\\s+diff"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `command` | `"delta"` | Binary to run |
| `args` | `[]` | Extra delta flags, appended last so they win over git config |
| `timeoutMs` | `2000` | Per-invocation timeout |
| `maxBytes` | `262144` | Diffs larger than this skip delta |
| `extraCommands` | `[]` | Regexes added to the bash command matcher |

## How it works, and what that costs

Pi has no renderer-only extension point, so this registers tools named `bash` and
`edit` that spread pi's built-in definitions and replace only the render slots.
Execution, schemas, and prompt metadata are pi's, untouched.

Two consequences worth knowing:

- **Do not combine it with an extension that routes `bash` elsewhere** (a
  container or SSH router). Both register the same name and the last one wins.
  Registration happens unconditionally when the extension loads, before any
  config is read, so `enabled: false` cannot prevent the conflict — it only
  stops text reaching delta once registered. The only fix is to not load this
  extension in that setup.
- **`edit` shows no pending preview.** Pi computes that preview with an
  unexported helper; reproducing it would be a fork that breaks on upgrades. You
  see `edit <path>` while the edit is in flight and the delta diff once it lands.

Delta runs asynchronously, so a diff appears in pi's own styling for one frame
before delta's rendering replaces it. Results are cached per diff, width, and
config; a resize re-renders at the new width.

`write` is not touched: it has no diff to render.
