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

import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { createCommands } = await loadExt("worktree/commands.ts");
const { DEFAULT_CONFIG } = await loadExt("worktree/config.ts");
const { openModel } = await loadExt("worktree/jimothy.ts");
const { getRepoInfo } = await loadExt("lib/git.ts");

const exists = async (path) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * jimothy's registry for a repo, read straight off disk.
 *
 * `/worktree new` writes through `Registry.create` now, so the record — its
 * name, its branch and where it landed — is the thing to assert on, not a
 * directory the extension chose.
 */
async function readRegistry(dir) {
	try {
		return JSON.parse(await readFile(join(dir, ".git", "jimothy", "registry.json"), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return { worktrees: [] };
		throw error;
	}
}

/**
 * A repo on `main` plus linked worktrees for each requested branch.
 *
 * Every repo here gets a `jimothy.config.json` with a **relative** `baseDir`,
 * committed so worktrees made from it carry it too. Without one, jimothy's
 * default is `~/.jimothy/worktrees` and every `/worktree new` in this file would
 * create a real worktree in the developer's home directory that nothing here
 * ever cleans up.
 */
async function makeRepo(branches = ["exp"], { jimothy = {}, lockfile = false } = {}) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy", ...jimothy }));
	if (lockfile) {
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
	}
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
	await writeFile(join(upstream, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
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
 *
 * `dir` is the repository the session's jimothy model is opened over — worktree
 * identity comes from that model now, so a test that dispatches anything which
 * lists must supply it. `withModel: false` pins the other path: a session whose
 * model could not be opened.
 */
async function setup({
	dir,
	hasUI = true,
	confirms = [],
	select,
	input,
	editor = async (_prompt, prefill) => prefill,
	entries = [],
	config = {},
	withModel = true,
	install = { stdout: "", stderr: "", code: 0, killed: false },
} = {}) {
	const said = [];
	const reported = [];
	const focusCalls = [];
	// Recorded separately from `focusCalls` so a door that still moves focus
	// without the lease is visible: `setFocus` is the one that does not carry it.
	const setFocusCalls = [];
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

	// The model's runner is what `provision` installs through, and a real `npm
	// install` in a temp repo is neither fast nor deterministic. Package managers
	// are answered from `install`; everything else — all of git — is real, because
	// worktree behaviour is the thing under test.
	const installCalls = [];
	const realModelRunner = execRunner();
	const modelRunner = {
		exec: (command, args, options) => {
			if (command === "npm" || command === "pnpm") {
				installCalls.push({ command, args, cwd: options?.cwd });
				return Promise.resolve(install);
			}
			return realModelRunner.exec(command, args, options);
		},
	};

	const model = dir && withModel ? await openModel(modelRunner, dir) : undefined;

	const commands = createCommands({
		runner,
		ui,
		getModel: () => model,
		getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
		getConfigSources: () => [],
		getFocus: () => focus,
		setFocus: (_ctx, target) => {
			focus = target;
			focusCalls.push(target);
			setFocusCalls.push(target);
		},
		// The transition itself is index.ts's wiring and is tested against the real
		// registry in transition.test.mjs; what this file cares about is that every
		// door goes through it, so it records like setFocus and always succeeds.
		moveFocus: async (_ctx, target) => {
			focus = target;
			focusCalls.push(target);
			return true;
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
		dir,
		model,
		said,
		reported,
		prompts,
		focusCalls,
		setFocusCalls,
		gitCalls,
		installCalls,
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
	const h = await setup({ dir, confirms: [true, true] });

	await h.commands.dispatch(info, h.ctx, `remove ${basename(dir)}`);
	ok(
		"refuses to remove the session's own worktree",
		h.errors().some((m) => m.includes("refusing to remove the session's own worktree")),
		JSON.stringify(h.said),
	);
	ok("and it is still there", await exists(join(dir, "file.txt")));
	ok("and it never asked for confirmation", h.prompts.confirm.length === 0);

	// The same guard from inside a linked worktree, which is the other half of
	// "the session's own": there the session worktree is the one being named.
	const { dir: other, paths } = await makeRepo();
	const linkedInfo = await getRepoInfo(execRunner(), paths.exp);
	const linked = await setup({ dir: other, confirms: [true, true] });
	await linked.commands.dispatch(linkedInfo, linked.ctx, "remove exp");
	ok(
		"refuses to remove the session's own linked worktree",
		linked.errors().some((m) => m.includes("refusing to remove the session's own worktree")),
		JSON.stringify(linked.said),
	);
	ok("and that one is still there too", await exists(join(paths.exp, "file.txt")));

	await rm(dir, { recursive: true, force: true });
	await rm(other, { recursive: true, force: true });
}

// ============================================ remove: dirty worktrees

{
	const { dir, paths } = await makeRepo();
	await writeFile(join(paths.exp, "uncommitted.txt"), "precious\n");

	const h = await setup({ dir, hasUI: false });
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
	const h = await setup({ dir, confirms: [false] });
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
	const h = await setup({ dir, confirms: [true, false] });
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
	const h = await setup({ dir, confirms: [true, true] });
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
	const h = await setup({ dir, confirms: [true, false] });
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
	const h = await setup({ dir, hasUI: false });

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
	const h = await setup({ dir, hasUI: false });
	await h.commands.dispatch(info, h.ctx, "remove feature");
	ok("an ambiguous prefix removes nothing", await exists(join(dir, "wt", "feature-a")));
	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo(["feature-a", "feature-b"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir, confirms: [] });
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
	const h = await setup({ dir, hasUI: false });
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
	const h = await setup({ dir, confirms: [false], select: (labels) => labels[0] });
	await h.commands.dispatch(info, h.ctx, "remove");
	ok("with a UI it offers a picker", h.prompts.select.length === 1, JSON.stringify(h.prompts.select));
	ok("the picker lists the worktrees", h.prompts.select[0]?.labels.length >= 1);
	await rm(dir, { recursive: true, force: true });
}

// ============================================ focus and list

{
	const { dir, paths } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

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
	const h = await setup({ dir });
	h.setFocus({ path: paths.exp, branch: "exp" });

	await h.commands.dispatch(info, h.ctx, "list");
	const lines = h.reported[0]?.lines.join("\n") ?? "";
	ok("list marks the session worktree", /session/.test(lines), lines);
	ok("list marks the focused worktree", /focused/.test(lines), lines);
	ok("list counts dirty files", /1 dirty/.test(lines), lines);

	await rm(dir, { recursive: true, force: true });
}

// ============================================ list: rendered from the model

{
	// A worktree jimothy did not create is surfaced, labelled, and keeps its
	// branch — losing the branch would break `/worktree focus <branch>`.
	const { dir, paths } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "list");
	const block = h.reported[0]?.lines ?? [];
	const listed = block.find((line) => line.startsWith("exp "));
	ok("lists a worktree the registry did not create", listed !== undefined, JSON.stringify(block));
	ok("labels it unmanaged", /unmanaged/.test(String(listed)), String(listed));
	ok("keeps its branch", /\(exp\)/.test(String(listed)), String(listed));

	// The model omits the main working tree because nothing it does applies to
	// one; this extension has always listed and focused it, so `refresh` puts it
	// back. Asserted directly so a future reader sees it is deliberate.
	const registryPaths = (await h.model.registry.list()).unmanaged.map((entry) => entry.path);
	ok("the registry's own listing omits the main working tree", !registryPaths.includes(dir), JSON.stringify(registryPaths));
	const main = block.find((line) => line.startsWith(`${basename(dir)} `));
	ok("the main working tree is listed anyway", main !== undefined, JSON.stringify(block));
	ok("with the branch it has checked out", /\(main\)/.test(String(main)), String(main));
	ok("and it is marked as the session's", /session/.test(String(main)), String(main));
	ok("exactly once", block.filter((line) => line.startsWith(`${basename(dir)} `)).length === 1, JSON.stringify(block));

	// The same repository from inside the linked worktree: the session marker
	// follows the session, not the repository.
	const linkedInfo = await getRepoInfo(execRunner(), paths.exp);
	const linked = await setup({ dir });
	await linked.commands.dispatch(linkedInfo, linked.ctx, "list");
	const fromLinked = linked.reported[0]?.lines ?? [];
	ok(
		"a session in a linked worktree marks that one",
		/session/.test(String(fromLinked.find((line) => line.startsWith("exp ")))),
		JSON.stringify(fromLinked),
	);
	ok(
		"and the main working tree is still listed, unmarked",
		!/session/.test(String(fromLinked.find((line) => line.startsWith(`${basename(dir)} `)))),
		JSON.stringify(fromLinked),
	);

	await rm(dir, { recursive: true, force: true });
}

{
	// A session that could not open the model still runs: listing says why
	// instead of throwing.
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir, withModel: false });

	await h.commands.dispatch(info, h.ctx, "list");
	ok(
		"says why it cannot list rather than throwing",
		h.errors().some((m) => /unavailable/i.test(m)),
		JSON.stringify(h.said),
	);
	ok("and reports nothing", h.reported.length === 0, JSON.stringify(h.reported));

	// Not "no worktrees found": on the destructive path that reading would invite
	// the user to recreate something that is still there.
	await h.commands.dispatch(info, h.ctx, "remove exp");
	ok(
		"naming a worktree says the same, rather than that there are none",
		h.errors().every((m) => /unavailable/i.test(m)) && h.errors().length === 2,
		JSON.stringify(h.said),
	);
	ok("and removes nothing", await exists(join(dir, "wt", "exp")));

	await rm(dir, { recursive: true, force: true });
}

// ================================= list: bare-repository layout

{
	// proj/.bare + proj/main + siblings: the same layout the AGENTS.md invariant
	// names as the one exception where `mainWorktree` is not the repository's
	// invoking directory. `openModel`'s cwd is `proj/main`, and the assertion is
	// the same one the plain-repo listing test above makes: the main working
	// tree is still listed, unmanaged, under this layout too.
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-commands-bare-")));
	const seed = join(root, "seed");
	await pexec("git", ["init", "-q", "-b", "main", seed]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: seed });
	await pexec("git", ["config", "user.name", "Test"], { cwd: seed });
	await writeFile(join(seed, "file.txt"), "hi\n");
	await writeFile(join(seed, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	await pexec("git", ["add", "."], { cwd: seed });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: seed });

	const proj = join(root, "proj");
	await pexec("git", ["clone", "-q", "--bare", seed, join(proj, ".bare")]);
	await writeFile(join(proj, ".git"), "gitdir: ./.bare\n");
	await pexec("git", ["worktree", "add", "-q", join(proj, "main"), "main"], { cwd: proj });

	const info = await getRepoInfo(execRunner(), join(proj, "main"));
	const h = await setup({ dir: join(proj, "main") });
	await h.commands.dispatch(info, h.ctx, "list");
	const block = h.reported[0]?.lines ?? [];
	const main = block.find((line) => line.startsWith("main "));
	ok("bare layout: main working tree is listed", main !== undefined, JSON.stringify(block));
	ok("bare layout: labelled unmanaged", /unmanaged/.test(String(main)), String(main));
	ok("bare layout: with its checked-out branch", /\(main\)/.test(String(main)), String(main));
	ok("bare layout: marked as the session's", /session/.test(String(main)), String(main));

	await rm(root, { recursive: true, force: true });
}

// ============================================ dispatch

{
	const { dir } = await makeRepo();
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });
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
	const h = await setup({ dir, hasUI: false });
	await h.commands.dispatch(info, h.ctx, "");
	ok("bare /worktree with no UI lists", h.reported.length === 1, JSON.stringify(h.reported));
	await rm(dir, { recursive: true, force: true });
}

// ============================================ completions

{
	const { dir } = await makeRepo(["feature-a", "feature-b"]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });
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

/** The record the registry holds for `name`, or undefined if it made none. */
async function recordFor(dir, name) {
	return (await readRegistry(dir)).worktrees.find((record) => record.name === name);
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Accepting the suggestion: the default fake editor returns its prefill.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug"), userEntry("yes, do it")] });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("the prompt is prefilled with a suggestion", h.prompts.editor[0]?.prefill === "fix-parser-bug", JSON.stringify(h.prompts.editor));
	ok("and no bare input prompt is used", h.prompts.input.length === 0);
	const record = await recordFor(dir, "fix-parser-bug");
	ok("accepting it creates that worktree", record !== undefined && (await exists(record.path)), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Typing over the suggestion wins, and a stray newline is not part of the name.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")], editor: async () => "my-own-name\n" });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("the typed name wins", (await recordFor(dir, "my-own-name")) !== undefined, JSON.stringify(h.said));
	ok("and the suggestion is not created", (await recordFor(dir, "fix-parser-bug")) === undefined);

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Clearing the field cancels, as an empty submit always has.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")], editor: async () => "  " });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("an empty submit creates nothing", (await readRegistry(dir)).worktrees.length === 0, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Esc is the same as an empty submit.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")], editor: async () => undefined });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a cancelled editor creates nothing", (await readRegistry(dir)).worktrees.length === 0, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Embedded newlines: only the first line is used.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")], editor: async () => "foo\nbar" });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a multiline name uses the first line only", (await recordFor(dir, "foo")) !== undefined, JSON.stringify(h.said));
	ok("and does not join across the newline", (await recordFor(dir, "foo-bar")) === undefined, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// A leading blank line is trimmed, not treated as a cancel.
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")], editor: async () => "\nfoo" });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a leading newline is trimmed", (await recordFor(dir, "foo")) !== undefined, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// The suggested name is already taken: offer the suffixed one. Uniqueness is
	// the registry's answer now, so what makes the name taken is a worktree *git*
	// reports — the registry has no record of this one at all.
	await pexec("git", ["worktree", "add", "-q", "-b", "fix-parser-bug", join(dir, "wt", "fix-parser-bug")], { cwd: dir });
	const h = await setup({ dir, entries: [userEntry("fix the parser bug")] });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("a taken suggestion is suffixed", h.prompts.editor[0]?.prefill === "fix-parser-bug-2", JSON.stringify(h.prompts.editor));
	ok("and that is what gets created", (await recordFor(dir, "fix-parser-bug-2")) !== undefined, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// Non-interactive: no prompt to fall back on, so use the suggestion.
	const h = await setup({ dir, hasUI: false, entries: [userEntry("fix the parser bug")] });

	await h.commands.dispatch(info, h.ctx, "new");

	ok("non-interactive creates the suggested worktree", (await recordFor(dir, "fix-parser-bug")) !== undefined, JSON.stringify(h.said));
	ok("and says which name it chose", h.messages().some((m) => m.includes("fix-parser-bug")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	// No transcript at all: still a name, and still a worktree.
	const h = await setup({ dir, hasUI: false, entries: [] });

	await h.commands.dispatch(info, h.ctx, "new");

	const createdMsg = h.messages().find((m) => m.startsWith("created "));
	ok(
		"an empty transcript still names something",
		createdMsg !== undefined && /; branch jimothy\/[a-z]+-[a-z]+ \(from main\)/.test(createdMsg),
		JSON.stringify(h.said),
	);
	ok("and creates it", (await readRegistry(dir)).worktrees.length === 1, JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

// ============================================ new: through the registry

{
	// The heart of it: `/worktree new` is a `Registry.create`, so the record, the
	// branch and the directory are jimothy's — one model, one convention.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike");

	const records = (await readRegistry(dir)).worktrees;
	ok("new: the registry holds the record", records.length === 1 && records[0].name === "spike", JSON.stringify(records));
	ok("new: the branch comes from jimothy's prefix, not the extension's", records[0]?.branch === "jimothy/spike", JSON.stringify(records));
	ok("new: the branch is jimothy's to delete", records[0]?.branchCreated === true, JSON.stringify(records));
	ok("new: it lands under jimothy's baseDir", records[0]?.path.startsWith(join(dir, ".jimothy") + "/"), String(records[0]?.path));
	ok("new: and exists on disk", await exists(records[0].path));
	ok("new: the create is reported with the path and the base", h.messages().some((m) => m === `created ${records[0].path}; branch jimothy/spike (from main)`), JSON.stringify(h.said));
	ok("new: nothing was said at the warning level", !h.said.some((s) => s.level !== "info"), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	// autoFocus goes through `moveFocus`, which carries the lease; `setFocus`
	// would move focus into a worktree this session does not hold.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir, config: { autoFocus: true } });

	await h.commands.dispatch(info, h.ctx, "new spike");
	const record = await recordFor(dir, "spike");
	ok("new: the new worktree is focused", h.focusCalls.at(-1)?.path === record.path, JSON.stringify(h.focusCalls));
	ok("new: with its branch", h.focusCalls.at(-1)?.branch === "jimothy/spike", JSON.stringify(h.focusCalls));
	ok("new: through moveFocus, not setFocus", h.setFocusCalls.length === 0, JSON.stringify(h.setFocusCalls));

	const off = await setup({ dir, config: { autoFocus: false } });
	await off.commands.dispatch(info, off.ctx, "new second");
	ok("new: autoFocus off still creates", (await recordFor(dir, "second")) !== undefined, JSON.stringify(off.said));
	ok("new: and focuses nothing", off.focusCalls.length === 0, JSON.stringify(off.focusCalls));

	await rm(dir, { recursive: true, force: true });
}

{
	// Provisioning is the visible half of the move: jimothy's `link` entries are
	// materialised into a worktree `/worktree new` never touched before.
	const { dir } = await makeRepo([], { jimothy: { link: [".env"], copy: ["absent.json"] } });
	await writeFile(join(dir, ".env"), "SECRET=1\n");
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike");

	const record = await recordFor(dir, "spike");
	ok("new: a linked file is symlinked into the worktree", (await lstat(join(record.path, ".env"))).isSymbolicLink(), record.path);
	ok("new: a missing source is a warning, not a failure", h.said.some((s) => s.level === "warning" && s.message.includes('skipped "absent.json"')), JSON.stringify(h.said));
	ok("new: and the worktree is kept", await exists(record.path));

	await rm(dir, { recursive: true, force: true });
}

{
	// An install is the one step that can take minutes, so it narrates line by
	// line rather than reporting once at the end.
	const { dir } = await makeRepo([], { lockfile: true });
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike");

	const record = await recordFor(dir, "spike");
	ok("new: the package manager is run in the new worktree", h.installCalls.some((c) => c.command === "npm" && c.args.join(" ") === "install" && c.cwd === record.path), JSON.stringify(h.installCalls));
	ok("new: the install is narrated before it finishes", h.messages().some((m) => /^installing dependencies with npm in /.test(m)), JSON.stringify(h.said));
	ok("new: and again when it does", h.messages().some((m) => /^dependencies installed in /.test(m)), JSON.stringify(h.said));
	const narrated = h.messages().findIndex((m) => m.startsWith("installing dependencies"));
	ok("new: the narration precedes the summary", narrated >= 0 && narrated < h.messages().findIndex((m) => m.startsWith("created ")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	// A failed install is not a failed create: the checkout is real work, so it
	// is reported and kept rather than destroyed. This is why `createAndProvision`
	// has no try/catch of its own.
	const { dir } = await makeRepo([], { lockfile: true });
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir, install: { stdout: "", stderr: "ENOTFOUND registry", code: 1, killed: false } });

	await h.commands.dispatch(info, h.ctx, "new spike");

	const record = await recordFor(dir, "spike");
	ok("new: a failed install is reported", h.errors().some((m) => /npm install failed/.test(m)), JSON.stringify(h.said));
	ok("new: the worktree survives it", record !== undefined && (await exists(record.path)), JSON.stringify(await readRegistry(dir)));

	await rm(dir, { recursive: true, force: true });
}

{
	// The base: what the user named, else jimothy's `defaultBase`, else the
	// repository's default branch. `Registry.create` resolves none of that itself.
	const { dir } = await makeRepo([]);
	await writeFile(join(dir, "second.txt"), "two\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "second"], { cwd: dir });
	const first = (await pexec("git", ["rev-parse", "HEAD~1"], { cwd: dir })).stdout.trim();
	const head = (await pexec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike HEAD~1");
	ok("new: a base the user names is used", (await recordFor(dir, "spike"))?.baseCommit === first, JSON.stringify(await readRegistry(dir)));
	ok("new: and reported", h.messages().some((m) => m.includes("(from HEAD~1)")), JSON.stringify(h.said));

	await h.commands.dispatch(info, h.ctx, "new plain");
	ok("new: without one, the default branch is", (await recordFor(dir, "plain"))?.baseCommit === head, JSON.stringify(await readRegistry(dir)));

	await rm(dir, { recursive: true, force: true });
}

{
	// jimothy's `defaultBase` sits between the two: it beats the default branch
	// and loses to an explicit argument.
	const { dir } = await makeRepo([], { jimothy: { defaultBase: "side" } });
	await pexec("git", ["checkout", "-q", "-b", "side"], { cwd: dir });
	await writeFile(join(dir, "side.txt"), "side\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "side"], { cwd: dir });
	const sideCommit = (await pexec("git", ["rev-parse", "side"], { cwd: dir })).stdout.trim();
	await pexec("git", ["checkout", "-q", "main"], { cwd: dir });
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike");
	ok("new: jimothy's defaultBase is used when no base is given", (await recordFor(dir, "spike"))?.baseCommit === sideCommit, JSON.stringify(await readRegistry(dir)));
	ok("new: and named in the report", h.messages().some((m) => m.includes("(from side)")), JSON.stringify(h.said));

	await rm(dir, { recursive: true, force: true });
}

{
	// A create the registry refuses is reported, not thrown, and leaves the
	// existing worktree alone.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir });

	await h.commands.dispatch(info, h.ctx, "new spike");
	await h.commands.dispatch(info, h.ctx, "new spike");

	ok("new: a duplicate name is refused", h.errors().some((m) => /already exists/.test(m)), JSON.stringify(h.said));
	ok("new: and nothing is added", (await readRegistry(dir)).worktrees.length === 1, JSON.stringify(await readRegistry(dir)));

	// A name the registry will not accept fails on its own terms rather than deep
	// inside git — and is never silently rewritten into something legal.
	await h.commands.dispatch(info, h.ctx, "new 'Not A Name'");
	ok("new: an illegal name is refused, not slugified", h.errors().length === 2, JSON.stringify(h.said));
	ok("new: and still nothing is added", (await readRegistry(dir)).worktrees.length === 1, JSON.stringify(await readRegistry(dir)));

	await rm(dir, { recursive: true, force: true });
}

{
	// Without a model there is no registry to create through, so it says so.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const h = await setup({ dir, withModel: false });

	await h.commands.dispatch(info, h.ctx, "new spike");
	ok("new: says why it cannot create rather than throwing", h.errors().some((m) => /unavailable/i.test(m)), JSON.stringify(h.said));
	ok("new: and creates nothing", (await readRegistry(dir)).worktrees.length === 0, JSON.stringify(await readRegistry(dir)));

	await rm(dir, { recursive: true, force: true });
}

// ==================================================== checkout

{
	const { dir, paths } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = await setup({ dir, config: { branchPrefix: "joel/", autoFocus: true } });
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
	const t = await setup({ dir, config: { branchPrefix: "joel/", autoFocus: false } });

	await t.commands.dispatch(info, t.ctx, "checkout origin/alice/hotfix");
	const hotfix = join(dir, ".claude/worktrees/alice-hotfix");
	ok("checkout: remote branch checked out", await exists(hotfix), t.messages().join(" | "));
	ok("checkout: tracking reported", t.messages().at(-1)?.includes("tracking origin/alice/hotfix"), String(t.messages().at(-1)));
	const upstreamRef = (await pexec("git", ["config", "branch.alice/hotfix.merge"], { cwd: dir })).stdout.trim();
	ok("checkout: upstream configured", upstreamRef === "refs/heads/alice/hotfix", upstreamRef);

	// The lazy-fetch rule, measured where a fetch was actually possible: this repo
	// has a remote, and `origin/alice/hotfix` was already a remote-tracking ref, so
	// nothing above may have touched the network.
	const before = t.gitCalls.filter((c) => c.startsWith("fetch")).length;
	ok("checkout: no fetch when a remote-tracking ref already matched", before === 0, JSON.stringify(t.gitCalls));

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
	const t = await setup({ dir, hasUI: false });
	await t.commands.dispatch(info, t.ctx, "checkout");
	ok("checkout: no argument without a UI is an error", t.errors().at(-1)?.includes("required"), String(t.errors().at(-1)));
	ok("checkout: no picker is shown without a UI", t.prompts.select.length === 0);
	await rm(dir, { recursive: true, force: true });
}

{
	// Interactive picker, and the marking of a branch already checked out.
	const { dir } = await makeRepo(["exp"]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = await setup({ dir, select: (labels) => labels.find((l) => l.startsWith("main")) });
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
	const t = await setup({ dir, config: { branchPrefix: "joel/" } });
	await pexec("git", ["branch", "joel/thing"], { cwd: dir });
	await pexec("git", ["branch", "other/thing"], { cwd: dir });
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing custom-dir");
	ok("checkout: explicit name is used verbatim", await exists(join(dir, ".claude/worktrees/custom-dir")), t.messages().join(" | "));

	// The same name again, for a different branch: an explicit name must fail
	// loudly rather than quietly becoming `custom-dir-2`.
	await pexec("git", ["branch", "third/thing"], { cwd: dir });
	await t.commands.dispatch(info, t.ctx, "checkout third/thing custom-dir");
	ok(
		"checkout: explicit name is never uniquified",
		t.errors().at(-1)?.includes("Path already exists") && !(await exists(join(dir, ".claude/worktrees/custom-dir-2"))),
		String(t.errors().at(-1)),
	);

	await t.commands.dispatch(info, t.ctx, "checkout other/thing");
	ok("checkout: derived name is other-thing", await exists(join(dir, ".claude/worktrees/other-thing")), t.messages().join(" | "));
	await t.commands.dispatch(info, t.ctx, "checkout joel/thing a b");
	ok("checkout: extra arguments rejected", t.errors().at(-1)?.includes("unexpected extra arguments"), String(t.errors().at(-1)));
	await rm(dir, { recursive: true, force: true });
}

{
	// The branch cache is refreshed after a create, so `checkout <tab>` offers a
	// branch `/worktree new` just made without waiting for the next session.
	const { dir } = await makeRepo([]);
	const info = await getRepoInfo(execRunner(), dir);
	const t = await setup({ dir, config: { branchPrefix: "joel/" } });
	ok("completions: nothing is cached before anything runs", t.commands.getArgumentCompletions("checkout ") === null);

	await t.commands.dispatch(info, t.ctx, "new fresh-thing");
	const items = t.commands.getArgumentCompletions("checkout ");
	ok(
		"completions: a branch /worktree new just created is offered",
		// jimothy's prefix, not the extension's `joel/`: `new` creates through the
		// registry, so there is one convention for a branch name.
		items?.some((i) => i.value === "checkout jimothy/fresh-thing"),
		JSON.stringify(items),
	);
	await rm(dir, { recursive: true, force: true });
}

// ==================================================== completions

{
	// Branch completions come from the cache alone, so this block needs no repo
	// and no model.
	const t = await setup();
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

// ==================================================== completions: from the model's shape

{
	// No repo or model needed: `setKnown` drives the cache directly, same as the
	// `setKnownBranches` block above.
	const h = await setup();
	h.commands.setKnown([
		{ name: "alpha", path: "/wt/alpha", branch: "jimothy/alpha", managed: true, status: "provisioned" },
		{ name: "chosen", path: "/hand/dup", branch: "feature-y", managed: true, status: "not provisioned" },
		{ name: "made", path: "/hand/made", branch: "feature-x", managed: false },
	]);
	const focus = h.commands.getArgumentCompletions("focus ") ?? [];
	const values = focus.map((item) => item.value);
	ok("offers registry names", values.includes("focus alpha") && values.includes("focus chosen"), JSON.stringify(values));
	ok("offers unmanaged worktrees too", values.includes("focus made"), JSON.stringify(values));
	ok("offers 'off' for focus", values.includes("focus off"), JSON.stringify(values));
	const filtered = h.commands.getArgumentCompletions("focus al") ?? [];
	ok("filters by prefix", filtered.length > 0 && filtered.every((item) => /al/.test(item.value)), JSON.stringify(filtered));
	ok("returns null when nothing matches", h.commands.getArgumentCompletions("focus zzz") === null);
}

// ==================================================== refreshCached: lock-free

{
	// The whole point of `refreshCached` is that it costs no registry lock and no
	// rewrite. A spy on `list()` (the reconciling call `refresh`/`refreshKnown`
	// use) proves it: this would fail if `refreshCached` were implemented over
	// `list()` instead of `snapshot()`.
	const { dir } = await makeRepo();
	const model = await openModel(execRunner(), dir);
	let listed = 0;
	const spyModel = {
		...model,
		registry: {
			...model.registry,
			list: async (...args) => {
				listed++;
				return model.registry.list(...args);
			},
			snapshot: (...args) => model.registry.snapshot(...args),
		},
	};
	const commands = createCommands({
		runner: execRunner(),
		ui: { say: () => {}, report: () => {}, clearReport: () => {}, clearAll: () => {}, setStatus: () => {} },
		getModel: () => spyModel,
		getConfig: () => DEFAULT_CONFIG,
		getConfigSources: () => [],
		getFocus: () => undefined,
		setFocus: () => {},
		moveFocus: async () => true,
	});

	await commands.refreshCached();
	ok("seeding the completion cache does not reconcile", listed === 0);

	await rm(dir, { recursive: true, force: true });
}

// ==================================================== refreshKnown: sees unmanaged worktrees

{
	// The reconciling read is the whole reason `refreshKnown` exists separately
	// from `refreshCached`: `snapshot()` has no unmanaged half at all, so a
	// worktree the model-facing tool just created through raw git would be
	// invisible to completions until the next `/worktree` command, unless the
	// tool calls this one instead.
	const { dir, paths } = await makeRepo();
	const h = await setup({ dir });

	const seen = await h.commands.refreshKnown();
	ok(
		"refreshKnown sees the unmanaged worktree",
		seen.some((wt) => wt.path === paths.exp && !wt.managed),
		JSON.stringify(seen),
	);

	await rm(dir, { recursive: true, force: true });
}
done();

function basename(p) {
	return p.split("/").filter(Boolean).pop();
}
