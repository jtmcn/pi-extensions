/**
 * The `/worktree` slash command.
 *
 * Split out of index.ts, which had grown to hold this alongside the PR monitor
 * and the tool. Everything here is user-facing and interactive-aware: each
 * handler must work when `ctx.hasUI` is false, where there is no prompt to fall
 * back on, so a missing argument is an error rather than a question.
 *
 * State lives in the caller: this module reads config and focus through getters
 * and changes focus through `moveFocus`, which carries the worktree lease with
 * it, so there is one owner of session state rather than two copies to keep in
 * step — and one path that can move where the agent writes.
 */

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CreateOptions,
	provision,
	type ProvisionResult,
	resolveDefaultBranch,
	type WorktreeRecord,
} from "jimothy/worktrees";
import { countDirty, getRepoInfo, type GitRunner, type RepoInfo } from "../lib/git.ts";
import type { WorktreeConfig } from "./config.ts";
import type { FocusTarget } from "./focus.ts";
import type { Model } from "./jimothy.ts";
import { describeKnown, type KnownWorktree, toKnown } from "./known.ts";
import { matchWorktree, parseNewArgs, tokenize } from "./select.ts";
import type { HeldLease, WorktreeSession } from "./session.ts";
import { messageTexts, suggestName } from "./suggest.ts";
import { LEASE_LABEL } from "./take-lease.ts";
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
import { pruneWorktrees } from "./worktrees.ts";

/**
 * Said when the session has no model.
 *
 * Every command that names a worktree resolves it through the registry, so
 * without one the honest answer is "cannot look", not "none found" — the
 * difference matters most on `remove`, where the second reading invites the user
 * to create a duplicate of something that is still there.
 */
export const MODEL_UNAVAILABLE = "jimothy's worktree model is unavailable, so worktrees cannot be listed";

/** Is there still a directory there? */
const exists = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Create a worktree and make it usable, which is two operations the user thinks
 * of as one. Shared by `/worktree new`, `/worktree checkout` and the model's
 * tool, so a worktree made through any door has the same links, copies and
 * install as one jimothy made — the alternative is doors that agree about
 * identity and differ about everything the user actually notices.
 *
 * `create`'s failure is left to propagate: nothing exists yet, so the caller
 * has nothing to add beyond the message. `provision`'s failure is different —
 * it leaves a real worktree the user can still use, a failed install is
 * retryable and the checkout is their work — so it is caught here and handed
 * back alongside the record rather than thrown, which is what lets the caller
 * say *what was created* and *that provisioning failed* instead of losing the
 * first fact to whichever `catch` happens to run.
 *
 * `report` is a line sink, not a UI: an install is the one step here that can
 * take minutes, and a caller that only speaks when it finishes looks hung.
 */
export async function createAndProvision(
	model: Model,
	report: (message: string) => void,
	name: string,
	opts: CreateOptions,
): Promise<{ record: WorktreeRecord; provision: ProvisionResult | { failed: Error } }> {
	const record = await model.registry.create(name, opts);
	try {
		const result = await provision(model.deps, {
			record,
			repoRoot: model.info.mainWorktree,
			config: model.config,
			report,
		});
		return { record, provision: result };
	} catch (error) {
		return { record, provision: { failed: error as Error } };
	}
}

const SUBCOMMANDS = [
	{ value: "list", label: "list", description: "Show worktrees for this repo" },
	{ value: "new", label: "new <name>", description: "Create a worktree and branch" },
	{ value: "checkout", label: "checkout <branch>", description: "Create a worktree for an existing branch" },
	{ value: "focus", label: "focus <name|off>", description: "Redirect tool calls into a worktree" },
	{ value: "remove", label: "remove <name>", description: "Remove a worktree" },
	{ value: "adopt", label: "adopt [path]", description: "Take an existing worktree into the registry" },
	{ value: "prune", label: "prune", description: "Prune stale worktree metadata" },
	{ value: "config", label: "config", description: "Show effective configuration" },
];

