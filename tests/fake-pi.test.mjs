/**
 * The fake pi's interactive surface.
 *
 * Everything phase 3 does at startup can ask the user a question, and a test
 * that cannot answer one cannot test any of it. Scripted answers are queues
 * rather than single values because the take-over path asks twice in a row in
 * some orders, and "the second answer was consumed by the second prompt" is the
 * kind of thing that silently stops being true.
 */

import { assertions } from "./harness.mjs";
import { createFakePi } from "./fake-pi.mjs";

const { ok, done } = assertions();

// --- defaults, for the tests that never prompt ---------------------------
{
	const fake = createFakePi();
	const ctx = fake.ctx();
	ok("confirm defaults to false", (await ctx.ui.confirm("t", "m")) === false);
	ok("select defaults to undefined", (await ctx.ui.select("t", ["a"])) === undefined);
	ok("input defaults to undefined", (await ctx.ui.input("t")) === undefined);
}

// --- scripted answers ----------------------------------------------------
{
	const fake = createFakePi({ confirms: [true, false], selects: ["Take over"], inputs: ["name"] });
	const ctx = fake.ctx();
	ok("confirm answers from the queue in order", (await ctx.ui.confirm("first", "m")) === true);
	ok("and again", (await ctx.ui.confirm("second", "m")) === false);
	ok("select answers from its own queue", (await ctx.ui.select("pick", ["Quit", "Take over"])) === "Take over");
	ok("input answers from its own queue", (await ctx.ui.input("name?")) === "name");
	ok("an exhausted queue falls back to the default", (await ctx.ui.confirm("third", "m")) === false);
}

// --- what was asked ------------------------------------------------------
{
	const fake = createFakePi({ selects: ["Quit"] });
	const ctx = fake.ctx();
	await ctx.ui.confirm("Remove it?", "This cannot be undone.");
	await ctx.ui.select("Worktree in use", ["Quit", "Take over"]);
	ok("records the confirm's title and message", fake.prompts.confirm[0].title === "Remove it?");
	ok("records the confirm's detail", fake.prompts.confirm[0].message === "This cannot be undone.");
	ok("records the select's options", fake.prompts.select[0].options.join(",") === "Quit,Take over");
}

// --- shutdown ------------------------------------------------------------
{
	const fake = createFakePi();
	const ctx = fake.ctx();
	ok("no shutdown yet", fake.shutdowns.length === 0);
	ctx.shutdown();
	ok("shutdown is recorded rather than performed", fake.shutdowns.length === 1);
	ok("and names the context that asked", fake.shutdowns[0] === ctx);
}

// --- prompts belong to the session that asked ----------------------------
{
	const fake = createFakePi({ confirms: [true, true] });
	const first = fake.ctx();
	await first.ui.confirm("a", "m");
	await fake.fire("session_start");
	const second = fake.ctx();
	await second.ui.confirm("b", "m");
	ok("the aggregate records both", fake.prompts.confirm.length === 2);
	ok("each prompt names its own context", fake.prompts.confirm[1].ctx === second);
}

done();
