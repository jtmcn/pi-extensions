/**
 * Tests for worktree/branches.ts — the pure half.
 *
 *   node tests/worktree/branches.test.mjs
 *
 * No repo, no pi, no subprocesses. The cases that matter are the ones a naive
 * implementation gets wrong: a remote whose name contains a slash (git accepts
 * `git remote add a/b`), the `<remote>/HEAD` symref, and a local branch that
 * shadows a remote one — which must win, because it may hold unpushed commits.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt, execRunner, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { parseBranchRefs, resolveBranch, checkoutName, defaultRemote, branchOptions, EMPTY_BRANCHES } =
	await loadExt("worktree/branches.ts");

// ============================================ parseBranchRefs

{
	const refs = [
		"refs/heads/main",
		"refs/heads/joel/fix-parser",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
		"refs/remotes/origin/alice/hotfix",
		"refs/tags/v1",
	].join("\n");
	const list = parseBranchRefs(refs, ["origin"]);
	ok("parse: locals", JSON.stringify(list.local) === JSON.stringify(["main", "joel/fix-parser"]), JSON.stringify(list.local));
	ok("parse: remote HEAD dropped", !list.remote.some((r) => r.name === "HEAD"), JSON.stringify(list.remote));
	ok("parse: tags ignored", list.local.length === 2 && list.remote.length === 2);
	const hotfix = list.remote.find((r) => r.name === "alice/hotfix");
	ok("parse: slashed branch keeps its remote", hotfix?.remote === "origin" && hotfix?.full === "origin/alice/hotfix", JSON.stringify(hotfix));
	ok("parse: remotes carried through", JSON.stringify(list.remotes) === JSON.stringify(["origin"]));

	// git accepts `git remote add a/b`, so the first path segment is not the remote.
	const slashed = parseBranchRefs("refs/remotes/a/b/main\nrefs/remotes/a/b/HEAD", ["origin", "a/b"]);
	ok("parse: slash-containing remote name", slashed.remote.length === 1 && slashed.remote[0].remote === "a/b" && slashed.remote[0].name === "main", JSON.stringify(slashed.remote));
	// Ambiguous prefix: must match the longest remote name, not the first in the list.
	const ambigPrefix = parseBranchRefs("refs/remotes/a/b/main\nrefs/remotes/a/solo", ["a", "a/b"]);
	ok("parse: longest remote match wins", ambigPrefix.remote[0].remote === "a/b" && ambigPrefix.remote[1].remote === "a", JSON.stringify(ambigPrefix.remote));
	ok("parse: unknown remote skipped", parseBranchRefs("refs/remotes/gone/main", ["origin"]).remote.length === 0);
	ok("parse: empty input", parseBranchRefs("", []).local.length === 0);
}

// ============================================ resolveBranch

const branches = parseBranchRefs(
	[
		"refs/heads/main",
		"refs/heads/joel/fix-parser",
		"refs/remotes/origin/main",
		"refs/remotes/origin/joel/fix-parser",
		"refs/remotes/origin/alice/hotfix",
		"refs/remotes/upstream/alice/hotfix",
		"refs/remotes/origin/solo",
	].join("\n"),
	["origin", "upstream"],
);

{
	const local = resolveBranch(branches, "main");
	ok("resolve: local branch", local.kind === "local" && local.branch === "main", JSON.stringify(local));
	ok("resolve: local records the remote it shadows", local.shadows === "origin/main", String(local.shadows));

	const qualified = resolveBranch(branches, "origin/alice/hotfix");
	ok("resolve: fully qualified remote", qualified.kind === "remote" && qualified.branch === "alice/hotfix" && qualified.full === "origin/alice/hotfix", JSON.stringify(qualified));

	const inferred = resolveBranch(branches, "solo");
	ok("resolve: remote inferred when unique", inferred.kind === "remote" && inferred.full === "origin/solo", JSON.stringify(inferred));

	const ambiguous = resolveBranch(branches, "alice/hotfix");
	ok("resolve: same name on two remotes is ambiguous", ambiguous.kind === "ambiguous", JSON.stringify(ambiguous));
	ok("resolve: ambiguity lists both", JSON.stringify(ambiguous.candidates?.sort()) === JSON.stringify(["origin/alice/hotfix", "upstream/alice/hotfix"]), JSON.stringify(ambiguous.candidates));

	// The unpushed-commits case: asking for the remote ref by name must still
	// land on the local branch rather than resetting anything to the remote.
	const shadowed = resolveBranch(branches, "origin/joel/fix-parser");
	ok("resolve: local wins over the remote ref that names it", shadowed.kind === "local" && shadowed.branch === "joel/fix-parser", JSON.stringify(shadowed));
	ok("resolve: shadow is reported", shadowed.shadows === "origin/joel/fix-parser", String(shadowed.shadows));

	ok("resolve: no match", resolveBranch(branches, "nope").kind === "none");
	ok("resolve: empty query", resolveBranch(branches, "   ").kind === "none");
	ok("resolve: refs/heads/ prefix tolerated", resolveBranch(branches, "refs/heads/main").kind === "local");
	ok("resolve: no branches at all", resolveBranch(EMPTY_BRANCHES, "main").kind === "none");
}

// ============================================ checkoutName

ok("name: branchPrefix stripped", checkoutName("joel/fix-parser", "joel/") === "fix-parser", checkoutName("joel/fix-parser", "joel/"));
ok("name: other owner stays attributed", checkoutName("alice/hotfix", "joel/") === "alice-hotfix", checkoutName("alice/hotfix", "joel/"));
ok("name: unprefixed branch flattened", checkoutName("renovate/lockfile", "joel/") === "renovate-lockfile");
ok("name: empty prefix", checkoutName("main", "") === "main");
ok("name: prefix only", checkoutName("joel/", "joel/") === "worktree", checkoutName("joel/", "joel/"));
ok("name: partial prefix is not stripped", checkoutName("joelx/thing", "joel/") === "joelx-thing");

// ============================================ defaultRemote

ok("remote: origin preferred", defaultRemote(branches) === "origin");
ok("remote: taken from the query", defaultRemote(branches, "upstream/alice/hotfix") === "upstream");
ok("remote: query with an unknown prefix falls back", defaultRemote(branches, "nope/thing") === "origin");
ok("remote: first when origin is absent", defaultRemote({ ...EMPTY_BRANCHES, remotes: ["fork", "other"] }) === "fork");
ok("remote: none configured", defaultRemote(EMPTY_BRANCHES) === undefined);
ok("remote: longest match wins", defaultRemote({ ...EMPTY_BRANCHES, remotes: ["a", "a/b"] }, "a/b/main") === "a/b");

// ============================================ branchOptions

{
	const options = branchOptions(branches, new Set(["main"]));
	const values = options.map((o) => o.value);
	ok("options: locals come first", values[0] === "main" && values[1] === "joel/fix-parser", JSON.stringify(values));
	ok("options: checked-out branch is marked", options[0].label.includes("checked out"), options[0].label);
	ok("options: remote shadowed by a local is omitted", !values.includes("origin/joel/fix-parser"), JSON.stringify(values));
	ok("options: distinct remotes offered", values.includes("origin/alice/hotfix") && values.includes("upstream/alice/hotfix"), JSON.stringify(values));
	ok("options: values are unique", new Set(values).size === values.length);
	ok("options: empty list", branchOptions(EMPTY_BRANCHES, new Set()).length === 0);
}

// ====================================== integration: real git, two repos

const { listBranches, fetchRemote } = await loadExt("worktree/branches.ts");
const runner = execRunner();

const root = await realpath(await mkdtemp(join(tmpdir(), "pi-branches-")));
const up = join(root, "up");
await pexec("git", ["init", "-q", "-b", "main", up]);
await pexec("git", ["config", "user.email", "test@example.com"], { cwd: up });
await pexec("git", ["config", "user.name", "Test"], { cwd: up });
await writeFile(join(up, "a.txt"), "hi\n");
await pexec("git", ["add", "-A"], { cwd: up });
await pexec("git", ["commit", "-qm", "init"], { cwd: up });
await pexec("git", ["branch", "alice/hotfix"], { cwd: up });

const down = join(root, "down");
await pexec("git", ["clone", "-q", up, down]);

{
	const list = await listBranches(runner, down);
	ok("list: local branch", list.local.includes("main"), JSON.stringify(list.local));
	ok("list: remote branch with a slash", list.remote.some((r) => r.full === "origin/alice/hotfix"), JSON.stringify(list.remote));
	ok("list: origin/HEAD is not a branch", !list.remote.some((r) => r.name === "HEAD"));
	ok("list: remotes", JSON.stringify(list.remotes) === JSON.stringify(["origin"]));
}

// A branch pushed after the clone: invisible until something fetches.
await pexec("git", ["branch", "later"], { cwd: up });
{
	const before = await listBranches(runner, down);
	ok("fetch: new branch invisible before fetching", !before.remote.some((r) => r.name === "later"));
	const error = await fetchRemote(runner, down, "origin");
	ok("fetch: succeeds quietly", error === undefined, String(error));
	const after = await listBranches(runner, down);
	ok("fetch: new branch visible after fetching", after.remote.some((r) => r.full === "origin/later"), JSON.stringify(after.remote));
}

{
	// An unreachable remote must produce a message, not a rejection.
	await pexec("git", ["remote", "add", "broken", join(root, "does-not-exist")], { cwd: down });
	const error = await fetchRemote(runner, down, "broken");
	ok("fetch: failure is reported, not thrown", typeof error === "string" && error.length > 0, String(error));
	ok("fetch: unknown remote is also just a message", typeof (await fetchRemote(runner, down, "nope")) === "string");
}

await rm(root, { recursive: true, force: true });

done();
