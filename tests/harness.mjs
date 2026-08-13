/**
 * Shared test harness for the extension collection.
 *
 * Every test file needs the same three things before it can assert anything:
 * the path to the globally installed pi, a jiti importer aliased so extension
 * sources resolve, and an assertion counter. They used to be copy-pasted per
 * file. Add a test file, import these instead.
 *
 *   import { assertions, loadExt, execRunner } from "../harness.mjs";
 *
 *   const { ok, done } = assertions();
 *   const git = await loadExt("lib/git.ts");
 *   ok("name", cond);
 *   done();
 *
 * Deliberately not here: tmp repo construction and multi-call scripted runners.
 * Those differ per test, and pretending otherwise makes the harness the thing
 * you have to read first.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const pexec = promisify(execFile);

/** Repo root: the directory holding lib/, tests/, and the extensions. */
export const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Entry point of the pi package the extensions are typed and run against.
 *
 * `PI_DIST` overrides it; otherwise it comes from the global npm root, since
 * pi is installed globally and the extensions are loaded from a symlink rather
 * than an npm dependency tree. Same indirection typecheck.sh performs.
 */
export async function piEntry() {
	if (process.env.PI_DIST) return process.env.PI_DIST;
	const { stdout } = await pexec("npm", ["root", "-g"]);
	return join(stdout.trim(), "@earendil-works/pi-coding-agent/dist/index.js");
}

/**
 * Entry *file* of a package installed next to pi rather than next to the tests.
 *
 * jiti aliases must point at a file, not a directory, so a bare package name
 * will not do.
 */
async function nestedEntry(piPkg, name) {
	const dir = join(piPkg, "node_modules", name);
	const meta = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	const root = meta.exports?.["."];
	const entry = root?.import ?? root?.default ?? meta.module ?? meta.main;
	if (!entry) throw new Error(`cannot resolve an entry point for ${name}`);
	return join(dir, entry);
}

/**
 * Entry file of the pi-tui package nested inside pi.
 *
 * Tests that assert a component never emits a line wider than its render width
 * need pi's own `visibleWidth`; re-implementing ANSI-aware width measurement per
 * test file is how those assertions end up wrong.
 */
export async function piTuiEntry() {
	const entry = await piEntry();
	return nestedEntry(entry.replace(/\/dist\/index\.js$/, ""), "@earendil-works/pi-tui");
}

let jitiPromise;

/**
 * A jiti importer with pi and its nested deps aliased.
 *
 * Built once per process and shared: extension entry points import typebox and
 * pi-ai, which live inside the pi package, and resolving those costs a few file
 * reads per call.
 */
async function importer() {
	if (!jitiPromise) {
		jitiPromise = (async () => {
			const entry = await piEntry();
			const piPkg = entry.replace(/\/dist\/index\.js$/, "");
			return createJiti(import.meta.url, {
				alias: {
					"@earendil-works/pi-coding-agent": entry,
					typebox: await nestedEntry(piPkg, "typebox"),
					"@earendil-works/pi-ai": await nestedEntry(piPkg, "@earendil-works/pi-ai"),
				},
			});
		})();
	}
	return jitiPromise;
}

/**
 * Import an extension source by repo-relative path, e.g. `worktree/focus.ts`.
 */
export async function loadExt(relativePath) {
	const jiti = await importer();
	return jiti.import(join(EXT_ROOT, relativePath));
}

/**
 * An assertion counter.
 *
 * Returns `ok` to assert, `skip` to record a skipped section, and `done` to
 * print the summary and exit with the correct code. Output format is the
 * original one, which run-all.mjs parses.
 */
export function assertions() {
	let fails = 0;
	const ok = (name, cond, extra = "") => {
		if (cond) console.log(`ok    ${name}`);
		else {
			fails++;
			console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
		}
	};
	const skip = (reason) => console.log(`skip  ${reason}`);
	const done = () => {
		console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
		process.exit(fails ? 1 : 0);
	};
	return { ok, skip, done, failures: () => fails };
}

/**
 * A runner that really executes subprocesses, in the shape `pi.exec` provides:
 * it resolves with a non-zero `code` instead of throwing.
 */
export function execRunner() {
	return {
		async exec(command, args, options = {}) {
			try {
				const { stdout, stderr } = await pexec(command, args, { cwd: options.cwd });
				return { stdout, stderr, code: 0, killed: false };
			} catch (err) {
				return {
					stdout: err.stdout ?? "",
					stderr: err.stderr ?? String(err),
					code: typeof err.code === "number" ? err.code : 1,
					killed: false,
				};
			}
		},
	};
}

/** A runner that returns one canned result and records every call. */
export function fakeRunner(result) {
	const calls = [];
	return {
		calls,
		async exec(command, args, options = {}) {
			calls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false, ...result };
		},
	};
}

/** Promisified execFile, for tests that drive git directly. */
export { pexec };
