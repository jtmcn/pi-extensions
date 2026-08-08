# Worktree Name Suggestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/worktree new` with no name offers a prefilled, editable suggested name — derived from the conversation, falling back to a random adjective–noun pair.

**Architecture:** One new pure module, `worktree/suggest.ts`, turns session entries into a slug: newest-first scan of user messages for the first with two or more content words, else a random pair, then a uniqueness suffix. `worktree/commands.ts`'s `doNew` uses it in two places — prefilling `ctx.ui.editor` when there is a UI, and using it outright when there is not (today that path silently does nothing). No config, no change to the model-facing tool.

**Tech Stack:** TypeScript loaded by pi through jiti (no build step), Node's `node:test`-free hand-rolled assertions via `tests/harness.mjs`, real git in throwaway repos for the wiring test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-worktree-name-suggestion-design.md`. Read it first.
- No new configuration keys. The suggestion is always offered and always editable.
- The model's `worktree` tool is **not** changed: omitting `name` stays an error.
- A user-typed name is never mangled for uniqueness — only generated names get a `-2`/`-3` suffix.
- `worktree/suggest.ts` is pure: no imports from `node:fs`, no `pi`, no session types. It may import `slugify` from `../lib/git.ts`.
- Generated names are capped at 24 characters, cut at a `-` boundary.
- Tabs for indentation, matching every other file in this repo. Double quotes.
- Every file gets the repo's house comment style: a top-of-file block saying *why* the module exists, not what each line does.
- Verify with `node tests/run-all.mjs worktree` while iterating and `npm run check` before the final commit.
- Break each new assertion on purpose before trusting it (mutate the implementation, watch it fail, restore).

---

### Task 1: `worktree/suggest.ts` — the pure name generator

**Files:**
- Create: `worktree/suggest.ts`
- Test: `tests/worktree/suggest.test.mjs`

**Interfaces:**
- Consumes: `slugify` from `lib/git.ts` (`(input: string) => string`; lowercases, replaces runs of non `[a-z0-9._/-]` with `-`, collapses `--`, trims leading/trailing `-`/`.`, caps at 60, returns `"worktree"` for empty input).
- Produces, all exported from `worktree/suggest.ts`:
  - `messageTexts(entries: readonly unknown[]): string[]` — user message texts, oldest first
  - `contentWords(text: string): string[]`
  - `nameFromMessages(texts: readonly string[]): string | undefined`
  - `randomName(random?: () => number): string`
  - `suggestName(texts: readonly string[], random?: () => number): string`
  - `uniqueName(base: string, taken: (name: string) => boolean, random?: () => number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/worktree/suggest.test.mjs`:

