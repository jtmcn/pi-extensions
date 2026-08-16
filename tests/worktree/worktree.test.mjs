/**
 * Tests for the worktree extension.
 *
 *   cd tests && npm install && node worktree/worktree.test.mjs
 *
 * Covers layout detection (plain / bare), porcelain parsing, path slugging,
 * focus-mode rewriting, argument parsing / worktree matching, create/remove/
 * prune, and config precedence.
 *
 * Everything runs against throwaway repos in $TMPDIR. A small extra section
 * runs only when $PI_TEST_BARE_REPO points at a bare-layout checkout.
 */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const OPTIONAL_BARE_REPO = process.env.PI_TEST_BARE_REPO;

const { ok, skip, done } = assertions();
const git = await loadExt("lib/git.ts");
const focus = await loadExt("worktree/focus.ts");
const config = await loadExt("worktree/config.ts");
const worktrees = await loadExt("worktree/worktrees.ts");
const select = await loadExt("worktree/select.ts");

/** Minimal GitRunner: same shape pi's `pi.exec` provides. */
const runner = execRunner();
const exists = async (p) => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};
const rejects = async (name, fn, pattern) => {
	try {
		await fn();
		ok(name, false, "expected a rejection");
	} catch (err) {
		ok(name, pattern.test(err.message), err.message);
	}
};

// =========================================================== pure functions

ok("slug: spaces and punctuation", git.slugify("My Feature!") === "my-feature", git.slugify("My Feature!"));
ok("slug: slashes flattened", git.slugify("joel/fix thing") === "joel-fix-thing", git.slugify("joel/fix thing"));
ok("slug: degenerate input", git.slugify("///") === "worktree", git.slugify("///"));
ok("slug: length capped", git.slugify("a".repeat(200)).length === 60);

const base = { ...config.DEFAULT_CONFIG };
ok(
	"path: default template",
	config.worktreePath(base, "/proj", "feat") === "/proj/.claude/worktrees/feat",
	config.worktreePath(base, "/proj", "feat"),
);
ok(
	"path: {name} placeholder",
	config.worktreePath({ ...base, path: "../wt-{name}" }, "/proj/x", "feat") === "/proj/wt-feat",
	config.worktreePath({ ...base, path: "../wt-{name}" }, "/proj/x", "feat"),
);
ok("path: absolute config", config.worktreePath({ ...base, path: "/tmp/wts" }, "/proj", "feat") === "/tmp/wts/feat");

// ============================================================= focus mode

const target = { path: "/proj/.claude/worktrees/feat", branch: "feat" };
const opts = { sessionRoot: "/proj/main", remapAbsolutePaths: true };
const rewrite = (tool, input, o = opts, t = target) => {
	focus.applyFocus(tool, input, t, o);
	return input;
};

const bash = rewrite("bash", { command: "npm test" });
ok(
	"focus: bash gets cd prefix",
	bash.command === "cd '/proj/.claude/worktrees/feat' || exit 1\nnpm test",
	JSON.stringify(bash.command),
);
rewrite("bash", bash);
ok("focus: bash prefix is idempotent", bash.command.split("cd '").length === 2, JSON.stringify(bash.command));

const quoted = rewrite("bash", { command: "echo hi" }, opts, { path: "/tmp/it's here" });
ok("focus: worktree path is shell-quoted", quoted.command.startsWith("cd '/tmp/it'\\''s here' || exit 1\n"), quoted.command);

