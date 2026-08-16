/**
 * Tests for restoring focus from the session transcript (worktree/index.ts).
 *
 *   cd tests && npm install && node worktree/restore.test.mjs
 *
 * Focus survives `/reload` and resume because `setFocus` writes a custom *entry*
 * and `session_start` reads it back. That is a documented promise which had no
 * test: it was verified once by hand, against a transcript built by hand, which
 * is not a thing anyone will redo before a refactor.
 *
 * Driven through a fake `pi` with real git in a throwaway repo, because the
 * restore path ends in a filesystem check — a focused worktree that another
 * session removed must be dropped rather than restored, or every later bash call
 * becomes `cd '<gone>' || exit 1`.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, loadExt, pexec } from "../harness.mjs";

const panels = await loadExt("lib/panels.ts");

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;

/** A repo on `main` with one commit and a linked worktree on `exp`. */
async function makeRepo() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-restore-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	const worktree = join(dir, "wt", "exp");
	await pexec("git", ["worktree", "add", "-q", "-b", "exp", worktree], { cwd: dir });
	return { dir, worktree };
}

/**
 * Load the extension against a fake pi.
 *
 * `entries` is what `session_start` will find in the transcript. gh is answered
 * as unavailable so the PR monitor disables itself immediately: this file is
 * about restore, and a real gh would make it slow and machine-dependent.
 */
function harness(cwd, entries, options = {}) {
	const h = createFakePi({
		cwd,
		entries: () => entries,
		exec: (command) => (command === "gh" ? { stdout: "", stderr: "", code: 1, killed: false } : undefined),
		...options,
	});
	extension(h.pi);
	return h;
}

/**
 * Capture real `process.stdout` writes.
 *
 * The extension builds its own `ui` internally, so the injectable stdout that
 * ui.test.mjs uses is not reachable from here — and the whole point of the quit
 * banner is that it goes to the real stream.
 */
async function captureStdout(fn) {
	const written = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		written.push(String(chunk));
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return written.join("");
}

/** A transcript entry as `pi.appendEntry("worktree-focus", …)` writes it. */
const focusEntry = (data) => ({
	type: "custom",
	id: "e1",
	parentId: null,
	timestamp: "2026-08-08T00:00:00.000Z",
	customType: "worktree-focus",
	data,
});

// ===================================================== restoring focus

{
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })]);
	await h.fire("session_start");

	ok("focus is restored from the transcript", /⑂ exp/.test(h.status() ?? ""), JSON.stringify(h.status()));
	ok("with its branch", (h.status() ?? "").includes("(exp)"), h.status());
	// Restoring is reading state back, not setting it: appending here would grow the
	// transcript by one entry per reload, forever.
	ok("restoring writes no new entry", h.appended.length === 0, JSON.stringify(h.appended));
	ok("restoring warns about nothing", h.notices.length === 0, JSON.stringify(h.notices));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// The transcript is append-only, so an earlier focus is superseded rather than
	// removed: the last entry on the branch is the current state.
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [
		focusEntry({ path: join(dir, "wt", "stale"), branch: "stale" }),
		focusEntry({ path: worktree, branch: "exp" }),
	]);
	await h.fire("session_start");
	ok("the last focus entry wins", /⑂ exp/.test(h.status() ?? ""), JSON.stringify(h.status()));
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// `/worktree focus off` records an empty entry; restoring that must mean "not
	// focused", not "focused on undefined".
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" }), focusEntry({})]);
	await h.fire("session_start");
	ok("a cleared entry restores as unfocused", !/⑂/.test(h.status() ?? ""), JSON.stringify(h.status()));
	// Ending up unfocused is not enough: a cleared entry read as `{ path: undefined }`
	// is truthy, so it would be "restored", fail the existence check, and arrive at
	// the same status by way of a warning about a worktree called `undefined` and a
	// junk entry appended to the transcript.
	ok("a cleared entry warns about nothing", h.notices.length === 0, JSON.stringify(h.notices));
	ok("a cleared entry appends nothing", h.appended.length === 0, JSON.stringify(h.appended));
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo();
	const h = harness(dir, []);
	await h.fire("session_start");
	ok("no entries means no focus", !/⑂/.test(h.status() ?? ""), JSON.stringify(h.status()));
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ============================================ the model fails to open at session start

