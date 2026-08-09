/**
 * Tests for the /worktree command layer (worktree/commands.ts).
 *
 *   cd tests && npm install && node worktree/commands.test.mjs
 *
 * The reason this file exists is `doRemove`. Removing a worktree destroys
 * uncommitted work, and the guards against doing that by accident are plain
 * conditionals with no test:
 *
 *  - never remove the session's own worktree
 *  - never remove a dirty worktree without a confirmation
 *  - never remove *anything* non-interactively on a fuzzy name match
 *  - branch deletion is a separate question from worktree removal
 *
 * `resolveWorktree`'s `exactOnly: !ctx.hasUI` is the same class of guard: with no
 * prompt to disambiguate, "wt" must not silently resolve to whichever worktree
 * happened to sort first.
 *
 * Real git in a throwaway repo, since dirtiness and removal are filesystem
 * facts. `ui` and the interactive prompts are fakes so the answers can be
 * scripted, including "the user said no".
 */

import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { createCommands } = await loadExt("worktree/commands.ts");
const { DEFAULT_CONFIG } = await loadExt("worktree/config.ts");
const { getRepoInfo } = await loadExt("lib/git.ts");

const exists = async (path) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/** A repo on `main` plus linked worktrees for each requested branch. */
async function makeRepo(branches = ["exp"]) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	const paths = {};
	for (const branch of branches) {
		paths[branch] = join(dir, "wt", branch);
		await pexec("git", ["worktree", "add", "-q", "-b", branch, paths[branch]], { cwd: dir });
	}
	return { dir, paths };
}

/**
 * An upstream repo plus a clone of it, for the remote half of `checkout`.
 * `remoteOnly` branches are created upstream *after* the clone, so the clone
 * cannot see them without fetching.
 */
async function makeClone({ shared = [], remoteOnly = [] } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-clone-")));
	const upstream = join(root, "upstream");
	await pexec("git", ["init", "-q", "-b", "main", upstream]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: upstream });
	await pexec("git", ["config", "user.name", "Test"], { cwd: upstream });
	await writeFile(join(upstream, "file.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: upstream });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: upstream });
	for (const branch of shared) await pexec("git", ["branch", branch], { cwd: upstream });
	const dir = join(root, "down");
	await pexec("git", ["clone", "-q", upstream, dir]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	for (const branch of remoteOnly) await pexec("git", ["branch", branch], { cwd: upstream });
	return { root, upstream, dir };
}

/**
 * Commands wired to fakes.
 *
 * `confirm` is a queue of answers, so a test can say yes to removal and no to
 * the branch, which is the combination the code treats as two decisions.
 */
function setup({
	hasUI = true,
	confirms = [],
	select,
	input,
	editor = async (_prompt, prefill) => prefill,
	entries = [],
	config = {},
} = {}) {
	const said = [];
	const reported = [];
	const focusCalls = [];
	const answers = [...confirms];
	const prompts = { confirm: [], select: [], input: [], editor: [] };
	let focus;

	const gitCalls = [];
	const real = execRunner();
	const runner = {
		exec: (command, args, options) => {
			gitCalls.push(args.join(" "));
			return real.exec(command, args, options);
		},
	};

	const ui = {
		say: (_ctx, message, level = "info") => said.push({ message, level }),
		report: (_ctx, title, lines) => reported.push({ title, lines }),
		clearReport: () => {},
		clearAll: () => {},
		setStatus: () => {},
	};

	const commands = createCommands({
		runner,
		ui,
		getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
		getConfigSources: () => [],
		getFocus: () => focus,
		setFocus: (_ctx, target) => {
			focus = target;
			focusCalls.push(target);
		},
	});

	const ctx = {
		hasUI,
		mode: hasUI ? "interactive" : "print",
		ui: {
			confirm: async (question, detail) => {
				prompts.confirm.push({ question, detail });
				return answers.length ? answers.shift() : false;
			},
			select: async (prompt, labels) => {
				prompts.select.push({ prompt, labels });
				return select ? select(labels) : undefined;
			},
			input: async (prompt) => {
				prompts.input.push({ prompt });
				return input;
			},
			editor: async (prompt, prefill) => {
				prompts.editor.push({ prompt, prefill });
				return editor(prompt, prefill);
			},
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
	};

	return {
		commands,
		ctx,
		said,
		reported,
		prompts,
		focusCalls,
		gitCalls,
		setFocus: (target) => {
			focus = target;
		},
		messages: () => said.map((s) => s.message),
		errors: () => said.filter((s) => s.level === "error").map((s) => s.message),
	};
}

// ============================================ remove: the session's own worktree

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ confirms: [true, true] });

	await h.commands.dispatch(info, h.ctx, `remove ${basename(dir)}`);
	ok(
		"refuses to remove the session's own worktree",
		h.errors().some((m) => m.includes("refusing to remove the session's own worktree")),
		JSON.stringify(h.said),
	);
	ok("and it is still there", await exists(join(dir, "file.txt")));
	ok("and it never asked for confirmation", h.prompts.confirm.length === 0);

	await rm(dir, { recursive: true, force: true });
}

