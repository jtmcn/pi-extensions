/**
 * Tests for the model-facing `worktree` tool (worktree/tool.ts).
 *
 *   cd tests && node worktree/tool.test.mjs
 *
 * This file has never existed before: the tool used to parse raw git and call
 * the extension's own `createWorktree`, with no injected `Deps` to fake and
 * nothing but a real npm install to test against. Now it goes through
 * `createAndProvision`, the same path `/worktree new` uses, so it can be tested
 * the same way — a real repo, a real registry, and a fake runner that answers
 * only the package manager.
 *
 * What matters here that a plain unit test of `execute` would miss:
 *
 *  - `list` renders through `describeKnown`, so an unmanaged worktree is
 *    labelled, not merely listed;
 *  - `create` focuses through `moveFocus`, not `setFocus`, and a refusal is
 *    reported as a refusal, never claimed as a move;
 *  - a provisioning failure still leaves the record (the worktree is real and
 *    usable, only its setup failed) and says so in the text;
 *  - a call handed an already-aborted signal does no work at all, and one
 *    cancelled *during* its install cancels that install rather than leaving it
 *    running until the session ends.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { createWorktreeTool } = await loadExt("worktree/tool.ts");
const { DEFAULT_CONFIG } = await loadExt("worktree/config.ts");
const { openModel } = await loadExt("worktree/jimothy.ts");

/**
 * jimothy's registry for a repo, read straight off disk.
 *
 * Matches `commands.test.mjs`'s helper of the same name and for the same
 * reason: the record — name, branch, path — is the thing `create` is judged
 * on, not a directory the extension chose.
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
 * A repo on `main`, with a **relative** `baseDir` so every worktree this file
 * creates lands under the temp repo and not the developer's real
 * `~/.jimothy/worktrees`.
 */
async function makeRepo({ withLockfile = false } = {}) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-tool-")));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "file.txt"), "hi\n");
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ baseDir: ".jimothy" }));
	if (withLockfile) {
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
	}
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

/**
 * The tool, wired to a real model over `dir` and fakes for everything pi would
 * otherwise supply.
 *
 * `install` answers every `npm`/`pnpm` call the provisioner makes; everything
 * else — all of git — goes through a real runner, because worktree identity is
 * exactly what is under test. A function rather than a fixed answer when a test
 * needs the options the install was handed — the signal, above all — or needs to
 * act while it is running. `moveFocusResult` and `hasSessionCtx` let a test
 * choose which branch of the focus logic it is exercising without a real pi
 * session to drive it.
 */
async function setupTool({
	dir,
	install = { stdout: "", stderr: "", code: 0, killed: false },
	config = {},
	hasSessionCtx = true,
	moveFocusResult = true,
} = {}) {
	const real = execRunner();
	const runner = {
		exec: (command, args, options) => real.exec(command, args, options),
	};
	const modelRunner = {
		exec: (command, args, options) => {
			if (command === "npm" || command === "pnpm") {
				return Promise.resolve(typeof install === "function" ? install(command, args, options) : install);
			}
			return real.exec(command, args, options);
		},
	};
	const model = dir ? await openModel(modelRunner, dir) : undefined;

	let known = [];
	const refreshKnown = async () => {
		if (!model) return [];
		const { toKnown } = await loadExt("worktree/known.ts");
		known = toKnown(await model.registry.list(), model.deps);
		return known;
	};

	const moveFocusCalls = [];
	const branchesSet = [];

	const tool = createWorktreeTool({
		runner,
		getModel: () => model,
		getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
		getSessionCtx: () => (hasSessionCtx ? { fake: "ctx" } : undefined),
		moveFocus: async (ctx, next, opts) => {
			moveFocusCalls.push({ ctx, next, opts });
			return moveFocusResult;
		},
		refreshKnown,
		setKnownBranches: (branches) => branchesSet.push(branches),
	});

	return { tool, dir, model, moveFocusCalls, branchesSet, refreshKnown };
}

// ============================================================= list