```js
/**
 * Tests for worktree/suggest.ts — the generated name offered by `/worktree new`.
 *
 *   node tests/worktree/suggest.test.mjs
 *
 * Pure: no repo, no pi, no subprocesses. The interesting cases are the ones a
 * naive implementation gets wrong — "yes, do it" as the newest message, a
 * pasted blob, an all-stopword transcript — so each is asserted directly
 * rather than through the command layer.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { messageTexts, contentWords, nameFromMessages, randomName, suggestName, uniqueName } =
	await loadExt("worktree/suggest.ts");

/** A user message entry in the shape `sessionManager.getBranch()` returns. */
const user = (content) => ({ type: "message", message: { role: "user", content } });
const assistant = (text) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

// ============================================ messageTexts

{
	const entries = [
		user("first thing"),
		assistant("some reply about kittens"),
		user([{ type: "text", text: "second thing" }, { type: "image", data: "…" }]),
		{ type: "custom", customType: "worktree-focus", data: { path: "/tmp/x" } },
	];
	const texts = messageTexts(entries);
	ok("only user messages, oldest first", JSON.stringify(texts) === JSON.stringify(["first thing", "second thing"]), JSON.stringify(texts));
	ok("assistant text is not read", !texts.join(" ").includes("kittens"));
	ok("junk entries are ignored", messageTexts([undefined, null, {}, { type: "message" }]).length === 0);
}

// ============================================ contentWords

{
	ok(
		"stopwords and filler are dropped",
		JSON.stringify(contentWords("the worktree extension should offer a generated name")) ===
			JSON.stringify(["worktree", "extension", "offer", "generated", "name"]),
		JSON.stringify(contentWords("the worktree extension should offer a generated name")),
	);
	ok("an acknowledgement has no content words", contentWords("yes, do it").length === 0, JSON.stringify(contentWords("yes, do it")));
	ok("punctuation is not a word", JSON.stringify(contentWords("fix: parser!!")) === JSON.stringify(["fix", "parser"]));
	ok("a slash command yields nothing", contentWords("/worktree new").length === 0);
	ok("code-ish tokens survive", JSON.stringify(contentWords("rename listWorktrees")) === JSON.stringify(["rename", "listworktrees"]));
}

// ============================================ nameFromMessages

{
	const texts = ["the worktree extension should offer a generated name", "ok", "yes, do it"];
	ok(
		"skips acknowledgements back to the real request",
		nameFromMessages(texts) === "worktree-extension-offer",
		String(nameFromMessages(texts)),
	);
	const two = nameFromMessages(["fix the parser bug", "retry the flaky fetcher"]);
	ok("newest qualifying message wins", two === "retry-flaky-fetcher", String(two));
	ok("nothing to go on is undefined", nameFromMessages(["ok", "yes", "do it"]) === undefined);
	ok("an empty transcript is undefined", nameFromMessages([]) === undefined);
	ok("one content word is not enough", nameFromMessages(["parser"]) === undefined);

	const blob = `paste this ${"x".repeat(5000)} ${Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")}`;
	const fromBlob = nameFromMessages([blob]);
	ok("a pasted blob cannot produce a long name", (fromBlob ?? "").length <= 24, String(fromBlob));

	const long = nameFromMessages(["reorganise the authentication middleware configuration"]);
	const words = ["reorganise", "authentication", "middleware", "configuration"];
	ok("the cap holds", long !== undefined && long.length <= 24, String(long));
	ok("and does not leave a trailing dash", !long.endsWith("-"), String(long));
	ok(
		"and does not cut mid-word",
		long.split("-").every((word) => words.includes(word)),
		String(long),
	);
}

// ============================================ randomName / suggestName

{
	const first = randomName(() => 0);
	ok("a random pair is adjective-noun", /^[a-z]+-[a-z]+$/.test(first), first);
	ok("an injected random is deterministic", randomName(() => 0) === first);
	ok("a different draw gives a different pair", randomName(() => 0.5) !== first);

	ok("suggestName prefers the conversation", suggestName(["fix the parser bug"], () => 0) === "fix-parser-bug", suggestName(["fix the parser bug"], () => 0));
	ok("suggestName falls back to a pair", suggestName(["yes"], () => 0) === first, suggestName(["yes"], () => 0));
	ok("suggestName on an empty transcript falls back", suggestName([], () => 0) === first);
}

// ============================================ uniqueName

{
	ok("a free name is returned as-is", uniqueName("parser-fix", () => false) === "parser-fix");
	ok("a taken name is suffixed", uniqueName("parser-fix", (n) => n === "parser-fix") === "parser-fix-2");
	ok(
		"and keeps counting",
		uniqueName("parser-fix", (n) => n === "parser-fix" || n === "parser-fix-2") === "parser-fix-3",
	);
	const exhausted = uniqueName("parser-fix", () => true, () => 0);
	ok("everything taken falls back to a random pair", exhausted === randomName(() => 0), exhausted);
	ok("the suffix respects the cap", uniqueName("abcdefghij-abcdefghij-abc", (n) => n === "abcdefghij-abcdefghij-abc").length <= 24);
}

done();
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/joel/Code/pi-extensions
node tests/worktree/suggest.test.mjs
```

Expected: failure resolving `worktree/suggest.ts` (the module does not exist yet).

- [ ] **Step 3: Write `worktree/suggest.ts`**

```ts
/**
 * The name `/worktree new` offers when you do not supply one.
 *
 * Pure, and deliberately so: naming is guesswork, and guesswork is only
 * trustworthy with tests over its awkward inputs — an acknowledgement as the
 * newest message, a pasted file, a transcript of nothing but stopwords.
 *
 * The rule is newest-first with a content-word floor. Plain "last user message"
 * yields `yes-do` when you approve a plan and then reach for a worktree, which
 * is the common case; skipping short acknowledgements walks back to the message
 * that described the work. When nothing qualifies there is still a name: a
 * random adjective-noun pair beats an empty prompt.
 */

import { slugify } from "../lib/git.ts";

/** Characters of a generated name. Long enough to read, short enough for a branch. */
const MAX_LENGTH = 24;

