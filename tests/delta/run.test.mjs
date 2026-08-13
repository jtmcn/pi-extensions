/**
 * The subprocess half. Failure modes are scripted through a fake spawn; the
 * happy path runs the real delta when it is installed, because "delta emits
 * colour when its stdout is a pipe" is an assumption about another program and
 * a fake cannot check it.
 *
 *   node tests/delta/run.test.mjs
 */

import { assertions, loadExt, pexec } from "../harness.mjs";

const { ok, skip, done } = assertions();
const { createRunner, nodeSpawn } = await loadExt("delta/run.ts");
const { DEFAULT_CONFIG } = await loadExt("delta/config.ts");
const { FILL_SENTINEL } = await loadExt("delta/ansi.ts");

const PATCH = [
	"diff --git a/f.txt b/f.txt",
	"index 0000000..1111111 100644",
	"--- a/f.txt",
	"+++ b/f.txt",
	"@@ -1,3 +1,3 @@",
	" a",
	"-b",
	"+B",
	" c",
	"",
].join("\n");

// Long-line fixture: the changed lines exceed 80 columns so that side-by-side
// mode must wrap them at width 80 but not at width 200.
const WIDE_PATCH = [
	"diff --git a/wide.txt b/wide.txt",
	"index 0000000..1111111 100644",
	"--- a/wide.txt",
	"+++ b/wide.txt",
	"@@ -1,3 +1,3 @@",
	" context",
	"-this-is-a-very-long-line-in-the-old-version-of-the-file-that-extends-past-eighty-columns-for-sure-here-we-go-extra-padding-xxxx",
	"+this-is-a-very-long-line-in-the-new-version-of-the-file-that-extends-past-eighty-columns-for-sure-here-we-go-extra-padding-yyyy",
	" context",
	"",
].join("\n");

// ---- scripted failures

const calls = [];
const fake = (result) => async (command, args, input, timeoutMs) => {
	calls.push({ command, args, input, timeoutMs });
	return result;
};

const config = () => ({ ...DEFAULT_CONFIG, args: ["--side-by-side"], timeoutMs: 250 });

const ok1 = createRunner({ config, spawn: fake({ code: 0, stdout: "\x1b[31mrendered\x1b[0m\n", timedOut: false }) });
ok("returns rendered output", (await ok1.render(PATCH, 80)) === "\x1b[31mrendered\x1b[0m");
ok("forces paging never", calls[0].args.slice(0, 2).join(" ") === "--paging never", JSON.stringify(calls[0].args));
ok("passes width", calls[0].args.includes("80"));
ok("config args come last", calls[0].args.at(-1) === "--side-by-side", JSON.stringify(calls[0].args));
ok("timeout comes from config", calls[0].timeoutMs === 250);
ok("diff is written to stdin", calls[0].input === PATCH);

const failed = createRunner({ config, spawn: fake({ code: 1, stdout: "half output", timedOut: false }) });
ok("nonzero exit yields nothing", (await failed.render(PATCH, 80)) === undefined);

const timedOut = createRunner({ config, spawn: fake({ code: null, stdout: "partial", timedOut: true }) });
ok("timeout yields nothing", (await timedOut.render(PATCH, 80)) === undefined);

const empty = createRunner({ config, spawn: fake({ code: 0, stdout: "   \n", timedOut: false }) });
ok("blank output yields nothing", (await empty.render(PATCH, 80)) === undefined);

// Erase-in-line is not dropped, it becomes `fill()`'s sentinel: this is how
// the caller (delta/body.ts, delta/bash-result.ts) expands it back into the
// background padding delta used it for, once the render width is known.
const dirty = createRunner({ config, spawn: fake({ code: 0, stdout: "a\x1b[0Kb\n", timedOut: false }) });
ok(
	"output is sanitized, with the erase turned into the fill sentinel",
	(await dirty.render(PATCH, 80)) === `a${FILL_SENTINEL}b`,
	JSON.stringify(await dirty.render(PATCH, 80)),
);

const probeCalls = [];
const probed = createRunner({
	config,
	spawn: async (command, args) => {
		probeCalls.push(args.join(" "));
		return { code: 0, stdout: "delta 0.19.2", timedOut: false };
	},
});
ok("available probes --version", (await probed.available()) === true && probeCalls[0] === "--version");
await probed.available();
ok("probe is memoized", probeCalls.length === 1, String(probeCalls.length));
probed.reset();
await probed.available();
ok("reset re-probes", probeCalls.length === 2);

const missing = createRunner({ config, spawn: fake({ code: null, stdout: "", timedOut: false }) });
ok("missing binary is unavailable", (await missing.available()) === false);

// ---- the real binary, when present

