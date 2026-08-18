/**
 * Worktree extension for pi.
 *
 * Manages git worktrees and, optionally, redirects the agent's tool calls into
 * one without restarting the session.
 *
 *   /worktree                 interactive menu
 *   /worktree list            show worktrees for this repo
 *   /worktree new <name>      create a worktree (+ branch) and focus it
 *   /worktree checkout <branch> [name]
 *                             create a worktree for a branch that exists
 *   /worktree focus <name>    redirect tool calls into a worktree
 *   /worktree focus off       stop redirecting
 *   /worktree remove <name>   remove a worktree
 *   /worktree prune           prune stale worktree metadata
 *   /worktree config          show effective configuration
 *
 * Layout aware: ordinary repos, linked worktrees, and bare layouts
 * (`proj/.bare` + `proj/main` + siblings) all resolve correctly.
 *
 * Mostly wiring, plus the session-start sequence. The lease handshake this
 * used to run inline — deciding and acting on who holds the worktree a session
 * is about to write to — now lives in `take-lease.ts`, which this file calls
 * at `session_start` with a `LeaseEnv` built from its own closure.
 *
 * The parts this wires together:
 *
 *   session.ts     per-session state, focus, held leases, and the PR monitor
 *   pr-monitor.ts  the PR status state machine
 *   commands.ts    the /worktree command and its completions
 *   tool.ts        the model-facing tool
 *   ui.ts          notifications, reports, and the status segment
 *   lease.ts       the lease decision table, and the launcher's identity
 *   take-lease.ts  the lease handshake: acquiring, retargeting, prompting
 *   transition.ts  moving focus, and the lease with it
 *   jimothy.ts     jimothy's worktree model: registry, deps, repo info
 *   focus.ts       rewriting a tool call's paths into the focused worktree
 *   panel.ts       the dashboard's location panel
 *
 * The one rule to preserve here: **the extension closure outlives the session**.
 * Commands and tools are registered once per process and must always act on the
 * *current* session, which is why they receive getters rather than values.
 */

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aheadBehind, countDirty, getRepoInfo, type RepoInfo } from "../lib/git.ts";
import { createHerdrReporter, type HerdrReporter, herdrTarget } from "../lib/herdr.ts";
import { EMPTY_BRANCHES, listBranches } from "./branches.ts";
import { createCommands } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { applyFocus } from "./focus.ts";
import { type Model, openModel } from "./jimothy.ts";
import { captureLauncherEnv, type LauncherEnv } from "./lease.ts";
import {
	beginLocationCycle,
	clearLocationPanel,
	isCurrentLocationCycle,
	publishLocationPanel,
	readStack,
} from "./panel.ts";
import { createSession, FOCUS_ENTRY_TYPE, type WorktreeSession } from "./session.ts";
import { type LeaseEnv, takeLeaseForSession } from "./take-lease.ts";
import { createWorktreeTool } from "./tool.ts";
import { moveFocus } from "./transition.ts";
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
	 * The current session's herdr reporter, if pi is running under herdr with a
	 * UI. Retired with the session it belongs to, so a replaced session cannot
	 * keep reporting a branch nobody is looking at.
	 */
	let reporter: HerdrReporter | undefined;

	/**
	 * Bumped for every reporter created, so a reporter can tell whether it still
	 * owns the herdr ids it is about to write.
	 *
	 * `dispose()` is not enough on its own: shutdown disposes the reporter and
	 * *then* awaits its clear, and that clear can still be running when the next
	 * session starts reporting (`/new` fires session_shutdown, then
	 * session_start). Both sessions write the same workspace and pane id, so the
	 * loser of that race must drop its remaining writes rather than land last.
	 *
	 * The write it has already spawned cannot be dropped; lib/herdr.ts orders that
	 * one behind this session's, keyed by `runner` — which is why every reporter
	 * in this process is built over the same `pi`.
	 */
	let reporterGeneration = 0;

	/**
	 * What jimothy told this process, read once and removed from the environment.
	 *
	 * Neither on the session nor in this closure: a session replacement rebuilds
	 * both, and the environment it would read again has already been scrubbed —
	 * see `captureLauncherEnv`, which keeps it where a replacement cannot reach.
	 * Provenance is defined against this run id, and a session that had forgotten
	 * it would release a lease jimothy is going to release.
	 *
	 * Captured at `session_start` rather than at load, so the delete happens inside
	 * the handler pi awaits before any tool can run.
	 */
	let launcher: LauncherEnv | undefined;

	/**
	 * The only place `session` is assigned.
	 *
	 * Retiring the outgoing session is not optional: its monitor may have a fetch
	 * in flight and a poll armed, and both would land on a `ctx` that pi has since
	 * made stale — which throws and takes the process down. Routing every change
	 * through here means the disposal cannot be forgotten or ordered wrongly.
	 */
	const replaceSession = (next: WorktreeSession | undefined, nextReporter?: HerdrReporter) => {
		session?.dispose();
		reporter?.dispose();
		session = next;
		reporter = nextReporter;
		return next;
	};

	/**
	 * What `take-lease.ts` needs from this closure.
	 *
	 * Built per call rather than once, because `launcher` is captured at
	 * `session_start` and `session` changes under it: a value built at
	 * registration time would answer for whichever session happened to be first.
	 */
	const leaseEnv = (): LeaseEnv => ({
		launcher,
		say,
		current: (candidate) => session === candidate,
	});

	/**
	 * A reporter for this session, or undefined.
	 *
	 * Gated on `hasUI` deliberately: a `pi -p` run borrows the user's own shell
	 * pane for a few seconds, and the PR monitor does not poll without a footer,
	 * so a reported branch would never refresh anyway.
	 */
	const makeReporter = (ctx: ExtensionContext, branchPrefix: string): HerdrReporter | undefined => {
		if (!ctx.hasUI) return undefined;
		const target = herdrTarget(process.env);
		if (!target) return undefined;
		const generation = ++reporterGeneration;
		return createHerdrReporter({
			runner: pi,
			target,
			branchPrefix,
			isCurrent: () => generation === reporterGeneration,
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		// Before anything can spawn a child, and before any await: every subagent and
		// every pi the model starts from bash inherits this environment, and an
		// inherited launcher would retarget the live agent's lease onto a process about
		// to exit. Unconditional — the scrub runs on every session even though the
		// answer is only read once per process.
		launcher = captureLauncherEnv(process.env);
		replaceSession(undefined);
		clearLocationPanel();
		commands.setKnown([]);
		commands.setKnownBranches(EMPTY_BRANCHES);
		const cycle = beginLocationCycle();

		const repo = await getRepoInfo(pi, ctx.cwd);
		if (!repo) {
			// Still a session, just not one that can do anything: the status segment
			// needs clearing either way. It still gets its own controller, so this
			// path's session disposes identically to the ordinary one.
			const noRepoReporter = makeReporter(ctx, "");
			replaceSession(
				createSession({
					pi,
					ui,
					ctx,
					repo: undefined,
					model: undefined,
					abort: new AbortController(),
					report: (branch) => noRepoReporter?.report(branch),
				}),
				noRepoReporter,
			)?.paint(ctx);
			return;
		}

		const loaded = await loadConfig({
			projectRoot: repo.projectRoot,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const nextReporter = makeReporter(ctx, loaded.config.branchPrefix);

		// Owned by the session, not the call: it is handed to createSession below
		// so dispose() can abort it, cancelling any child the model started without
		// reaching for openModel's return value again.
		const abort = new AbortController();
		let model: Model | undefined;
		try {
			model = await openModel(pi, ctx.cwd, { signal: abort.signal });
		} catch (error) {
			// Reported, never fatal: pi is already running, and a session that cannot
			// reach the registry can still focus, still monitor a PR, and still paint.
			say(ctx, `jimothy model unavailable: ${(error as Error).message}`, "warning");
		}

		const active = replaceSession(
			createSession({
				pi,
				ui,
				ctx,
				repo,
				model,
				abort,
				config: loaded.config,
				configSources: loaded.sources,
				report: (branch) => nextReporter?.report(branch),
			}),
			nextReporter,
		);
		if (!active) return;
		for (const warning of loaded.warnings) say(ctx, warning, "warning");

		// The worktree cache seeds from the lock-free snapshot, not the reconciling
		// `list()`: a fresh session has no completion to offer yet, and paying the
		// registry lock for it here would cost every session start what only a
		// keystroke needs to be cheap. The snapshot has no unmanaged half, so until
		// the cache is refilled this is managed-only: in a repository with nothing
		// jimothy manages, `focus <tab>` offers only `off` and `remove <tab>` offers
		// nothing. That is a deliberate trade, not an oversight — the reconciling
		// read would take the registry's lock, run git and write `registry.json`
		// into every repository a session merely opens. A failure here (like a
		// branch listing failure) is tolerated, never fatal: the cache is refilled
		// opportunistically by the first `/worktree` command that lists.
		try {
			await commands.refreshCached();
			commands.setKnownBranches(await listBranches(pi, repo.projectRoot));
		} catch {
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

		// After the focus restore, and after the check above has had its say about a
		// worktree that is gone: the lease belongs on the directory this session will
		// actually write to, which for a reload, a resume or a fork is the restored
		// focus rather than the cwd pi was started in.
		// A false answer means either that the user chose to quit rather than displace
		// another session, and `ctx.shutdown()` has already been called, or that this
		// session was replaced while the handshake waited. Stop here: pi is
		// tearing this context down, and painting a footer and fetching git status
		// on the way out is work nobody asked for on a context that is going away —
		// the shutdown spike showed anything queued after that call may not run at
		// all, so a session that carries on is racing its own exit.
		if (!(await takeLeaseForSession(leaseEnv(), active, ctx))) return;

		active.paint(ctx);
		active.prMonitor.refresh();

		// Read git status after painting the footer so a git error here cannot
		// prevent the footer from rendering. The focused worktree (if any) is the
		// canonical head; fall back to the repo root for an unfocused session.
		// countDirty and aheadBehind run concurrently to halve the serial latency.
		// `ctx` is not touched inside the callback — publishing goes through the
		// registry so no stale-context crash is possible.
		const head = active.focus?.path ?? repo.worktreeRoot ?? ctx.cwd;
		const branch = active.focus ? active.focus.branch : repo.branch;
		try {
			const [dirty, ab] = await Promise.all([
				countDirty(pi, head),
				aheadBehind(pi, head),
			]);
			if (!isCurrentLocationCycle(cycle)) return;
			const location = { path: head, branch, dirty, ...(ab ?? {}) };
			publishLocationPanel(location, { kind: "pending" });
			void readStack(pi, head, branch).then((stack) => {
				if (!isCurrentLocationCycle(cycle)) return;
				publishLocationPanel(location, stack);
			});
		} catch {
			// Git errors during startup do not affect the session.
		}
	});

	/**
	 * On the way out, leave the focused worktree's path in the user's scrollback.
	 *
	 * Focus moves the *agent*, never the user's shell — a child process cannot
	 * change its parent's working directory — so quitting drops the user back
	 * wherever they launched pi, with the worktree they were just working in
	 * named only in a status bar that is now gone. Printing the path makes the
	 * follow-up `cd` a copy-paste instead of an archaeology exercise.
	 *
	 * Only on `quit`: the same event fires for `/new`, `/fork`, `/reload`, and
	 * `--resume`, where the TUI lives on and a raw stdout write would tear a hole
	 * in the rendering.
	 */
	pi.on("session_shutdown", async (event, ctx) => {
		const focus = session?.focus;
		// Focus on the session's own worktree never redirected anything, so its path
		// is just the cwd the user already has.
		const redirected = focus && focus.path !== session?.repo?.worktreeRoot;
		if (event.reason === "quit" && focus && redirected) {
			ui.farewell(ctx, [
				`worktree: ${basename(focus.path)}${focus.branch ? ` (${focus.branch})` : ""}`,
				`  cd ${focus.path}`,
			]);
		}
		// Ours to release, or the launcher's? The runId decides, not how we got it:
		// a hand-launched pi that reloaded *adopted* its own lease and must still
		// give it back, while a delegated one is released by jimothy's own finally,
		// which matches on that same runId.
		//
		// Unconditional across every `reason`, not just "quit": an "ours" lease left
		// held past this shutdown is a lease with nobody left to release it. `/reload`
		// and `/fork` replace the session object but keep the process, so releasing
		// only on the terminal shutdown would leave that lease held by a live pid for
		// the rest of the process's life — recoverable only with `jimothy wt release
		// --force`, since no session object survives to know it should be freed. The
		// cost accepted instead is a window, one event-loop turn wide, between this
		// release and the replacement session's session_start re-acquiring the same
		// name, in which another process could in principle take it. That failure is
		// visible and self-correcting — the replacement session prompts, exactly as
		// it would for any other stranger's lease — rather than the silent, permanent
		// leak the alternative risks.
		//
		// This must run before replaceSession(undefined) below, not after: it reads
		// the session's leases and its model, and a session that has already dropped
		// its model cannot release anything.
		const model = session?.model;
		// A session that has no model cannot release anything, so the question is asked
		// once rather than per lease.
		if (model) {
			// The deferred queue first, and regardless of provenance: a transition has
			// already decided these worktrees are no longer this session's to hold, and
			// `agent_settled` is the only other thing that drains them. `/reload` and
			// `/fork` end a session without ending the process, so one left queued here
			// would stay held by a *live* pid for the rest of that process's life —
			// recoverable only with `jimothy wt release --force`.
			for (const lease of session?.takeDeferredReleases() ?? []) {
				await model.registry.releaseLease(lease.name, lease.runId).catch((error: Error) => {
					say(ctx, `could not release the worktree lease: ${error.message}`, "warning");
				});
			}
			for (const lease of session?.leases ?? []) {
				if (lease.provenance !== "ours") continue;
				// Reported, never fatal: pi is on its way out, and a lock we could not take
				// leaves a lease whose pid is about to be dead — which the next run reclaims.
				await model.registry.releaseLease(lease.name, lease.runId).catch((error: Error) => {
					say(ctx, `could not release the worktree lease: ${error.message}`, "warning");
				});
			}
		}

		// Retire session and UI before awaiting the clear: if pi fires session_start
		// before the clear resolves, a post-await replaceSession(undefined) would
		// silently dispose the newly created session. Workspace tokens have no TTL,
		// so a half-finished clear leaves a stale branch on herdr's sidebar.
		const retiring = reporter;
		// Invalidate any in-flight readStack so its result cannot publish after shutdown.
		beginLocationCycle();
		replaceSession(undefined);
		clearLocationPanel();
		ui.clearAll(ctx);
		// Cap the clear at 1s: pi sends SIGTERM and SIGKILLs 5s later; one wedged
		// herdr call costs HERDR_TIMEOUT_MS (2s) and clear() can await up to four
		// calls (an in-flight report's two, then its own two) — worst case ≈28s,
		// plus whatever the previous session still has queued for those surfaces.
		// The timer is unref'd so a pending deadline cannot hold the process open;
		// .catch() ensures the losing clear() cannot produce an unhandled rejection.
		const clearDeadline = new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 1_000);
			t.unref();
		});
		await Promise.race([(retiring?.clear() ?? Promise.resolve()).catch(() => {}), clearDeadline]);
	});

	/**
	 * Give back the worktrees this session has focused away from.
	 *
	 * A transition drops the origin's lease the moment focus moves but defers the
	 * release to here, because focus is applied at `tool_call` time: a call already
	 * in flight is still writing into that worktree, and releasing it there would
	 * invite a second agent into a directory being written.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		const active = session;
		const model = active?.model;
		if (!active || !model) return;
		for (const lease of active.takeDeferredReleases()) {
			await model.registry.releaseLease(lease.name, lease.runId).catch((error: Error) => {
				// Reported only while this is still the live session: a replaced one's
				// `ctx` is stale, and touching it throws out of the handler. The release
				// itself is attempted either way — it is runId-guarded, so a late one
				// cannot unlock a worktree someone else has taken.
				if (session !== active) return;
				say(ctx, `could not release worktree "${lease.name}": ${error.message}`, "warning");
			});
		}
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

	/**
	 * Move focus, and the worktree lease with it.
	 *
	 * Bound to the live session for the same reason `setFocus` is; the rules it
	 * applies are `transition.ts`'s, and this supplies only the environment they
	 * need from this closure.
	 */
	const moveFocusHere = async (
		ctx: ExtensionContext,
		next: Parameters<WorktreeSession["setFocus"]>[1],
		opts?: { announce?: boolean },
	): Promise<boolean> => {
		const active = session;
		if (!active) return false;
		// No model is no registry, and focus has never needed one: it is a rewrite of
		// pi's own tool calls. A session that could not open jimothy still focuses,
		// it just cannot lease what it focuses.
		if (!active.model) {
			active.setFocus(ctx, next, opts?.announce);
			return true;
		}
		// Realpath'd because records store resolved paths and `home` is compared
		// against them: an unresolved one would look like a third worktree, so
		// clearing focus would "move" to a path nothing manages. A path that cannot
		// be resolved is used as it stands rather than failing the move.
		const root = active.repo?.worktreeRoot ?? ctx.cwd;
		const home = await realpath(root).catch(() => root);
		if (session !== active) return false;
		return await moveFocus({ lease: leaseEnv(), model: active.model, home }, active, ctx, next, opts);
	};

	const commands = createCommands({
		runner: pi,
		ui,
		getModel: () => session?.model,
		getConfig: () => session?.config ?? DEFAULT_CONFIG,
		getConfigSources: () => session?.configSources ?? [],
		getFocus: () => session?.focus,
		setFocus,
		moveFocus: moveFocusHere,
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
				// The registry's reconciling list() and the git calls dispatch makes for
				// checkout, create and remove all throw; an unhandled rejection here would
				// surface as a crash rather than a message.
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
			// A create through the tool bypasses the model's write paths (phase 4),
			// so what it just made is unmanaged until then — snapshot() cannot see
			// an unmanaged worktree at all, so the reconciling read is the one that
			// must run here, not refreshCached's lock-free one.
			refreshKnown: commands.refreshKnown,
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