export interface CommandDeps {
	/** Reaches git. `pi` in production. */
	runner: GitRunner;
	ui: Ui;
	/**
	 * The current session's jimothy model, or undefined when it could not be
	 * opened. A getter, not a value: these commands are registered once per
	 * process and must act on the *current* session.
	 */
	getModel: () => Model | undefined;
	/**
	 * The current session, or undefined outside one. A getter for the same reason
	 * `getModel` is.
	 *
	 * Only `remove` needs it, and only for the leases: a worktree this session
	 * holds has to be handed back before it can be removed, and the session is what
	 * knows which those are.
	 */
	getSession: () => WorktreeSession | undefined;
	getConfig: () => WorktreeConfig;
	/** Config files that were applied, for `/worktree config`. */
	getConfigSources: () => string[];
	getFocus: () => FocusTarget | undefined;
	/**
	 * Move focus, carrying the worktree lease with it: acquire the destination,
	 * move, release the origin when the agent settles. `false` means the
	 * destination could not be held and focus is unchanged — the refusal has
	 * already been reported, so a caller reports its own success and nothing else.
	 *
	 * Bound by `index.ts` to the live session, like the getters above, because
	 * these commands are registered once per process.
	 */
	moveFocus: (ctx: ExtensionContext, next: FocusTarget | undefined, opts?: { announce?: boolean }) => Promise<boolean>;
	/**
	 * Take the worktree lease on one path, for a session that is already writing
	 * there. Bound by `index.ts` to the same lease machinery a transition uses.
	 *
	 * Only `adopt` needs it, and needs it because adoption is the one door that can
	 * make the worktree the agent is *currently* writing in leasable for the first
	 * time: before it there is no record to hold, after it there is a record nothing
	 * holds — managed, unleased, being written to, and offered to the next session
	 * with no prompt. Not `moveFocus`, because focus is not moving.
	 */
	takeLease: (ctx: ExtensionContext, path: string) => Promise<boolean>;
}

