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

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../fake-pi.mjs";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

/**
 * A live process that is neither us nor our parent, to hold a lease.
 *
 * A lease held by a pid that is *not* alive is a stale lease and takes an
 * entirely different row, so the stranger rows below need a genuinely live
 * foreign process rather than an invented pid.
 *
 * Killed from an exit hook rather than at the end of the file: `done()` exits
 * the process, and an assertion that throws before it would otherwise orphan
 * this child for its full 60s. Unref'd so it can never hold the run open.
 */
const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
stranger.unref();
process.on("exit", () => stranger.kill());

const panels = await loadExt("lib/panels.ts");

const { ok, done } = assertions();
const extension = (await loadExt("worktree/index.ts")).default;
const { openModel } = await loadExt("worktree/jimothy.ts");

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

/**
 * A repo with one jimothy-managed worktree, created through the model so the
 * registry record is real rather than hand-written.
 *
 * The config is what keeps this out of the developer's home directory:
 * jimothy's default baseDir is `~/.jimothy/worktrees`, and a relative one is
 * resolved against the repository, so every worktree created here dies with the
 * temp repo. `.jimothy` rather than `wt`, which `makeRepo` already uses for a
 * hand-made *unmanaged* worktree — telling the two apart is what these tests
 * are about, and sharing a directory would hide a confusion between them.
 */
async function makeManaged(name = "alpha") {
	const { dir } = await makeRepo();
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	const model = await openModel(execRunner(), dir);
	// `create` takes the name positionally and requires exactly one of
	// base/branch/track; `main` is what makeRepo's initial commit is on.
	const record = await model.registry.create(name, { base: "main" });
	return { dir, model, record };
}

