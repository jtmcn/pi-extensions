import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { enableQuietStartup, defaultSettingsPath } = await loadExt("dashboard/settings.ts");

const dir = join(await mkdtemp(join(tmpdir(), "dash-settings-")), "agent");
await mkdir(dir, { recursive: true });
const path = join(dir, "settings.json");

// Happy path preserves everything else in the file.
await writeFile(path, JSON.stringify({ theme: "dark", editorPaddingX: 2 }, null, "\t"));
const first = await enableQuietStartup(path);
ok("reports success", first.ok === true);
ok("reports the path it wrote", first.path === path);
const written = JSON.parse(await readFile(path, "utf8"));
ok("sets quietStartup", written.quietStartup === true);
ok("preserves other settings", written.theme === "dark" && written.editorPaddingX === 2);
ok("writes tab-indented json", (await readFile(path, "utf8")).includes('\n\t"'));
ok("ends with a newline", (await readFile(path, "utf8")).endsWith("\n"));

// Idempotent.
const second = await enableQuietStartup(path);
ok("running twice succeeds", second.ok === true);
ok("running twice leaves it enabled", JSON.parse(await readFile(path, "utf8")).quietStartup === true);

// A file we cannot parse is never overwritten: the user's whole config is in it.
await writeFile(path, "{ not json");
const broken = await enableQuietStartup(path);
ok("malformed json fails", broken.ok === false);
ok("malformed json explains why", typeof broken.reason === "string" && broken.reason.length > 0);
ok("malformed json is left untouched", (await readFile(path, "utf8")) === "{ not json");

// A missing file is a first-run, not an error.
const fresh = join(dir, "absent.json");
const created = await enableQuietStartup(fresh);
ok("missing file is created", created.ok === true);
ok("created file has the setting", JSON.parse(await readFile(fresh, "utf8")).quietStartup === true);

// A JSON file that is not an object is not a settings file.
await writeFile(path, "[1,2,3]");
const array = await enableQuietStartup(path);
ok("non-object json fails", array.ok === false);
ok("non-object json is left untouched", (await readFile(path, "utf8")) === "[1,2,3]");

ok("default path is in the agent dir", defaultSettingsPath().endsWith(join("agent", "settings.json")));

// Missing parent directories must be created automatically so the user does not
// have to pre-create them before running /dashboard setup on a fresh machine.
const nested = join(dir, "subdir", "deep", "settings.json");
const nestedResult = await enableQuietStartup(nested);
ok("creates missing parent directories", nestedResult.ok === true, nestedResult.reason);
ok("created nested file has the setting", JSON.parse(await readFile(nested, "utf8")).quietStartup === true);

// An unreadable existing file must not be silently treated as a first-run
// (ENOENT): touching the user’s config when we couldn’t even read it is data loss.
if (process.getuid?.() !== 0) {
	const locked = join(dir, "locked.json");
	await writeFile(locked, JSON.stringify({ existing: true }));
	await chmod(locked, 0o000);
	try {
		const lockedResult = await enableQuietStartup(locked);
		ok("unreadable file fails rather than being treated as first-run", lockedResult.ok === false);
		ok("unreadable file error is not a parse error", !(lockedResult.reason ?? "").includes("parse"));
	} finally {
		await chmod(locked, 0o644);
	}
} else {
	ok("unreadable file fails rather than being treated as first-run", true); // skip: running as root
	ok("unreadable file error is not a parse error", true);
}

done();
