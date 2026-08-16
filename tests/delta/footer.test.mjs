/**
 * The footer split mirrors bash.js's own strip. If the two disagree, either
 * delta colours prose or the user loses the "full output" path.
 *
 *   node tests/delta/footer.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { splitBashFooter, bashWarnings } = await loadExt("delta/footer.ts");

const details = {
	truncation: { truncated: true, truncatedBy: "lines", outputLines: 50, totalLines: 900 },
	fullOutputPath: "/tmp/pi-bash-abc.txt",
};
const body = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b";
const footer = "\n\n[Showing lines 851-900 of 900. Full output: /tmp/pi-bash-abc.txt]";

const split = splitBashFooter(body + footer, details);
ok("body excludes footer", split.body === body, JSON.stringify(split.body));
ok("footer captured", split.footer === footer, JSON.stringify(split.footer));

const untruncated = splitBashFooter(body, undefined);
ok("no details: body unchanged", untruncated.body === body && untruncated.footer === "");

// A diff line can legitimately end in "]" — that alone must not look like a footer.
const endsWithBracket = "diff --git a/x b/x\n+const a = [1]";
const bracket = splitBashFooter(endsWithBracket, details);
ok("bracket without footer text is not a footer", bracket.body === endsWithBracket && bracket.footer === "");

// Truncation flagged but the footer already stripped upstream.
const noFooter = splitBashFooter(body, { truncation: { truncated: true }, fullOutputPath: "/tmp/x" });
ok("truncated but no footer present", noFooter.body === body && noFooter.footer === "");

// A footer-shaped block that names a different path is not ours.
const otherPath = `${body}\n\n[Showing lines 1-2 of 9. Full output: /tmp/other.txt]`;
const other = splitBashFooter(otherPath, details);
ok("footer naming another path is left alone", other.body === otherPath && other.footer === "");

ok(
	"warnings: path and line counts",
	JSON.stringify(bashWarnings(details)) ===
		JSON.stringify(["Full output: /tmp/pi-bash-abc.txt", "Truncated: showing 50 of 900 lines"]),
	JSON.stringify(bashWarnings(details)),
);
ok(
	"warnings: byte truncation has no line counts",
	JSON.stringify(bashWarnings({ truncation: { truncated: true, outputLines: 12 }, fullOutputPath: "/tmp/x" })) ===
		JSON.stringify(["Full output: /tmp/x", "Truncated: 12 lines shown"]),
);
ok("warnings: none without details", bashWarnings(undefined).length === 0);

done();
