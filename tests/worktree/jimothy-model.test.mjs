/**
 * Opening jimothy's model for a session.
 *
 * Two things matter here and neither is obvious from the happy path: the
 * repository is resolved with *jimothy's* reader (whose RepoInfo is a different
 * shape from the extension's), and a failure to open the model must not stop a
 * session — pi is already running, and refusing to start would be worse than a
 * session that cannot list worktrees. This file pins the first; the second is
 * the caller's, so all that is asserted here is that the failure arrives as a
 * rejection with a message a user can act on.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { openModel } = await loadExt("worktree/jimothy.ts");

async function makeRepo(prefix = "pi-model-") {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	await pexec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await pexec("git", ["config", "user.email", "t@e.com"], { cwd: dir });
	await pexec("git", ["config", "user.name", "T"], { cwd: dir });
	await writeFile(join(dir, "f.txt"), "hi\n");
	await pexec("git", ["add", "."], { cwd: dir });
	await pexec("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}

// --- the happy path ------------------------------------------------------
{
	const dir = await makeRepo();
	const model = await openModel(execRunner(), dir);
	ok("resolves the repository with jimothy's reader", model.info.mainWorktree === dir, model.info.mainWorktree);
	ok("carries a common dir", typeof model.info.commonDir === "string" && model.info.commonDir.length > 0);
	ok("loads jimothy's config with its defaults", model.config.branchPrefix === "jimothy/", model.config.branchPrefix);
	ok("lists through the registry", Array.isArray((await model.registry.list()).managed));
	ok("carries the deps the registry was built over", typeof model.deps.now === "function");
	await rm(dir, { recursive: true, force: true });
}

// --- resolved from a linked worktree, not the invoking one ---------------
{
	// The model's repository is the *main* working tree wherever the session is
	// standing: config lives there, and so does the registry's namespace.
	const dir = await makeRepo();
	const linked = join(dir, "wt", "exp");
	await pexec("git", ["worktree", "add", "-q", "-b", "exp", linked], { cwd: dir });
	const model = await openModel(execRunner(), linked);
	ok("resolves the main working tree from inside a linked one", model.info.mainWorktree === dir, model.info.mainWorktree);
	await rm(dir, { recursive: true, force: true });
}

// --- a repository-local jimothy config -----------------------------------
{
	const dir = await makeRepo();
	await writeFile(join(dir, "jimothy.config.json"), JSON.stringify({ branchPrefix: "joel/" }));
	const model = await openModel(execRunner(), dir);
	ok("reads the repository's jimothy config", model.config.branchPrefix === "joel/", model.config.branchPrefix);
	await rm(dir, { recursive: true, force: true });
}

// --- failure is reported, not fatal --------------------------------------
{
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-model-nogit-")));
	let threw;
	try {
		await openModel(execRunner(), dir);
	} catch (error) {
		threw = error;
	}
	ok("rejects outside a git repository", threw !== undefined);
	ok(
		"rejects with a message a user can act on",
		/not a git repository|fatal/i.test(String(threw?.message)),
		String(threw?.message),
	);
	await rm(dir, { recursive: true, force: true });
}

done();