ok(
	"focus: relative path resolves into worktree",
	rewrite("read", { path: "src/a.ts" }).path === "/proj/.claude/worktrees/feat/src/a.ts",
);
ok(
	"focus: absolute path inside session worktree is remapped",
	rewrite("edit", { path: "/proj/main/src/a.ts" }).path === "/proj/.claude/worktrees/feat/src/a.ts",
);
ok("focus: absolute path outside repo untouched", rewrite("read", { path: "/etc/hosts" }).path === "/etc/hosts");
ok(
	"focus: other worktrees untouched",
	rewrite("read", { path: "/proj/other-wt/x.ts" }).path === "/proj/other-wt/x.ts",
);
ok(
	"focus: sibling with shared prefix untouched",
	rewrite("read", { path: "/proj/main-old/x.ts" }).path === "/proj/main-old/x.ts",
);
ok(
	"focus: already inside target untouched",
	rewrite("read", { path: "/proj/.claude/worktrees/feat/x.ts" }).path === "/proj/.claude/worktrees/feat/x.ts",
);
ok(
	"focus: remapAbsolutePaths=false disables remapping",
	rewrite("read", { path: "/proj/main/src/a.ts" }, { ...opts, remapAbsolutePaths: false }).path ===
		"/proj/main/src/a.ts",
);
ok("focus: grep defaults to worktree", rewrite("grep", { pattern: "TODO" }).path === "/proj/.claude/worktrees/feat");
ok("focus: find defaults to worktree", rewrite("find", { pattern: "*.ts" }).path === "/proj/.claude/worktrees/feat");
ok("focus: read without path is left alone", rewrite("read", {}).path === undefined);
ok("focus: unknown tools are left alone", rewrite("some_custom_tool", { path: "x.ts" }).path === "x.ts");
ok("focus: malformed input is ignored", focus.applyFocus("bash", undefined, target, opts) === undefined);

ok("focus: sameOrInside exact", focus.sameOrInside("/a/b", "/a/b"));
ok("focus: sameOrInside nested", focus.sameOrInside("/a/b/c", "/a/b"));
ok("focus: sameOrInside rejects prefix collision", !focus.sameOrInside("/a/bc", "/a/b"));

// ================================================ argument parsing / matching

ok("args: name and base", JSON.stringify(select.parseNewArgs("feat main")) === '{"name":"feat","base":"main","extra":[]}');
ok(
	"args: quoted name with spaces",
	select.parseNewArgs('"My Feature!" main').name === "My Feature!",
	JSON.stringify(select.parseNewArgs('"My Feature!" main')),
);
ok("args: single quotes too", select.parseNewArgs("'my feat'").name === "my feat");
ok(
	"args: unquoted two-word name is still name + base",
	select.parseNewArgs("My Feature").name === "My" && select.parseNewArgs("My Feature").base === "Feature",
);
ok(
	"args: third token lands in extra",
	JSON.stringify(select.parseNewArgs("a b c").extra) === '["c"]',
	JSON.stringify(select.parseNewArgs("a b c")),
);
ok("args: empty", select.parseNewArgs("   ").name === undefined);

// Matching is over the model's worktrees now, so the fixtures are KnownWorktree
// objects: a name that is the registry's for a managed worktree, and the
// directory's for one jimothy did not create.
//
// The unmanaged fixture's name ("made") and branch ("feature-x") are
// deliberately unlike each other: an assertion that queries the branch and
// happens to also equal the name would still pass if branch matching were
// deleted, which is exactly the regression this phase exists to catch.
const wts = [
	{ name: "made", path: "/hand/made", branch: "hotfix", managed: false },
	{ name: "feature-a", path: "/proj/wt/feature-a", branch: "joel/feature-a", managed: true, status: "provisioned" },
	{ name: "feature-b", path: "/proj/wt/feature-b", branch: "joel/feature-b", managed: true, status: "provisioned" },
	{ name: "detached", path: "/hand/detached", managed: false },
];
ok("match: exact name", select.matchWorktree(wts, "feature-a").worktree === wts[1]);
ok("match: exact path", select.matchWorktree(wts, "/hand/made").worktree === wts[0]);
ok("match: exact branch", select.matchWorktree(wts, "joel/feature-b").worktree === wts[2]);
ok("match: unique prefix", select.matchWorktree(wts, "ma").worktree === wts[0]);
ok("match: ambiguous prefix is refused", select.matchWorktree(wts, "feature").kind === "many");
ok("match: ambiguous prefix lists candidates", select.matchWorktree(wts, "feature").worktrees.length === 2);
ok("match: no match", select.matchWorktree(wts, "nope").kind === "none");
ok("match: exactOnly rejects prefixes", select.matchWorktree(wts, "ma", { exactOnly: true }).kind === "none");
ok("match: exactOnly still takes exact", select.matchWorktree(wts, "made", { exactOnly: true }).kind === "one");
// An unmanaged worktree still resolves by branch: /worktree focus <branch> has
// always worked, and losing it for the half jimothy does not manage would be a
// silent regression. The query ("hotfix") is the fixture's branch, not its
// name, so this fails if branch matching is ever deleted.
ok("match: an unmanaged worktree by branch", select.matchWorktree(wts, "hotfix").worktree === wts[0]);
ok("match: a worktree with no branch does not throw", select.matchWorktree(wts, "detach").worktree === wts[3]);