export interface Commands {
	dispatch: (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => Promise<void>;
	/** Completions for the command's arguments; null when there is nothing to offer. */
	getArgumentCompletions: (prefix: string) => { value: string; label: string }[] | null;
	/** Seed the name cache used by completions. */
	setKnown: (worktrees: KnownWorktree[]) => void;
	/**
	 * Seed the completion cache from the lock-free snapshot. For `session_start`
	 * and anything else that must not take the registry lock.
	 */
	refreshCached: () => Promise<KnownWorktree[]>;
	/**
	 * Seed the completion cache from the reconciling read. For a caller — the
	 * model-facing tool, after a create — that just changed what git reports and
	 * needs the cache to see it, including an unmanaged worktree `refreshCached`
	 * cannot.
	 */
	refreshKnown: () => Promise<KnownWorktree[]>;
	/** Seed the branch cache used by `checkout` completions. */
	setKnownBranches: (branches: BranchList) => void;
}

export function createCommands(deps: CommandDeps): Commands {
	const { runner, ui, getModel, getSession, getConfig, getConfigSources, getFocus, moveFocus, takeLease } = deps;
	const say = ui.say;
	const report = ui.report;

	/** Worktree names for autocomplete; refreshed opportunistically. */
	let known: KnownWorktree[] = [];

	/**
	 * The repository's main working tree, which the model's listing leaves out.
	 *
	 * jimothy omits it because nothing jimothy *does* applies to it: it cannot be
	 * provisioned, leased, adopted or removed. This extension has always listed it
	 * and `/worktree focus <main>` has always resolved it, so it is put back here —
	 * from the model's own repository info, so worktree identity still has exactly
	 * one source and no second git listing is parsed. `managed: false` is the
	 * truth, and the listing labels it so.
	 *
	 * Its branch is the one read-only question jimothy has no opinion about — what
	 * is checked out at a path — which is `lib/git.ts`'s job. A main checkout that
	 * cannot be read degrades to no branch rather than failing the whole listing.
	 */
	const mainWorktree = async (model: Model): Promise<KnownWorktree> => {
		const path = model.info.mainWorktree;
		const branch = await getRepoInfo(runner, path)
			.then((info) => info?.branch)
			.catch(() => undefined);
		return { name: basename(path), path, ...(branch === undefined ? {} : { branch }), managed: false };
	};

	/** The reconciling read, for commands that must be exact. */
	const refresh = async (): Promise<KnownWorktree[]> => {
		const model = getModel();
		if (!model) return [];
		const worktrees = toKnown(await model.registry.list(), model.deps);
		// Deduped by path rather than assumed absent: the model decides what its
		// listing contains, and a repository could yet be one it manages.
		if (!worktrees.some((wt) => wt.path === model.info.mainWorktree)) {
			worktrees.unshift(await mainWorktree(model));
		}
		known = worktrees;
		return known;
	};

	/**
	 * Seed the completion cache without reconciling.
	 *
	 * `list()` takes the registry lock and rewrites `registry.json` on every call,
	 * which is right for a command that must be exact and wrong for a cache that
	 * refills on every keystroke. `snapshot()` costs neither: it may name a
	 * worktree git has since dropped, but offering it as a completion costs only a
	 * failed command with a clear message, and the next reconciling call (the
	 * first `showList`, `focus` or `remove`) corrects the cache.
	 *
	 * What it cannot offer: unmanaged worktrees, which only `list()` discovers by
	 * asking git, and (for the same reason) the repository's main working tree
	 * that `refresh()` puts back — both trades accepted for a lock-free keystroke.
	 */
	const refreshCached = async (): Promise<KnownWorktree[]> => {
		const model = getModel();
		if (!model) return [];
		const snapshot = await model.registry.snapshot();
		known = toKnown({ managed: snapshot.managed, unmanaged: [] }, model.deps);
		return known;
	};

	/** Branch names for `checkout` completions; refreshed opportunistically. */
	let knownBranches: BranchList = EMPTY_BRANCHES;

	const refreshBranches = async (info: RepoInfo): Promise<BranchList> => {
		knownBranches = await listBranches(runner, info.projectRoot);
		return knownBranches;
	};

	/**
	 * A *seed* for a new worktree's name, read out of the conversation.
	 *
	 * Only half the job, and deliberately: turning a seed into a name that is
	 * legal and free is `registry.suggestName`, because only the registry knows
	 * what is taken — by a record, by a worktree git reports, or by a branch (the
	 * extension used to track this itself, stripping its own `branchPrefix` and
	 * seeing only worktrees and branches a door here had made). This half stays
	 * here because only pi has a transcript.
	 */
	const seedFromTranscript = (ctx: ExtensionContext): string =>
		suggestName(messageTexts(ctx.sessionManager.getBranch()));

	const resolveWorktree = async (
		ctx: ExtensionCommandContext,
		query: string,
		prompt: string,
	): Promise<KnownWorktree | undefined> => {
		if (!getModel()) {
			say(ctx, MODEL_UNAVAILABLE, "error");
			return undefined;
		}
		const worktrees = await refresh();
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
				const names = match.worktrees.map((wt) => wt.name).join(", ");
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
		const labels = worktrees.map(describeKnown);
		const choice = await ctx.ui.select(prompt, labels);
		if (!choice) return undefined;
		return worktrees[labels.indexOf(choice)];
	};

	const showList = async (info: RepoInfo, ctx: ExtensionContext) => {
		const model = getModel();
		if (!model) {
			say(ctx, MODEL_UNAVAILABLE, "error");
			return;
		}
		const worktrees = await refresh();
		const dirtyCounts = await Promise.all(worktrees.map((wt) => countDirty(runner, wt.path)));
		const lines = worktrees.map((wt, index) => {
			const dirty = dirtyCounts[index];
			const marks = [
				wt.path === info.worktreeRoot ? "session" : undefined,
				getFocus() && wt.path === getFocus()?.path ? "focused" : undefined,
				dirty > 0 ? `${dirty} dirty` : undefined,
			].filter(Boolean);
			return `${describeKnown(wt)}${marks.length ? `  — ${marks.join(", ")}` : ""}`;
		});
		if (lines.length === 0) lines.push("(none)");
		// Excludes the main working tree `refresh()` puts back above: it is
		// unmanaged too, but nothing jimothy does applies to it, so it is never
		// what this hint means by "adopt".
		//
		// Compared against jimothy's `model.info.mainWorktree`, not this function's
		// own `info.projectRoot` — two different `RepoInfo` shapes coexist here
		// (the design spec calls this out as a named risk): `info` is this
		// extension's, read from `lib/git.ts` and equal to the *dirname of the
		// common dir*; `model.info` is jimothy's, and `.mainWorktree` is the
		// directory `refresh()` actually unshifted above. They coincide for an
		// ordinary repo and diverge in a `proj/.bare` layout, where `projectRoot`
		// is `proj` and the main worktree is `proj/main` — comparing against the
		// wrong one prints "can be adopted" for a repository whose only unmanaged
		// row is the one thing that cannot be.
		if (worktrees.some((wt) => !wt.managed && wt.path !== model.info.mainWorktree)) {
			lines.push("", "unmanaged worktrees can be adopted with /worktree adopt");
		}
		report(ctx, `Worktrees in ${info.projectRoot}:`, lines);
	};

	const doNew = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const parsed = parseNewArgs(args);
		if (parsed.extra.length > 0) {
			say(ctx, `unexpected extra arguments: ${parsed.extra.join(" ")} (quote names containing spaces)`, "error");
			return;
		}
		const model = getModel();
		if (!model) {
			say(ctx, MODEL_UNAVAILABLE, "error");
			return;
		}

		let name = parsed.name;
		if (!name) {
			// A suggestion rather than an empty box: pi's `input` placeholder is never
			// rendered, so the old hint was invisible. `editor` does prefill, which
			// makes the name editable instead of merely proposed.
			const suggestion = await model.registry.suggestName(seedFromTranscript(ctx));
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

		// `create` takes a base and resolves no default of its own, so the three
		// answers are ordered here: what the user typed, what the repository's
		// jimothy config says, then the repository's default branch.
		const base =
			parsed.base ?? model.config.defaultBase ?? (await resolveDefaultBranch(model.deps, model.info.mainWorktree));

		say(ctx, `creating ${name} …`, "info");
		try {
			// Narrated line by line through `say`, not `ui.report`: `report` takes a
			// title plus a block of lines and renders once, which is the opposite of
			// narration — an install that speaks only when it finishes is the hang the
			// line sink exists to avoid.
			const { record, provision: result } = await createAndProvision(
				model,
				(line) => say(ctx, line, "info"),
				name,
				{ base },
			);
			await refresh();
			// The new branch exists now: `checkout <tab>` should offer it.
			await refreshBranches(info);

			const created = [`created ${record.path}`, `branch ${record.branch} (from ${base})`];
			// A provisioning failure still names what was created: the worktree is real
			// and usable for editing, only its links/copies/install are missing, so the
			// user is told where it is rather than left to rediscover it via "already
			// exists" on a retry.
			if ("failed" in result) {
				say(ctx, [...created, `provisioning failed: ${result.failed.message}`].join("; "), "warning");
			} else {
				const notes = [...created, ...result.warnings];
				say(ctx, notes.join("; "), result.warnings.length ? "warning" : "info");
			}

			// Through `moveFocus`, not `setFocus`: focus is where the agent writes, so
			// it carries the worktree lease with it. The worktree exists on either
			// path above, so focusing it is still right even when provisioning failed.
			if (getConfig().autoFocus) await moveFocus(ctx, { path: record.path, branch: record.branch });
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
		const model = getModel();
		if (!model) {
			say(ctx, MODEL_UNAVAILABLE, "error");
			return;
		}

		let branches = await refreshBranches(info);
		const worktrees = await refresh();
		const checkedOut = new Map<string, KnownWorktree>();
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
				`"${match.branch}" is already checked out at ${occupied.path} — /worktree focus ${occupied.name}`,
				"error",
			);
			return;
		}

		// The worktree *directory* name is a different thing from the branch: a name
		// the user typed is used verbatim, and only a derived one may be adjusted —
		// `registry.suggestName` is what knows a name is free, against records, every
		// worktree git reports, and every branch. jimothy's prefix, not the
		// extension's own (now-dead for this door): a tracked or existing branch's
		// identity belongs to the branch itself, but the *directory* still follows
		// jimothy's convention for stripping it, same as `new`.
		//
		// `creatingBranch: false`, unlike `new`: the branch component of that taken set
		// protects a caller about to *mint* `${branchPrefix}${name}`, and this door mints
		// nothing — `create({ branch })` and `create({ track })` check out a branch that
		// already exists. Counting it would mean the seed, derived from that same branch,
		// always collides with itself: `checkout feature` landing in `feature-2` and a
		// message inviting the user to look for a `feature` nobody made.
		const name =
			explicitName ??
			(await model.registry.suggestName(checkoutName(match.branch, model.config.branchPrefix), {
				creatingBranch: false,
			}));

		say(ctx, `creating ${name} …`, "info");
		try {
			// Mutually exclusive by construction: an existing local branch is checked
			// out unprefixed and is not jimothy's to delete (`branchCreated: false`), and
			// a remote branch is tracked by its full ref so the local checkout, `git
			// push` and every PR tool keep agreeing on what the branch is called.
			const opts = match.kind === "remote" ? { track: match.full } : { branch: match.branch };
			const { record, provision: result } = await createAndProvision(
				model,
				(line) => say(ctx, line, "info"),
				name,
				opts,
			);
			await refresh();
			// The branch this created is now checked out; a stale cache would still
			// offer it under `checkout <tab>`.
			await refreshBranches(info);

			const extras = [
				match.kind === "remote" ? `tracking ${match.full}` : undefined,
				match.kind === "local" && match.shadows ? `using the local branch, not ${match.shadows}` : undefined,
			].filter((extra): extra is string => extra !== undefined);
			const created = [`created ${record.path}`, `branch ${record.branch}`, ...extras];

			// Mirrors `doNew`: a provisioning failure still names what was created,
			// because the worktree is real and usable for editing either way.
			if ("failed" in result) {
				say(ctx, [...created, `provisioning failed: ${result.failed.message}`].join("; "), "warning");
			} else {
				const notes = [...created, ...result.warnings];
				say(ctx, notes.join("; "), result.warnings.length ? "warning" : "info");
			}

			// Through `moveFocus`, not `setFocus`: see `doNew`.
			if (getConfig().autoFocus) await moveFocus(ctx, { path: record.path, branch: record.branch });
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};

	/**
	 * `/worktree adopt [path]` — take an existing worktree into the registry.
	 *
	 * The path defaults to a chosen unmanaged worktree rather than to cwd (which
	 * is what `jimothy wt adopt` does): in a session the interesting ones are the
	 * repository's *other* worktrees, and cwd is usually already managed. No
	 * filesystem completions are offered for the argument — the selection prompt
	 * below is the affordance, and completing arbitrary paths would invite
	 * adopting something that is not a worktree of this repository at all.
	 */
	const doAdopt = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const model = getModel();
		if (!model) {
			say(ctx, MODEL_UNAVAILABLE, "error");
			return;
		}

		let target = args.trim();
		if (!target) {
			// The reconciling read: a worktree just created by hand (`git worktree
			// add`) must show up here without a prior `/worktree list`.
			const { unmanaged } = await model.registry.list();
			const candidates = unmanaged.filter(
				(entry) => !entry.bare && entry.path !== model.info.mainWorktree,
			);
			if (candidates.length === 0) {
				say(ctx, "no unmanaged worktrees to adopt", "info");
				return;
			}
			if (!ctx.hasUI) {
				say(ctx, "a path is required in non-interactive mode", "error");
				return;
			}
			const labels = candidates.map(
				(entry) => `${basename(entry.path)}  (${entry.branch ?? "detached"})  ${entry.path}`,
			);
			const choice = await ctx.ui.select("Adopt which worktree?", labels);
			if (!choice) return;
			target = candidates[labels.indexOf(choice)].path;
		}

		try {
			const record = await model.registry.adopt(target);
			await refresh();
			say(ctx, `adopted ${record.name} (${record.branch})`, "info");
			// Adopting the worktree this session writes in is the one adoption that leaves
			// a hole: it was unleased because there was nothing to lease, and now there is
			// a record nobody holds while the agent goes on writing there — so the next
			// session to open it is handed it with no prompt. Through the same lease
			// machinery a transition uses, and reported rather than fatal, like every other
			// lease failure here: the adoption itself succeeded either way.
			//
			// The write target is the focused worktree, or the session's own when nothing
			// is focused. Realpath'd because records store resolved paths, and an
			// unresolved one silently matches nothing — a session in a symlinked worktree
			// would adopt it and leave it unleased, which is the state this closes.
			const writing = getFocus()?.path ?? info.worktreeRoot;
			const resolved = writing ? await realpath(writing).catch(() => writing) : undefined;
			if (resolved === record.path) await takeLease(ctx, record.path);
		} catch (error) {
			say(ctx, (error as Error).message, "error");
		}
	};

