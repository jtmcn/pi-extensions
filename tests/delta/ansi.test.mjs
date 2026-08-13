/**
 * Delta's output has to survive pi's frame. Everything stripped here is a
 * sequence that moves or erases, which pi's width accounting cannot see;
 * everything kept is colour, which is the entire point of the feature.
 *
 *   node tests/delta/ansi.test.mjs
 */

import { assertions, loadExt, piEntry } from "../harness.mjs";

const { ok, done } = assertions();
const { sanitize, plain } = await loadExt("delta/ansi.ts");

ok("erase-in-line with parameter stripped", sanitize("a\x1b[0Kb") === "ab", JSON.stringify(sanitize("a\x1b[0Kb")));
ok("bare erase-in-line stripped", sanitize("a\x1b[Kb") === "ab");
ok("erase-in-display stripped", sanitize("a\x1b[2Jb") === "ab");
ok("carriage return stripped", sanitize("a\rb") === "ab");
ok("colour preserved", sanitize("\x1b[31mred\x1b[0m") === "\x1b[31mred\x1b[0m");
ok(
	"24-bit background preserved",
	sanitize("\x1b[48;2;63;45;61mx\x1b[0m") === "\x1b[48;2;63;45;61mx\x1b[0m",
);
ok(
	"OSC 8 hyperlink preserved",
	sanitize("\x1b]8;;file:///x\x07t\x1b]8;;\x07") === "\x1b]8;;file:///x\x07t\x1b]8;;\x07",
);
ok("newlines preserved", sanitize("a\nb") === "a\nb");

// ---- plain(): text coming *in* from a tool result
//
// This is pi's `getTextOutput` minus `sanitizeBinaryOutput`: pi strips every
// escape and every carriage return before styling bash output, so text that
// reaches delta (and pi's fallback styler) must be stripped the same way.

ok("colour is stripped from tool text", plain("\x1b[31m-a\x1b[0m") === "-a", JSON.stringify(plain("\x1b[31m-a\x1b[0m")));
ok("24-bit colour is stripped", plain("\x1b[48;2;63;45;61mx\x1b[0m") === "x");
ok("OSC 8 hyperlinks are stripped", plain("\x1b]8;;file:///x\x07t\x1b]8;;\x07") === "t", JSON.stringify(plain("\x1b]8;;file:///x\x07t\x1b]8;;\x07")));
ok("erase sequences are stripped", plain("a\x1b[0Kb") === "ab");
ok("carriage returns are stripped", plain("a\r\nb\r") === "a\nb");
ok("the diff text itself survives", plain("diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b") === "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b");
ok("text with no escapes is returned unchanged", plain("plain text") === "plain text");

// pi's stripAnsi is the reference: same input, same output.
const piStripAnsi = (await import(`file://${(await piEntry()).replace(/index\.js$/, "utils/ansi.js")}`)).stripAnsi;
for (const sample of [
	"\x1b[1mdiff --git a/f b/f\x1b[m",
	"\x1b[36m@@ -1 +1 @@\x1b[m",
	"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\",
	"\x1b[48;2;1;2;3mbg\x1b[0m",
	"no escapes at all",
]) {
	ok(`matches pi's stripAnsi: ${JSON.stringify(sample)}`, plain(sample) === piStripAnsi(sample).replace(/\r/g, ""));
}

done();
