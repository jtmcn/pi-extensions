/**
 * Run every test file in the collection.
 *
 *   cd tests && npm install && node run-all.mjs
 *   node run-all.mjs worktree      # only files under tests/worktree/
 *
 * Discovers `**\/*.test.mjs`, so a new extension's tests are picked up without
 * editing anything. Each file runs as its own process and every file runs even
 * when an earlier one fails — a suite that stops at the first failure hides how
 * much is broken.
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const files = (await discover(TESTS_DIR)).sort();
const selected = filter ? files.filter((f) => relative(TESTS_DIR, f).includes(filter)) : files;

if (selected.length === 0) {
	console.error(filter ? `no test files match "${filter}"` : "no test files found");
	process.exit(1);
}

const results = [];
for (const file of selected) {
	const name = relative(TESTS_DIR, file);
	console.log(`\n=== ${name} ===`);
	const { code, output } = await run(file);
	results.push({ name, code, passed: count(output, /^ok {4}/gm), failed: count(output, /^FAIL/gm) });
}

const totalPassed = results.reduce((n, r) => n + r.passed, 0);
const totalFailed = results.reduce((n, r) => n + r.failed, 0);
const broken = results.filter((r) => r.code !== 0);

console.log(`\n${"=".repeat(60)}`);
for (const r of results) {
	const status = r.code === 0 ? "PASS" : "FAIL";
	console.log(`${status}  ${r.name.padEnd(34)} ${r.passed} passed${r.failed ? `, ${r.failed} failed` : ""}`);
}
console.log(`\n${results.length} files, ${totalPassed} assertions passed, ${totalFailed} failed`);

if (broken.length > 0) {
	// A file can exit non-zero without a FAIL line (an import threw, a fixture
	// died). Call that out rather than reporting a clean run.
	console.log(`${broken.length} file(s) exited non-zero: ${broken.map((r) => r.name).join(", ")}`);
	process.exit(1);
}
console.log("ALL PASS");

/** Test files anywhere under `dir`, skipping node_modules and fixtures. */
async function discover(dir) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "fixtures") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await discover(path)));
		else if (entry.name.endsWith(".test.mjs")) found.push(path);
	}
	return found;
}

/** Run one file, streaming its output through while capturing it for counting. */
function run(file) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file], {
			cwd: TESTS_DIR,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});
}

function count(text, pattern) {
	return (text.match(pattern) ?? []).length;
}