// A managed worktree can share a name or branch with an unmanaged one — most
// commonly the repository's main working tree, which (unlike anything jimothy
// creates) keeps whatever name and branch its directory already had. The
// managed entry must win: the registry name is what every other command
// prints, and winning the collision is what makes such a worktree reachable
// by name at all — it never was before the registry, since git always listed
// the main working tree first.
const collision = [
	{ name: "api", path: "/hand/api", branch: "main", managed: false },
	{ name: "api", path: "/wt/api", branch: "jimothy/api", managed: true, status: "provisioned" },
	{ name: "other", path: "/hand/other", branch: "shared-branch", managed: false },
	{ name: "renamed", path: "/wt/renamed", branch: "shared-branch", managed: true, status: "provisioned" },
];
ok(
	"match: a name collision resolves to the managed worktree",
	select.matchWorktree(collision, "api").worktree === collision[1],
);
ok(
	"match: a branch collision resolves to the managed worktree",
	select.matchWorktree(collision, "shared-branch").worktree === collision[3],
);
ok(
	"match: an exact path still wins over a name collision",
	select.matchWorktree(collision, "/hand/api").worktree === collision[0],
);

// The name is the registry's, not the directory's — the case the old matcher,
// which read `basename(path)`, could not express.
const renamed = [{ name: "chosen", path: "/hand/dup", branch: "feature-y", managed: true, status: "not provisioned" }];
ok("match: the registry name, not the directory", select.matchWorktree(renamed, "chosen").worktree === renamed[0]);
ok("match: the directory name is not matched", select.matchWorktree(renamed, "dup").kind === "none");

// ============================================== integration: plain git repo

const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-test-")));

const repo = join(root, "repo");
await mkdir(repo, { recursive: true });
await pexec("git", ["init", "-q", "-b", "main"], { cwd: repo });
await pexec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
await pexec("git", ["config", "user.name", "test"], { cwd: repo });
await writeFile(join(repo, "README.md"), "hi\n");
await writeFile(join(repo, ".env"), "SECRET=1\n");
await writeFile(join(repo, ".gitignore"), ".env\n");
await pexec("git", ["add", "-A"], { cwd: repo });
await pexec("git", ["commit", "-qm", "init"], { cwd: repo });

const plain = await git.getRepoInfo(runner, repo);
ok("plain: projectRoot", plain.projectRoot === repo, plain.projectRoot);
ok("plain: worktreeRoot", plain.worktreeRoot === repo, plain.worktreeRoot);
ok("plain: branch", plain.branch === "main", plain.branch);
ok("plain: defaultBranch", (await git.defaultBranch(runner, repo)) === "main");
ok("plain: non-repo returns undefined", (await git.getRepoInfo(runner, tmpdir())) === undefined);

const cfg = {
	...config.DEFAULT_CONFIG,
	branchPrefix: "joel/",
	copyFiles: [".env"],
	postCreate: "echo built > .built",
};

