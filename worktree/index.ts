/**
 * Worktree extension for pi.
 *
 * Manages git worktrees and, optionally, redirects the agent's tool calls into
 * one without restarting the session.
 *
 *   /worktree                 interactive menu
 *   /worktree list            show worktrees for this repo
 *   /worktree new <name>      create a worktree (+ branch) and focus it
 *   /worktree focus <name>    redirect tool calls into a worktree
 *   /worktree focus off       stop redirecting
 *   /worktree remove <name>   remove a worktree
 *   /worktree prune           prune stale worktree metadata
 *   /worktree config          show effective configuration
 *
 * Layout aware: ordinary repos, linked worktrees, and bare layouts
 * (`proj/.bare` + `proj/main` + siblings) all resolve correctly.
 *
 * This file is wiring only. The parts it wires together:
 *
 *   session.ts     per-session state, focus, and the session's PR monitor
 *   pr-monitor.ts  the PR status state machine
 *   commands.ts    the /worktree command and its completions
 *   tool.ts        the model-facing tool
 *   ui.ts          notifications, reports, and the status segment
 *
 * The one rule to preserve here: **the extension closure outlives the session**.
 * Commands and tools are registered once per process and must always act on the
 * *current* session, which is why they receive getters rather than values.
 */

import { stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRepoInfo, listWorktrees, type RepoInfo } from "../lib/git.ts";
import { EMPTY_BRANCHES, listBranches } from "./branches.ts";
import { createCommands } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { applyFocus } from "./focus.ts";
import { createSession, FOCUS_ENTRY_TYPE, type WorktreeSession } from "./session.ts";
import { createWorktreeTool } from "./tool.ts";
import { createUi } from "./ui.ts";

const STATUS_KEY = "worktree";

export default function (pi: ExtensionAPI) {
	const ui = createUi({ statusKey: STATUS_KEY, prefix: "worktree" });
	const say = ui.say;

	/**
	 * The current session, or undefined before the first `session_start` and
	 * after shutdown.
	 *
	 * Everything below reaches session state through this one reference, so a
	 * replaced session cannot leave half its state behind.
	 */
	let session: WorktreeSession | undefined;

	/**
	 * The only place `session` is assigned.
	 *
	 * Retiring the outgoing session is not optional: its monitor may have a fetch
	 * in flight and a poll armed, and both would land on a `ctx` that pi has since
	 * made stale — which throws and takes the process down. Routing every change
	 * through here means the disposal cannot be forgotten or ordered wrongly.
	 */
	const replaceSession = (next: WorktreeSession | undefined) => {
		session?.dispose();
		session = next;
		return next;
	};

	pi.on("session_start", async (_event, ctx) => {
		replaceSession(undefined);
		commands.setKnown([]);
		commands.setKnownBranches(EMPTY_BRANCHES);

		const repo = await getRepoInfo(pi, ctx.cwd);
		if (!repo) {
			// Still a session, just not one that can do anything: the status segment
			// needs clearing either way.
			replaceSession(createSession({ pi, ui, ctx, repo: undefined }))?.paint(ctx);
			return;
		}

		const loaded = await loadConfig({
			projectRoot: repo.projectRoot,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const active = replaceSession(
			createSession({
				pi,
				ui,
				ctx,
				repo,
				config: loaded.config,
				configSources: loaded.sources,
			}),
		);
		if (!active) return;
		for (const warning of loaded.warnings) say(ctx, warning, "warning");

		try {
			commands.setKnown(await listWorktrees(pi, repo.projectRoot));
			commands.setKnownBranches(await listBranches(pi, repo.projectRoot));
		} catch {
			commands.setKnown([]);
			commands.setKnownBranches(EMPTY_BRANCHES);
		}

		// Restore focus from the session transcript so /reload and resume keep it.
		let restored: { path: string; branch?: string } | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== FOCUS_ENTRY_TYPE) continue;
			const data = entry.data as { path?: string; branch?: string } | undefined;
			restored = data?.path ? { path: data.path, branch: data.branch } : undefined;
		}
		active.restoreFocus(restored);

		// The worktree may have been removed by another session in the meantime.
		// Without this check every bash call becomes `cd '<gone>' || exit 1`.
		if (restored && !(await isDirectory(restored.path))) {
			say(ctx, `focused worktree ${restored.path} no longer exists; focus cleared`, "warning");
			active.setFocus(ctx, undefined, false);
		}
		active.paint(ctx);
		active.prMonitor.refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		replaceSession(undefined);
		ui.clearAll(ctx);
	});

	// Reports stay up until the user does something else.
	pi.on("input", (_event, ctx) => {
		ui.clearReport(ctx);
		// Input also ends idle suspension: refresh if stale, then re-arm.
		session?.prMonitor.onInput();
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		session?.prMonitor.onBashCommand((event.input as { command?: unknown } | undefined)?.command);
	});

	pi.on("user_bash", (event) => {
		session?.prMonitor.onBashCommand(event.command);
	});

	// ---- Focus mode: rewrite tool inputs -----------------------------------

	pi.on("tool_call", (event) => {
		const focus = session?.focus;
		if (!focus || !event.input || typeof event.input !== "object") return;
		// Focusing the session's own worktree is a no-op; skip the rewrite entirely.
		if (session?.repo?.worktreeRoot === focus.path) return;
		applyFocus(event.toolName, event.input as Record<string, unknown>, focus, {
			sessionRoot: session?.repo?.worktreeRoot,
			remapAbsolutePaths: session?.config.remapAbsolutePaths ?? DEFAULT_CONFIG.remapAbsolutePaths,
		});
	});

	// ---- Command -----------------------------------------------------------

	const requireRepo = (ctx: ExtensionContext): RepoInfo | undefined => {
		if (!session?.repo) {
			say(ctx, "not inside a git repository", "error");
			return undefined;
		}
		return session.repo;
	};

	/**
	 * Focus changes go through the live session.
	 *
	 * Registered handlers outlive any one session, so this cannot capture a
	 * `setFocus`; a call arriving with no session is dropped rather than throwing.
	 */
	const setFocus = (ctx: ExtensionContext, target: Parameters<WorktreeSession["setFocus"]>[1], announce = true) => {
		session?.setFocus(ctx, target, announce);
	};

	const commands = createCommands({
		runner: pi,
		ui,
		getConfig: () => session?.config ?? DEFAULT_CONFIG,
		getConfigSources: () => session?.configSources ?? [],
		getFocus: () => session?.focus,
		setFocus,
	});

	pi.registerCommand("worktree", {
		description: "Manage git worktrees and focus the agent on one",
		getArgumentCompletions: commands.getArgumentCompletions,
		handler: async (args, ctx) => {
			const info = requireRepo(ctx);
			if (!info) return;

			try {
				await commands.dispatch(info, ctx, args);
			} catch (error) {
				// listWorktrees and friends throw GitError; an unhandled rejection here
				// would surface as a crash rather than a message.
				say(ctx, (error as Error).message, "error");
			}
		},
	});

	// ---- Tool: let the model inspect and create worktrees -------------------

	pi.registerTool(
		createWorktreeTool({
			runner: pi,
			getRepo: () => session?.repo,
			getConfig: () => session?.config ?? DEFAULT_CONFIG,
			getSessionCtx: () => session?.ctx,
			setFocus,
			setKnown: commands.setKnown,
			setKnownBranches: commands.setKnownBranches,
		}),
	);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
