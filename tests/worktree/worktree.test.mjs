/**
 * Tests for the worktree extension.
 *
 *   cd tests && npm install && node worktree/worktree.test.mjs
 *
 * Covers layout detection (plain / bare), porcelain parsing, slugging,
 * focus-mode rewriting, argument parsing / worktree matching, prune, and config
 * precedence.
 *
 * Creating and removing worktrees is *not* here any more: it is jimothy's, and
 * the doors that reach it are covered in commands.test.mjs and tool.test.mjs
 * against the real registry.
 *
 * Everything runs against throwaway repos in $TMPDIR. A small extra section
 * runs only when $PI_TEST_BARE_REPO points at a bare-layout checkout.
 */

import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
// =========================================================== pure functions

ok("slug: spaces and punctuation", git.slugify("My Feature!") === "my-feature", git.slugify("My Feature!"));
ok("slug: slashes flattened", git.slugify("joel/fix thing") === "joel-fix-thing", git.slugify("joel/fix thing"));
ok("slug: degenerate input", git.slugify("///") === "worktree", git.slugify("///"));
ok("slug: length capped", git.slugify("a".repeat(200)).length === 60);

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

// `countDirty` still has callers — the status footer, and the confirmation
// `/worktree remove` puts in front of a dirty worktree — so it keeps its
// coverage here. `isDirty` has none left; it is exercised anyway, on the
// principle that a function `lib/git.ts` still exports should still be proven
// to work. The worktree is made with raw git: this extension has no create of
// its own any more, and one made through the registry needs a whole model,
// which commands.test.mjs already builds.
const dirtyWt = join(root, "dirty-wt");
await pexec("git", ["worktree", "add", "-q", "-b", "joel/dirty", dirtyWt], { cwd: repo });
await writeFile(join(dirtyWt, "dirty.txt"), "x");
ok("dirty: counts untracked files", (await git.countDirty(runner, dirtyWt)) === 1, String(await git.countDirty(runner, dirtyWt)));
ok("dirty: isDirty true", (await git.isDirty(runner, dirtyWt)) === true);
ok(
	"list: a worktree shows up with its branch",
	(await git.listWorktrees(runner, repo)).some((w) => w.path === dirtyWt && w.branch === "joel/dirty"),
);

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

// Prune is the subject; the worktree it prunes is made with raw git.
const spike = join(proj, "spike");
await pexec("git", ["worktree", "add", "-q", "-b", "spike", spike], { cwd: proj });
await rm(spike, { recursive: true, force: true });
ok("prune: prunable detected", (await git.listWorktrees(runner, proj)).some((w) => w.prunable));
await worktrees.pruneWorktrees(runner, proj);
ok("prune: metadata removed", !(await git.listWorktrees(runner, proj)).some((w) => w.path === spike));

// ==================================================== config precedence

await mkdir(join(proj, ".pi"), { recursive: true });
const writeProjectConfig = (value) => writeFile(join(proj, ".pi/worktree.json"), value);

await writeProjectConfig(JSON.stringify({ autoFocus: false, remapAbsolutePaths: false, bogus: 1 }));
const trusted = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok(
	"config: project file applied",
	trusted.config.autoFocus === false && trusted.config.remapAbsolutePaths === false,
	JSON.stringify(trusted.config),
);
ok("config: unknown keys ignored silently", trusted.warnings.length === 0, JSON.stringify(trusted.warnings));
ok("config: source recorded", trusted.sources.some((s) => s.endsWith("/.pi/worktree.json")));

const untrusted = await config.loadConfig({ projectRoot: proj, projectTrusted: false });
ok("config: untrusted project file ignored", untrusted.config.autoFocus === true, JSON.stringify(untrusted.config));

await writeProjectConfig("{ not json");
const broken = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok(
	"config: malformed JSON warns and falls back",
	broken.warnings.length === 1 && broken.config.autoFocus === true,
	JSON.stringify(broken.warnings),
);

await writeProjectConfig(JSON.stringify({ autoFocus: 5, remapAbsolutePaths: "nope" }));
const badTypes = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok("config: type errors warn per field", badTypes.warnings.length === 2, JSON.stringify(badTypes.warnings));
ok("config: bad values do not clobber defaults", badTypes.config.autoFocus === true);

// A key that moved is warned about, not silently ignored with the unknown ones:
// a setting still in the file is one the user believes is in effect. The warning
// must also not read as a straight rename, because it is not one — jimothy's
// `copy` does not take directories, and it has no `postCreate` at all.
await writeProjectConfig(
	JSON.stringify({ path: "wt/{name}", branchPrefix: "x/", defaultBase: "main", copyFiles: [".env"], postCreate: "npm i" }),
);
const moved = await config.loadConfig({ projectRoot: proj, projectTrusted: true });
ok("config: a removed key is not read", moved.config.branchPrefix === undefined, JSON.stringify(moved.config));
ok("config: every removed key warns", moved.warnings.length === 5, JSON.stringify(moved.warnings));
const movedText = moved.warnings.join("\n");
ok("config: the warning names jimothy's config", /jimothy\.config\.json/.test(movedText), movedText);
ok("config: copyFiles is named", /copyFiles/.test(movedText), movedText);
ok("config: copy is not claimed to take directories", /copies files, not directories/.test(movedText), movedText);
ok(
	"config: postCreate is not claimed as an upgrade",
	/postCreate has no equivalent/.test(movedText),
	movedText,
);
ok(
	"config: a moved key does not survive as config",
	JSON.stringify(Object.keys(moved.config).sort()) === '["autoFocus","remapAbsolutePaths"]',
	JSON.stringify(Object.keys(moved.config)),
);

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

done();