const created = await worktrees.createWorktree(runner, {
	name: "My Feature!",
	branch: "joel/my-feature",
	config: cfg,
	projectRoot: repo,
	sourceWorktree: repo,
});
ok("create: slugged path", created.path === join(repo, ".claude/worktrees/my-feature"), created.path);
ok("create: branch created", created.createdBranch === true);
ok("create: base is default branch", created.base === "main", String(created.base));
ok("create: gitignored file copied", created.copied.includes(".env"), JSON.stringify(created.copied));
ok("create: copied contents match", (await readFile(join(created.path, ".env"), "utf8")) === "SECRET=1\n");
ok("create: no warnings on the happy path", created.warnings.length === 0, JSON.stringify(created.warnings));
ok("create: postCreate ran in worktree", created.postCreate.code === 0);
ok("create: postCreate side effect", (await readFile(join(created.path, ".built"), "utf8")).trim() === "built");
ok("create: tracked files checked out", (await readFile(join(created.path, "README.md"), "utf8")) === "hi\n");
ok(
	"create: shows up in worktree list",
	(await git.listWorktrees(runner, repo)).some((w) => w.path === created.path && w.branch === "joel/my-feature"),
);

await rejects(
	"create: duplicate path rejected",
	() =>
		worktrees.createWorktree(runner, {
			name: "my-feature",
			branch: "joel/other",
			config: cfg,
			projectRoot: repo,
			sourceWorktree: repo,
		}),
	/already exists/,
);
await rejects(
	"create: branch already checked out rejected",
	() =>
		worktrees.createWorktree(runner, {
			name: "second",
			branch: "joel/my-feature",
			config: cfg,
			projectRoot: repo,
			sourceWorktree: repo,
		}),
	/already checked out/,
);
await rejects(
	"create: unknown base rejected",
	() =>
		worktrees.createWorktree(runner, {
			name: "third",
			branch: "joel/third",
			base: "does-not-exist",
			config: cfg,
			projectRoot: repo,
			sourceWorktree: repo,
		}),
	/does not exist/,
);

await pexec("git", ["branch", "existing"], { cwd: repo });
const reused = await worktrees.createWorktree(runner, {
	name: "existing",
	branch: "existing",
	config: { ...cfg, postCreate: undefined },
	projectRoot: repo,
	sourceWorktree: repo,
});
ok("create: existing branch reused, not recreated", reused.createdBranch === false && reused.base === undefined);

await writeFile(join(created.path, "dirty.txt"), "x");
ok("dirty: counts untracked files", (await git.countDirty(runner, created.path)) === 2);
ok("dirty: isDirty true", (await git.isDirty(runner, created.path)) === true);

const entry = (await git.listWorktrees(runner, repo)).find((w) => w.path === created.path);
await rejects(
	"remove: dirty worktree needs force",
	() => worktrees.removeWorktree(runner, { worktree: entry, projectRoot: repo, force: false }),
	/contains modified|untracked/,
);
// A dirty worktree says nothing about whether its branch is merged: forcing the
// worktree removal must not force the branch deletion.
await pexec("git", ["commit", "-qm", "unmerged", "--allow-empty"], { cwd: created.path });
await rejects(
	"remove: unmerged branch is kept, not force-deleted",
	() => worktrees.removeWorktree(runner, { worktree: entry, projectRoot: repo, force: true, deleteBranch: true }),
	/not fully merged|was kept/,
);
ok("remove: worktree still gone after branch failure", !(await git.listWorktrees(runner, repo)).some((w) => w.path === created.path));
ok("remove: unmerged branch survives", await git.branchExists(runner, "joel/my-feature", repo));
await pexec("git", ["branch", "-D", "joel/my-feature"], { cwd: repo });

const merged = await worktrees.createWorktree(runner, {
	name: "mergeable",
	branch: "joel/mergeable",
	config: { ...cfg, postCreate: undefined },
	projectRoot: repo,
	sourceWorktree: repo,
});
const mergedEntry = (await git.listWorktrees(runner, repo)).find((w) => w.path === merged.path);
await worktrees.removeWorktree(runner, {
	worktree: mergedEntry,
	projectRoot: repo,
	force: false,
	deleteBranch: true,
});
ok("remove: gone from list", !(await git.listWorktrees(runner, repo)).some((w) => w.path === merged.path));
ok("remove: merged branch deleted", !(await git.branchExists(runner, "joel/mergeable", repo)));

