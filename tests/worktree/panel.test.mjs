import { assertions, fakeRunner, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { parseStack, readStack, locationLines, publishLocationPanel, clearLocationPanel } =
	await loadExt("worktree/panel.ts");
const panels = await loadExt("lib/panels.ts");

// --- Parsing real `gt ls -s` output ---
const simple = parseStack("◯  pr-status (needs restack)\n◉  main\n");
ok("parses both branches", simple.length === 2);
ok("reads branch names", simple[0].branch === "pr-status");
ok("marks the current branch", simple[1].current === true && simple[0].current === false);
ok("keeps the note", simple[0].note === "needs restack");

// Graphite draws tree characters for branching stacks.
const tree = parseStack("◯    eric/docs (frozen)\n│ ◉  joel/feature\n◯─┘  main\n");
ok("parses a branching stack", tree.length === 3);
ok("strips tree glyphs from names", tree[1].branch === "joel/feature");
ok("finds the current branch in a tree", tree[1].current === true);
ok("ignores blank lines", parseStack("\n\n◉  main\n").length === 1);

// --- readStack degrades ---
const untracked = await readStack(
	fakeRunner({ code: 1, stderr: "ERROR: Cannot perform this operation on untracked branch feat.\n" }),
	"/repo",
	"feat",
);
ok("untracked branch is its own state", untracked.kind === "untracked");
ok("untracked carries the branch", untracked.branch === "feat");

const absent = await readStack(
	{ async exec() { throw new Error("ENOENT"); } },
	"/repo",
	"main",
);
ok("missing gt is unavailable", absent.kind === "unavailable");

const failed = await readStack(fakeRunner({ code: 1, stderr: "not a graphite repo" }), "/repo", "main");
ok("other failures are unavailable", failed.kind === "unavailable");

const good = await readStack(fakeRunner({ code: 0, stdout: "◉  main\n" }), "/repo", "main");
ok("success yields a stack", good.kind === "stack" && good.entries.length === 1);

// --- Rendering ---
const location = { path: "~/Code/proj", branch: "feature", dirty: 3, ahead: 2, behind: 0 };
const rendered = locationLines(location, good, 120).join("\n");
ok("shows the path", rendered.includes("~/Code/proj"));
ok("shows the branch", rendered.includes("feature"));
ok("shows dirty count", rendered.includes("3 files dirty"));
ok("shows ahead", rendered.includes("↑2"));
ok("hides behind when zero", !rendered.includes("↓"));
ok("renders the stack", rendered.includes("main"));

const clean = locationLines({ path: "~/p", branch: "b", dirty: 0 }, good, 120).join("\n");
ok("clean tree says nothing about dirt", !clean.includes("dirty"));

ok(
	"pending stack says so",
	locationLines(location, { kind: "pending" }, 120).join("\n").includes("…"),
);
ok(
	"untracked explains the fix",
	locationLines(location, { kind: "untracked", branch: "feat" }, 120).join("\n").includes("gt track"),
);
ok(
	"unavailable stack renders no stack lines",
	locationLines(location, { kind: "unavailable" }, 120).join("\n").split("\n").length === 1,
);

// Width-clamp sweep: fixture must genuinely exceed every width under test.
// A deep worktree path + long branch name produces a 126-char head line
// (verified: "  ~/Code/someorg/somerepo/.claude/worktrees/mellow-thicket  ⑂ joel/some-long-and-descriptive-branch-name  · 3 files dirty · ↑2"),
// which exceeds 120, 80, and 40 — so all three assertions are live detectors.
const longLocation = {
	path: "~/Code/someorg/somerepo/.claude/worktrees/mellow-thicket",
	branch: "joel/some-long-and-descriptive-branch-name",
	dirty: 3,
	ahead: 2,
	behind: 0,
};
const longStack = await readStack(
	fakeRunner({ code: 0, stdout: "◉  joel/some-long-and-descriptive-branch-name (needs restack)\n◯  main\n" }),
	"/repo",
	"joel/some-long-and-descriptive-branch-name",
);
for (const width of [120, 80, 40]) {
	const lines = locationLines(longLocation, longStack, width);
	ok(`no line exceeds ${width}`, Math.max(...lines.map((l) => l.length)) <= width);
}

// --- Session generation guard ---
{
	const { beginLocationCycle, isCurrentLocationCycle } = await loadExt("worktree/panel.ts");
	const first = beginLocationCycle();
	ok("a fresh cycle is current", isCurrentLocationCycle(first));
	const second = beginLocationCycle();
	ok("a new cycle supersedes the old", !isCurrentLocationCycle(first));
	ok("the new cycle is current", isCurrentLocationCycle(second));
	ok("cycles are distinct", first !== second);

	// The bug this guards: a superseded session's late gt result must not
	// overwrite the current session's location.
	panels.resetPanels("worktree");
	const stale = beginLocationCycle();
	const fresh = beginLocationCycle();
	if (isCurrentLocationCycle(fresh)) {
		publishLocationPanel({ path: "~/new", dirty: 0 }, { kind: "pending" });
	}
	if (isCurrentLocationCycle(stale)) {
		publishLocationPanel({ path: "~/old", dirty: 0 }, good);
	}
	const shown = panels.listPanels().find((p) => p.owner === "worktree").render(120).join("\n");
	ok("a superseded session never publishes", shown.includes("~/new") && !shown.includes("~/old"));
}

// --- Registry integration ---
panels.resetPanels("worktree");
publishLocationPanel(location, { kind: "pending" });
const first = panels.listPanels().filter((p) => p.owner === "worktree");
ok("registers one panel", first.length === 1);
ok("panel sorts before MCP", first[0].order < 20);
publishLocationPanel(location, good);
ok("republishing replaces", panels.listPanels().filter((p) => p.owner === "worktree").length === 1);
ok("republished panel shows the stack", panels.listPanels()[0].render(120).join("\n").includes("main"));
clearLocationPanel();
ok("clear removes it", panels.listPanels().filter((p) => p.owner === "worktree").length === 0);

done();
