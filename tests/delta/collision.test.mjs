/**
 * Detecting when another extension has taken a tool name delta registered.
 *
 * pi keeps one definition per tool name and the *first* registration (in
 * extension-load order) wins, so if a second extension also registers `bash`
 * or `edit`, one of them silently stops rendering. The only observable signal
 * pi exposes is `getAllTools().sourceInfo`: the surviving entry's `path`
 * points at whoever owns the name. This module turns that into a warning, so
 * the clash is loud instead of a readdir-order coin flip.
 *
 *   node tests/delta/collision.test.mjs
 */

import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { toolCollisions, sameRegistrationPath } =
	await loadExt("delta/collision.ts");

// Paths standing in for delta's own index and a second, conflicting extension.
const mine = "/Users/joel/Code/pi-extensions/delta/index.ts";
const foreign = "/Users/joel/Code/pi-extensions/worktree/index.ts";
const identity = (a, b) => a === b;

ok(
	"we own both names -> no collision",
	toolCollisions(
		[
			{ name: "bash", path: mine, source: "local" },
			{ name: "edit", path: mine, source: "local" },
		],
		mine,
		["bash", "edit"],
		identity,
	).length === 0,
);

ok(
	"a foreign extension owns bash -> reported",
	(() => {
		const lost = toolCollisions(
			[
				{ name: "bash", path: foreign, source: "local" },
				{ name: "edit", path: mine, source: "local" },
			],
			mine,
			["bash", "edit"],
			identity,
		);
		return (
			lost.length === 1 && lost[0].name === "bash" && lost[0].owner === foreign
		);
	})(),
);

ok(
	"a foreign owner is reported by its path",
	(() => {
		const [c] = toolCollisions(
			[{ name: "bash", path: foreign, source: "local" }],
			mine,
			["bash"],
			identity,
		);
		return c && c.name === "bash" && c.owner === foreign;
	})(),
);

// pi's own built-in as the owner means nothing overrode delta — delta was
// filtered out entirely, not beaten by another extension. Not a collision.
ok(
	"builtin owner is not a collision",
	toolCollisions(
		[{ name: "bash", path: "<builtin:bash>", source: "builtin" }],
		mine,
		["bash"],
		identity,
	).length === 0,
);

// A name that is not in the current tool set has no rendering to fight over.
ok(
	"a name absent from the registry is not a collision",
	toolCollisions([], mine, ["edit"], identity).length === 0,
);

// An SDK-registered tool is a real owner (an extension can surface a tool via
// the SDK with a synthetic path); report it.
ok(
	"an sdk owner is reported as a collision",
	(() => {
		const lost = toolCollisions(
			[{ name: "bash", path: "<sdk:my-bash-router>", source: "sdk" }],
			mine,
			["bash"],
			identity,
		);
		return lost.length === 1 && lost[0].owner.includes("sdk");
	})(),
);

// Both names lost at once => both reported.
ok(
	"losing both names reports both",
	(() => {
		const lost = toolCollisions(
			[
				{ name: "bash", path: foreign, source: "local" },
				{ name: "edit", path: foreign, source: "local" },
			],
			mine,
			["bash", "edit"],
			identity,
		);
		return lost.length === 2 && lost.map((c) => c.name).join(",") === "bash,edit";
	})(),
);

// The default same-path matcher resolves symlinks: pi records the discovery
// path (possibly a symlink into the collection) while import.meta.url is the
// real path. Real behaviour, real files.
const dir = mkdtempSync(join(tmpdir(), "delta-collision-"));
const realFile = join(dir, "target.ts");
writeFileSync(realFile, "");
const linkFile = join(dir, "link.ts");
symlinkSync(realFile, linkFile);
ok(
	"same path through a symlink is the same file",
	sameRegistrationPath(realFile, linkFile) === true,
);
ok(
	"a symlink and an unrelated file are different",
	sameRegistrationPath(linkFile, join(dir, "other.ts")) === false,
);
// Two stale paths that do not exist: falls back to a lexical resolve, so `./`
// prefixes and trailing/leading nothing do not hide equality, and real
// differences stay different.
ok(
	"nonexistent paths compare lexically",
	sameRegistrationPath("./a.ts", `${process.cwd()}/a.ts`) === true,
);
ok(
	"distinct nonexistent paths differ",
	sameRegistrationPath("a.ts", "b.ts") === false,
);
rmSync(dir, { recursive: true, force: true });

done();
