/**
 * Tests for per-session state (worktree/session.ts).
 *
 *   cd tests && npm install && node worktree/session.test.mjs
 *
 * The session object exists to make "reset everything on session_start"
 * unnecessary: a replaced session is disposed, not cleaned. What is worth
 * pinning down is therefore the lifetime — that a disposed session is inert —
 * and the two things focus changes must get right: focus is persisted as a
 * durable *entry* (a queued custom message is lost on reload), and restoring
 * focus from the transcript must not re-persist or re-announce it.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createSession, FOCUS_ENTRY_TYPE, FOCUS_MESSAGE_TYPE } = await loadExt("worktree/session.ts");

const REPO = {
	projectRoot: "/proj",
	worktreeRoot: "/proj/main",
	branch: "main",
	bare: false,
};

// `noRepo` rather than `repo: undefined`: a destructuring default fires on an
// explicit undefined, so the latter would silently hand back REPO.
function setup({ noRepo = false, hasUI = true, exec } = {}) {
	const repo = noRepo ? undefined : REPO;
	const entries = [];
	const messages = [];
	const statuses = [];
	const pi = {
		exec: exec ?? (async () => ({ stdout: "", stderr: "", code: 1, killed: false })),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		sendMessage: (message, options) => messages.push({ message, options }),
	};
	const ui = {
		say: () => {},
		report: () => {},
		clearReport: () => {},
		clearAll: () => {},
		setStatus: (_ctx, parts) => statuses.push(parts),
	};
	const ctx = { cwd: "/proj/main", hasUI, mode: "interactive" };
	const session = createSession({ pi, ui, ctx, repo });
	return { session, ctx, entries, messages, statuses };
}

// ===================================================== focus persistence

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });

	ok("focus is readable", h.session.focus?.path === "/proj/feat");
	ok("focus is persisted as an entry", h.entries[0]?.customType === FOCUS_ENTRY_TYPE);
	ok(
		"the entry carries the path and branch",
		h.entries[0]?.data?.path === "/proj/feat" && h.entries[0]?.data?.branch === "feature/x",
		JSON.stringify(h.entries[0]),
	);
	ok("the model is told", h.messages[0]?.message.customType === FOCUS_MESSAGE_TYPE);
	ok("the note names the worktree", h.messages[0]?.message.content.includes("/proj/feat"));
	// deliverAs nextTurn is in-memory only, which is exactly why the state above
	// went into an entry rather than this message.
	ok("the note is queued for the next turn", h.messages[0]?.options?.deliverAs === "nextTurn");
	ok("focus paints", h.statuses.length >= 1);
	ok("the segment shows the worktree and branch", h.statuses.at(-1)?.[0] === "⑂ feat (feature/x)", JSON.stringify(h.statuses.at(-1)));
}

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	h.session.setFocus(h.ctx, undefined);
	ok("clearing focus records it too", h.entries.length === 2);
	ok("the cleared entry is empty", JSON.stringify(h.entries[1]?.data) === "{}");
	ok("clearing is announced", h.messages[1]?.message.content.includes("cleared"));
	ok("clearing empties the segment", JSON.stringify(h.statuses.at(-1)) === "[]");
}

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat" }, false);
	ok("announce=false still persists", h.entries.length === 1);
	ok("announce=false tells the model nothing", h.messages.length === 0);
	ok("a branchless worktree shows just the name", h.statuses.at(-1)?.[0] === "⑂ feat", JSON.stringify(h.statuses.at(-1)));
}

// ===================================================== restoring focus

{
	const h = setup();
	h.session.restoreFocus({ path: "/proj/feat", branch: "feature/x" });
	ok("restored focus is adopted", h.session.focus?.path === "/proj/feat");
	// Restoring is reading the transcript back, not making a decision: writing an
	// entry would append a duplicate on every reload, and announcing would tell
	// the model something it was already told.
	ok("restoring writes no entry", h.entries.length === 0);
	ok("restoring announces nothing", h.messages.length === 0);
	ok("restoring paints nothing by itself", h.statuses.length === 0);
}

// ===================================================== disposal

{
	const h = setup();
	h.session.setFocus(h.ctx, { path: "/proj/feat", branch: "feature/x" });
	const paintsBefore = h.statuses.length;

	h.session.dispose();
	h.session.paint(h.ctx);
	ok("a disposed session does not paint", h.statuses.length === paintsBefore);

	// The ctx a session holds is stale the moment pi replaces that session, and
	// touching a stale ctx throws. Disposal is what makes that unreachable.
	h.session.prMonitor.refresh(true);
	h.session.prMonitor.onInput();
	await Promise.resolve();
	ok("a disposed session's monitor is dead", h.statuses.length === paintsBefore);
	ok("disposal is idempotent", (() => {
		h.session.dispose();
		return true;
	})());
}

// ===================================================== no repo

{
	const h = setup({ noRepo: true });
	ok("a session outside a repo still exists", h.session.repo === undefined);
	h.session.paint(h.ctx);
	ok("and paints an empty segment rather than nothing", JSON.stringify(h.statuses.at(-1)) === "[]");
}

done();