// `openModel` rejects when `jimothy.config.json` is unreadable — after the
// repository itself resolved, so this is a config failure, not a "not a git
// repo" one. That must be reported, and it must not be fatal: the rest of
// session_start (focus restore, the location panel) has nothing to do with
// the registry and must still run.
{
	const { dir, worktree } = await makeRepo();
	await writeFile(join(dir, "jimothy.config.json"), "{ not valid json");
	panels.resetPanels("worktree");

	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })]);
	await h.fire("session_start");

	ok(
		"a broken config warns that the model is unavailable",
		h.notices.some((n) => n.level === "warning" && n.message.includes("jimothy model unavailable")),
		JSON.stringify(h.notices),
	);
	ok("focus still restores from the transcript", /⑂ exp/.test(h.status() ?? ""), JSON.stringify(h.status()));
	ok("with its branch", (h.status() ?? "").includes("(exp)"), h.status());
	const panel = panels.listPanels().find((p) => p.owner === "worktree");
	ok("the location panel is still published", panel !== undefined);
	const rendered = panel?.render(120).join("\n") ?? "";
	ok("and reflects the restored focus", rendered.includes(worktree), rendered);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- the session's work is cancelled when the session ends ---------------
{
	const dir = (await makeRepo()).dir;
	const fake = createFakePi({ cwd: dir });
	extension(fake.pi);
	await fake.fire("session_start");

	// The model's deps reach pi through `pi.exec`, so the signal the session
	// carries is observable as the one handed to the runner. Not `at(-1)`:
	// session_start also runs git calls (ahead/behind, the stack panel, herdr)
	// that go through `pi` directly rather than through the model's deps and so
	// never carry a signal, and one of those is the last call the model's own
	// calls always precede. A signal is unique to a model call, so filtering on
	// its presence finds one unambiguously.
	const before = fake.execCalls.filter((call) => call.options.signal !== undefined).at(-1);
	ok("model calls carry a signal", before !== undefined);
	ok("and it is live while the session is", before?.options.signal.aborted === false);

	await fake.fire("session_shutdown", { reason: "quit" });
	ok("shutting down aborts it", before?.options.signal.aborted === true);

	await rm(dir, { recursive: true, force: true });
}

// ============================================ a worktree removed behind our back

{
	const { dir, worktree } = await makeRepo();
	// Another session removed it while this one was away.
	await pexec("git", ["worktree", "remove", "--force", worktree], { cwd: dir });

	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })]);
	await h.fire("session_start");

	ok("a vanished worktree is not restored", !/⑂/.test(h.status() ?? ""), JSON.stringify(h.status()));
	ok(
		"and the user is told why",
		h.notices.some((n) => n.message.includes("no longer exists") && n.level === "warning"),
		JSON.stringify(h.notices),
	);
	// Clearing it is a real state change, so unlike a restore it is persisted —
	// otherwise the next reload would warn all over again.
	ok(
		"the cleared focus is persisted",
		h.appended.some((entry) => entry.customType === "worktree-focus" && !entry.data?.path),
		JSON.stringify(h.appended),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ============================================ replacing a session

{
	// `/new` and resume replace the session under a live extension closure, and the
	// context the old one held is stale from that moment: pi throws if an extension
	// touches one. Restoring focus into a replaced session must therefore paint
	// through the *new* context only.
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })]);

	await h.fire("session_start");
	const first = h.ctx();
	ok("the first session painted", first.own.statuses.length > 0);

	await h.fire("session_start");
	ok("the replacement gets its own context", h.ctx() !== first);
	ok("the replacement restores focus and paints", /⑂ exp/.test(h.ctx().own.statuses.at(-1) ?? ""), JSON.stringify(h.ctx().own.statuses));

	// Deliberately not asserting here that the superseded context is never written
	// to again. gh is stubbed unavailable in this file, so the PR monitor switches
	// itself off and there is no in-flight work left to land on the old context —
	// the assertion would pass no matter what the code did. It lives in
	// pr-status.test.mjs, where a gated gh call makes it observable.

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ============================================ the path printed on quit