// ============================================ remove: dirty worktrees

{
	const { dir, paths } = await makeRepo();
	await writeFile(join(paths.exp, "uncommitted.txt"), "precious\n");

	const h = setup({ hasUI: false });
	const info = await getRepoInfo(execRunner(), dir);
	await h.commands.dispatch(info, h.ctx, "remove exp");

	ok(
		"refuses to remove a dirty worktree with no way to confirm",
		h.errors().some((m) => m.includes("refusing to remove a dirty worktree")),
		JSON.stringify(h.said),
	);
	ok("the uncommitted file survives", await exists(join(paths.exp, "uncommitted.txt")));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir, paths } = await makeRepo();
	await writeFile(join(paths.exp, "uncommitted.txt"), "precious\n");

	// Interactive, and the user declines.
	const h = setup({ confirms: [false] });
	const info = await getRepoInfo(execRunner(), dir);
	await h.commands.dispatch(info, h.ctx, "remove exp");

	ok("declining the confirmation removes nothing", await exists(join(paths.exp, "uncommitted.txt")));
	ok("the prompt says what will be lost", h.prompts.confirm[0]?.detail.includes("uncommitted file(s) will be lost"), JSON.stringify(h.prompts.confirm));
	ok("and no branch question is asked after declining", h.prompts.confirm.length === 1);

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir, paths } = await makeRepo();
	await writeFile(join(paths.exp, "uncommitted.txt"), "gone\n");

	// Confirm the removal, decline the branch deletion: two decisions.
	const h = setup({ confirms: [true, false] });
	const info = await getRepoInfo(execRunner(), dir);
	await h.commands.dispatch(info, h.ctx, "remove exp");

	ok("confirming removes the worktree", !(await exists(paths.exp)));
	ok("the branch is a separate question", h.prompts.confirm.length === 2 && h.prompts.confirm[1].question.includes("delete branch"));
	const branches = await pexec("git", ["branch", "--list", "exp"], { cwd: dir });
	ok("declining keeps the branch", branches.stdout.includes("exp"), JSON.stringify(branches.stdout));
	ok("removal is reported", h.messages().some((m) => m.includes("removed exp")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir, paths } = await makeRepo();
	const h = setup({ confirms: [true, true] });
	const info = await getRepoInfo(execRunner(), dir);
	await h.commands.dispatch(info, h.ctx, "remove exp");

	ok("confirming both removes the worktree", !(await exists(paths.exp)));
	const branches = await pexec("git", ["branch", "--list", "exp"], { cwd: dir });
	ok("and deletes the merged branch", !branches.stdout.includes("exp"), JSON.stringify(branches.stdout));

	await rm(dir, { recursive: true, force: true });
}

{
	// Removing the focused worktree must drop focus, or every later tool call is
	// redirected into a directory that no longer exists.
	const { dir, paths } = await makeRepo();
	const h = setup({ confirms: [true, false] });
	h.setFocus({ path: paths.exp, branch: "exp" });
	const info = await getRepoInfo(execRunner(), dir);
	await h.commands.dispatch(info, h.ctx, "remove exp");

	ok("removing the focused worktree clears focus", h.focusCalls.at(-1) === undefined && h.focusCalls.length === 1);

	await rm(dir, { recursive: true, force: true });
}

// ============================================ resolving names

