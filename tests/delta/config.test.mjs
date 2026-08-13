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

ok("version is stable for equal config", configVersion(DEFAULT_CONFIG) === configVersion({ ...DEFAULT_CONFIG }));
ok(
	"version changes with args",
	configVersion(DEFAULT_CONFIG) !== configVersion({ ...DEFAULT_CONFIG, args: ["--side-by-side"] }),
);
ok("loaded config carries its version", trusted.version === configVersion(trusted.config));

await rm(root, { recursive: true, force: true });
done();
