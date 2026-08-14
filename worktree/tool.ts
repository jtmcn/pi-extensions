/**
 * The `worktree` tool: what the model is allowed to do.
 *
 * Deliberately the safe half of the feature. Listing and creating a worktree are
 * additive and reversible, so they are exposed here; focusing, removing, and
 * pruning change the user's environment and stay behind the slash command.
 *
 * Creating one *does* focus the session when configured to, which is a visible
 * change — hence the explicit note in the result, and the refusal to focus when
 * there is no session context to paint a status line with, where the user would
 * have no way of knowing.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listWorktrees, type RepoInfo, slugify } from "../lib/git.ts";
import { type BranchList, listBranches } from "./branches.ts";
import type { WorktreeConfig } from "./config.ts";
import type { FocusTarget } from "./focus.ts";
import type { KnownWorktree } from "./known.ts";
import { type CommandRunner, createWorktree } from "./worktrees.ts";

export interface ToolDeps {
	runner: CommandRunner;
	getRepo: () => RepoInfo | undefined;
	getConfig: () => WorktreeConfig;
	/** The live session context, or undefined outside a session. */
	getSessionCtx: () => ExtensionContext | undefined;
	setFocus: (ctx: ExtensionContext, target: FocusTarget | undefined, announce?: boolean) => void;
	/**
	 * Keep the slash command's completion cache in step after a create. The
	 * reconciling read, not the lock-free one: what this tool just created is
	 * unmanaged until phase 4 moves this create onto the model's write paths, and
	 * a snapshot cannot see an unmanaged worktree at all.
	 */
	refreshKnown: () => Promise<KnownWorktree[]>;
	/** Same, for the branch cache `checkout` completes from. */
	setKnownBranches: (branches: BranchList) => void;
}

export function createWorktreeTool(deps: ToolDeps) {
	const { runner, getRepo, getConfig, getSessionCtx, setFocus, refreshKnown, setKnownBranches } = deps;

	return {
		name: "worktree",
		label: "Worktree",
		description:
			"List or create git worktrees for the current repository. Use this to run an experiment " +
			"on a separate branch without disturbing the user's working tree. Unless auto-focus is " +
			"disabled, creating a worktree moves you into it: relative paths and bash commands then " +
			"resolve there. The tool result says which happened. Creating one may run the project's " +
			"configured postCreate setup command inside it.",
		promptSnippet: "List or create git worktrees for isolated parallel work",
		parameters: Type.Object({
			action: StringEnum(["list", "create"] as const, {
				description: "list existing worktrees, or create a new one",
			}),
			name: Type.Optional(Type.String({ description: "Directory name for the new worktree (create only)" })),
			base: Type.Optional(Type.String({ description: "Start point for the new branch (create only)" })),
		}),
		async execute(
			_toolCallId: string,
			params: { action: "list" | "create"; name?: string; base?: string },
			signal: AbortSignal | undefined,
		): Promise<{
			content: { type: "text"; text: string }[];
			isError?: boolean;
			details: Record<string, unknown>;
		}> {
			const repo = getRepo();
		if (!repo) {
				return { content: [{ type: "text", text: "Not inside a git repository." }], isError: true, details: {} };
			}

			if (params.action === "list") {
				const worktrees = (await listWorktrees(runner, repo.projectRoot)).filter((wt) => !wt.bare);
				const text = worktrees
					.map((wt) => `${wt.path}  [${wt.branch ?? (wt.detached ? "detached" : "unknown")}]`)
					.join("\n");
				return { content: [{ type: "text", text: text || "(none)" }], details: { worktrees } };
			}

			if (!params.name) {
				return { content: [{ type: "text", text: "`name` is required to create a worktree." }], isError: true, details: {} };
			}

			try {
				const slug = slugify(params.name);
				const result = await createWorktree(runner, {
					name: slug,
					branch: `${getConfig().branchPrefix}${slug}`,
					base: params.base,
					config: getConfig(),
					projectRoot: repo.projectRoot,
					sourceWorktree: repo.worktreeRoot,
					signal,
				});
				// Completion caches only. The worktree exists either way, so a failure
				// here must not turn a successful create into an error.
				try {
					await refreshKnown();
					setKnownBranches(await listBranches(runner, repo.projectRoot));
				} catch {}

				// Move the model into the new worktree, same as `/worktree new`. Without
				// a context there is no status line to update, so focus would be invisible
				// to the user — leave it alone in that case.
				const focused =
					getConfig().autoFocus && getSessionCtx() !== undefined && result.path !== repo.worktreeRoot;
				if (focused) {
					setFocus(getSessionCtx() as ExtensionContext, { path: result.path, branch: result.branch }, false);
				}

				const notes = [
					`Created worktree at ${result.path}`,
					`Branch: ${result.branch}${result.base ? ` (from ${result.base})` : ""}`,
					result.copied.length ? `Copied: ${result.copied.join(", ")}` : undefined,
					...result.warnings.map((warning) => `Warning: ${warning}`),
					result.postCreate
						? `postCreate exit ${result.postCreate.code}: ${result.postCreate.output.slice(0, 500)}`
						: undefined,
					focused
						? "You are now working in this worktree: relative paths and bash commands resolve there. " +
							"Absolute paths outside it are unchanged. The user can undo this with `/worktree focus off`."
						: "Your working directory is unchanged. Use absolute paths under the new worktree to work in it.",
				].filter(Boolean);
				return { content: [{ type: "text", text: notes.join("\n") }], details: { ...result } };
			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to create worktree: ${(error as Error).message}` }],
					isError: true,
					details: {},
				};
			}
		},
	};
}
