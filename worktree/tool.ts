/**
 * The `worktree` tool: what the model is allowed to do.
 *
 * Deliberately the safe half of the feature. Listing and creating a worktree are
 * additive and reversible, so they are exposed here; focusing, removing, and
 * pruning change the user's environment and stay behind the slash command.
 *
 * The last door to move onto jimothy's registry (`commands.ts`'s `new` and
 * `checkout` went first): `list` now renders through `describeKnown`, the same
 * renderer `/worktree list` uses, and `create` calls `createAndProvision` —
 * the registry, then jimothy's own provisioning (`link`/`copy`/install) —
 * instead of this extension's own `createWorktree`. A worktree made through
 * either door now has the same identity, the same links and copies, and the
 * same install.
 *
 * Creating one *does* focus the session when configured to, which is a visible
 * change — hence the explicit note in the result, and the refusal to focus when
 * there is no session context to paint a status line with, where the user would
 * have no way of knowing. Focus moves through `moveFocus`, the same transition
 * every other door uses, which can now refuse a destination held by a live
 * stranger — a tool call has no UI to prompt with, so a refusal is reported as
 * what it is rather than claimed as a success.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveDefaultBranch } from "jimothy/worktrees";
import { Type } from "typebox";
import type { GitRunner } from "../lib/git.ts";
import { type BranchList, listBranches } from "./branches.ts";
import { createAndProvision, MODEL_UNAVAILABLE } from "./commands.ts";
import type { WorktreeConfig } from "./config.ts";
import type { FocusTarget } from "./focus.ts";
import type { Model } from "./jimothy.ts";
import { describeKnown, type KnownWorktree } from "./known.ts";

export interface ToolDeps {
	/** Reaches git, for the branch cache refreshed after a create. */
	runner: GitRunner;
	/**
	 * The current session's jimothy model, or undefined when it could not be
	 * opened. A getter, like every other door's, because this tool is registered
	 * once per process and must act on the *current* session.
	 */
	getModel: () => Model | undefined;
	getConfig: () => WorktreeConfig;
	/** The live session context, or undefined outside a session. */
	getSessionCtx: () => ExtensionContext | undefined;
	/**
	 * Move focus, carrying the worktree lease with it — the same transition
	 * `/worktree focus` and `new` go through. `false` means the destination could
	 * not be held and focus is unchanged; the tool must not tell the model it is
	 * working somewhere it was refused.
	 */
	moveFocus: (
		ctx: ExtensionContext,
		next: FocusTarget | undefined,
		opts?: { announce?: boolean },
	) => Promise<boolean>;
	/**
	 * Keep the slash command's completion cache in step after a create. The
	 * reconciling read, not the lock-free one: a snapshot cannot see the
	 * worktree this call just made until `list()` has reconciled it in.
	 */
	refreshKnown: () => Promise<KnownWorktree[]>;
	/** Same, for the branch cache `checkout` completes from. */
	setKnownBranches: (branches: BranchList) => void;
}

export function createWorktreeTool(deps: ToolDeps) {
	const { runner, getModel, getConfig, getSessionCtx, moveFocus, refreshKnown, setKnownBranches } = deps;

	return {
		name: "worktree",
		label: "Worktree",
		description:
			"List or create git worktrees for the current repository. Use this to run an experiment " +
			"on a separate branch without disturbing the user's working tree. Unless auto-focus is " +
			"disabled, creating a worktree moves you into it: relative paths and bash commands then " +
			"resolve there. The tool result says which happened, including when focus could not move " +
			"because the worktree is in use elsewhere. Creating one runs the project's configured " +
			"setup (links, copies, and a package install where a lockfile is present).",
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
			const model = getModel();
			if (!model) {
				return { content: [{ type: "text", text: MODEL_UNAVAILABLE }], isError: true, details: {} };
			}

			if (params.action === "list") {
				// `describeKnown` is what `/worktree list` renders, so the model and the
				// user read the same spelling of the same worktree — including the
				// `unmanaged` label, which is the model's only cue that `/worktree
				// adopt` exists.
				const worktrees = await refreshKnown();
				const text = worktrees.map((wt) => describeKnown(wt)).join("\n");
				return { content: [{ type: "text", text: text || "(none)" }], details: { worktrees } };
			}

			// Checked before any work starts, not threaded into the registry call:
			// the model can cancel a call it already regrets, but a create in flight
			// keeps running to a real, reportable result — the `Deps` this model was
			// opened with already carries the *session's* abort signal for that.
			// Wiring this per-call one into `create` too is a change to `openModel`,
			// not to this file.
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "cancelled" }], isError: true, details: {} };
			}

			try {
				const base =
					params.base ?? model.config.defaultBase ?? (await resolveDefaultBranch(model.deps, model.info.mainWorktree));
				// A seed, not a requirement: `suggestName` generates one when the model
				// gives none, the same as `/worktree new` does from an empty prompt.
				const name = await model.registry.suggestName(params.name);
				// No `report` sink: the tool's output is the model's own narration, and
				// a provisioning line printed into the transcript mid-call is noise it
				// cannot act on. The warnings below still reach it, in the result text.
				const { record, provision: result } = await createAndProvision(model, () => {}, name, { base });

				// Completion caches only. The worktree exists either way, so a failure
				// here must not turn a successful create into an error.
				try {
					await refreshKnown();
					setKnownBranches(await listBranches(runner, model.info.mainWorktree));
				} catch {
					// best-effort: the caches are refilled by the next command that lists.
				}

				// Silently, and only with a context: the tool runs mid-execution, so an
				// announcement would interrupt the model's own account of what it did.
				const ctx = getSessionCtx();
				const attemptedFocus = getConfig().autoFocus && ctx !== undefined;
				const focused = attemptedFocus
					? await moveFocus(ctx as ExtensionContext, { path: record.path, branch: record.branch }, { announce: false })
					: false;

				const provisionNotes =
					"failed" in result
						? [`Provisioning failed: ${result.failed.message}`]
						: result.warnings.map((warning) => `Warning: ${warning}`);
				const notes = [
					`Created worktree at ${record.path}`,
					`Branch: ${record.branch} (from ${base})`,
					...provisionNotes,
					focused
						? "You are now working in this worktree: relative paths and bash commands resolve there. " +
							"Absolute paths outside it are unchanged. The user can undo this with `/worktree focus off`."
						: attemptedFocus
							// `moveFocus` has already said why to the user; the tool must not
							// claim the model moved somewhere it was refused.
							? "Could not focus the new worktree — it is in use elsewhere. Your working directory is unchanged."
							: "Your working directory is unchanged. Use absolute paths under the new worktree to work in it.",
				];
				return { content: [{ type: "text", text: notes.join("\n") }], details: { record } };
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