/** Words taken from one message. Three is a phrase; four is a sentence. */
const MAX_WORDS = 3;

/** A message must carry this many content words to name a worktree. */
const MIN_WORDS = 2;

/** Characters of a message body considered. Keeps a pasted file from winning. */
const MAX_TEXT = 200;

/**
 * Words that say nothing about the work.
 *
 * Articles, pronouns, auxiliaries, and the filler of talking to an agent. The
 * list is short on purpose: over-filtering turns "fix the parser" into
 * "parser", and a two-word name is more recognisable than a one-word one.
 */
const STOPWORDS = new Set([
	"a", "about", "add", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be",
	"been", "but", "by", "can", "could", "did", "do", "does", "doing", "done", "for", "from",
	"get", "go", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its",
	"just", "know", "let", "like", "make", "may", "me", "might", "more", "my", "need", "no",
	"not", "now", "of", "ok", "okay", "on", "one", "only", "or", "our", "out", "over",
	"please", "put", "same", "say", "see", "should", "so", "some", "sure", "than", "that",
	"the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "try",
	"up", "us", "use", "want", "was", "way", "we", "well", "were", "what", "when", "where",
	"which", "while", "who", "why", "will", "with", "would", "yes", "you", "your",
]);

const ADJECTIVES = [
	"amber", "brave", "bright", "calm", "clever", "crisp", "eager", "gentle", "golden",
	"keen", "lively", "lucky", "mellow", "quiet", "rapid", "silver", "solid", "swift",
	"tidy", "warm",
];

const NOUNS = [
	"anchor", "arbor", "badger", "beacon", "cedar", "comet", "delta", "ember", "falcon",
	"harbor", "heron", "lantern", "meadow", "orbit", "otter", "quarry", "ridge", "summit",
	"thicket", "willow",
];

/**
 * User message texts from session entries, oldest first.
 *
 * Narrows structurally rather than importing pi's entry types: this module has
 * no other reason to know them, and its tests can then pass plain objects.
 */
export function messageTexts(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		const message = (entry as { type?: unknown; message?: unknown } | undefined)?.message as
			| { role?: unknown; content?: unknown }
			| undefined;
		if ((entry as { type?: unknown })?.type !== "message" || message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((block) => (block as { type?: unknown })?.type === "text")
			.map((block) => String((block as { text?: unknown }).text ?? ""))
			.join(" ");
		if (text) texts.push(text);
	}
	return texts;
}

