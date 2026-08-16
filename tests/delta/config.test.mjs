/**
 * Config resolution, including the two rules that are easy to get wrong: a
 * project file is only read in a trusted project, and a malformed file warns
 * instead of throwing (it would otherwise break session startup).
 *
 *   node tests/delta/config.test.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { loadConfig, configVersion, DEFAULT_CONFIG } = await loadExt("delta/config.ts");

const root = await mkdtemp(join(tmpdir(), "delta-config-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(join(project, ".pi"), { recursive: true });

const load = (projectTrusted) => loadConfig({ projectRoot: project, projectTrusted, agentDir });
const writeGlobal = (text) => writeFile(join(agentDir, "delta.json"), text);
const writeProject = (text) => writeFile(join(project, ".pi", "delta.json"), text);

const defaults = await load(false);
ok("defaults when no file exists", defaults.config.command === "delta" && defaults.config.enabled === true);
ok("defaults record no sources", defaults.sources.length === 0);
ok("defaults produce no warnings", defaults.warnings.length === 0);
ok("default args suppress line backgrounds (--minus-style present)", DEFAULT_CONFIG.args[0] === "--minus-style");
ok("default args suppress line backgrounds (--plus-style present)", DEFAULT_CONFIG.args.includes("--plus-style"));

await writeGlobal(JSON.stringify({ command: "/opt/homebrew/bin/delta", timeoutMs: 500 }));
const global = await load(false);
ok("global file applied", global.config.command === "/opt/homebrew/bin/delta" && global.config.timeoutMs === 500);
ok("unspecified keys keep defaults", global.config.maxBytes === DEFAULT_CONFIG.maxBytes);
ok("global source recorded", global.sources.length === 1 && global.sources[0].endsWith("agent/delta.json"));

await writeProject(JSON.stringify({ args: ["--side-by-side"], enabled: false }));
const untrusted = await load(false);
ok("untrusted project file ignored", untrusted.config.enabled === true && JSON.stringify(untrusted.config.args) === JSON.stringify(DEFAULT_CONFIG.args));

const trusted = await load(true);
ok("trusted project file applied", trusted.config.enabled === false);
ok("project args applied", JSON.stringify(trusted.config.args) === '["--side-by-side"]');
ok("project file does not clobber global", trusted.config.command === "/opt/homebrew/bin/delta");
ok("both sources recorded", trusted.sources.length === 2, JSON.stringify(trusted.sources));

// Escape hatch: "args": [] in a trusted project file restores delta's own banded rendering.
await writeProject(JSON.stringify({ args: [] }));
const escaped = await load(true);
ok("args:[] in trusted config resets to empty (escape hatch)", escaped.config.args.length === 0);

await writeProject("{ not json");
const broken = await load(true);
ok("malformed JSON warns", broken.warnings.length === 1, JSON.stringify(broken.warnings));
ok("malformed JSON falls back", broken.config.enabled === true);

await writeProject(JSON.stringify({ command: 5, args: "nope", timeoutMs: "soon", extraCommands: [7] }));
const badTypes = await load(true);
ok("type errors warn per field", badTypes.warnings.length === 4, JSON.stringify(badTypes.warnings));
ok("bad values do not clobber", badTypes.config.command === "/opt/homebrew/bin/delta");

// A typo in a key is the one config mistake that produces no visible effect at
// all: the value is simply never read, and the feature quietly behaves as if the
// setting had not been written. Warning is the whole remedy.
await writeProject(JSON.stringify({ timeuotMs: 500, enabled: true }));
const typo = await load(true);
ok(
	"an unknown key warns",
	typo.warnings.some((w) => w.includes("timeuotMs")),
	JSON.stringify(typo.warnings),
);
ok("an unknown key does not stop the known ones applying", typo.config.enabled === true);
ok("a known key does not warn", !typo.warnings.some((w) => w.includes('"enabled"')), JSON.stringify(typo.warnings));

// `maxBytes` is the size of diff handed to delta, and every rendering of one is
// held in a 64-entry cache. An absurd value turns that cache into an unbounded
// memory sink, so it is clamped rather than trusted.
await writeProject(JSON.stringify({ maxBytes: 999_999_999, timeoutMs: 600_000 }));
const absurd = await load(true);
ok("an absurd maxBytes is clamped", absurd.config.maxBytes < 999_999_999, String(absurd.config.maxBytes));
ok("clamping maxBytes warns", absurd.warnings.some((w) => w.includes("maxBytes")), JSON.stringify(absurd.warnings));
ok("an absurd timeoutMs is clamped", absurd.config.timeoutMs < 600_000, String(absurd.config.timeoutMs));
ok("clamping timeoutMs warns", absurd.warnings.some((w) => w.includes("timeoutMs")), JSON.stringify(absurd.warnings));

await writeProject(JSON.stringify({ maxBytes: 1024, timeoutMs: 500 }));
const sane = await load(true);
ok("a sane maxBytes is left alone", sane.config.maxBytes === 1024, String(sane.config.maxBytes));
ok("a sane timeoutMs is left alone", sane.config.timeoutMs === 500, String(sane.config.timeoutMs));
ok("sane values do not warn", sane.warnings.length === 0, JSON.stringify(sane.warnings));

ok("version is stable for equal config", configVersion(DEFAULT_CONFIG) === configVersion({ ...DEFAULT_CONFIG }));
ok(
	"version changes with args",
	configVersion(DEFAULT_CONFIG) !== configVersion({ ...DEFAULT_CONFIG, args: ["--side-by-side"] }),
);
ok("loaded config carries its version", trusted.version === configVersion(trusted.config));

await rm(root, { recursive: true, force: true });
done();
