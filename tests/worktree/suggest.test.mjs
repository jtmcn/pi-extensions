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
const { messageTexts, contentWords, nameFromMessages, randomName, suggestName } =
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

	const stopwordBlob = "the and or ".repeat(20) + "laterword1 laterword2";
	ok(
		"truncation ignores content beyond 200 chars",
		nameFromMessages([stopwordBlob]) === undefined,
		String(nameFromMessages([stopwordBlob])),
	);

	const long = nameFromMessages(["reorganise the authentication middleware configuration"]);
	const words = ["reorganise", "authentication", "middleware", "configuration"];
	ok("the cap holds", long !== undefined && long.length <= 24, String(long));
	ok("and does not leave a trailing dash", !long.endsWith("-"), String(long));
	ok(
		"and does not cut mid-word",
		long.split("-").every((word) => words.includes(word)),
		String(long),
	);
	// Pin the exact result so changes to cap() are deliberate.
	ok("the long message yields a specific result", long === "reorganise", String(long));
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

done();
