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
