import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const panels = await loadExt("lib/panels.ts");

const panel = (id, owner, order) => ({
	id,
	owner,
	title: id.toUpperCase(),
	order,
	render: () => [`${id} line`],
});

// Ordering
panels.resetPanels("a");
panels.resetPanels("b");
panels.registerPanel(panel("second", "a", 20));
panels.registerPanel(panel("first", "b", 10));
ok(
	"listPanels sorts by order",
	panels.listPanels().map((p) => p.id).join(",") === "first,second",
);

// resetPanels is scoped to one owner
panels.resetPanels("a");
ok(
	"resetPanels drops only that owner",
	panels.listPanels().map((p) => p.id).join(",") === "first",
);

// Re-registering the same id replaces rather than duplicates
panels.registerPanel(panel("first", "b", 10));
ok("re-register replaces", panels.listPanels().length === 1);

// Subscribers
let calls = 0;
const unsubscribe = panels.subscribe(() => calls++);
panels.updatePanel("first");
ok("updatePanel notifies", calls === 1);
panels.registerPanel(panel("third", "b", 30));
ok("registerPanel notifies", calls === 2);
panels.resetPanels("b");
ok("resetPanels notifies", calls === 3);
unsubscribe();
panels.updatePanel("first");
ok("unsubscribe stops notification", calls === 3);

// A throwing subscriber must not break the others
panels.resetPanels("b");
let reached = false;
const un1 = panels.subscribe(() => {
	throw new Error("boom");
});
const un2 = panels.subscribe(() => {
	reached = true;
});
panels.registerPanel(panel("x", "b", 1));
ok("a throwing subscriber does not stop the rest", reached);
un1();
un2();

done();