// A read-only subtree is what pants leaves behind: tool digests under
// `pants.d/tmp/immutable_inputs*/` are materialized mode 555, and unlinking a
// file needs the write bit on its *parent*, so git's recursive delete stops
// with EACCES after having already deregistered the worktree.
const readOnly = await worktrees.createWorktree(runner, {
	name: "readonly",
	branch: "joel/readonly",
	config: { ...cfg, postCreate: undefined },
	projectRoot: repo,
	sourceWorktree: repo,
});
const digest = join(readOnly.path, "pants.d", "tmp", "immutable_inputs", "digest");
await mkdir(join(digest, "bin"), { recursive: true });
await writeFile(join(digest, "bin", "protoc"), "binary");
await chmod(join(digest, "bin", "protoc"), 0o555);
await chmod(join(digest, "bin"), 0o555);
await chmod(digest, 0o555);

const readOnlyEntry = (await git.listWorktrees(runner, repo)).find((w) => w.path === readOnly.path);
let readOnlyError;
try {
	await worktrees.removeWorktree(runner, {
		worktree: readOnlyEntry,
		projectRoot: repo,
		force: true,
		deleteBranch: true,
	});
} catch (err) {
	readOnlyError = err;
}
ok("remove: read-only subtree does not fail", !readOnlyError, readOnlyError?.message);
ok("remove: read-only directory actually deleted", !(await exists(readOnly.path)));
ok(
	"remove: read-only worktree deregistered",
	!(await git.listWorktrees(runner, repo)).some((w) => w.path === readOnly.path),
);
ok("remove: branch deleted after recovery", !(await git.branchExists(runner, "joel/readonly", repo)));
// Restore write bits when the fix regressed, so the $TMPDIR cleanup below can
// still delete the tree instead of failing with the very error under test.
if (await exists(readOnly.path)) await pexec("chmod", ["-R", "u+w", readOnly.path]);

// A refusal must never be mistaken for a partial delete: git rejects a dirty
// worktree *before* touching anything, so recovery must not delete the files.
const refused = await worktrees.createWorktree(runner, {
	name: "refused",
	branch: "joel/refused",
	config: { ...cfg, postCreate: undefined },
	projectRoot: repo,
	sourceWorktree: repo,
});
await writeFile(join(refused.path, "precious.txt"), "do not delete");
const refusedEntry = (await git.listWorktrees(runner, repo)).find((w) => w.path === refused.path);
await rejects(
	"remove: dirty refusal still rejects",
	() => worktrees.removeWorktree(runner, { worktree: refusedEntry, projectRoot: repo, force: false }),
	/contains modified|untracked/,
);
ok("remove: refusal leaves the worktree intact", await exists(join(refused.path, "precious.txt")));
ok(
	"remove: refusal leaves the worktree registered",
	(await git.listWorktrees(runner, repo)).some((w) => w.path === refused.path),
);
await worktrees.removeWorktree(runner, { worktree: refusedEntry, projectRoot: repo, force: true });

// ============================================= integration: bare layout

const proj = join(root, "proj");
await mkdir(proj, { recursive: true });
await pexec("git", ["clone", "-q", "--bare", repo, join(proj, ".bare")]);
await writeFile(join(proj, ".git"), "gitdir: ./.bare\n");
await pexec("git", ["worktree", "add", "-q", join(proj, "main"), "main"], { cwd: proj });

