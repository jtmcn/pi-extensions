/**
 * The two pi settings a replaced `bash` tool has to keep honouring.
 *
 * Registering a tool named `bash` replaces pi's in the execution registry, so
 * `shellPath` and `shellCommandPrefix` only survive if this module finds them.
 * Resolution has to match pi's SettingsManager — global, then project when the
 * project is trusted — and a broken settings file must never throw: it is read
 * on the path of every bash command.
 *
 *   node tests/delta/shell.test.mjs
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { loadShellSettings, shellSettingsKey } = await loadExt("delta/shell.ts");

const root = await mkdtemp(join(tmpdir(), "delta-shell-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(join(project, ".pi"), { recursive: true });

const global = join(agentDir, "settings.json");
const local = join(project, ".pi", "settings.json");
const load = (projectTrusted = true) => loadShellSettings({ projectRoot: project, projectTrusted, agentDir });

try {
	// ---- nothing configured

	ok("no settings files means no settings", JSON.stringify(await load()) === "{}", JSON.stringify(await load()));

	// ---- global settings

	await writeFile(global, JSON.stringify({ shellPath: "/bin/zsh", shellCommandPrefix: "source ~/.env", quietStartup: true }));
	{
		const settings = await load();
		ok("global shellPath is read", settings.shellPath === "/bin/zsh", JSON.stringify(settings));
		ok("global shellCommandPrefix is read", settings.commandPrefix === "source ~/.env", JSON.stringify(settings));
		ok("unrelated settings are ignored", Object.keys(settings).sort().join(",") === "commandPrefix,shellPath", JSON.stringify(settings));
	}

	// ---- project settings win, but only in a trusted project

	await writeFile(local, JSON.stringify({ shellPath: "/opt/homebrew/bin/fish" }));
	{
		const trusted = await load(true);
		ok("project settings override global", trusted.shellPath === "/opt/homebrew/bin/fish", JSON.stringify(trusted));
		ok("keys the project does not set stay global", trusted.commandPrefix === "source ~/.env", JSON.stringify(trusted));

		const untrusted = await load(false);
		ok("an untrusted project is not read", untrusted.shellPath === "/bin/zsh", JSON.stringify(untrusted));
	}

	// ---- a broken settings file must not throw, and must not lose the other one

	await writeFile(local, "{ not json");
	{
		const settings = await load();
		ok("malformed project settings are ignored", settings.shellPath === "/bin/zsh", JSON.stringify(settings));
	}

	await writeFile(local, JSON.stringify(["shellPath"]));
	ok("a non-object settings file is ignored", (await load()).shellPath === "/bin/zsh");

	await writeFile(local, JSON.stringify({ shellPath: 42, shellCommandPrefix: "" }));
	{
		const settings = await load();
		ok("a wrongly typed shellPath is ignored", settings.shellPath === "/bin/zsh", JSON.stringify(settings));
		ok("an empty prefix is ignored", settings.commandPrefix === "source ~/.env", JSON.stringify(settings));
	}

	// ---- tilde expansion, which pi does with an unexported helper

	await writeFile(local, JSON.stringify({ shellPath: "~/bin/fish" }));
	ok("a leading ~ is expanded", (await load()).shellPath === join(homedir(), "bin/fish"), JSON.stringify(await load()));

	await writeFile(local, JSON.stringify({ shellPath: "/opt/x~y/sh" }));
	ok("a ~ elsewhere is left alone", (await load()).shellPath === "/opt/x~y/sh");

	// ---- the memoization key

	ok("the key separates cwds", shellSettingsKey("/a", {}) !== shellSettingsKey("/b", {}));
	ok("the key separates shells", shellSettingsKey("/a", { shellPath: "/bin/zsh" }) !== shellSettingsKey("/a", {}));
	ok("the key separates prefixes", shellSettingsKey("/a", { commandPrefix: "x" }) !== shellSettingsKey("/a", {}));
	ok(
		"the key does not confuse a prefix with a shell",
		shellSettingsKey("/a", { shellPath: "x" }) !== shellSettingsKey("/a", { commandPrefix: "x" }),
	);
	ok("the same inputs give the same key", shellSettingsKey("/a", { shellPath: "z" }) === shellSettingsKey("/a", { shellPath: "z" }));
} finally {
	await rm(root, { recursive: true, force: true });
}

done();