{
	// The dangerous case for exactOnly is a prefix matching exactly ONE worktree:
	// a fuzzy match would resolve, and with no UI there is no confirmation step
	// left to catch it, so "remove feat" would delete feature-a outright. Two
	// matches are merely ambiguous and refused either way, which is why asserting
	// on that case cannot tell the two behaviours apart.
	const { dir } = await makeRepo(["feature-a"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ hasUI: false });

	await h.commands.dispatch(info, h.ctx, "remove feat");
	ok(
		"a single fuzzy match is refused with no UI",
		h.errors().some((m) => m.includes('no worktree matching "feat"')),
		JSON.stringify(h.said),
	);
	ok("the worktree survives", await exists(join(dir, "wt", "feature-a")));

	// An exact name still works without a UI: the guard is against guessing, not
	// against non-interactive use.
	await h.commands.dispatch(info, h.ctx, "remove feature-a");
	ok("an exact name is accepted with no UI", !(await exists(join(dir, "wt", "feature-a"))), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo(["feature-a", "feature-b"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ hasUI: false });
	await h.commands.dispatch(info, h.ctx, "remove feature");
	ok("an ambiguous prefix removes nothing", await exists(join(dir, "wt", "feature-a")));
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo(["feature-a", "feature-b"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ confirms: [] });
	await h.commands.dispatch(info, h.ctx, "remove feature");
	ok(
		"an ambiguous match is reported interactively too",
		h.errors().some((m) => m.includes("ambiguous")),
		JSON.stringify(h.said),
	);
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ hasUI: false });
	await h.commands.dispatch(info, h.ctx, "remove");
	ok(
		"a missing name is an error, not a prompt, with no UI",
		h.errors().some((m) => m.includes("required in non-interactive mode")),
		JSON.stringify(h.said),
	);
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup({ confirms: [false], select: (labels) => labels[0] });
	await h.commands.dispatch(info, h.ctx, "remove");
	ok("with a UI it offers a picker", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));
	ok("the picker lists the worktrees", h.prompts.select[0]?.labels.length >= 1);
	await rm(dir, { recursive: true, force: true });
}

// ============================================ focus and list

