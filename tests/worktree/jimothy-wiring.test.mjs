/**
 * The dependency wiring itself.
 *
 * This is the one test that fails for an environmental reason rather than a
 * code one — a jimothy that was not built, or was built but never had its own
 * `npm install` run. Both produce errors that name jimothy's internals
 * (`Cannot find package 'proper-lockfile'`) rather than the missing step, so
 * this test says the missing step out loud.
 */

import { assertions } from "../harness.mjs";

const { ok, done } = assertions();

let model;
try {
	model = await import("jimothy/worktrees");
} catch (error) {
	ok(`jimothy/worktrees imports (run \`npm install && npm run build\` in ~/Code/jimothy): ${error.message}`, false);
	done();
}

ok("exports Registry", typeof model.Registry === "function");
ok("exports readRepoInfo", typeof model.readRepoInfo === "function");
ok("exports loadConfig", typeof model.loadConfig === "function");
ok("exports UserError", typeof model.UserError === "function");
ok("exports the naming helpers", typeof model.slugify === "function" && typeof model.isValidWorktreeName === "function");
// The barrel is deliberately narrow: identity comes from Registry.list(), so a
// second route to raw git must not be reachable through it.
ok("does not re-export a raw git listing", model.listGitWorktrees === undefined);

done();
