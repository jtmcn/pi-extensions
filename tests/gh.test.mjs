/**
 * Tests for the gh calls behind the PR status display (worktree/gh.ts).
 *
 *   cd ~/.pi/agent/extensions/tests && npm install && node gh.test.mjs
 *
 * No subprocesses: a scripted fake runner returns canned stdout/stderr/exit
 * codes, including the real error strings gh produces.
 */

import { join } from "node:path";
import { createJiti } from "jiti";

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_ENTRY = process.env.PI_DIST ?? (await resolvePiEntry());

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
});
const gh = await jiti.import(`${EXT}/worktree/gh.ts`);

let fails = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`ok    ${name}`);
	else {
		fails++;
		console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
	}
};

/** A runner that returns a canned result and records the call. */
const fakeRunner = (result) => {
	const calls = [];
	return {
		calls,
		async exec(command, args, options = {}) {
			calls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false, ...result };
		},
	};
};

const PR_JSON = JSON.stringify({
	number: 26904,
	state: "OPEN",
	isDraft: false,
	url: "https://github.com/equilibrium-energy/helios/pull/26904",
	statusCheckRollup: [{ __typename: "StatusContext", context: "buildkite/helios", state: "SUCCESS" }],
});

// ========================================================== nameWithOwner

{
	const runner = fakeRunner({ stdout: '{"nameWithOwner":"equilibrium-energy/helios"}\n' });
	const name = await gh.fetchNameWithOwner(runner, "/repo");
	ok("repo: parses nameWithOwner", name === "equilibrium-energy/helios", name);
	ok("repo: runs in the given cwd", runner.calls[0].options.cwd === "/repo");
	ok("repo: passes a timeout", runner.calls[0].options.timeout === gh.GH_TIMEOUT_MS);
}

{
	const runner = fakeRunner({ code: 1, stderr: "not a github repository" });
	ok("repo: failure yields undefined", (await gh.fetchNameWithOwner(runner, "/repo")) === undefined);
}

{
	const runner = fakeRunner({ stdout: "not json" });
	ok("repo: unparseable output yields undefined", (await gh.fetchNameWithOwner(runner, "/repo")) === undefined);
}

// ================================================================= fetchPr

{
	const runner = fakeRunner({ stdout: PR_JSON });
	const result = await gh.fetchPr(runner, "joel/thing", "/repo");
	ok("pr: status is pr", result.status === "pr", JSON.stringify(result));
	ok("pr: number parsed", result.pr?.number === 26904);
	ok("pr: branch passed to gh", runner.calls[0].args.includes("joel/thing"), JSON.stringify(runner.calls[0].args));
	ok(
		"pr: asks for every field the display needs",
		runner.calls[0].args.at(-1) === "number,state,isDraft,url,statusCheckRollup",
		runner.calls[0].args.at(-1),
	);
}

{
	// The exact message gh prints for a branch with no PR.
	const runner = fakeRunner({ code: 1, stderr: "no pull requests found for branch \"joel/thing\"\n" });
	ok("pr: no PR is not an error", (await gh.fetchPr(runner, "joel/thing", "/repo")).status === "none");
}

{
	const runner = fakeRunner({ code: 4, stderr: "gh auth login required\n" });
	ok("pr: unauthenticated is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({
		code: 1,
		stderr: "none of the git remotes configured for this repository point to a known GitHub host\n",
	});
	ok("pr: non-github remote is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = { async exec() { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } };
	ok("pr: missing gh binary is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({ code: 1, stderr: "dial tcp: lookup api.github.com: no such host\n" });
	ok("pr: network failure is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

{
	const runner = fakeRunner({ stdout: "{oops" });
	ok("pr: unparseable JSON is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);

async function resolvePiEntry() {
	const { execSync } = await import("node:child_process");
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent/dist/index.js");
}
