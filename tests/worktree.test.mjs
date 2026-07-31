/**
 * Tests for the worktree extension.
 *
 *   cd ~/.pi/agent/extensions/tests && npm install && node worktree.test.mjs
 *
 * Covers layout detection (plain / bare), porcelain parsing, path slugging,
 * focus-mode rewriting, create/remove/prune, and config precedence.
 *
 * Everything runs against throwaway repos in $TMPDIR. A small extra section
 * runs only if a known bare-layout repo is present locally.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const pexec = promisify(execFile);
const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_ENTRY = process.env.PI_DIST ?? (await resolvePiEntry());
const OPTIONAL_BARE_REPO = "/Users/joel/Code/hellos";

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
});
const git = await jiti.import(`${EXT}/lib/git.ts`);
const focus = await jiti.import(`${EXT}/worktree/focus.ts`);
const config = await jiti.import(`${EXT}/worktree/config.ts`);
const worktrees = await jiti.import(`${EXT}/worktree/worktrees.ts`);

/** Minimal GitRunner: same shape pi's `pi.exec` provides. */
const runner = {
	async exec(cmd, args, opts = {}) {
		try {
			const { stdout, stderr } = await pexec(cmd, args, { cwd: opts.cwd });
			return { stdout, stderr, code: 0, killed: false };
		} catch (err) {
			return {
				stdout: err.stdout ?? "",
				stderr: err.stderr ?? String(err),
				code: typeof err.code === "number" ? err.code : 1,
				killed: false,
			};
		}
	},
};

let fails = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`ok    ${name}`);
	else {
		fails++;
		console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
	}
};
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
ok("focus: read file_path alias", rewrite("read", { file_path: "src/a.ts" }).file_path === "/proj/.claude/worktrees/feat/src/a.ts");

ok("focus: sameOrInside exact", focus.sameOrInside("/a/b", "/a/b"));
ok("focus: sameOrInside nested", focus.sameOrInside("/a/b/c", "/a/b"));
ok("focus: sameOrInside rejects prefix collision", !focus.sameOrInside("/a/bc", "/a/b"));

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
await worktrees.removeWorktree(runner, { worktree: entry, projectRoot: repo, force: true, deleteBranch: true });
ok("remove: gone from list", !(await git.listWorktrees(runner, repo)).some((w) => w.path === created.path));
ok("remove: branch deleted", !(await git.branchExists(runner, "joel/my-feature", repo)));

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

if (await exists(join(OPTIONAL_BARE_REPO, ".bare"))) {
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
	console.log("skip  local bare-layout repo checks (no fixture on this machine)");
}

await rm(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);

async function resolvePiEntry() {
	const { execSync } = await import("node:child_process");
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent/dist/index.js");
}
