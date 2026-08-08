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
import { assertions, loadExt, pexec } from "../harness.mjs";

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
function harness(cwd, entries) {
	const events = new Map();
	const statuses = [];
	const notices = [];
	const appended = [];

	const pi = {
		on(event, handler) {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
		},
		async exec(command, args, options = {}) {
			if (command === "gh") return { stdout: "", stderr: "", code: 1, killed: false };
			try {
				const { stdout, stderr } = await pexec(command, args, { cwd: options.cwd });
				return { stdout, stderr, code: 0, killed: false };
			} catch (error) {
				return {
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? String(error),
					code: typeof error.code === "number" ? error.code : 1,
					killed: false,
				};
			}
		},
		registerCommand() {},
		registerTool() {},
		appendEntry: (customType, data) => appended.push({ customType, data }),
		sendMessage() {},
	};

	const ctx = {
		cwd,
		hasUI: true,
		mode: "interactive",
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (_key, value) => statuses.push(value),
			setWidget: () => {},
			notify: (message, level) => notices.push({ message, level }),
		},
	};

	extension(pi);
	return {
		statuses,
		notices,
		appended,
		status: () => statuses.at(-1),
		fire: async (event, payload = {}) => {
			for (const handler of events.get(event) ?? []) await handler(payload, ctx);
		},
	};
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

done();
