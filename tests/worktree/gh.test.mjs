/**
 * Tests for the gh calls behind the PR status display (worktree/gh.ts).
 *
 *   cd tests && npm install && node worktree/gh.test.mjs
 *
 * No subprocesses: a scripted fake runner returns canned stdout/stderr/exit
 * codes, including the real error strings gh produces.
 */

import { assertions, fakeRunner, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const gh = await loadExt("worktree/gh.ts");
const pr = await loadExt("worktree/pr.ts");

const PR_JSON = JSON.stringify([
	{
		number: 26904,
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/equilibrium-energy/helios/pull/26904",
		statusCheckRollup: [{ __typename: "StatusContext", context: "buildkite/helios", state: "SUCCESS" }],
	},
]);

// ========================================================== nameWithOwner

{
	const runner = fakeRunner({ stdout: '{"nameWithOwner":"equilibrium-energy/helios"}\n' });
	const result = await gh.fetchNameWithOwner(runner, "/repo");
	ok("repo: parses nameWithOwner", result.status === "repo" && result.nameWithOwner === "equilibrium-energy/helios", JSON.stringify(result));
	ok("repo: runs in the given cwd", runner.calls[0].options.cwd === "/repo");
	ok("repo: passes a timeout", runner.calls[0].options.timeout === gh.GH_TIMEOUT_MS);
}

{
	const runner = fakeRunner({ code: 1, stderr: "dial tcp: lookup api.github.com: no such host\n" });
	ok("repo: a network failure is retryable", (await gh.fetchNameWithOwner(runner, "/repo")).status === "error");
}

{
	const runner = fakeRunner({
		code: 1,
		stderr: "none of the git remotes configured for this repository point to a known GitHub host\n",
	});
	ok("repo: a non-github remote is terminal", (await gh.fetchNameWithOwner(runner, "/repo")).status === "unavailable");
}

{
	const runner = { async exec() { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } };
	ok("repo: a missing gh binary is terminal", (await gh.fetchNameWithOwner(runner, "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({ stdout: "not json" });
	ok("repo: unparseable output is retryable", (await gh.fetchNameWithOwner(runner, "/repo")).status === "error");
}

{
	// What pi's own exec resolves with when the binary cannot be spawned: exit 1,
	// both streams empty, no throw. This is the *only* shape production sees for
	// a missing gh, so it has to be terminal here too.
	const runner = fakeRunner({ code: 1, stdout: "", stderr: "" });
	ok(
		"repo: exit 1 with no output at all is terminal",
		(await gh.fetchNameWithOwner(runner, "/repo")).status === "unavailable",
	);
}

{
	// A timed-out or aborted call resolves as code 0 + killed with whatever had
	// been flushed. A truncated payload that happens to parse must not be trusted.
	const runner = fakeRunner({ code: 0, killed: true, stdout: '{"nameWithOwner":"joel/thing"}' });
	ok("repo: a killed call is a retryable error", (await gh.fetchNameWithOwner(runner, "/repo")).status === "error");
}

// ================================================================= fetchPr

{
	const runner = fakeRunner({ stdout: PR_JSON });
	const result = await gh.fetchPr(runner, "joel/thing", "/repo");
	ok("pr: status is pr", result.status === "pr", JSON.stringify(result));
	ok("pr: number parsed", result.pr?.number === 26904);
	ok(
		"pr: branch passed as an explicit --head filter",
		runner.calls[0].args.join(" ").includes("--head joel/thing"),
		JSON.stringify(runner.calls[0].args),
	);
	ok(
		"pr: never uses `pr view <branch>`, whose argument is parsed number-first",
		!runner.calls[0].args.includes("view"),
		JSON.stringify(runner.calls[0].args),
	);
	ok(
		"pr: asks for merged and closed PRs too",
		runner.calls[0].args.join(" ").includes("--state all"),
		JSON.stringify(runner.calls[0].args),
	);
	ok(
		"pr: asks for every field the display needs",
		runner.calls[0].args.at(-1) === "number,state,isDraft,url,statusCheckRollup",
		runner.calls[0].args.at(-1),
	);
}

{
	// A branch named like a number must resolve as a branch. `gh pr view 1234`
	// would show PR #1234 — a different PR, linked and displayed as this one.
	const runner = fakeRunner({ stdout: "[]" });
	await gh.fetchPr(runner, "1234", "/repo");
	const args = runner.calls[0].args.join(" ");
	ok("pr: a numeric branch name stays a branch name", args.includes("--head 1234"), args);
}

{
	// `gh pr list` exits 0 with an empty array when the branch has no PR.
	const runner = fakeRunner({ stdout: "[]\n" });
	ok("pr: no PR is not an error", (await gh.fetchPr(runner, "joel/thing", "/repo")).status === "none");
}

{
	// Reusing a branch leaves history behind: the open PR is the one being worked
	// on, so it wins over an older merged or closed one regardless of order.
	const runner = fakeRunner({
		stdout: JSON.stringify([
			{ number: 10, state: "MERGED", isDraft: false, url: "u10" },
			{ number: 4, state: "OPEN", isDraft: false, url: "u4" },
		]),
	});
	const result = await gh.fetchPr(runner, "b", "/repo");
	ok("pr: an open PR wins over a merged one", result.pr?.number === 4, JSON.stringify(result));
}

{
	const runner = fakeRunner({
		stdout: JSON.stringify([
			{ number: 4, state: "CLOSED", isDraft: false, url: "u4" },
			{ number: 10, state: "MERGED", isDraft: false, url: "u10" },
		]),
	});
	const result = await gh.fetchPr(runner, "b", "/repo");
	ok("pr: with none open, the newest wins", result.pr?.number === 10, JSON.stringify(result));
}

{
	const runner = fakeRunner({ stdout: JSON.stringify([{ state: "OPEN", url: "u" }]) });
	ok("pr: a payload with no number is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

{
	const runner = fakeRunner({ stdout: JSON.stringify({ number: 1, state: "OPEN" }) });
	ok("pr: a non-array payload is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
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

{
	// The shape pi's exec resolves with for a missing binary (see the repo case).
	const runner = fakeRunner({ code: 1, stdout: "", stderr: "" });
	ok("pr: exit 1 with no output at all is unavailable", (await gh.fetchPr(runner, "b", "/repo")).status === "unavailable");
}

{
	const runner = fakeRunner({ code: 0, killed: true, stdout: JSON.stringify([{ number: 1, state: "OPEN", isDraft: false, url: "u" }]) });
	ok("pr: a killed call is a retryable error", (await gh.fetchPr(runner, "b", "/repo")).status === "error");
}

// ================================================================ selectPr

{
	ok("selectPr: nothing to select", pr.selectPr([]) === undefined);
	ok(
		"selectPr: a draft counts as open",
		pr.selectPr([
			{ number: 9, state: "MERGED", isDraft: false, url: "u" },
			{ number: 2, state: "OPEN", isDraft: true, url: "u" },
		])?.number === 2,
	);
	ok(
		"selectPr: skips entries with no usable number",
		pr.selectPr([{ state: "OPEN", url: "u" }, { number: 3, state: "CLOSED", isDraft: false, url: "u" }])?.number === 3,
	);
}

done();