{
	const dir = await makeRepo();
	const model = await openModel(execRunner(), dir);
	await model.registry.create("spike", { base: "main" });
	// Unmanaged: a worktree git knows about that jimothy did not make.
	await pexec("git", ["worktree", "add", "-q", "-b", "scratch", join(dir, "wt", "scratch")], { cwd: dir });

	const h = await setupTool({ dir });
	const result = await h.tool.execute("call-1", { action: "list" }, undefined);

	ok("lists the managed worktree by name", result.content[0].text.includes("spike"), result.content[0].text);
	ok("lists the unmanaged worktree", result.content[0].text.includes("scratch"), result.content[0].text);
	ok(
		"labels the unmanaged one, same wording as /worktree list",
		result.content[0].text.includes("scratch (scratch) — unmanaged"),
		result.content[0].text,
	);
	ok("not an error", !result.isError);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: focused

{
	const dir = await makeRepo();
	const h = await setupTool({ dir, moveFocusResult: true });

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);

	const registry = await readRegistry(dir);
	ok("writes a record", registry.worktrees.length === 1, JSON.stringify(registry));
	ok("the record is named as asked", registry.worktrees[0]?.name === "spike", JSON.stringify(registry));
	ok(
		"the branch comes from jimothy's config, not a literal",
		registry.worktrees[0]?.branch === "jimothy/spike",
		JSON.stringify(registry),
	);
	ok("moveFocus was tried", h.moveFocusCalls.length === 1, JSON.stringify(h.moveFocusCalls));
	ok(
		"moveFocus was asked to go through the transition silently",
		h.moveFocusCalls[0]?.opts?.announce === false,
		JSON.stringify(h.moveFocusCalls),
	);
	ok(
		"says it is now working there",
		result.content[0].text.includes("You are now working in this worktree"),
		result.content[0].text,
	);
	ok("not an error", !result.isError);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: focus refused

{
	const dir = await makeRepo();
	const h = await setupTool({ dir, moveFocusResult: false });

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);

	const registry = await readRegistry(dir);
	ok("the worktree is still created", registry.worktrees.length === 1, JSON.stringify(registry));
	ok(
		"does not claim the model is working there",
		!result.content[0].text.includes("You are now working in this worktree"),
		result.content[0].text,
	);
	ok(
		"says focus could not move",
		result.content[0].text.includes("Could not focus the new worktree"),
		result.content[0].text,
	);
	ok("not an error: the create itself succeeded", !result.isError);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: no session context

{
	const dir = await makeRepo();
	const h = await setupTool({ dir, hasSessionCtx: false });

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);

	ok("never asked to move focus with nothing to paint a status line with", h.moveFocusCalls.length === 0);
	ok(
		"says the working directory is unchanged",
		result.content[0].text.includes("Your working directory is unchanged."),
		result.content[0].text,
	);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: autoFocus disabled

{
	const dir = await makeRepo();
	const h = await setupTool({ dir, config: { autoFocus: false } });

	await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);

	ok("never asked to move focus when autoFocus is off", h.moveFocusCalls.length === 0);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: provisioning failure

{
	const dir = await makeRepo({ withLockfile: true });
	const h = await setupTool({ dir, install: { stdout: "", stderr: "boom", code: 1, killed: false } });

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);

	const registry = await readRegistry(dir);
	ok(
		"the worktree is kept: setup is retryable, the checkout is real",
		registry.worktrees.length === 1,
		JSON.stringify(registry),
	);
	ok(
		"says provisioning failed",
		result.content[0].text.includes("Provisioning failed"),
		result.content[0].text,
	);
	ok("a successful create is never turned into an error by a provisioning failure", !result.isError);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: aborted before it starts

{
	const dir = await makeRepo();
	const h = await setupTool({ dir });
	const controller = new AbortController();
	controller.abort();

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, controller.signal);

	ok("reports an error", result.isError === true);
	const registry = await readRegistry(dir);
	ok("creates nothing at all", registry.worktrees.length === 0, JSON.stringify(registry));
	ok("never touches focus", h.moveFocusCalls.length === 0);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= create: cancelled mid-install

{
	// The signal is threaded to the install, not merely checked before the call
	// starts: a cancelled call used to leave its install running until the whole
	// session ended. Aborted from *inside* the install, which is the only ordering
	// that proves anything — a pre-flight refusal would pass on a signal nothing ever
	// handed to a child.
	const dir = await makeRepo({ withLockfile: true });
	const controller = new AbortController();
	let seen;
	const h = await setupTool({
		dir,
		install: (_command, _args, options) => {
			seen = options?.signal;
			controller.abort();
			// What pi resolves a cancelled exec as: the child is killed, so it reports a
			// signal exit like any other failure.
			return { stdout: "", stderr: "", code: 143, killed: true };
		},
	});

	const result = await h.tool.execute("call-1", { action: "create", name: "spike" }, controller.signal);

	ok("the install is handed a signal at all", seen !== undefined);
	ok("and it is one this call's cancellation aborts", seen?.aborted === true);
	const registry = await readRegistry(dir);
	ok(
		"the worktree is kept, exactly as for any other unfinished setup",
		registry.worktrees.length === 1,
		JSON.stringify(registry),
	);
	ok(
		"the cancellation is reported as one, not as a mysterious install failure",
		/was cancelled/.test(result.content[0].text) && !/install failed|did not finish within/.test(result.content[0].text),
		result.content[0].text,
	);
	ok(
		"and the line above it does not call a cancellation a failure either",
		!/Provisioning failed/.test(result.content[0].text),
		result.content[0].text,
	);
	ok(
		"and the text still names what was created",
		result.content[0].text.includes("Created worktree at"),
		result.content[0].text,
	);

	await rm(dir, { recursive: true, force: true });
}

// ============================================================= no model

{
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-tool-norepo-")));
	const h = await setupTool({ dir: undefined });

	const listResult = await h.tool.execute("call-1", { action: "list" }, undefined);
	ok("list reports the model is unavailable", listResult.isError === true);

	const createResult = await h.tool.execute("call-1", { action: "create", name: "spike" }, undefined);
	ok("create reports the model is unavailable too", createResult.isError === true);

	await rm(dir, { recursive: true, force: true });
}

done();
