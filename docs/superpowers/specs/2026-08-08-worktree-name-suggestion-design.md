# Suggested names for new worktrees

`/worktree new` with no name asks `Worktree name:` through `ctx.ui.input`, whose
second argument — `"feature-name"` — is a placeholder that pi's TUI never
renders (`ExtensionInputComponent` takes it as `_placeholder` and drops it). So
the prompt is an empty box, and naming a worktree is entirely on the user. In
non-interactive mode the same path returns silently, doing nothing at all.

This adds a suggested name, prefilled and editable: press Enter to take it, or
type over it.

## Behaviour

`/worktree new` with no name, interactive:

```
Worktree name:
worktree-generated-name▌
```

The suggestion is prefilled through `ctx.ui.editor(title, prefill)`, which does
honour its second argument. Enter submits, Esc cancels, and the text can be
edited or cleared like any other field. Submitting empty cancels, as today.

`/worktree new` with no name, non-interactive (`pi -p`): the suggestion is used
without asking, and the existing `creating <path> …` line reports it. This
replaces a silent no-op.

`/worktree new <name>` is unchanged. The model's `worktree` tool is unchanged:
omitting `name` stays an error, because the model knows what it is doing and a
task-shaped name from it beats anything we can generate.

## Where the name comes from

Two sources, tried in order.

**The conversation.** Walk `ctx.sessionManager.getBranch()` — root → leaf, so
newest last — and consider user messages newest first. Take the first message
with at least two content words after filtering; content words are what remains
after lowercasing, stripping punctuation, and dropping a stopword list of
articles, pronouns, auxiliaries and filler ("the", "a", "should", "can", "you",
"please", "yes", "ok", "now", "also", "like", …). The first three content words,
joined with `-`, become the name.

Newest-first with a content-word floor is the point of the rule: the plain "last
user message" gives `yes-do` when you approve a plan and then reach for a
worktree, which is the common case. Skipping short acknowledgements walks back
to the message that actually described the work. Anchoring on the session's
*first* message was the alternative — stabler, but stale exactly when a session
has drifted far enough to want a new worktree.

Guards on what we read: only `role: "user"` messages, string content or the
`text` of text blocks; each message truncated to its first 200 characters before
tokenising, so a pasted file or command output cannot dominate; messages whose
text begins with `/` are skipped as slash commands.

**A random pair.** When no message qualifies — a fresh session, `/worktree new`
as the first thing typed, a slash-only `pi -p` run — fall back to an
adjective–noun pair from two short curated lists: `brave-otter`,
`quiet-harbor`. Memorable, and never empty.

Either way the result goes through the existing `slugify`, and is capped at 24
characters (cutting at a `-` boundary rather than mid-word) so a branch name
stays readable.

## Collisions

A generated name is made unique before it is offered: if a worktree of that
directory name exists, or its prefixed branch is already checked out somewhere,
suffix `-2`, then `-3`, up to a small bound, then fall back to a random pair.
Both facts come from the worktree list `doNew` already refreshes — no extra git
calls, and `uniqueName` stays synchronous over a precomputed set. A branch that
exists but is checked out nowhere is not a collision: `createWorktree` already
reuses it deliberately. A user-typed name is left alone —
`createWorktree` already fails loudly on an existing path or branch, and
silently creating `my-feature-2` because the user forgot they had `my-feature`
would be worse than the error.

## Configuration

None. The suggestion is always offered and always editable, so an off switch
buys nothing.

## Code

One new module, one wiring change.

`worktree/suggest.ts` — pure, no I/O, no `pi`:

```ts
/** Content words from one message text, stopwords and slash commands dropped. */
export function contentWords(text: string): string[];

/** Newest-first scan for the first message with >= 2 content words. */
export function nameFromMessages(texts: string[]): string | undefined;

/** Adjective–noun pair. `random` defaults to Math.random, injected in tests. */
export function randomName(random?: () => number): string;

/** nameFromMessages, else randomName. */
export function suggestName(texts: string[], random?: () => number): string;

/** First candidate not rejected by `taken`, else a random pair. */
export function uniqueName(
  base: string,
  taken: (name: string) => boolean,
  random?: () => number,
): string;
```

`texts` is a plain `string[]`, oldest first, so the module never touches session
entry types. Extracting them from `getBranch()` is a small reader in
`commands.ts`, which already holds the interactive plumbing:

- `doNew`, when `parsed.name` is empty, builds `texts`, calls `suggestName`,
  passes it through `uniqueName` against names taken by the refreshed worktree
  list, then either prefills `ctx.ui.editor` (interactive) or uses it directly
  (non-interactive, with the existing `say`).
- `CommandDeps` gains `getEntryTexts: () => string[]`, supplied by `index.ts`
  from the live `ctx`, keeping `commands.ts` free of a session-manager
  dependency and keeping the seam injectable in tests.
- Editor input is normalised: first line, trimmed, before the existing
  `slugify`.

## Tests

`tests/worktree/suggest.test.mjs`, pure, no repo:

- "yes, do it" then "the worktree extension should offer a generated name"
  yields `worktree-generated-name` — the acknowledgement is skipped.
- All-stopword and empty transcripts fall back to a random pair; an injected
  `random` makes the pair deterministic.
- A pasted 5KB blob does not produce a 60-character name (truncation).
- A leading `/` message is ignored.
- `uniqueName` suffixes `-2` and `-3`, and gives up to a random pair.
- Cap cuts on a `-` boundary.

`tests/worktree/worktree.test.mjs` or the fake-`pi` integration test covers the
wiring: `/worktree new` with no name in a scripted-UI session creates the
suggested directory, and the same command with `hasUI` false creates one rather
than doing nothing.

Each test gets broken on purpose before it is trusted — a suggestion module is
exactly the kind of code where a test can pass on a coincidence of stopwords.
