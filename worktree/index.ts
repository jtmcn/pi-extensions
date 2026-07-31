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

import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	countDirty,
	describeWorktree,
	getRepoInfo,
	listWorktrees,
	type RepoInfo,
	slugify,
	type Worktree,
} from "../lib/git.ts";
import { DEFAULT_CONFIG, loadConfig, type WorktreeConfig, worktreePath } from "./config.ts";
import { applyFocus, type FocusTarget } from "./focus.ts";
import { createWorktree, pruneWorktrees, removeWorktree } from "./worktrees.ts";

const STATUS_KEY = "worktree";
const FOCUS_MESSAGE_TYPE = "worktree-focus";

const SUBCOMMANDS = [
	{ value: "list", label: "list", description: "Show worktrees for this repo" },
	{ value: "new", label: "new <name>", description: "Create a worktree and branch" },
	{ value: "focus", label: "focus <name|off>", description: "Redirect tool calls into a worktree" },
	{ value: "remove", label: "remove <name>", description: "Remove a worktree" },
	{ value: "prune", label: "prune", description: "Prune stale worktree metadata" },
	{ value: "config", label: "config", description: "Show effective configuration" },
];

export default function (pi: ExtensionAPI) {
	let config: WorktreeConfig = { ...DEFAULT_CONFIG };
	let configSources: string[] = [];
	let repo: RepoInfo | undefined;
	let focus: FocusTarget | undefined;

	/** Worktree names for autocomplete; refreshed opportunistically. */
	let knownWorktrees: Worktree[] = [];

	/**
	 * Emit a one-line message. Falls back to stdout in print mode, where
	 * `ctx.ui.notify` is a no-op and the user would otherwise see nothing.
	 */
	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) {
			ctx.ui.notify(`worktree: ${message}`, level);
			return;
		}
		if (ctx.mode === "print") {
			const stream = level === "error" ? process.stderr : process.stdout;
			stream.write(`worktree: ${message}\n`);
		}
	};

	/** True while a report widget is on screen, so the next input can clear it. */
	let widgetShown = false;

	/**
	 * Render a block of information.
	 *
	 * Uses a widget in interactive modes and stdout in print mode. The widget is
	 * cleared on the next user input rather than on a timer: a timer would fire
	 * with a captured `ctx` that is stale after session replacement or shutdown.
	 */
	const report = (ctx: ExtensionContext, title: string, lines: string[]) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget(STATUS_KEY, [title, ...lines.map((line) => `  ${line}`)]);
			widgetShown = true;
			return;
		}
		if (ctx.mode === "print") {
			process.stdout.write(`${[title, ...lines.map((line) => `  ${line}`)].join("\n")}\n`);
		}
	};

	const clearReport = (ctx: ExtensionContext) => {
		if (!widgetShown || !ctx.hasUI) return;
		ctx.ui.setWidget(STATUS_KEY, undefined);
		widgetShown = false;
	};

	const setStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!focus) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = focus.branch ? `${basename(focus.path)} (${focus.branch})` : basename(focus.path);
		ctx.ui.setStatus(STATUS_KEY, `⑂ ${label}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		repo = await getRepoInfo(pi, ctx.cwd);
		if (!repo) return;

		const loaded = await loadConfig({
			projectRoot: repo.projectRoot,
			projectTrusted: ctx.isProjectTrusted(),
		});
		config = loaded.config;
		configSources = loaded.sources;
		for (const warning of loaded.warnings) say(ctx, warning, "warning");

		try {
			knownWorktrees = await listWorktrees(pi, repo.projectRoot);
		} catch {
			knownWorktrees = [];
		}

		// Restore focus from the session transcript so /reload and resume keep it.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || entry.customType !== FOCUS_MESSAGE_TYPE) continue;
			const details = entry.details as { path?: string; branch?: string } | undefined;
			focus = details?.path ? { path: details.path, branch: details.branch } : undefined;
		}
		setStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
		widgetShown = false;
	});

	// Reports stay up until the user does something else.
	pi.on("input", (_event, ctx) => {
		clearReport(ctx);
	});

	// ---- Focus mode: rewrite tool inputs -----------------------------------

	pi.on("tool_call", (event) => {
		if (!focus) return;
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
				details: target ? { path: target.path, branch: target.branch } : {},
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

	const refresh = async (info: RepoInfo): Promise<Worktree[]> => {
		knownWorktrees = (await listWorktrees(pi, info.projectRoot)).filter((wt) => !wt.bare);
		return knownWorktrees;
	};

	const resolveWorktree = async (
		info: RepoInfo,
		ctx: ExtensionCommandContext,
		query: string,
		prompt: string,
	): Promise<Worktree | undefined> => {
		const worktrees = await refresh(info);
		if (worktrees.length === 0) {
			say(ctx, "no worktrees found", "warning");
			return undefined;
		}
		if (query) {
			const needle = query.trim();
			const match =
				worktrees.find((wt) => wt.path === needle) ??
				worktrees.find((wt) => basename(wt.path) === needle) ??
				worktrees.find((wt) => wt.branch === needle) ??
				worktrees.find((wt) => basename(wt.path).startsWith(needle));
			if (!match) {
				say(ctx, `no worktree matching "${needle}"`, "error");
				return undefined;
			}
			return match;
		}
		if (!ctx.hasUI) return undefined;
		const labels = worktrees.map(describeWorktree);
		const choice = await ctx.ui.select(prompt, labels);
		if (!choice) return undefined;
		return worktrees[labels.indexOf(choice)];
	};

	const showList = async (info: RepoInfo, ctx: ExtensionContext) => {
		const worktrees = await refresh(info);
		const lines: string[] = [];
		for (const wt of worktrees) {
			const dirty = await countDirty(pi, wt.path);
			const marks = [
				wt.path === repo?.worktreeRoot ? "session" : undefined,
				focus && wt.path === focus.path ? "focused" : undefined,
				dirty > 0 ? `${dirty} dirty` : undefined,
			].filter(Boolean);
			lines.push(`${describeWorktree(wt)}${marks.length ? `  — ${marks.join(", ")}` : ""}`);
		}
		if (lines.length === 0) lines.push("(none)");
		report(ctx, `Worktrees in ${info.projectRoot}:`, lines);
	};

	const doNew = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const [rawName, rawBase] = args.split(/\s+/).filter(Boolean);
		let name = rawName;
		if (!name) {
			if (!ctx.hasUI) return;
			name = (await ctx.ui.input("Worktree name:", "feature-name")) ?? "";
			if (!name.trim()) return;
		}
		const slug = slugify(name);
		const branch = `${config.branchPrefix}${slug}`;
		const target = worktreePath(config, info.projectRoot, slug);

		say(ctx, `creating ${target} …`, "info");
		try {
			const result = await createWorktree(pi, {
				name: slug,
				branch,
				base: rawBase,
				config,
				projectRoot: info.projectRoot,
				sourceWorktree: info.worktreeRoot,
			});
			await refresh(info);

			const parts = [`created ${basename(result.path)} on ${result.branch}`];
			if (result.base) parts.push(`from ${result.base}`);
			if (result.copied.length) parts.push(`copied ${result.copied.join(", ")}`);
			if (result.postCreate && result.postCreate.code !== 0) {
				parts.push(`postCreate failed (exit ${result.postCreate.code})`);
			}
			say(ctx, parts.join("; "), result.postCreate?.code ? "warning" : "info");

			if (config.autoFocus) setFocus(ctx, { path: result.path, branch: result.branch });
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};

	const doFocus = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const query = args.trim();
		if (query === "off" || query === "none" || query === "clear") {
			setFocus(ctx, undefined);
			say(ctx, "focus cleared", "info");
			return;
		}
		const target = await resolveWorktree(info, ctx, query, "Focus which worktree?");
		if (!target) return;
		if (target.path === info.worktreeRoot) {
			setFocus(ctx, undefined);
			say(ctx, "focus cleared (that is the session worktree)", "info");
			return;
		}
		setFocus(ctx, { path: target.path, branch: target.branch });
		say(ctx, `focused ${describeWorktree(target)}`, "info");
	};

	const doRemove = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const target = await resolveWorktree(info, ctx, args.trim(), "Remove which worktree?");
		if (!target) return;
		if (target.path === info.worktreeRoot) {
			say(ctx, "refusing to remove the session's own worktree", "error");
			return;
		}

		const dirty = await countDirty(pi, target.path);
		if (ctx.hasUI) {
			const message = dirty > 0 ? `${dirty} uncommitted file(s) will be lost.` : "This cannot be undone.";
			const ok = await ctx.ui.confirm(`Remove ${describeWorktree(target)}?`, message);
			if (!ok) return;
		} else if (dirty > 0) {
			say(ctx, "refusing to remove a dirty worktree without confirmation", "error");
			return;
		}

		let deleteBranch = false;
		if (ctx.hasUI && target.branch) {
			deleteBranch = await ctx.ui.confirm(`Also delete branch "${target.branch}"?`, "Only if fully merged.");
		}

		try {
			await removeWorktree(pi, { worktree: target, projectRoot: info.projectRoot, force: dirty > 0, deleteBranch });
			if (focus?.path === target.path) setFocus(ctx, undefined);
			await refresh(info);
			say(ctx, `removed ${basename(target.path)}`, "info");
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};

	const doConfig = (info: RepoInfo, ctx: ExtensionContext) => {
		const lines = [
			`project root:   ${info.projectRoot}`,
			`session wt:     ${info.worktreeRoot ?? "(none)"}`,
			`focused:        ${focus ? focus.path : "(none)"}`,
			`new worktrees:  ${worktreePath(config, info.projectRoot, "<name>")}`,
			`branch prefix:  ${config.branchPrefix || "(none)"}`,
			`copy files:     ${config.copyFiles.join(", ") || "(none)"}`,
			`post create:    ${config.postCreate ?? "(none)"}`,
			`auto focus:     ${config.autoFocus}`,
			`remap abs:      ${config.remapAbsolutePaths}`,
			`config files:   ${configSources.join(", ") || "(defaults only)"}`,
		];
		report(ctx, "worktree config", lines);
	};

	pi.registerCommand("worktree", {
		description: "Manage git worktrees and focus the agent on one",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.value.startsWith(parts[0] ?? ""));
				return items.length ? items : null;
			}
			const [sub, ...rest] = parts;
			if (sub !== "focus" && sub !== "remove") return null;
			const needle = rest.join(" ");
			const names = knownWorktrees.filter((wt) => !wt.bare).map((wt) => basename(wt.path));
			if (sub === "focus") names.unshift("off");
			const items = names
				.filter((n) => n.startsWith(needle))
				.map((n) => ({ value: `${sub} ${n}`, label: `${sub} ${n}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const info = requireRepo(ctx);
			if (!info) return;

			const trimmed = args.trim();
			const spaceAt = trimmed.indexOf(" ");
			let sub = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
			const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();

			if (!sub) {
				if (!ctx.hasUI) {
					await showList(info, ctx);
					return;
				}
				const labels = SUBCOMMANDS.map((s) => s.label);
				const choice = await ctx.ui.select("Worktree:", labels);
				if (!choice) return;
				sub = SUBCOMMANDS[labels.indexOf(choice)].value;
			}

			switch (sub) {
				case "list":
					await showList(info, ctx);
					return;
				case "new":
				case "add":
					await doNew(info, ctx, rest);
					return;
				case "focus":
				case "switch":
					await doFocus(info, ctx, rest);
					return;
				case "remove":
				case "rm":
					await doRemove(info, ctx, rest);
					return;
				case "prune":
					try {
						const out = await pruneWorktrees(pi, info.projectRoot);
						await refresh(info);
						say(ctx, out || "nothing to prune", "info");
					} catch (error) {
						say(ctx, (error as Error).message, "error");
					}
					return;
				case "config":
					doConfig(info, ctx);
					return;
				default:
					say(ctx, `unknown subcommand "${sub}"`, "error");
			}
		},
	});

	// ---- Tool: let the model inspect and create worktrees -------------------

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"List or create git worktrees for the current repository. Use this to run an experiment " +
			"on a separate branch without disturbing the user's working tree. Creating a worktree does " +
			"not change your working directory; the returned path must be used explicitly.",
		promptSnippet: "List or create git worktrees for isolated parallel work",
		parameters: Type.Object({
			action: StringEnum(["list", "create"] as const, {
				description: "list existing worktrees, or create a new one",
			}),
			name: Type.Optional(Type.String({ description: "Directory name for the new worktree (create only)" })),
			base: Type.Optional(Type.String({ description: "Start point for the new branch (create only)" })),
		}),
		async execute(
			_toolCallId,
			params,
			signal,
		): Promise<{
			content: { type: "text"; text: string }[];
			isError?: boolean;
			details: Record<string, unknown>;
		}> {
			if (!repo) {
				return { content: [{ type: "text", text: "Not inside a git repository." }], isError: true, details: {} };
			}

			if (params.action === "list") {
				const worktrees = await listWorktrees(pi, repo.projectRoot);
				const text = worktrees.map((wt) => `${wt.path}  ${describeWorktree(wt)}`).join("\n");
				return { content: [{ type: "text", text: text || "(none)" }], details: { worktrees } };
			}

			if (!params.name) {
				return { content: [{ type: "text", text: "`name` is required to create a worktree." }], isError: true, details: {} };
			}

			try {
				const slug = slugify(params.name);
				const result = await createWorktree(pi, {
					name: slug,
					branch: `${config.branchPrefix}${slug}`,
					base: params.base,
					config,
					projectRoot: repo.projectRoot,
					sourceWorktree: repo.worktreeRoot,
					signal,
				});
				knownWorktrees = await listWorktrees(pi, repo.projectRoot);
				const notes = [
					`Created worktree at ${result.path}`,
					`Branch: ${result.branch}${result.base ? ` (from ${result.base})` : ""}`,
					result.copied.length ? `Copied: ${result.copied.join(", ")}` : undefined,
					result.postCreate
						? `postCreate exit ${result.postCreate.code}: ${result.postCreate.output.slice(0, 500)}`
						: undefined,
					"Your working directory is unchanged. Use absolute paths under the new worktree to work in it.",
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
	});
}
