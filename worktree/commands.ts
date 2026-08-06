/**
 * The `/worktree` slash command.
 *
 * Split out of index.ts, which had grown to hold this alongside the PR monitor
 * and the tool. Everything here is user-facing and interactive-aware: each
 * handler must work when `ctx.hasUI` is false, where there is no prompt to fall
 * back on, so a missing argument is an error rather than a question.
 *
 * State lives in the caller: this module reads config and focus through getters
 * and changes focus through `setFocus`, so there is one owner of session state
 * rather than two copies to keep in step.
 */

import { basename } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countDirty, describeWorktree, listWorktrees, type RepoInfo, slugify, type Worktree } from "../lib/git.ts";
import { type WorktreeConfig, worktreePath } from "./config.ts";
import type { FocusTarget } from "./focus.ts";
import { matchWorktree, parseNewArgs } from "./select.ts";
import type { Ui } from "./ui.ts";
import { type CommandRunner, createWorktree, pruneWorktrees, removeWorktree } from "./worktrees.ts";

const SUBCOMMANDS = [
	{ value: "list", label: "list", description: "Show worktrees for this repo" },
	{ value: "new", label: "new <name>", description: "Create a worktree and branch" },
	{ value: "focus", label: "focus <name|off>", description: "Redirect tool calls into a worktree" },
	{ value: "remove", label: "remove <name>", description: "Remove a worktree" },
	{ value: "prune", label: "prune", description: "Prune stale worktree metadata" },
	{ value: "config", label: "config", description: "Show effective configuration" },
];

export interface CommandDeps {
	/** Reaches git. `pi` in production. */
	runner: CommandRunner;
	ui: Ui;
	getConfig: () => WorktreeConfig;
	/** Config files that were applied, for `/worktree config`. */
	getConfigSources: () => string[];
	getFocus: () => FocusTarget | undefined;
	setFocus: (ctx: ExtensionContext, target: FocusTarget | undefined, announce?: boolean) => void;
}

export interface Commands {
	dispatch: (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => Promise<void>;
	/** Completions for the command's arguments; null when there is nothing to offer. */
	getArgumentCompletions: (prefix: string) => { value: string; label: string }[] | null;
	/** Seed the name cache used by completions. */
	setKnown: (worktrees: Worktree[]) => void;
}

export function createCommands(deps: CommandDeps): Commands {
	const { runner, ui, getConfig, getConfigSources, getFocus, setFocus } = deps;
	const say = ui.say;
	const report = ui.report;

	/** Worktree names for autocomplete; refreshed opportunistically. */
	let known: Worktree[] = [];

const refresh = async (info: RepoInfo): Promise<Worktree[]> => {
	known = (await listWorktrees(runner, info.projectRoot)).filter((wt) => !wt.bare);
	return known;
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
		// Non-interactive callers get no confirmation prompt, so a fuzzy match
		// could silently act on the wrong worktree.
		const match = matchWorktree(worktrees, needle, { exactOnly: !ctx.hasUI });
		if (match.kind === "one") return match.worktree;
		if (match.kind === "many") {
			const names = match.worktrees.map((wt) => basename(wt.path)).join(", ");
			say(ctx, `"${needle}" is ambiguous: ${names}`, "error");
			return undefined;
		}
		say(ctx, `no worktree matching "${needle}"`, "error");
		return undefined;
	}
	if (!ctx.hasUI) {
		say(ctx, "a worktree name is required in non-interactive mode", "error");
		return undefined;
	}
	const labels = worktrees.map(describeWorktree);
	const choice = await ctx.ui.select(prompt, labels);
	if (!choice) return undefined;
	return worktrees[labels.indexOf(choice)];
};

const showList = async (info: RepoInfo, ctx: ExtensionContext) => {
	const worktrees = await refresh(info);
	const dirtyCounts = await Promise.all(worktrees.map((wt) => countDirty(runner, wt.path)));
	const lines = worktrees.map((wt, index) => {
		const dirty = dirtyCounts[index];
		const marks = [
			wt.path === info.worktreeRoot ? "session" : undefined,
			getFocus() && wt.path === getFocus()?.path ? "focused" : undefined,
			dirty > 0 ? `${dirty} dirty` : undefined,
		].filter(Boolean);
		return `${describeWorktree(wt)}${marks.length ? `  — ${marks.join(", ")}` : ""}`;
	});
	if (lines.length === 0) lines.push("(none)");
	report(ctx, `Worktrees in ${info.projectRoot}:`, lines);
};

const doNew = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
	const parsed = parseNewArgs(args);
	if (parsed.extra.length > 0) {
		say(ctx, `unexpected extra arguments: ${parsed.extra.join(" ")} (quote names containing spaces)`, "error");
		return;
	}
	const rawBase = parsed.base;
	let name = parsed.name;
	if (!name) {
		if (!ctx.hasUI) return;
		name = (await ctx.ui.input("Worktree name:", "feature-name")) ?? "";
		if (!name.trim()) return;
	}
	const slug = slugify(name);
	const branch = `${getConfig().branchPrefix}${slug}`;
	const target = worktreePath(getConfig(), info.projectRoot, slug);

