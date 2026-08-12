/**
 * The matcher decides whether a bash result gets recoloured, from the command
 * alone. Two failure modes matter and both are asserted here: missing a real
 * diff, and recolouring output that only mentions one.
 *
 *   node tests/delta/detect.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { isDiffCommand, compilePatterns } = await loadExt("delta/detect.ts");

const matches = [
	"git diff",
	"git diff HEAD~1",
	"git diff --cached",
	"git -c color.ui=always diff",
	"git -C /tmp/repo diff",
	"git show HEAD",
	"git log -p",
	"git log --patch -n2",
	"git stash show -p",
	"git range-diff main...HEAD",
	"diff -u a.txt b.txt",
	"diff -U3 a.txt b.txt",
	"git diff | head -50",
	"cd /tmp/repo && git diff",
	"git fetch; git diff origin/main",
	"git diff > /tmp/out.diff",
];
for (const command of matches) ok(`matches: ${command}`, isDiffCommand(command) === true);

const rejects = [
	"git diff --stat",
	"git diff --numstat",
	"git diff --name-only",
	"git diff --name-status",
	"git diff --shortstat",
	"git show --stat HEAD",
	"git log",
	"git log --oneline -20",
	"git stash show",
	"git status",
	"git difftool",
	"diff a.txt b.txt",
	'echo "git diff"',
	"rg 'diff --git' .",
	"cat some.patch",
	"",
	"   ",
];
for (const command of rejects) ok(`rejects: ${command || "(empty)"}`, isDiffCommand(command) === false);

// extraCommands is the escape hatch that makes command matching tolerable.
const extra = compilePatterns(["^jj\\s+diff"], []);
ok("extra pattern matches jj diff", isDiffCommand("jj diff", extra) === true);
ok("extra pattern still rejects jj log", isDiffCommand("jj log", extra) === false);
ok("extra pattern applies per segment", isDiffCommand("cd x && jj diff", extra) === true);
ok("summary flags beat extra patterns", isDiffCommand("jj diff --stat", extra) === false);

const warnings = [];
const compiled = compilePatterns(["(unclosed", "^ok"], warnings);
ok("invalid regex dropped", compiled.length === 1);
ok("invalid regex warns", warnings.length === 1 && warnings[0].includes("(unclosed"), JSON.stringify(warnings));

done();
