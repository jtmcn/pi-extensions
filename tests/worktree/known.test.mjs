/**
 * Flattening the model's listing into the one shape this extension renders,
 * matches and completes against.
 *
 * The interesting part is unmanaged worktrees. They have no registry name and
 * no status, but they do have a branch — and losing that branch would silently
 * break resolving `/worktree focus <branch>`, which is why the model reports
 * whole git entries rather than bare paths.
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { toKnown, describeKnown } = await loadExt("worktree/known.ts");

const deps = { isPidAlive: () => false, now: () => new Date("2026-08-14T12:00:00.000Z") };

const listing = {
	managed: [
		{ name: "alpha", path: "/wt/alpha", branch: "jimothy/alpha", baseCommit: "a1", provisioned: { lockHash: "h", linked: [], at: "x" } },
		{ name: "beta", path: "/wt/beta", branch: "jimothy/beta", baseCommit: "b1" },
	],
	unmanaged: [
		{ path: "/hand/made", branch: "feature-x", bare: false, detached: false },
		{ path: "/hand/detached", bare: false, detached: true },
	],
};

const known = toKnown(listing, deps);

ok("keeps every worktree", known.length === 4);
ok("managed come first", known[0].name === "alpha" && known[1].name === "beta");
ok("managed carry the registry name", known[0].managed === true && known[0].name === "alpha");
ok("managed carry a rendered status", typeof known[0].status === "string" && known[0].status.length > 0);
ok("provisioned state reaches the status", known[0].status !== known[1].status);

const unmanaged = known.find((wt) => wt.path === "/hand/made");
ok("unmanaged are flagged", unmanaged.managed === false);
ok("unmanaged keep their branch", unmanaged.branch === "feature-x");
ok("unmanaged are named by their directory", unmanaged.name === "made");
ok("unmanaged have no status", unmanaged.status === undefined);

const detached = known.find((wt) => wt.path === "/hand/detached");
ok("a detached unmanaged worktree has no branch", detached.branch === undefined);

// --- rendering -----------------------------------------------------------
ok("renders a managed worktree with its name and branch", /alpha/.test(describeKnown(known[0])) && /jimothy\/alpha/.test(describeKnown(known[0])));
ok("renders a managed worktree's status", new RegExp(known[0].status).test(describeKnown(known[0])));
ok("labels an unmanaged worktree", /unmanaged/.test(describeKnown(unmanaged)));
ok("renders a detached worktree without printing undefined", !/undefined/.test(describeKnown(detached)));

done();
