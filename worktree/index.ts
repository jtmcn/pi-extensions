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
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRepoInfo, listWorktrees, type RepoInfo } from "../lib/git.ts";
import { createCommands } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig, type WorktreeConfig } from "./config.ts";
import { applyFocus, type FocusTarget } from "./focus.ts";
import { resolveTarget } from "./pr.ts";
import { createPrMonitor } from "./pr-monitor.ts";
import { createWorktreeTool } from "./tool.ts";
import { createUi } from "./ui.ts";

const STATUS_KEY = "worktree";
/** Custom entry holding focus state. Entries are durable; custom messages are not. */
const FOCUS_ENTRY_TYPE = "worktree-focus";
/** Custom message announcing focus to the model. Carries no state. */
const FOCUS_MESSAGE_TYPE = "worktree-focus-note";


export default function (pi: ExtensionAPI) {
	let config: WorktreeConfig = { ...DEFAULT_CONFIG };
	let configSources: string[] = [];
	let repo: RepoInfo | undefined;
	let focus: FocusTarget | undefined;

	/**
	 * The live session context, captured at session_start.
	 *
	 * Tool `execute` gets no context, but focusing needs one (status line,
	 * notifications). A session can be replaced while this closure lives on, so
	 * this is re-assigned on every session_start and dropped on shutdown rather
	 * than captured once.
	 */
	let sessionCtx: ExtensionContext | undefined;

	// ---- PR status ---------------------------------------------------------

	/**
	 * The PR status monitor.
	 *
	 * Owns every piece of PR state. Created once per process and reset on each
	 * session_start, like the rest of this closure. It reaches git and gh through
	 * `pi` and reports back through the callbacks below; it deliberately knows
	 * nothing about focus, repo, or ctx.
	 */
	const prMonitor = createPrMonitor({
		runner: pi,
		getTarget: () => resolveTarget(focus, repo),
		getHead: () => focus?.path ?? repo?.worktreeRoot,
		// Write back to whichever object supplied the path. Focus may have moved
		// while git ran, in which case the branch belongs to a worktree nobody is
		// showing — drop it.
		setBranch: (head, branch) => {
			if (focus) {
				if (focus.path === head) focus.branch = branch;
			} else if (repo?.worktreeRoot === head) {
				repo.branch = branch;
			}
		},
		paint: () => {
			if (sessionCtx) setStatus(sessionCtx);
		},
		hasUI: () => sessionCtx?.hasUI === true,
	});

	const ui = createUi({ statusKey: STATUS_KEY, prefix: "worktree" });
	const say = ui.say;

	/**
	 * Paint the footer segment: focused worktree, PR, or both.
	 *
	 * Unfocused sessions show the PR alone — pi's own footer line already reads
	 * `<pwd> (<branch>)`, so the branch is not lost.
	 */
	const setStatus = (ctx: ExtensionContext) => {
		const parts: string[] = [];
		if (focus) {
			const label = focus.branch ? `${basename(focus.path)} (${focus.branch})` : basename(focus.path);
			parts.push(`⑂ ${label}`);
		}
		const pr = prMonitor.label();
		if (pr) parts.push(pr);
		ui.setStatus(ctx, parts);
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		// Every field below is session state. A session can be *replaced* (`/new`,
		// resume) while this closure lives on, so reset everything first — leaving
		// a stale `focus` here silently redirects a session that never asked for it.
		config = { ...DEFAULT_CONFIG };
		configSources = [];
		commands.setKnown([]);
		focus = undefined;
		repo = undefined;
		// Cancels leftover timers before dropping state: a poll that fired mid-reset
		// would run against this session's generation but the previous repo/focus.
		prMonitor.reset();

		repo = await getRepoInfo(pi, ctx.cwd);
		if (!repo) {
			setStatus(ctx);
			return;
		}

		const loaded = await loadConfig({
			projectRoot: repo.projectRoot,
			projectTrusted: ctx.isProjectTrusted(),
		});
		config = loaded.config;
		configSources = loaded.sources;
		for (const warning of loaded.warnings) say(ctx, warning, "warning");

		try {
			commands.setKnown(await listWorktrees(pi, repo.projectRoot));
		} catch {
			commands.setKnown([]);
		}

		// Restore focus from the session transcript so /reload and resume keep it.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== FOCUS_ENTRY_TYPE) continue;
			const data = entry.data as { path?: string; branch?: string } | undefined;
			focus = data?.path ? { path: data.path, branch: data.branch } : undefined;
		}

		// The worktree may have been removed by another session in the meantime.
		// Without this check every bash call becomes `cd '<gone>' || exit 1`.
		if (focus && !(await isDirectory(focus.path))) {
			say(ctx, `focused worktree ${focus.path} no longer exists; focus cleared`, "warning");
			setFocus(ctx, undefined, false);
		}
		setStatus(ctx);
		prMonitor.refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		prMonitor.stopTimers();
		sessionCtx = undefined;
		ui.clearAll(ctx);
	});

	// Reports stay up until the user does something else.
	pi.on("input", (_event, ctx) => {
		ui.clearReport(ctx);
		// Input also ends idle suspension: refresh if stale, then re-arm.
		prMonitor.onInput();
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		prMonitor.onBashCommand((event.input as { command?: unknown } | undefined)?.command);
	});

	pi.on("user_bash", (event) => {
		prMonitor.onBashCommand(event.command);
	});

	// ---- Focus mode: rewrite tool inputs -----------------------------------

	pi.on("tool_call", (event) => {
		if (!focus || !event.input || typeof event.input !== "object") return;
		// Focusing the session's own worktree is a no-op; skip the rewrite entirely.
		if (repo?.worktreeRoot === focus.path) return;
		applyFocus(event.toolName, event.input as Record<string, unknown>, focus, {
			sessionRoot: repo?.worktreeRoot,
			remapAbsolutePaths: config.remapAbsolutePaths,
		});
	});

	// ---- Command -----------------------------------------------------------

	const setFocus = (ctx: ExtensionContext, target: FocusTarget | undefined, announce = true) => {
		focus = target;
		setStatus(ctx);
		// Repaint from cache above, then reconcile the new target in background.
		prMonitor.refresh();

		// State lives in a custom *entry*: it is written to the transcript now.
		// A custom message with deliverAs "nextTurn" is only queued in memory, so
		// focus would be lost by a /reload before the next prompt.
		pi.appendEntry(FOCUS_ENTRY_TYPE, target ? { path: target.path, branch: target.branch } : {});

		if (!announce) return;

		const content = target
			? `Working directory is now the git worktree \`${target.path}\`` +
				(target.branch ? ` (branch \`${target.branch}\`).` : ".") +
				` Relative paths and bash commands resolve there. Absolute paths outside that worktree are unchanged.`
			: `Worktree focus cleared. Working directory is back to \`${repo?.worktreeRoot ?? ctx.cwd}\`.`;

		pi.sendMessage(
			{
				customType: FOCUS_MESSAGE_TYPE,
				content,
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
	};

	const requireRepo = (ctx: ExtensionContext): RepoInfo | undefined => {
		if (!repo) {
			say(ctx, "not inside a git repository", "error");
			return undefined;
		}
		return repo;
	};

	const commands = createCommands({
		runner: pi,
		ui,
		getConfig: () => config,
		getConfigSources: () => configSources,
		getFocus: () => focus,
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
			getRepo: () => repo,
			getConfig: () => config,
			getSessionCtx: () => sessionCtx,
			setFocus,
			setKnown: commands.setKnown,
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