{
	const { dir, paths } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup();

	await h.commands.dispatch(info, h.ctx, "focus exp");
	ok("focus resolves a name", h.focusCalls.at(-1)?.path === paths.exp, JSON.stringify(h.focusCalls));

	await h.commands.dispatch(info, h.ctx, "focus off");
	ok("focus off clears", h.focusCalls.at(-1) === undefined);

	// Focusing the session's own worktree is not a redirect, it is a no-op, and
	// pretending otherwise would rewrite every path for nothing.
	await h.commands.dispatch(info, h.ctx, `focus ${basename(dir)}`);
	ok("focusing the session worktree clears instead", h.focusCalls.at(-1) === undefined);
	ok("and says so", h.messages().some((m) => m.includes("that is the session worktree")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir, paths } = await makeRepo();
	await writeFile(join(paths.exp, "dirty.txt"), "x\n");
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup();
	h.setFocus({ path: paths.exp, branch: "exp" });

	await h.commands.dispatch(info, h.ctx, "list");
	const lines = h.reported[0]?.lines.join("\n") ?? "";
	ok("list marks the session worktree", /session/.test(lines), lines);
	ok("list marks the focused worktree", /focused/.test(lines), lines);
	ok("list counts dirty files", /1 dirty/.test(lines), lines);

	await rm(dir, { recursive: true, force: true });
}

// ============================================ dispatch

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup();
	await h.commands.dispatch(info, h.ctx, "bogus");
	ok("an unknown subcommand is an error", h.errors().some((m) => m.includes('unknown subcommand "bogus"')), JSON.stringify(h.said));

	await h.commands.dispatch(info, h.ctx, "config");
	ok("config reports", h.reported.at(-1)?.title === "worktree config");

	// Aliases exist because muscle memory does.
	await h.commands.dispatch(info, h.ctx, "rm");
	ok("rm is an alias for remove", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	// No arguments and no UI lists rather than prompting into the void.
	const h = setup({ hasUI: false });
	await h.commands.dispatch(info, h.ctx, "");
	ok("bare /worktree with no UI lists", h.reported.length === 1, JSON.stringify(h.reported));
	await rm(dir, { recursive: true, force: true });
}

// ============================================ completions

{
	const { dir } = await makeRepo(["feature-a", "feature-b"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = setup();
	await h.commands.dispatch(info, h.ctx, "list");

	ok("completes subcommands", (h.commands.getArgumentCompletions("re") ?? []).some((i) => i.value === "remove"));
	ok("offers nothing for an unknown prefix", h.commands.getArgumentCompletions("zzz") === null);

	const focusItems = h.commands.getArgumentCompletions("focus feature") ?? [];
	ok("completes worktree names for focus", focusItems.length === 2, JSON.stringify(focusItems));
	ok("offers 'off' for focus", (h.commands.getArgumentCompletions("focus o") ?? []).some((i) => i.value === "focus off"));
	ok("offers no names for subcommands that take none", h.commands.getArgumentCompletions("list x") === null);

	await rm(dir, { recursive: true, force: true });
}

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
	// Esc is the same as an empty submit.
	const h = setup({ entries: [userEntry("fix the parser bug")], editor: async () => undefined, config: { path: "wt", branchPrefix: "" } });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a cancelled editor creates nothing", !(await exists(join(dir, "wt"))), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Embedded newlines: only the first line is used.
	const h = setup({
		entries: [userEntry("fix the parser bug")],
		editor: async () => "foo\nbar",
		config: { path: "wt", branchPrefix: "" },
	});

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a multiline name uses the first line only", await exists(join(dir, "wt", "foo")), JSON.stringify(h.said));
	ok("and does not slugify across the newline", !(await exists(join(dir, "wt", "foo-bar"))), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// A leading blank line is trimmed, not treated as a cancel.
	const h = setup({
		entries: [userEntry("fix the parser bug")],
		editor: async () => "\nfoo",
		config: { path: "wt", branchPrefix: "" },
	});

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a leading newline is trimmed", await exists(join(dir, "wt", "foo")), JSON.stringify(h.said));

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

	// Extract the created name from messages like "created <name> on <branch>".
	const createdMsg = h.messages().find((m) => m.startsWith("created "));
	ok("an empty transcript still names something", createdMsg && /^created [a-z]+-[a-z]+ on /.test(createdMsg), JSON.stringify(h.said));
	ok("and creates it", (await pexec("git", ["worktree", "list"], { cwd: dir })).stdout.split("\n").length > 2, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

// ==================================================== checkout

{
	const { dir, paths } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/", autoFocus: true } });
	await pexec("git", ["branch", "joel/local-work"], { cwd: dir });

	await t.commands.dispatch(info, t.ctx, "checkout joel/local-work");
	const created = join(dir, ".claude/worktrees/local-work");
	ok("checkout: local branch checked out", await exists(created), t.messages().join(" | "));
	ok("checkout: branchPrefix stripped from the directory", !(await exists(join(dir, ".claude/worktrees/joel-local-work"))), t.messages().join(" | "));
	ok("checkout: focused", t.focusCalls.at(-1)?.path === created, JSON.stringify(t.focusCalls.at(-1)));
	ok("checkout: no fetch when it resolved locally", !t.gitCalls.some((c) => c.startsWith("fetch")), JSON.stringify(t.gitCalls));

	await t.commands.dispatch(info, t.ctx, "checkout exp");
	ok(
		"checkout: a branch checked out elsewhere is refused with the path",
		t.errors().at(-1)?.includes(paths.exp) && t.errors().at(-1)?.includes("/worktree focus"),
		String(t.errors().at(-1)),
	);

	await t.commands.dispatch(info, t.ctx, "checkout no-such-branch");
	ok("checkout: unknown branch errors", t.errors().at(-1)?.includes("no branch matching"), String(t.errors().at(-1)));

	await rm(dir, { recursive: true, force: true });
}

{
	// The remote half, with a branch that only exists upstream: resolving must
	// miss, fetch once, and then succeed.
	const { root, dir } = await makeClone({ shared: ["alice/hotfix"], remoteOnly: ["pushed-later"] });
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/", autoFocus: false } });

	await t.commands.dispatch(info, t.ctx, "checkout origin/alice/hotfix");
	const hotfix = join(dir, ".claude/worktrees/alice-hotfix");
	ok("checkout: remote branch checked out", await exists(hotfix), t.messages().join(" | "));
	ok("checkout: tracking reported", t.messages().at(-1)?.includes("tracking origin/alice/hotfix"), String(t.messages().at(-1)));
	const upstreamRef = (await pexec("git", ["config", "branch.alice/hotfix.merge"], { cwd: dir })).stdout.trim();
	ok("checkout: upstream configured", upstreamRef === "refs/heads/alice/hotfix", upstreamRef);

	const before = t.gitCalls.filter((c) => c.startsWith("fetch")).length;
	await t.commands.dispatch(info, t.ctx, "checkout pushed-later");
	const fetches = t.gitCalls.filter((c) => c.startsWith("fetch")).length - before;
	ok("checkout: a miss fetches exactly once", fetches === 1, String(fetches));
	ok("checkout: found after fetching", await exists(join(dir, ".claude/worktrees/pushed-later")), t.messages().join(" | "));

	await rm(root, { recursive: true, force: true });
}

{
	// Non-interactive: no argument is an error, never a prompt.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ hasUI: false });
	await t.commands.dispatch(info, t.ctx, "checkout");
	ok("checkout: no argument without a UI is an error", t.errors().at(-1)?.includes("required"), String(t.errors().at(-1)));
	ok("checkout: nothing was created", t.prompts.select.length === 0);
	await rm(dir, { recursive: true, force: true });
}

{
	// Interactive picker, and the marking of a branch already checked out.
	const { dir } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ select: (labels) => labels.find((l) => l.startsWith("main")) });
	await t.commands.dispatch(info, t.ctx, "checkout");
	const labels = t.prompts.select.at(-1)?.labels ?? [];
	ok("checkout: picker lists branches", labels.some((l) => l.startsWith("exp")), JSON.stringify(labels));
	ok("checkout: checked-out branches are marked", labels.find((l) => l.startsWith("exp"))?.includes("checked out"), JSON.stringify(labels));
	ok(
		"checkout: picking the session's own branch is refused with focus hint",
		t.errors().at(-1)?.includes("/worktree focus"),
		String(t.errors().at(-1)),
	);
	await rm(dir, { recursive: true, force: true });
}

{
	// An explicit name is used verbatim; a derived one gets uniquified.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = setup({ config: { branchPrefix: "joel/" } });
	await pexec("git", ["branch", "joel/thing"], { cwd: dir });
	await pexec("git", ["branch", "other/thing"], { cwd: dir });
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing custom-dir");
	ok("checkout: explicit name is used verbatim", await exists(join(dir, ".claude/worktrees/custom-dir")), t.messages().join(" | "));
	await t.commands.dispatch(info, t.ctx, "checkout other/thing");
	ok("checkout: derived name is other-thing", await exists(join(dir, ".claude/worktrees/other-thing")), t.messages().join(" | "));
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing a b");
	ok("checkout: extra arguments rejected", t.errors().at(-1)?.includes("unexpected extra arguments"), String(t.errors().at(-1)));
	await rm(dir, { recursive: true, force: true });
}
// ==================================================== completions

{
	const t = setup();
	t.commands.setKnownBranches({
		local: ["main", "joel/fix-parser", "feature/joel/cleanup"],
		remote: [{ remote: "origin", name: "alice/hotfix", full: "origin/alice/hotfix" }],
		remotes: ["origin"],
	});
	const all = t.commands.getArgumentCompletions("checkout ");
	ok("completions: locals offered", all?.some((i) => i.value === "checkout main"), JSON.stringify(all));
	ok("completions: remotes offered by full ref", all?.some((i) => i.value === "checkout origin/alice/hotfix"), JSON.stringify(all));
	const filtered = t.commands.getArgumentCompletions("checkout joel/");
	ok("completions: filtered by prefix", filtered?.length === 1 && filtered[0].value === "checkout joel/fix-parser", JSON.stringify(filtered));
	ok("completions: no match yields null", t.commands.getArgumentCompletions("checkout zzz") === null);
	ok("completions: subcommand itself still completes", t.commands.getArgumentCompletions("che")?.some((i) => i.value === "checkout"), JSON.stringify(t.commands.getArgumentCompletions("che")));
	ok("completions: unrelated subcommand unaffected", t.commands.getArgumentCompletions("prune x") === null);

	t.commands.setKnownBranches({ local: [], remote: [], remotes: [] });
	ok("completions: cleared cache offers nothing", t.commands.getArgumentCompletions("checkout ") === null);
}
done();

function basename(p) {
	return p.split("/").filter(Boolean).pop();
}