	say(ctx, `creating ${target} …`, "info");
	try {
		const result = await createWorktree(runner, {
			name: slug,
			branch,
			base: rawBase,
			config: getConfig(),
			projectRoot: info.projectRoot,
			sourceWorktree: info.worktreeRoot,
		});
		await refresh(info);

		const parts = [`created ${basename(result.path)} on ${result.branch}`];
		if (result.base) parts.push(`from ${result.base}`);
		if (result.copied.length) parts.push(`copied ${result.copied.join(", ")}`);
		for (const warning of result.warnings) parts.push(warning);
		if (result.postCreate && result.postCreate.code !== 0) {
			parts.push(`postCreate failed (exit ${result.postCreate.code})`);
		}
		const degraded = result.warnings.length > 0 || Boolean(result.postCreate?.code);
		say(ctx, parts.join("; "), degraded ? "warning" : "info");

		if (getConfig().autoFocus) setFocus(ctx, { path: result.path, branch: result.branch });
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

	const dirty = await countDirty(runner, target.path);
	if (ctx.hasUI) {
		const message = dirty > 0 ? `${dirty} uncommitted file(s) will be lost.` : "This cannot be undone.";
		const ok = await ctx.ui.confirm(`Remove ${describeWorktree(target)}?`, message);
		if (!ok) return;
	} else if (dirty > 0) {
		say(ctx, "refusing to remove a dirty worktree without confirmation", "error");
		return;
	}

	// Branch deletion is a separate decision from worktree dirtiness: `-d`
	// refuses to drop unmerged commits, and that refusal is the point.
	let deleteBranch = false;
	if (ctx.hasUI && target.branch) {
		deleteBranch = await ctx.ui.confirm(
			`Also delete branch "${target.branch}"?`,
			"Kept if it is not fully merged.",
		);
	}

	try {
		await removeWorktree(runner, {
			worktree: target,
			projectRoot: info.projectRoot,
			force: dirty > 0,
			deleteBranch,
			forceDeleteBranch: false,
		});
		if (getFocus()?.path === target.path) setFocus(ctx, undefined);
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
		`focused:        ${getFocus()?.path ?? "(none)"}`,
		`new worktrees:  ${worktreePath(getConfig(), info.projectRoot, "<name>")}`,
		`branch prefix:  ${getConfig().branchPrefix || "(none)"}`,
		`copy files:     ${getConfig().copyFiles.join(", ") || "(none)"}`,
		`post create:    ${getConfig().postCreate ?? "(none)"}`,
		`auto focus:     ${getConfig().autoFocus}`,
		`remap abs:      ${getConfig().remapAbsolutePaths}`,
		`config files:   ${getConfigSources().join(", ") || "(defaults only)"}`,
	];
	report(ctx, "worktree config", lines);
};

const dispatch = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
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
			return showList(info, ctx);
		case "new":
		case "add":
			return doNew(info, ctx, rest);
		case "focus":
		case "switch":
			return doFocus(info, ctx, rest);
		case "remove":
		case "rm":
			return doRemove(info, ctx, rest);
		case "prune": {
			const out = await pruneWorktrees(runner, info.projectRoot);
			await refresh(info);
			say(ctx, out || "nothing to prune", "info");
			return;
		}
		case "config":
			return doConfig(info, ctx);
		default:
			say(ctx, `unknown subcommand "${sub}"`, "error");
	}
};

	/**
	 * Complete subcommands, then worktree names for the two that take one.
	 *
	 * Uses the cached list rather than shelling out: completions run on every
	 * keystroke.
	 */
	const getArgumentCompletions = (prefix: string) => {
		const parts = prefix.split(/\s+/);
		if (parts.length <= 1) {
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(parts[0] ?? ""));
			return items.length ? items : null;
		}
		const [sub, ...rest] = parts;
		if (sub !== "focus" && sub !== "remove") return null;
		const needle = rest.join(" ");
		const names = known.filter((wt) => !wt.bare).map((wt) => basename(wt.path));
		if (sub === "focus") names.unshift("off");
		const items = names
			.filter((n) => n.startsWith(needle))
			.map((n) => ({ value: `${sub} ${n}`, label: `${sub} ${n}` }));
		return items.length ? items : null;
	};

	return { dispatch, getArgumentCompletions, setKnown: (worktrees) => { known = worktrees; } };
}