const bare = await git.getRepoInfo(runner, join(proj, "main"));
ok("bare: projectRoot is the dir holding .bare", bare.projectRoot === proj, bare.projectRoot);
ok("bare: worktreeRoot", bare.worktreeRoot === join(proj, "main"), bare.worktreeRoot);
const bareRoot = await git.getRepoInfo(runner, proj);
ok("bare: resolves from project root too", bareRoot.projectRoot === proj, bareRoot.projectRoot);
ok("bare: project root has no worktreeRoot", bareRoot.worktreeRoot === undefined);

const spike = await worktrees.createWorktree(runner, {
	name: "spike",
	branch: "spike",
	config: config.DEFAULT_CONFIG,
	projectRoot: proj,
	sourceWorktree: join(proj, "main"),
});
ok("bare: new worktree lands beside .bare", spike.path === join(proj, ".claude/worktrees/spike"), spike.path);
ok("bare: files checked out", (await readFile(join(spike.path, "README.md"), "utf8")) === "hi\n");

await rm(spike.path, { recursive: true, force: true });
ok("prune: prunable detected", (await git.listWorktrees(runner, proj)).some((w) => w.prunable));
await worktrees.pruneWorktrees(runner, proj);
ok("prune: metadata removed", !(await git.listWorktrees(runner, proj)).some((w) => w.path === spike.path));

// ==================================================== config precedence

await mkdir(join(proj, ".pi"), { recursive: true });
const writeProjectConfig = (value) => writeFile(join(proj, ".pi/worktree.json"), value);

await writeProjectConfig(
	JSON.stringify({ path: "wt/{name}", branchPrefix: "x/", copyFiles: [".env"], autoFocus: false, bogus: 1 }),
);
const trusted = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok(
	"config: project file applied",
	trusted.config.path === "wt/{name}" && trusted.config.branchPrefix === "x/" && trusted.config.autoFocus === false,
	JSON.stringify(trusted.config),
);
ok("config: unknown keys ignored silently", trusted.warnings.length === 0, JSON.stringify(trusted.warnings));
ok("config: source recorded", trusted.sources.some((s) => s.endsWith("/.pi/worktree.json")));

const untrusted = await config.loadConfig({ projectRoot: proj, projectTrusted: false });
ok("config: untrusted project file ignored", untrusted.config.path === ".claude/worktrees", untrusted.config.path);

await writeProjectConfig("{ not json");
const broken = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok(
	"config: malformed JSON warns and falls back",
	broken.warnings.length === 1 && broken.config.path === ".claude/worktrees",
	JSON.stringify(broken.warnings),
);

await writeProjectConfig(JSON.stringify({ path: 5, copyFiles: "nope" }));
const badTypes = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok("config: type errors warn per field", badTypes.warnings.length === 2, JSON.stringify(badTypes.warnings));
ok("config: bad values do not clobber defaults", badTypes.config.path === ".claude/worktrees");

// ======================== optional: real bare-layout repo on this machine

if (OPTIONAL_BARE_REPO && (await exists(join(OPTIONAL_BARE_REPO, ".bare")))) {
	const info = await git.getRepoInfo(runner, join(OPTIONAL_BARE_REPO, "main"));
	ok("local repo: projectRoot", info.projectRoot === OPTIONAL_BARE_REPO, info.projectRoot);
	ok("local repo: commonDir is .bare", info.commonDir.endsWith("/.bare"), info.commonDir);

	const list = await git.listWorktrees(runner, join(OPTIONAL_BARE_REPO, "main"));
	const porcelainCount = (
		await runner.exec("git", ["worktree", "list"], { cwd: join(OPTIONAL_BARE_REPO, "main") })
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean).length;
	ok("local repo: count matches git", list.length === porcelainCount, `${list.length} vs ${porcelainCount}`);
	ok("local repo: bare entry flagged", list.some((w) => w.bare));
	ok("local repo: every path absolute", list.every((w) => w.path.startsWith("/")));
	ok(
		"local repo: refs/heads/ stripped from branches",
		list.every((w) => !w.branch?.startsWith("refs/")),
		JSON.stringify(list.map((w) => w.branch)),
	);
} else {
	skip("local bare-layout repo checks (set PI_TEST_BARE_REPO to enable)");
}