	const doFocus = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const query = args.trim();
		// Every branch here goes through `moveFocus` rather than `setFocus`: focus is
		// where the agent writes, so it carries the worktree lease with it, and a
		// door that set it directly would be a door that writes into a worktree this
		// session does not hold. A `false` has already said why, so nothing is
		// reported on top of it.
		if (query === "off" || query === "none" || query === "clear") {
			if (!(await moveFocus(ctx, undefined))) return;
			say(ctx, "focus cleared", "info");
			return;
		}
		const target = await resolveWorktree(ctx, query, "Focus which worktree?");
		if (!target) return;
		if (target.path === info.worktreeRoot) {
			if (!(await moveFocus(ctx, undefined))) return;
			say(ctx, "focus cleared (that is the session worktree)", "info");
			return;
		}
		if (!(await moveFocus(ctx, { path: target.path, branch: target.branch }))) return;
		say(ctx, `focused ${describeKnown(target)}`, "info");
	};

	/**
	 * Take back a lease released for a removal that then did not happen.
	 *
	 * An ordinary acquire, deliberately. The lease was ours a moment ago, so this is
	 * not a steal — but a stranger may have taken it in the window between the
	 * release and the failure, and then losing it is the correct outcome: this
	 * session is not entitled to a worktree another live agent has just been granted,
	 * and `breakLease` here would take one. Under the same runId, so a delegated lease
	 * stays jimothy's to release.
	 *
	 * Reported rather than swallowed, because a session that has silently stopped
	 * holding the worktree it is focused on is the failure this ordering must never
	 * hide. No retry: whoever holds it now holds it, and asking again would only ask
	 * the same question.
	 *
	 * A lease taken out of the deferred queue for the removal comes back as *held*
	 * rather than pending, which is a deliberate simplification: the worktree the
	 * queue entry belonged to is one focus has already left, so nothing will drop it
	 * again and it goes back at shutdown instead of at the next settle. Held a while
	 * longer is the safe direction — the unsafe one is an agent writing in a worktree
	 * this session no longer holds.
	 *
	 * `active` is the session `doRemove` captured before the removal — the one the
	 * lease was dropped from — checked again here for the same reason `take-lease.ts`'s
	 * `acquire` row re-checks `env.current`: the acquire above crosses an await, and a
	 * session replaced in that window must record no lease. Re-reading `getSession()`
	 * and adding to whatever it returns *now* — the previous shape — either lands the
	 * lease on an unrelated replacement session or, if none is live, drops it with
	 * nothing recorded, and either way the registry is left holding the worktree under
	 * a live pid that nothing will ever release: the same leak `take-lease.ts`'s
	 * `acquire` row was fixed for. So a session mismatch here hands the lease straight
	 * back instead.
	 */
	const regainLease = async (ctx: ExtensionCommandContext, model: Model, active: WorktreeSession | undefined, lease: HeldLease) => {
		try {
			await model.registry.acquireLease(lease.name, lease.runId, process.pid, { label: LEASE_LABEL });
			if (getSession() !== active) {
				await model.registry.releaseLease(lease.name, lease.runId).catch(() => {});
				return;
			}
			active?.addLease(lease);
		} catch (error) {
			say(
				ctx,
				`worktree "${lease.name}" was released for the removal and could not be taken back: ${(error as Error).message}`,
				"warning",
			);
		}
	};

	const doRemove = async (info: RepoInfo, ctx: ExtensionCommandContext, args: string) => {
		const target = await resolveWorktree(ctx, args.trim(), "Remove which worktree?");
		if (!target) return;
		const model = getModel();
		if (!model) {
			// `resolveWorktree` has already refused a session without one, so this is
			// reachable only if the session was replaced while the picker was open —
			// which is a reason to say so, not to remove anything.
			say(ctx, MODEL_UNAVAILABLE, "error");
			return;
		}
		if (target.path === info.worktreeRoot) {
			say(ctx, "refusing to remove the session's own worktree", "error");
			return;
		}

		// Above both confirmations, not after them: an unmanaged worktree is refused
		// regardless of what the user answers, so asking "N uncommitted file(s) will
		// be lost" and "also delete branch" first only makes the eventual refusal read
		// as if consent mattered when it never did.
		if (!target.managed) {
			if (target.path === model.info.mainWorktree) {
				// A main working tree can never be adopted — jimothy refuses that
				// outright — so the ordinary "adopt it first" advice below is a dead
				// end for this one row. Say plainly that it cannot be removed at all,
				// rather than pointing at a command that will only refuse again.
				say(ctx, `"${target.name}" is the repository's main working tree and cannot be removed`, "error");
				return;
			}
			// `Registry.remove` takes a registry name, and an unmanaged worktree has
			// none — the extension's own git-level removal used to delete it anyway,
			// so this is a capability regression, acceptable only because the fix is
			// named rather than left for the user to guess: adopt, then remove.
			say(
				ctx,
				`"${target.name}" is not managed by jimothy, so there is nothing to remove — run ` +
					`/worktree adopt ${target.path} first, then remove it`,
				"error",
			);
			return;
		}

		const dirty = await countDirty(runner, target.path);
		if (ctx.hasUI) {
			const message = dirty > 0 ? `${dirty} uncommitted file(s) will be lost.` : "This cannot be undone.";
			const ok = await ctx.ui.confirm(`Remove ${describeKnown(target)}?`, message);
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

		// Held across the removal so a failure can hand it back: see the catch. `session`
		// is captured here too, alongside `released`, because `regainLease` must check
		// identity against *this* session, not whichever one `getSession()` returns after
		// the removal has run.
		let released: HeldLease | undefined;
		let session: WorktreeSession | undefined;
		try {
			// Our own lease would make `remove` refuse: it is live, under a live pid,
			// which is exactly what that check is for. So it is handed *back* first —
			// releasing is not `breakLease`, which would take a lease held by another
			// agent too, and that refusal is the one thing here worth keeping.
			//
			// From the deferred queue too, not just the session's list: a transition away
			// from this worktree drops the lease the moment focus moves but defers the
			// release to `agent_settled`, and a `dropLease` that could not see that queue
			// left the removal refused — naming *this* session as the holder that made it
			// impossible. At most one of the two can have it: `addLease` cancels a queued
			// release when the worktree is taken back.
			session = getSession();
			const held = session?.dropLease(target.path) ?? session?.cancelRelease(target.path);
			released = held;
			if (held) await model.registry.releaseLease(held.name, held.runId);

			await model.registry.remove(target.name, {
				force: dirty > 0,
				// Never, whatever the user confirmed above: uncommitted files say nothing
				// about whether another agent is working in this worktree.
				breakLease: false,
				// Only what the user actually answered; jimothy defaults it from the record
				// (`branchCreated`) when nobody asked.
				deleteBranch,
				// `false` rather than omitted, because jimothy's own default force-deletes a
				// branch it created that has no upstream — which is every `/worktree new`
				// branch — and the prompt above promises "Kept if it is not fully merged".
				// `-d` refusing to drop commits that exist nowhere else is the point of asking.
				forceDeleteBranch: false,
			});
			// After the removal succeeded, and through `moveFocus`: focus carries the
			// lease, so clearing it here is what gets the session back onto its own
			// worktree rather than pointing at a directory that no longer exists.
			if (getFocus()?.path === target.path) await moveFocus(ctx, undefined);
			await refresh();
			// The branch may have gone with the worktree: completing a dead branch
			// costs a pointless fetch when it is accepted.
			await refreshBranches(info);
			say(ctx, `removed ${target.name}`, "info");
		} catch (error) {
			say(ctx, (error as Error).message, "error");
			// A throw does not mean the worktree survived. jimothy deletes it and drops
			// its record *before* reporting a branch git declined to delete — an unmerged
			// branch under `-d`, which is the refusal the confirmation above exists to
			// respect — so that path is a removal that happened, with a caveat.
			//
			// The directory is the discriminator, not the message: parsing jimothy's
			// wording would tie this branch to a sentence it is free to reword.
			if (await exists(target.path)) {
				// The removal really did not happen, so the lease released for it is owed
				// back: without this the session holds nothing on a worktree it may still
				// be focused on, which is the state this whole ordering must not produce.
				if (released) await regainLease(ctx, model, session, released);
				return;
			}
			// Gone, so everything the success path does has to happen anyway. Skipping it
			// leaves a session focused on a deleted directory, and every later tool call
			// is redirected into it — the error then names a path the user never typed, so
			// it reads as a broken shell rather than as a worktree that was removed.
			if (getFocus()?.path === target.path) await moveFocus(ctx, undefined);
			await refresh();
			await refreshBranches(info);
		}
	};

	const doConfig = (info: RepoInfo, ctx: ExtensionContext) => {
		const lines = [
			`project root:   ${info.projectRoot}`,
			`session wt:     ${info.worktreeRoot ?? "(none)"}`,
			`focused:        ${getFocus()?.path ?? "(none)"}`,
			// Nothing about where a worktree lands or what its branch is called: that is
			// jimothy's config now, and printing a second answer here is how the two
			// tools came to disagree in the first place.
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
			case "adopt":
				return doAdopt(info, ctx, rest);
			case "prune": {
				const out = await pruneWorktrees(runner, info.projectRoot);
				await refresh();
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
	 * Complete subcommands, then their arguments: branch names for `checkout`,
	 * worktree names for `focus` and `remove` (plus `off` for `focus`).
	 *
	 * Uses the cached lists rather than shelling out: completions run on every
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
		const names = known.map((wt) => wt.name);
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
		refreshCached,
		refreshKnown: refresh,
		setKnownBranches: (branches) => {
			knownBranches = branches;
		},
	};
}
