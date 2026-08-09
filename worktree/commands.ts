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
import { matchWorktree, parseNewArgs, tokenize } from "./select.ts";
import { messageTexts, suggestName, uniqueName } from "./suggest.ts";
import type { Ui } from "./ui.ts";
import {
	type BranchList,
	branchOptions,
	checkoutName,
	defaultRemote,
	EMPTY_BRANCHES,
	fetchRemote,
	listBranches,
	resolveBranch,
} from "./branches.ts";
import { type CommandRunner, type CreateResult, createWorktree, pruneWorktrees, removeWorktree } from "./worktrees.ts";

const SUBCOMMANDS = [
	{ value: "list", label: "list", description: "Show worktrees for this repo" },
	{ value: "new", label: "new <name>", description: "Create a worktree and branch" },
	{ value: "checkout", label: "checkout <branch>", description: "Create a worktree for an existing branch" },
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
	/** Seed the branch cache used by `checkout` completions. */
	setKnownBranches: (branches: BranchList) => void;
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

	/** Branch names for `checkout` completions; refreshed opportunistically. */
	let knownBranches: BranchList = EMPTY_BRANCHES;

	const refreshBranches = async (info: RepoInfo): Promise<BranchList> => {
		knownBranches = await listBranches(runner, info.projectRoot);
		return knownBranches;
	};

	/**
	 * Directory names that are already spoken for.
	 *
	 * Worktree directory names and currently checked-out branches, with
	 * `branchPrefix` stripped so `joel/foo` occupies `foo`. Cannot see a stray
	 * non-worktree directory or a branch checked out nowhere — those still fall
	 * back to createWorktree's error.
	 */
	const takenNames = (worktrees: Worktree[]): Set<string> => {
		const prefix = getConfig().branchPrefix;
		const taken = new Set<string>();
		for (const wt of worktrees) {
			taken.add(basename(wt.path));
			if (wt.branch) taken.add(wt.branch.startsWith(prefix) ? wt.branch.slice(prefix.length) : wt.branch);
		}
		return taken;
	};

	/**
	 * A name to offer for a new worktree, unique against what already exists.
	 *
	 * Uniqueness is applied only here, to generated names: a name the user typed
	 * must keep failing loudly in `createWorktree` rather than quietly becoming
	 * something else.
	 */
	const suggest = async (info: RepoInfo, ctx: ExtensionContext): Promise<string> => {
		const taken = takenNames(await refresh(info));
		return uniqueName(suggestName(messageTexts(ctx.sessionManager.getBranch())), (name) => taken.has(name));
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

	/** The one place a finished create is described. `extra` goes after the branch. */
	const reportCreated = (ctx: ExtensionContext, result: CreateResult, extra: string[] = []) => {
		const parts = [`created ${basename(result.path)} on ${result.branch}`, ...extra];
		if (result.copied.length) parts.push(`copied ${result.copied.join(", ")}`);
		for (const warning of result.warnings) parts.push(warning);
		if (result.postCreate && result.postCreate.code !== 0) {
			parts.push(`postCreate failed (exit ${result.postCreate.code})`);
		}
		const degraded = result.warnings.length > 0 || Boolean(result.postCreate?.code);
		say(ctx, parts.join("; "), degraded ? "warning" : "info");
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
			// A suggestion rather than an empty box: pi's `input` placeholder is never
			// rendered, so the old hint was invisible. `editor` does prefill, which
			// makes the name editable instead of merely proposed.
			const suggestion = await suggest(info, ctx);
			if (!ctx.hasUI) {
				// No prompt to fall back on. Using the suggestion beats the silent
				// no-op this path used to be.
				name = suggestion;
			} else {
				// Trim before splitting: a leading blank line is not a cancel. The split is
				// load-bearing: Shift+Enter and external editors can insert newlines.
				name = ((await ctx.ui.editor("Worktree name:", suggestion)) ?? "").trim().split("\n")[0];
				if (!name.trim()) return;
			}
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

			reportCreated(ctx, result, result.base ? [`from ${result.base}`] : []);

			if (getConfig().autoFocus) setFocus(ctx, { path: result.path, branch: result.branch });
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};

	/**
	 * `/worktree checkout <branch> [name]` — a worktree for a branch that exists.
	 *
	 * Resolution is local-first and the fetch is lazy: the network is touched
	 * only when nothing matches, so the common case costs nothing and a branch
	 * pushed a minute ago is still found. A fetch that fails is a warning; the
	 * local half of this command works offline.
	 */
	const doCheckout = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const [queryArg, explicitName, ...extra] = tokenize(args);
		if (extra.length > 0) {
			say(ctx, `unexpected extra arguments: ${extra.join(" ")} (quote names containing spaces)`, "error");
			return;
		}

		let branches = await refreshBranches(info);
		const worktrees = await refresh(info);
		const checkedOut = new Map<string, Worktree>();
		for (const wt of worktrees) if (wt.branch) checkedOut.set(wt.branch, wt);

		let query = queryArg;
		if (!query) {
			if (!ctx.hasUI) {
				say(ctx, "a branch name is required in non-interactive mode", "error");
				return;
			}
			const options = branchOptions(branches, new Set(checkedOut.keys()));
			if (options.length === 0) {
				say(ctx, "no branches found", "warning");
				return;
			}
			const labels = options.map((option) => option.label);
			const choice = await ctx.ui.select("Check out which branch?", labels);
			if (!choice) return;
			query = options[labels.indexOf(choice)].value;
		}

		let match = resolveBranch(branches, query);
		let fetchError: string | undefined;
		if (match.kind === "none") {
			const remote = defaultRemote(branches, query);
			if (remote) {
				say(ctx, `fetching ${remote} …`, "info");
				fetchError = await fetchRemote(runner, info.projectRoot, remote);
				branches = await refreshBranches(info);
				match = resolveBranch(branches, query);
			}
		}

		if (match.kind === "ambiguous") {
			say(ctx, `"${query}" matches several remotes: ${match.candidates.join(", ")}`, "error");
			return;
		}
		if (match.kind === "none") {
			say(ctx, `no branch matching "${query}"${fetchError ? ` (fetch failed: ${fetchError})` : ""}`, "error");
			return;
		}
		if (fetchError) say(ctx, `fetch failed: ${fetchError}`, "warning");

		const occupied = checkedOut.get(match.branch);
		if (occupied) {
			say(
				ctx,
				`"${match.branch}" is already checked out at ${occupied.path} — /worktree focus ${basename(occupied.path)}`,
				"error",
			);
			return;
		}

		// A derived name may be adjusted; a name the user typed must not be.
		const taken = takenNames(worktrees);
		const name = explicitName ?? uniqueName(checkoutName(match.branch, getConfig().branchPrefix), (n) => taken.has(n));
		const slug = slugify(name);
		const target = worktreePath(getConfig(), info.projectRoot, slug);

		say(ctx, `creating ${target} …`, "info");
		try {
			const result = await createWorktree(runner, {
				name: slug,
				branch: match.branch,
				track: match.kind === "remote" ? match.full : undefined,
				config: getConfig(),
				projectRoot: info.projectRoot,
				sourceWorktree: info.worktreeRoot,
			});
			await refresh(info);
			await refreshBranches(info);

			const extras: string[] = [];
			if (result.track) extras.push(`tracking ${result.track}`);
			if (match.kind === "local" && match.shadows) extras.push(`using the local branch, not ${match.shadows}`);
			reportCreated(ctx, result, extras);

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
			case "checkout":
			case "co":
				return doCheckout(info, ctx, rest);
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
		const needle = rest.join(" ");

		if (sub === "checkout" || sub === "co") {
			const values = [...knownBranches.local, ...knownBranches.remote.map((branch) => branch.full)];
			const items = values
				.filter((value) => value.startsWith(needle))
				.map((value) => ({ value: `${sub} ${value}`, label: `${sub} ${value}` }));
			return items.length ? items : null;
		}

		if (sub !== "focus" && sub !== "remove") return null;
		const names = known.filter((wt) => !wt.bare).map((wt) => basename(wt.path));
		if (sub === "focus") names.unshift("off");
		const items = names
			.filter((n) => n.startsWith(needle))
			.map((n) => ({ value: `${sub} ${n}`, label: `${sub} ${n}` }));
		return items.length ? items : null;
	};

	return {
		dispatch,
		getArgumentCompletions,
		setKnown: (worktrees) => {
			known = worktrees;
		},
		setKnownBranches: (branches) => {
			knownBranches = branches;
		},
	};
}