/** Content words of one message: lowercased, punctuation and stopwords gone. */
export function contentWords(text: string): string[] {
	const head = text.trim().slice(0, MAX_TEXT);
	// A slash command is pi's syntax, not the user's description of the work.
	if (head.startsWith("/")) return [];
	return head
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Cut to MAX_LENGTH on a `-` boundary, so a name never ends mid-word. */
function cap(name: string): string {
	if (name.length <= MAX_LENGTH) return name;
	const cut = name.slice(0, MAX_LENGTH + 1);
	const boundary = cut.lastIndexOf("-");
	return (boundary > 0 ? cut.slice(0, boundary) : name.slice(0, MAX_LENGTH)).replace(/-+$/, "");
}

/** The newest message with enough content words, as a slug. */
export function nameFromMessages(texts: readonly string[]): string | undefined {
	for (let index = texts.length - 1; index >= 0; index--) {
		const words = contentWords(texts[index]);
		if (words.length < MIN_WORDS) continue;
		return cap(slugify(words.slice(0, MAX_WORDS).join("-")));
	}
	return undefined;
}

/** An adjective-noun pair. `random` is injected so tests are deterministic. */
export function randomName(random: () => number = Math.random): string {
	const pick = <T>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
	return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** The conversation's name, else a random pair. */
export function suggestName(texts: readonly string[], random: () => number = Math.random): string {
	return nameFromMessages(texts) ?? randomName(random);
}

/**
 * The first of `base`, `base-2`, `base-3`, … that `taken` rejects nothing for.
 *
 * Only generated names come through here. A name the user typed must fail
 * loudly instead: silently creating `my-feature-2` because they forgot about
 * `my-feature` is worse than the error `createWorktree` already raises.
 */
export function uniqueName(
	base: string,
	taken: (name: string) => boolean,
	random: () => number = Math.random,
): string {
	if (!taken(base)) return base;
	for (let suffix = 2; suffix <= 9; suffix++) {
		const candidate = cap(`${base}-${suffix}`);
		if (!taken(candidate)) return candidate;
	}
	return randomName(random);
}
```

- [ ] **Step 4: Run the test until it passes**

```bash
node tests/worktree/suggest.test.mjs
```

Expected: every line `ok`, ending with the assertion count. If the two cap assertions in `nameFromMessages` disagree with each other, simplify them to a length check plus "no trailing dash" plus "every segment is a whole word from the input" — do not weaken them to only a length check.

- [ ] **Step 5: Break it on purpose**

Make each of these mutations, confirm a *specific* assertion fails, then restore:

1. `for (let index = texts.length - 1; …)` → `for (let index = 0; index < texts.length; index++)`. Expect "newest qualifying message wins" to fail.
2. `if (words.length < MIN_WORDS) continue;` → `if (words.length < 1) continue;`. Expect "skips acknowledgements back to the real request" to fail (`do-it`).
3. `head.slice(0, MAX_TEXT)` → `head`. Expect "a pasted blob cannot produce a long name" to fail.
4. In `uniqueName`, `if (!taken(base)) return base;` → `return base;`. Expect "a taken name is suffixed" to fail.

If a mutation does not fail anything, the corresponding assertion is decoration — fix the assertion.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add worktree/suggest.ts tests/worktree/suggest.test.mjs
git commit -m "worktree: generate a suggested name from the conversation"
```

---

### Task 2: Offer the suggestion from `/worktree new`

**Files:**
- Modify: `worktree/commands.ts` — the `doNew` no-name branch (currently `worktree/commands.ts:120-127`) and its imports
- Modify: `tests/worktree/commands.test.mjs` — `setup()`'s fake ctx, plus new cases
- Modify: `worktree/README.md` — the Commands section and the Files list
- Modify: `README.md` — only if the worktree row's description no longer matches

**Interfaces:**
- Consumes: `messageTexts`, `suggestName`, `uniqueName` from `./suggest.ts` (signatures in Task 1); `slugify`, `listWorktrees` and `Worktree` from `../lib/git.ts`; `worktreePath(config, projectRoot, name)` from `./config.ts`; `ctx.ui.editor(title: string, prefill?: string): Promise<string | undefined>`; `ctx.sessionManager.getBranch(): unknown[]` (root → leaf, newest last).
- Produces: no new exports. `doNew`'s behaviour changes only when the name argument is absent.

- [ ] **Step 1: Write the failing tests**

In `tests/worktree/commands.test.mjs`, first extend `setup()` so the fake ctx can answer an editor prompt and hand over a transcript. Add `editor` and `entries` to the options; `editor` is a function of the prefill, defaulting to "the user pressed Enter", so accepting the suggestion needs no per-test wiring:

```js
function setup({
	hasUI = true,
	confirms = [],
	select,
	input,
	editor = async (_prompt, prefill) => prefill,
	entries = [],
	config = {},
} = {}) {
```

then add to `prompts`:

```js
	const prompts = { confirm: [], select: [], input: [], editor: [] };
```

and inside `ctx.ui`, next to `input`:

```js
			editor: async (prompt, prefill) => {
				prompts.editor.push({ prompt, prefill });
				return editor(prompt, prefill);
			},
```

and give the fake ctx a session manager, next to `ui`:

```js
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
```

Then append these cases at the end of the file, before `done()`:

```js
// ============================================ new: the suggested name

/** A user message entry, as `sessionManager.getBranch()` returns it. */
const userEntry = (content) => ({ type: "message", message: { role: "user", content } });

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Accepting the suggestion: the default fake editor returns its prefill.
	const h = setup({
		entries: [userEntry("fix the parser bug"), userEntry("yes, do it")],
		config: { path: "wt", branchPrefix: "" },
	});

	await h.commands.dispatch(info, h.ctx, "new");

	ok("the prompt is prefilled with a suggestion", h.prompts.editor[0]?.prefill === "fix-parser-bug", JSON.stringify(h.prompts.editor));
	ok("and no bare input prompt is used", h.prompts.input.length === 0);
	ok("accepting it creates that worktree", await exists(join(dir, "wt", "fix-parser-bug")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Typing over the suggestion wins, and a stray newline is not part of the name.
	const h = setup({
		entries: [userEntry("fix the parser bug")],
		editor: async () => "my-own-name\n",
		config: { path: "wt", branchPrefix: "" },
	});

	await h.commands.dispatch(info, h.ctx, "new");

	ok("the typed name wins", await exists(join(dir, "wt", "my-own-name")), JSON.stringify(h.said));
	ok("and the suggestion is not created", !(await exists(join(dir, "wt", "fix-parser-bug"))));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Clearing the field cancels, as an empty submit always has.
	const h = setup({ entries: [userEntry("fix the parser bug")], editor: async () => "  ", config: { path: "wt", branchPrefix: "" } });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("an empty submit creates nothing", !(await exists(join(dir, "wt"))), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// The suggested name is already taken: offer the suffixed one.
	await pexec("git", ["worktree", "add", "-q", "-b", "fix-parser-bug", join(dir, "wt", "fix-parser-bug")], { cwd: dir });
	const h = setup({ entries: [userEntry("fix the parser bug")], config: { path: "wt", branchPrefix: "" } });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a taken suggestion is suffixed", h.prompts.editor[0]?.prefill === "fix-parser-bug-2", JSON.stringify(h.prompts.editor));
	ok("and that is what gets created", await exists(join(dir, "wt", "fix-parser-bug-2")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Non-interactive: no prompt to fall back on, so use the suggestion.
	const h = setup({ hasUI: false, entries: [userEntry("fix the parser bug")], config: { path: "wt", branchPrefix: "" } });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("non-interactive creates the suggested worktree", await exists(join(dir, "wt", "fix-parser-bug")), JSON.stringify(h.said));
	ok("and says which name it chose", h.messages().some((m) => m.includes("fix-parser-bug")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// No transcript at all: still a name, and still a worktree.
	const h = setup({ hasUI: false, entries: [], config: { path: "wt", branchPrefix: "" } });

	await h.commands.dispatch(info, h.ctx, "new");

	const created = h.messages().join(" ");
	ok("an empty transcript still names something", /[a-z]+-[a-z]+/.test(created), JSON.stringify(h.said));
	ok("and creates it", (await pexec("git", ["worktree", "list"], { cwd: dir })).stdout.split("\n").length > 2, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}
```

Three notes for whoever writes this. `makeRepo([])` must be called with an explicit `[]` — the helper defaults to `branches = ["exp"]`. `pexec` and `basename` need to be in scope: `pexec` comes from `../harness.mjs`, `basename` from `node:path`; both are already imported for the removal tests, so check rather than re-add. And a cancelled editor (Esc, i.e. `undefined`) is covered by the empty-submit case only if `editor: async () => undefined` behaves the same way — add that one-line variant if the implementation treats them differently.

- [ ] **Step 2: Run them and watch them fail**

```bash
node tests/worktree/commands.test.mjs
```

Expected: the suggestion cases fail — `ctx.ui.editor` is never called (the code still calls `ctx.ui.input`), the non-interactive case creates nothing (today it returns early), and the prefill assertions read `undefined`.

- [ ] **Step 3: Change `doNew`**

In `worktree/commands.ts`, add to the imports:

```ts
import { messageTexts, suggestName, uniqueName } from "./suggest.ts";
```

Replace the no-name branch:

```ts
		const rawBase = parsed.base;
		let name = parsed.name;
		if (!name) {
			if (!ctx.hasUI) return;
			name = (await ctx.ui.input("Worktree name:", "feature-name")) ?? "";
			if (!name.trim()) return;
		}
```

with:

```ts
		const rawBase = parsed.base;
		let name = parsed.name;
		if (!name) {
			// A suggestion rather than an empty box: pi's `input` placeholder is never
			// rendered, so the old hint was invisible. `editor` does prefill, which
			// makes the name editable instead of merely proposed.
			const suggestion = await suggest(info, ctx);
			if (!ctx.hasUI) {
				// No prompt to fall back on. Using the suggestion beats the silent
				// no-op this path used to be.
				name = suggestion;
			} else {
				name = ((await ctx.ui.editor("Worktree name:", suggestion)) ?? "").split("\n")[0];
				if (!name.trim()) return;
			}
		}
```

and add `suggest` next to `refresh`, above `doNew`:

```ts
	/**
	 * A name to offer for a new worktree, unique against what already exists.
	 *
	 * Uniqueness is applied only here, to generated names: a name the user typed
	 * must keep failing loudly in `createWorktree` rather than quietly becoming
	 * something else.
	 */
	const suggest = async (info: RepoInfo, ctx: ExtensionContext): Promise<string> => {
		const worktrees = await refresh(info);
		const prefix = getConfig().branchPrefix;
		const taken = new Set<string>();
		for (const wt of worktrees) {
			taken.add(basename(wt.path));
			if (wt.branch) taken.add(wt.branch.startsWith(prefix) ? wt.branch.slice(prefix.length) : wt.branch);
		}
		return uniqueName(suggestName(messageTexts(ctx.sessionManager.getBranch())), (name) => taken.has(name));
	};
```

- [ ] **Step 4: Run the whole extension's tests until green**

```bash
node tests/run-all.mjs worktree
```

Expected: all files pass, including the pre-existing `commands.test.mjs` cases (`setup()` changed shape, so a missed call site shows up here).

- [ ] **Step 5: Break it on purpose**

Three mutations, each should fail a *named* assertion; restore after each:

1. `name = suggestion;` → `return;` in the `!ctx.hasUI` branch. Expect "non-interactive creates the suggested worktree" to fail.
2. `.split("\n")[0]` → nothing (use the raw editor text). Expect "the typed name wins" to fail, because `my-own-name\n` slugifies with a trailing separator — if it still passes, `slugify` absorbed it and the assertion should instead check the exact created directory name, which it does; verify by inspecting `wt/`.
3. In `suggest`, drop the `uniqueName` wrapper. Expect "a taken suggestion is suffixed" to fail.

- [ ] **Step 6: Update the docs**

In `worktree/README.md`, in the Commands section, replace the paragraph beginning "Names are slugified, and quoting works" with:

```markdown
Names are slugified, and quoting works, so `/worktree new "My Feature!"`
creates `my-feature`. The second token is the base ref, so an unquoted
multi-word name is an error rather than a mystery branch.

With no name, the prompt is prefilled with a suggestion: the newest thing you
asked for, reduced to three content words (`fix-parser-bug`), or an
adjective–noun pair (`brave-otter`) when the conversation has nothing to go on.
Press Enter to take it, or type over it. Short acknowledgements are skipped, so
approving a plan and then running `/worktree new` still names the work rather
than the approval. A suggestion that collides with an existing worktree or
branch is offered as `-2`; a name you type yourself is never adjusted, it fails.
Non-interactively (`pi -p`) the suggestion is used without asking, where the
command previously did nothing at all.
```

Add to the Files list in the same README, after the `select.ts` line:

```
worktree/suggest.ts      the generated name offered by `new` (pure)
```

Add to the Tests section's file count sentence: it is now eight files under `tests/worktree/`, and mention `suggest.test.mjs` alongside the other pure tests.

Check the root `README.md` row for `worktree` — if its one-line description still reads accurately, leave it.

- [ ] **Step 7: Full check and commit**

```bash
npm run check
git add worktree/commands.ts tests/worktree/commands.test.mjs worktree/README.md README.md
git commit -m "worktree: offer the suggested name from /worktree new"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Prefilled, editable suggestion via `ctx.ui.editor` | 2, step 3 |
| Enter accepts, empty submit still cancels | 2, steps 1 and 3 |
| Non-interactive uses the suggestion instead of no-op | 2, steps 1 and 3 |
| `/worktree new <name>` unchanged; model tool unchanged | not touched; guarded by the existing `commands.test.mjs` and `worktree.test.mjs` cases |
| Newest-first user messages, content-word floor of 2 | 1 (`nameFromMessages`) |
| Stopword list, 3 words, 200-char truncation, `/` skipped | 1 (`contentWords`, `MAX_TEXT`) |
| 24-char cap on a `-` boundary | 1 (`cap`) |
| Random adjective–noun fallback, injectable randomness | 1 (`randomName`, `suggestName`) |
| Collision suffix for generated names only | 1 (`uniqueName`) + 2 (`suggest`) |
| No configuration | nothing added |
| Docs | 2, step 6 |

**Types:** `messageTexts`/`contentWords`/`nameFromMessages`/`randomName`/`suggestName`/`uniqueName` are used in Task 2 exactly as declared in Task 1. `suggest` takes `(info: RepoInfo, ctx: ExtensionContext)` and `ExtensionCommandContext` extends `ExtensionContext`, so `doNew`'s `ctx` satisfies it.
