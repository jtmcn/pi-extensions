/**
 * The render slots' decisions, tested without a fake pi.
 *
 * These behaviours were all reachable before only by driving a render slot,
 * which meant constructing a pi context to assert on a boolean. Two of them were
 * not reachable at all: `backgroundKey`'s error branch is dead from the bash
 * slot (the caller returns early on `isError`), and `isOurComponent` guards a
 * crash that only happens when pi's own renderer receives our component.
 *
 *   node tests/delta/render-rules.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { backgroundKey, bashCommand, displayPath, isOurComponent, resultText, timing, usesDelta } =
	await loadExt("delta/render-rules.ts");

// ---- isOurComponent(): the guard against a TypeError inside pi's renderer

ok("our component is recognised by its update method", isOurComponent({ update() {} }) === true);
ok("pi's component is not ours", isOurComponent({ clear() {}, render() {} }) === false);
ok("undefined is not ours", isOurComponent(undefined) === false);
ok("null is not ours", isOurComponent(null) === false);
ok("a non-function update is not ours", isOurComponent({ update: "yes" }) === false);

// ---- usesDelta(): errors keep pi's rendering, the matcher decides the rest

ok("a diff command uses delta", usesDelta({ command: "git diff", isError: false, patterns: [] }) === true);
ok("a non-diff command does not", usesDelta({ command: "ls -la", isError: false, patterns: [] }) === false);
ok(
	"a failed diff command does not \u2014 the text is a message, not a diff",
	usesDelta({ command: "git diff", isError: true, patterns: [] }) === false,
);
ok(
	"a config pattern reaches the matcher",
	usesDelta({ command: "jj diff", isError: false, patterns: [/^jj\s+diff/] }) === true,
);
ok(
	"a config pattern does not override the error rule",
	usesDelta({ command: "jj diff", isError: true, patterns: [/^jj\s+diff/] }) === false,
);

// ---- bashCommand(): pi's args are untyped at this boundary

ok("a command is read out", bashCommand({ command: "git diff" }) === "git diff");
ok("missing args become empty", bashCommand(undefined) === "");
ok("a missing command becomes empty", bashCommand({}) === "");
ok("a non-string command is coerced", bashCommand({ command: 7 }) === "7");

// ---- resultText(): pi's getTextOutput, reproduced

ok("text parts are joined", resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb");
ok(
	"non-text parts are dropped",
	resultText([{ type: "image", data: "x" }, { type: "text", text: "a" }]) === "a",
);
ok("missing content is empty", resultText(undefined) === "");
ok("surrounding whitespace is trimmed", resultText([{ type: "text", text: "\n a \n" }]) === "a");
ok(
	"ANSI from a colour-forcing command is stripped",
	resultText([{ type: "text", text: "\x1b[31mred\x1b[0m" }]) === "red",
);
ok(
	"carriage returns from a CRLF repo are stripped",
	resultText([{ type: "text", text: "a\r\nb" }]) === "a\nb",
);

// ---- backgroundKey(): mirrors pi's own bgFn selection
//
// The error case cannot be reached through the bash render slot, so this is the
// only place it is pinned.

ok("a partial result is pending", backgroundKey({ isPartial: true, isError: false }) === "toolPendingBg");
ok("a failed result is error", backgroundKey({ isPartial: false, isError: true }) === "toolErrorBg");
ok("anything else is success", backgroundKey({ isPartial: false, isError: false }) === "toolSuccessBg");
ok(
	"pending wins over error, as it does in pi",
	backgroundKey({ isPartial: true, isError: true }) === "toolPendingBg",
);

// ---- timing(): pi's wording, and the clock only when the end is unknown

ok(
	"no start means no timing line",
	timing({ startedAt: undefined, endedAt: undefined, isPartial: false, now: 100 }) === undefined,
);
{
	const running = timing({ startedAt: 100, endedAt: undefined, isPartial: true, now: 450 });
	ok("a running command reports elapsed time from the clock", running.label === "Elapsed" && running.ms === 350, JSON.stringify(running));

	const finished = timing({ startedAt: 100, endedAt: 400, isPartial: false, now: 9999 });
	ok(
		"a finished command reports what it took, ignoring the clock",
		finished.label === "Took" && finished.ms === 300,
		JSON.stringify(finished),
	);

	const zero = timing({ startedAt: 100, endedAt: 100, isPartial: false, now: 100 });
	ok("an instant command is 0ms, not absent", zero.ms === 0, JSON.stringify(zero));
}

// ---- displayPath(): relative inside the cwd, verbatim outside it

ok("a path inside the cwd is shown relative", displayPath({ path: "/repo/src/a.ts" }, "/repo") === "src/a.ts");
ok("a path outside the cwd is shown as given", displayPath({ path: "/other/a.ts" }, "/repo") === "/other/a.ts");
ok("file_path is accepted too", displayPath({ file_path: "/repo/b.ts" }, "/repo") === "b.ts");
ok("path wins over file_path", displayPath({ path: "/repo/a.ts", file_path: "/repo/b.ts" }, "/repo") === "a.ts");
ok("no path becomes an ellipsis, not an empty header", displayPath({}, "/repo") === "...");
ok("undefined args become an ellipsis", displayPath(undefined, "/repo") === "...");
ok(
	"a sibling directory sharing the cwd's name prefix is not truncated",
	displayPath({ path: "/repo-two/a.ts" }, "/repo") === "/repo-two/a.ts",
);
ok("the cwd itself is not turned into an empty string", displayPath({ path: "/repo" }, "/repo") === "/repo");

done();