// Focus moves the agent, not the user's shell, so on quit the only trace of
// where the work happened is whatever reached the scrollback.
{
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })], { mode: "tui" });
	await h.fire("session_start");

	const output = await captureStdout(() => h.fire("session_shutdown", { reason: "quit" }));
	ok("quit: prints the full worktree path", output.includes(`cd ${worktree}`), JSON.stringify(output));
	ok("quit: names the branch", output.includes("(exp)"), JSON.stringify(output));
	await rm(dir, { recursive: true, force: true });
}

// The same event fires for session replacement, where the TUI lives on and a raw
// write would tear a hole in the rendering.
{
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })], { mode: "tui" });
	await h.fire("session_start");

	const output = await captureStdout(() => h.fire("session_shutdown", { reason: "new" }));
	ok("/new: prints nothing into a live TUI", output === "", JSON.stringify(output));
	await rm(dir, { recursive: true, force: true });
}

{
	// Nothing was redirected, so the path is just the cwd the user already has.
	const { dir } = await makeRepo();
	const h = harness(dir, [], { mode: "tui" });
	await h.fire("session_start");

	const output = await captureStdout(() => h.fire("session_shutdown", { reason: "quit" }));
	ok("unfocused: quit prints nothing", output === "", JSON.stringify(output));
	await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------ location panel lifecycle --------
//
// Mutation: deleting publishLocationPanel() from session_start, or deleting
// clearLocationPanel() from session_shutdown. After session_start in a real
// git repo, exactly one panel owned by "worktree" must be registered; after
// session_shutdown, none.
{
	const { dir } = await makeRepo();
	const h = harness(dir, []);
	panels.resetPanels("worktree");
	await h.fire("session_start");
	ok(
		"panel: session_start publishes exactly one location panel",
		panels.listPanels().filter((p) => p.owner === "worktree").length === 1,
		`got ${panels.listPanels().filter((p) => p.owner === "worktree").length}`,
	);
	await h.fire("session_shutdown");
	ok(
		"panel: session_shutdown removes the location panel",
		panels.listPanels().filter((p) => p.owner === "worktree").length === 0,
	);
	await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------- location panel reflects focus -----
//
// When a focus is restored from the transcript, the location panel must show
// the focused worktree’s path, not the repo root. Without this, /dashboard
// shows the parent repo while the footer shows the focused branch.
{
	const { dir, worktree } = await makeRepo();
	const h = harness(dir, [focusEntry({ path: worktree, branch: "exp" })]);
	panels.resetPanels("worktree");
	await h.fire("session_start");
	const panel = panels.listPanels().find((p) => p.owner === "worktree");
	const rendered = panel?.render(120).join("\n") ?? "";
	ok("focused panel shows the focused path, not the repo root", rendered.includes(worktree), rendered);
	ok("focused panel shows the focused branch", rendered.includes("exp"), rendered);
	ok("focused panel does not show the repo root", !rendered.includes(dir + "  "), rendered);
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------- unfocused session shows repo branch -----
//
// Mutation: change `active.focus ? active.focus.branch : repo.branch` back to
// `active.focus?.branch` — this assertion must FAIL because `branch` becomes
// `undefined` and `⑂ main` disappears from the panel.
{
	const { dir } = await makeRepo();
	const h = harness(dir, []);
	panels.resetPanels("worktree");
	await h.fire("session_start");
	const panel = panels.listPanels().find((p) => p.owner === "worktree");
	const rendered = panel?.render(120).join("\n") ?? "";
	ok("unfocused: panel shows repo branch", rendered.includes("⑂ main"), rendered);
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------- focused session with undefined branch -----
//
// Mutation: change the fix to `active.focus?.branch ?? repo.branch` — this
// assertion must FAIL because `branch` picks up `repo.branch` even though the
// session is focused, so `⑂ main` leaks into the focused panel.
{
	const { dir, worktree } = await makeRepo();
	// Focus entry has a path but no recorded branch (focus.branch === undefined).
	const h = harness(dir, [focusEntry({ path: worktree })]);
	panels.resetPanels("worktree");
	await h.fire("session_start");
	const panel = panels.listPanels().find((p) => p.owner === "worktree");
	const rendered = panel?.render(120).join("\n") ?? "";
	ok("focused with undefined branch: panel does not show repo branch", !rendered.includes("⑂ main"), rendered);
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

done();
