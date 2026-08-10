/**
 * Tests for `aheadBehind` in lib/git.ts.
 *
 *   cd tests && npm install && node worktree/aheadbehind.test.mjs
 *
 * Uses real git in a throwaway repo. Verifies the no-upstream case and the
 * correct behind/ahead destructure from `--left-right` output (upstream on the
 * left → [behind, ahead] is the right order).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, execRunner, loadExt, pexec } from "../harness.mjs";

const { ok, done } = assertions();
const { aheadBehind } = await loadExt("lib/git.ts");
const runner = execRunner();

// ----------------------------------------------------------------- setup

const root = await mkdtemp(join(tmpdir(), "pi-aheadbehind-"));

// Create a bare "remote".
const remote = join(root, "remote.git");
await pexec("git", ["init", "--bare", "-q", "-b", "main", remote]);

// Clone it for the "local" working copy.
const local = join(root, "local");
await pexec("git", ["clone", "-q", remote, local]);
await pexec("git", ["config", "user.email", "test@example.com"], { cwd: local });
await pexec("git", ["config", "user.name", "Test"], { cwd: local });

// Initial commit, push so both sides are in sync.
await writeFile(join(local, "a.txt"), "init\n");
await pexec("git", ["add", "."], { cwd: local });
await pexec("git", ["commit", "-q", "-m", "init"], { cwd: local });
await pexec("git", ["push", "-q"], { cwd: local });

// ----------------------------------------------------------------- tests

// No upstream: a branch with no tracking ref must return undefined, not crash.
// `aheadBehind` reports undefined for branches nobody has pushed — the common
// case in a fresh worktree — rather than treating it as an error.
await pexec("git", ["checkout", "-q", "-b", "detached"], { cwd: local });
const noUpstream = await aheadBehind(runner, local);
ok("no upstream returns undefined", noUpstream === undefined);

// Back to main (which has an upstream).
await pexec("git", ["checkout", "-q", "main"], { cwd: local });

// Exactly in sync with upstream.
const inSync = await aheadBehind(runner, local);
ok("in sync: returns an object", inSync !== undefined);
ok("in sync: ahead=0", inSync?.ahead === 0);
ok("in sync: behind=0", inSync?.behind === 0);

// One commit ahead of upstream.
await writeFile(join(local, "b.txt"), "local\n");
await pexec("git", ["add", "."], { cwd: local });
await pexec("git", ["commit", "-q", "-m", "local commit"], { cwd: local });

const ahead = await aheadBehind(runner, local);
ok("one commit ahead: ahead=1", ahead?.ahead === 1);
ok("one commit ahead: behind=0", ahead?.behind === 0);

// Push local commit, then add a commit to remote only and fetch it.
// That puts upstream one ahead of local — local is one behind.
await pexec("git", ["push", "-q"], { cwd: local });

const remote2 = join(root, "remote2.git");
await pexec("git", ["init", "--bare", "-q", "-b", "main", remote2]);
// Push the current local state to remote2, add a commit there, then add it as
// a remote and fetch so local's upstream is remote2/main (one ahead).
// Simpler: just add a commit directly to the bare remote using fast-import.
await writeFile(join(local, "c.txt"), "remote\n");
await pexec("git", ["add", "."], { cwd: local });
await pexec("git", ["commit", "-q", "-m", "remote commit"], { cwd: local });
await pexec("git", ["push", "-q"], { cwd: local });
// Now reset local HEAD back one commit and fetch so origin/main is ahead.
await pexec("git", ["reset", "--hard", "HEAD~1"], { cwd: local });

const behind = await aheadBehind(runner, local);
ok("one commit behind: behind=1", behind?.behind === 1);
ok("one commit behind: ahead=0", behind?.ahead === 0);

// Diverged: local has one commit not in upstream, upstream has one not in local.
await writeFile(join(local, "d.txt"), "diverge\n");
await pexec("git", ["add", "."], { cwd: local });
await pexec("git", ["commit", "-q", "-m", "diverge"], { cwd: local });

const diverged = await aheadBehind(runner, local);
ok("diverged: ahead=1", diverged?.ahead === 1);
ok("diverged: behind=1", diverged?.behind === 1);

// ----------------------------------------------------------------- cleanup

await rm(root, { recursive: true, force: true });
done();
