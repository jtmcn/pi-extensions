/**
 * Delta's output has to survive pi's frame. Everything stripped here is a
 * sequence that moves or erases, which pi's width accounting cannot see;
 * everything kept is colour, which is the entire point of the feature.
 *
 *   node tests/delta/ansi.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { sanitize } = await loadExt("delta/ansi.ts");

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

done();