let deltaInstalled = true;
try {
	await pexec("delta", ["--version"]);
} catch {
	deltaInstalled = false;
}

if (!deltaInstalled) {
	skip("delta is not installed; skipping real-binary assertions");
} else {
	const real = createRunner({ config: () => ({ ...DEFAULT_CONFIG }) });
	ok("real delta is available", (await real.available()) === true);
	const rendered = await real.render(PATCH, 80);
	ok("real delta returns output", typeof rendered === "string" && rendered.length > 0);
	ok("real delta emits colour into a pipe", /\x1b\[[0-9;]*m/.test(rendered ?? ""));
	ok("real output carries no erase sequences", !/\x1b\[[0-2]?[KJ]/.test(rendered ?? ""));
	ok("real output mentions the file", (rendered ?? "").includes("f.txt"));
	// Width sensitivity: delta's built-in file-decoration-style is "underline",
	// which draws a rule spanning the full terminal width. That rule carries
	// width even in unified mode — so on machines without a [delta] git config
	// section width IS observable in unified mode. The cache key on width is
	// therefore load-bearing for default installs, not only for side-by-side.
	//
	// --file-decoration-style=none removes the rule, making the assertion
	// environment-independent. Do not remove that flag: without it the assertion
	// passes only on machines whose git config happens to override the rule style.
	const noDecoRunner = createRunner({ config: () => ({ ...DEFAULT_CONFIG, args: ["--no-gitconfig", "--file-decoration-style=none"] }) });
	ok(
		"unified mode without file decoration is width-independent",
		(await noDecoRunner.render(WIDE_PATCH, 80)) === (await noDecoRunner.render(WIDE_PATCH, 200)),
	);
	// Side-by-side mode IS width-sensitive: each column gets half the terminal
	// width, so longer lines wrap at narrow widths but not at wide ones. This
	// is the primary justification for keying the render cache on width.
	const sbsRunner = createRunner({ config: () => ({ ...DEFAULT_CONFIG, args: ["--no-gitconfig", "--side-by-side"] }) });
	const sbsNarrow = await sbsRunner.render(WIDE_PATCH, 80);
	const sbsWide = await sbsRunner.render(WIDE_PATCH, 200);
	ok("width changes the rendering in side-by-side mode", sbsNarrow !== sbsWide);

	const bogus = createRunner({ config: () => ({ ...DEFAULT_CONFIG, args: ["--not-a-flag"] }) });
	ok("bad args fall back to nothing", (await bogus.render(PATCH, 80)) === undefined);

	const absent = createRunner({ config: () => ({ ...DEFAULT_CONFIG, command: "delta-does-not-exist" }) });
	ok("absent binary is unavailable", (await absent.available()) === false);

	// Default args (--minus-style "syntax normal" --plus-style "syntax normal") should suppress
	// line-level background SGRs that clash with pi's tool box frame, while args:[] restores
	// delta's full banded rendering. --no-gitconfig ensures the developer's own [delta] config
	// cannot change the outcome.
	const countBgLines = (str) => str.split("\n").filter((l) => /\x1b\[48;2;/.test(l)).length;
	const defaultNogit = createRunner({
		config: () => ({ ...DEFAULT_CONFIG, args: [...DEFAULT_CONFIG.args, "--no-gitconfig"] }),
	});
	const bandedNogit = createRunner({
		config: () => ({ ...DEFAULT_CONFIG, args: ["--no-gitconfig"] }),
	});
	const defaultOut = await defaultNogit.render(PATCH, 80) ?? "";
	const bandedOut = await bandedNogit.render(PATCH, 80) ?? "";
	ok(
		"default args produce fewer background-SGR lines than args:[] (banded)",
		countBgLines(defaultOut) < countBgLines(bandedOut),
		`default: ${countBgLines(defaultOut)} bg lines, banded: ${countBgLines(bandedOut)} bg lines`,
	);
	ok(
		"default args still carry foreground colour",
		/\x1b\[38;2;/.test(defaultOut),
		"expected truecolour foreground in default rendering",
	);

	// A real timeout. `sh -c 'sleep 5'` ignores stdin and outlives the timeout;
	// the forced flags land after `-c sleep 5` as harmless positional parameters.
	const hang = createRunner({
		config: () => ({ ...DEFAULT_CONFIG, command: "sh", args: ["-c", "sleep 5"], timeoutMs: 100 }),
	});
	const started = Date.now();
	ok("hanging command times out", (await hang.render(PATCH, 80)) === undefined);
	ok("timeout is enforced quickly", Date.now() - started < 2000, `${Date.now() - started}ms`);
}

ok("nodeSpawn is the default", typeof nodeSpawn === "function");

done();