await rm(root, { recursive: true, force: true });

// ================================= create: tracking an existing remote branch

{
	const pair = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-track-")));
	const upstream = join(pair, "upstream");
	await pexec("git", ["init", "-q", "-b", "main", upstream]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: upstream });
	await pexec("git", ["config", "user.name", "Test"], { cwd: upstream });
	await writeFile(join(upstream, "a.txt"), "hi\n");
	await pexec("git", ["add", "-A"], { cwd: upstream });
	await pexec("git", ["commit", "-qm", "init"], { cwd: upstream });
	await pexec("git", ["branch", "alice/hotfix"], { cwd: upstream });
	await pexec("git", ["branch", "shadowed"], { cwd: upstream });

	const down = join(pair, "down");
	await pexec("git", ["clone", "-q", upstream, down]);
	await pexec("git", ["config", "user.email", "test@example.com"], { cwd: down });
	await pexec("git", ["config", "user.name", "Test"], { cwd: down });
	const trackCfg = { ...config.DEFAULT_CONFIG, branchPrefix: "joel/", copyFiles: [] };

	const tracked = await worktrees.createWorktree(runner, {
		name: "alice-hotfix",
		branch: "alice/hotfix",
		track: "origin/alice/hotfix",
		config: trackCfg,
		projectRoot: down,
		sourceWorktree: down,
	});
	ok("track: local branch created", tracked.createdBranch === true && tracked.branch === "alice/hotfix");
	ok("track: reported on the result", tracked.track === "origin/alice/hotfix", String(tracked.track));
	ok("track: no base was resolved", tracked.base === undefined, String(tracked.base));
	const upstreamRef = (await pexec("git", ["config", "branch.alice/hotfix.merge"], { cwd: down })).stdout.trim();
	ok("track: upstream configured", upstreamRef === "refs/heads/alice/hotfix", upstreamRef);
	ok("track: checked out at the worktree", (await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tracked.path })).stdout.trim() === "alice/hotfix");

	// A local branch that already exists must be used as it stands: it may hold
	// commits the remote does not, and `track` must not cause a reset.
	await pexec("git", ["branch", "shadowed", "origin/shadowed"], { cwd: down });
	const wtForCommit = join(pair, "tmp-wt");
	await pexec("git", ["worktree", "add", "-q", wtForCommit, "shadowed"], { cwd: down });
	await pexec("git", ["commit", "-qm", "unpushed", "--allow-empty"], { cwd: wtForCommit });
	const head = (await pexec("git", ["rev-parse", "shadowed"], { cwd: down })).stdout.trim();
	await pexec("git", ["worktree", "remove", wtForCommit], { cwd: down });

	const shadowed = await worktrees.createWorktree(runner, {
		name: "shadowed",
		branch: "shadowed",
		track: "origin/shadowed",
		config: trackCfg,
		projectRoot: down,
		sourceWorktree: down,
	});
	ok("track: existing local branch is reused, not recreated", shadowed.createdBranch === false);
	ok("track: no tracking reported when the local branch won", shadowed.track === undefined, String(shadowed.track));
	ok("track: unpushed commit survives", (await pexec("git", ["rev-parse", "shadowed"], { cwd: down })).stdout.trim() === head);

	await rejects(
		"track: base and track together are rejected",
		() =>
			worktrees.createWorktree(runner, {
				name: "both",
				branch: "both",
				base: "main",
				track: "origin/main",
				config: trackCfg,
				projectRoot: down,
				sourceWorktree: down,
			}),
		/mutually exclusive/,
	);
	await rejects(
		"track: unknown remote ref rejected",
		() =>
			worktrees.createWorktree(runner, {
				name: "ghost",
				branch: "ghost",
				track: "origin/ghost",
				config: trackCfg,
				projectRoot: down,
				sourceWorktree: down,
			}),
		/does not exist/,
	);

	await rm(pair, { recursive: true, force: true });
}

done();