/** Who the registry currently says holds a worktree, read without the lock. */
async function ownerOf(model, name) {
	return (await model.registry.snapshot()).managed.find((r) => r.name === name)?.owner;
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

// ===================================================== taking the lease
//
// A session leases the worktree it will write to, so two agents cannot end up
// in one. Everything below drives the real registry in a throwaway repo: the
// decision is unit-tested in lease.test.mjs, and what is left to prove is the
// wiring — that the lease lands on the right worktree, under the right run id,
// and that nothing here can stop a session starting.

// --- acquiring on start --------------------------------------------------
{
	const { dir, model, record } = await makeManaged();
	const h = harness(record.path, []);
	await h.fire("session_start");

	const owner = await ownerOf(model, "alpha");
	ok("the session took the lease", owner !== undefined, JSON.stringify(h.notices));
	ok("under this process", owner?.pid === process.pid, JSON.stringify(owner));
	ok("with the pi session id as the run id", owner?.runId === "fake-session-id", JSON.stringify(owner));
	ok("labelled as a pi session", owner?.label === "pi session", JSON.stringify(owner));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- an unmanaged directory is left alone --------------------------------
{
	const { dir } = await makeRepo();
	const h = harness(dir, []);
	await h.fire("session_start");
	ok(
		"says nothing about a lease in a directory jimothy does not manage",
		h.messages().every((m) => !/lease/i.test(m)),
		JSON.stringify(h.notices),
	);
	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- a stale lease is reclaimed, and says so ------------------------------
{
	const { dir, model, record } = await makeManaged();
	// A pid that cannot be alive: the registry's dead-pid rule is what reclaims it.
	await model.registry.acquireLease("alpha", "old-run", 999_999_999, { label: "run" });
	const h = harness(record.path, []);
	await h.fire("session_start");

	const owner = await ownerOf(model, "alpha");
	ok("the dead owner is displaced", owner?.pid === process.pid, JSON.stringify(owner));
	ok(
		"and the user is told, rather than it silently opening",
		h.messages().some((m) => /reclaimed "alpha"/.test(m)),
		JSON.stringify(h.notices),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- a live stranger, with a UI ------------------------------------------
{
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	const h = harness(record.path, [], { selects: ["Quit"] });
	await h.fire("session_start");

	ok("the user is asked", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));
	ok(
		"and told what holds it",
		/someone-else/.test(h.prompts.select[0].title + h.prompts.select[0].options.join()),
		JSON.stringify(h.prompts.select[0]),
	);
	ok(
		"quit is offered first, so it is the default",
		h.prompts.select[0].options[0] === "Quit",
		JSON.stringify(h.prompts.select[0]?.options),
	);
	ok("choosing quit shuts pi down", h.shutdowns.length === 1, JSON.stringify(h.messages()));
	ok("and the stranger keeps the lease", (await ownerOf(model, "alpha"))?.runId === "someone-else");
	// pi is tearing this context down: painting a footer and fetching git status on
	// the way out is work nobody asked for, and the shutdown spike showed it may
	// not even run.
	ok("and the session stops starting", h.ctx().own.statuses.length === 0, JSON.stringify(h.ctx().own.statuses));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	const h = harness(record.path, [], { selects: ["Take over"] });
	await h.fire("session_start");

	const owner = await ownerOf(model, "alpha");
	ok("taking over moves the lease here", owner?.pid === process.pid, JSON.stringify(owner));
	ok("under this session's run id", owner?.runId === "fake-session-id", JSON.stringify(owner));
	ok(
		"and says whose run was displaced",
		h.messages().some((m) => /took over "alpha" from run someone-else/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("without shutting down", h.shutdowns.length === 0, JSON.stringify(h.messages()));
	// One question, not two: the acquisition that follows a take-over must not
	// come back round to the prompt row.
	ok("asking once", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// Consent names a holder. The user takes seconds to answer, and in that time
	// the run they were shown can release the lease and a *different* live session
	// take it — force-breaking that one displaces a run nobody consented to lose.
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	const h = harness(record.path, [], {
		selects: [
			// Run while the first prompt is open: the named holder goes away and a
			// second live session takes the worktree, then the user says "Take over".
			async () => {
				await model.registry.breakLease("alpha", { force: true });
				await model.registry.acquireLease("alpha", "someone-new", stranger.pid, { label: "pi session" });
				return "Take over";
			},
			"Quit",
		],
	});
	await h.fire("session_start");

	const owner = await ownerOf(model, "alpha");
	ok("the holder the user was never shown keeps its lease", owner?.runId === "someone-new", JSON.stringify(owner));
	ok("the user is asked again", h.prompts.select.length === 2, JSON.stringify(h.prompts.select.map((p) => p.title)));
	ok(
		"and this time about the run that actually holds it",
		/someone-new/.test(h.prompts.select[1]?.title ?? ""),
		JSON.stringify(h.prompts.select[1]?.title),
	);
	ok("and quitting still quits", h.shutdowns.length === 1, JSON.stringify(h.messages()));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// The re-decision is bounded exactly as the retarget row's is: a worktree that
	// changes hands under every prompt leaves the session unleased rather than
	// asking forever.
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "holder-1", stranger.pid, { label: "pi session" });

	const move = (to) => async () => {
		await model.registry.breakLease("alpha", { force: true });
		await model.registry.acquireLease("alpha", to, stranger.pid, { label: "pi session" });
		return "Take over";
	};
	// The third answer must never be reached; scripted so that asking a third time
	// would take the lease rather than silently resolving undefined.
	const h = harness(record.path, [], { selects: [move("holder-2"), move("holder-3"), "Take over"] });
	await h.fire("session_start");

	ok("asking at most twice", h.prompts.select.length === 2, JSON.stringify(h.prompts.select.map((p) => p.title)));
	const held = await ownerOf(model, "alpha");
	ok("the last holder keeps the lease", held?.runId === "holder-3", JSON.stringify(held));
	ok(
		"and the session is told it is running unleased",
		h.messages().some((m) => /changed hands again; leaving it unleased/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("without shutting down", h.shutdowns.length === 0, JSON.stringify(h.messages()));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

{
	// Dismissing the dialog is not consent to take someone's worktree.
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	// No scripted answer: the harness resolves `select` as undefined, which is
	// what pi does when the dialog is dismissed.
	const h = harness(record.path, []);
	await h.fire("session_start");

	ok("dismissal is treated as quit", h.shutdowns.length === 1, JSON.stringify(h.messages()));
	ok("and the lease is untouched", (await ownerOf(model, "alpha"))?.runId === "someone-else");

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- a live stranger, headless -------------------------------------------
{
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });

	const h = harness(record.path, [], { hasUI: false, mode: "print" });
	// A headless `say` goes to stdout rather than to `ctx.ui.notify`, so the
	// warning is only observable there — `h.messages()` stays empty by design.
	const output = await captureStdout(() => h.fire("session_start"));

	ok("nothing is asked", h.prompts.select.length === 0, JSON.stringify(h.prompts.select));
	ok(
		"the session is warned",
		/worktree "alpha" is in use by pi session someone-else/.test(output),
		JSON.stringify(output),
	);
	ok("and told it is running unleased", /continuing without a lease/.test(output), JSON.stringify(output));
	ok("and continues", h.shutdowns.length === 0, JSON.stringify(h.messages()));
	ok("leaving the lease where it was", (await ownerOf(model, "alpha"))?.runId === "someone-else");

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- the launcher's lease is retargeted, not fought -----------------------
{
	const { dir, model, record } = await makeManaged();
	// The launcher holds it under *our parent's* pid, which is what proves this
	// process is that launcher's agent.
	await model.registry.acquireLease("alpha", "launch-1", process.ppid, { label: "run" });
	// process.env is process-wide, but each test builds a fresh extension closure,
	// so the latch that reads this once cannot leak into the tests below. The
	// cleanup is here because a *failing* test would otherwise corrupt them: the
	// extension is expected to have deleted both already, which is asserted.
	process.env.JIMOTHY_RUN_ID = "launch-1";
	process.env.JIMOTHY_WORKTREE = record.path;
	try {
		const h = harness(record.path, []);
		await h.fire("session_start");

		const owner = await ownerOf(model, "alpha");
		ok("the lease moves onto this process", owner?.pid === process.pid, JSON.stringify(owner));
		ok(
			"keeping the launcher's run id, so jimothy's release still matches",
			owner?.runId === "launch-1",
			JSON.stringify(owner),
		);
		ok("the launcher variables are scrubbed", process.env.JIMOTHY_RUN_ID === undefined);
		ok("both of them", process.env.JIMOTHY_WORKTREE === undefined);

		await h.fire("session_shutdown");
	} finally {
		delete process.env.JIMOTHY_RUN_ID;
		delete process.env.JIMOTHY_WORKTREE;
	}
	await rm(dir, { recursive: true, force: true });
}

// --- a lease already ours is re-acquired cleanly across a reload -----------
{
	// Before release existed, the outgoing session's lease was still live at the
	// next session_start, so it had to be *adopted* rather than re-acquired
	// (acquireLease refuses a live lease, even our own). Now session_shutdown
	// gives an "ours" lease back regardless of why it fired, so the replacement
	// session meets a free record and acquires it afresh — which must still be
	// silent and uncontested, not treated as a stranger's worktree.
	const { dir, model, record } = await makeManaged();
	const h = harness(record.path, []);
	await h.fire("session_start");
	const first = await ownerOf(model, "alpha");
	await h.fire("session_shutdown", { reason: "reload" });
	await h.fire("session_start");

	const owner = await ownerOf(model, "alpha");
	ok("the replacement session holds the lease", owner?.pid === process.pid, JSON.stringify(owner));
	ok("under the same run id", owner?.runId === first?.runId, JSON.stringify(owner));
	ok("freshly acquired, not the same lease record", owner?.since !== first?.since, `${first?.since} -> ${owner?.since}`);
	ok("and says nothing about it", h.messages().every((m) => !/lease/i.test(m)), JSON.stringify(h.notices));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- release, by provenance ------------------------------------------------
//
// Provenance asks who will release the lease, not who took it: a lease we
// acquired is ours to give back, a delegated one is jimothy's own finally's,
// and a lease we adopted with no launcher anywhere is still ours.

{
	const { dir, model, record } = await makeManaged();
	const h = harness(record.path, []);
	await h.fire("session_start");
	await h.fire("session_shutdown", { reason: "quit" });

	ok("a lease we took is released", (await ownerOf(model, "alpha")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	// Delegated: jimothy's own `finally` releases this one, matching on its runId.
	const { dir, model, record } = await makeManaged();
	await model.registry.acquireLease("alpha", "launch-1", process.ppid, { label: "run" });
	process.env.JIMOTHY_RUN_ID = "launch-1";
	process.env.JIMOTHY_WORKTREE = record.path;
	try {
		const h = harness(record.path, []);
		await h.fire("session_start");
		await h.fire("session_shutdown", { reason: "quit" });

		const owner = await ownerOf(model, "alpha");
		ok("a delegated lease is left for its launcher", owner !== undefined, JSON.stringify(owner));
		ok("still under the launcher's run id", owner?.runId === "launch-1", JSON.stringify(owner));
	} finally {
		delete process.env.JIMOTHY_RUN_ID;
		delete process.env.JIMOTHY_WORKTREE;
	}

	await rm(dir, { recursive: true, force: true });
}

{
	// The case a how-it-was-obtained rule gets wrong: hand-launched, reloaded, so
	// the second session *adopted* its own lease — and must still release it.
	const { dir, model, record } = await makeManaged();
	const h = harness(record.path, []);
	await h.fire("session_start");
	await h.fire("session_shutdown", { reason: "reload" });
	await h.fire("session_start");
	await h.fire("session_shutdown", { reason: "quit" });

	ok("an adopted lease with no launcher is released on the way out", (await ownerOf(model, "alpha")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	// A release that arrives after someone else has taken the worktree must not
	// unlock it. `releaseLease` ignores a runId that is not the holder; this pins
	// that the extension relies on it rather than deleting blindly.
	const { dir, model, record } = await makeManaged();
	const h = harness(record.path, []);
	await h.fire("session_start");
	await model.registry.breakLease("alpha", { force: true });
	await model.registry.acquireLease("alpha", "someone-else", stranger.pid, { label: "pi session" });
	await h.fire("session_shutdown", { reason: "quit" });

	const owner = await ownerOf(model, "alpha");
	ok("a late release does not unlock someone else's worktree", owner?.runId === "someone-else", JSON.stringify(owner));

	await rm(dir, { recursive: true, force: true });
}

// --- the target is the restored focus, not the cwd ------------------------
{
	const { dir, model, record } = await makeManaged("beta");
	// The cwd is the main working tree, which jimothy does not manage; the focused
	// worktree is where every tool call is about to be rewritten to.
	const h = harness(dir, [focusEntry({ path: record.path, branch: record.branch })]);
	await h.fire("session_start");

	const owner = await ownerOf(model, "beta");
	ok("the lease follows the agent's write target", owner?.pid === process.pid, JSON.stringify(owner));

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

// --- failure is reported, never fatal ------------------------------------
{
	// A corrupt registry is the cheapest real failure that lands *inside* the
	// acquisition: the model opens from git and config alone, so it is only the
	// first read of registry.json that throws — as lock contention would.
	const { dir, record } = await makeManaged();
	await writeFile(join(dir, ".git", "jimothy", "registry.json"), "{ not valid json");

	const h = harness(record.path, []);
	// Reaching the next line at all is half the assertion: an unhandled throw in
	// the acquisition would reject session_start and take this file down with it.
	await h.fire("session_start");
	ok("the session still painted its footer", h.ctx().own.statuses.length > 0);
	ok(
		"and the failure is reported rather than swallowed",
		h.notices.some((n) => n.level === "warning" && n.message.includes("worktree lease unavailable")),
		JSON.stringify(h.notices),
	);

	await h.fire("session_shutdown");
	await rm(dir, { recursive: true, force: true });
}

done();
