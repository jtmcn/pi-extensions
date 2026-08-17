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

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkLease,
	describeLease,
	describeReclaim,
	type WorktreeLease,
	type WorktreeRecord,
} from "jimothy/worktrees";
import { aheadBehind, countDirty, getRepoInfo, type RepoInfo } from "../lib/git.ts";
import { createHerdrReporter, type HerdrReporter, herdrTarget } from "../lib/herdr.ts";
import { EMPTY_BRANCHES, listBranches } from "./branches.ts";
import { createCommands } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { applyFocus } from "./focus.ts";
import { type Model, openModel } from "./jimothy.ts";
import { decideLease, type LauncherEnv, type LeaseDecision, leaseProvenance, readLauncherEnv } from "./lease.ts";
import {
	beginLocationCycle,
	clearLocationPanel,
	isCurrentLocationCycle,
	publishLocationPanel,
	readStack,
} from "./panel.ts";
import { createSession, FOCUS_ENTRY_TYPE, type WorktreeSession } from "./session.ts";
import { createWorktreeTool } from "./tool.ts";
import { createUi } from "./ui.ts";

const STATUS_KEY = "worktree";
/** What a lease taken by this extension calls itself, wherever one is rendered. */
const LEASE_LABEL = "pi session";

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
	 * In the closure rather than on the session because it must survive `/reload`
	 * and `/fork`: provenance is defined against this run id, and a session that
	 * had forgotten it would release a lease jimothy is going to release.
	 *
	 * Read at the first `session_start` rather than at load, so the delete happens
	 * inside the handler pi awaits before any tool can run.
	 */
	let launcher: LauncherEnv | undefined;
	let launcherRead = false;

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

	/** The model's own rendering of a live holder, so this and `/worktree list` agree. */
	const held = (decision: { lease: WorktreeLease; ageMs: number }) =>
		describeLease({ state: "held", lease: decision.lease, ageMs: decision.ageMs });

	/**
	 * Carry out a decision, and record what we ended up holding.
	 *
	 * Returns whether the session should carry on starting: false only when the
	 * user chose to quit, which is the one row that ends the process.
	 *
	 * `retargetRetry` bounds the retarget row's re-decision: `true` on the first
	 * call (from `takeLease`'s default), `false` on the recursive one, so a
	 * lease that changes hands twice in a row is never chased a third time.
	 * `takeoverRetry` bounds the prompt row's re-decision the same way, and for
	 * the same reason — see that row.
	 */
	const applyDecision = async (
		active: WorktreeSession,
		ctx: ExtensionContext,
		model: Model,
		record: WorktreeRecord | undefined,
		decision: LeaseDecision,
		retargetRetry: boolean,
		takeoverRetry: boolean,
	): Promise<boolean> => {
		if (!record || decision.kind === "unmanaged") return true;
		const hold = (runId: string) =>
			active.addLease({ name: record.name, runId, provenance: leaseProvenance(runId, launcher?.runId) });

		switch (decision.kind) {
			case "acquire": {
				const runId = ctx.sessionManager.getSessionId();
				const result = await model.registry.acquireLease(record.name, runId, process.pid, {
					label: LEASE_LABEL,
				});
				// A worktree that was "in use" a moment ago and now simply opens makes
				// the lease look like it meant nothing.
				if (result.reclaimed) say(ctx, describeReclaim(record.name, result.reclaimed), "info");
				hold(runId);
				return true;
			}
			case "retarget": {
				const moved = await model.registry.retargetLease(record.name, decision.runId, {
					fromPid: decision.fromPid,
					pid: process.pid,
					label: LEASE_LABEL,
				});
				// False means the lease changed hands between the read and this call —
				// the launcher died and someone reclaimed it. Start again from the
				// current facts rather than assuming, but only once: `retargetRetry`
				// is what enforces that bound, since nothing about the decision shape
				// itself stops a record that races back into the retarget row from
				// recursing again. A lease that has changed hands twice under us in a
				// millisecond is not safely ours to chase further, so the second
				// failure is left unleased and reported by name. Exercised only by a
				// real race between two processes, not by a test — see the report.
				if (moved) hold(decision.runId);
				else if (retargetRetry) return await takeLease(active, ctx, false, takeoverRetry);
				else say(ctx, `worktree "${record.name}" lease changed hands again; leaving it unleased`, "warning");
				return true;
			}
			case "adopt":
				// Already ours: `session_shutdown` fires before the replacement's
				// `session_start`, so this is the ordinary `/reload` path. Whether it is
				// ours to release is the runId's business, not this row's.
				hold(decision.runId);
				return true;
			case "warn":
				// A headless run is bounded and usually read-only; a prompt is
				// impossible and killing a scripted run is worse than the warning. This
				// is also the row every pi-inside-a-pi lands on.
				say(ctx, `worktree "${record.name}" is ${held(decision)}; continuing without a lease`, "warning");
				return true;
			case "prompt": {
				const choice = await ctx.ui.select(`Worktree "${record.name}" is ${held(decision)}`, [
					"Quit",
					"Take over",
				]);
				// Dismissal is not consent: anything other than an explicit take-over
				// leaves the other session alone.
				//
				// Shutting down from inside `session_start` — a handler pi awaits before it
				// shows the prompt — was spiked under a pty before this was written: pi
				// exits 0 in under a second and does not wait for the rest of the handler,
				// so nothing after this call is guaranteed to run.
				if (choice !== "Take over") {
					say(ctx, `worktree "${record.name}" is held by another session`, "warning");
					ctx.shutdown();
					return false;
				}
				// Consent was given to displace the run the prompt *named*, and nobody
				// else. Answering takes seconds, `breakLease` breaks whoever holds it
				// now, and in between the holder may have released and a second live
				// session acquired — force-breaking that one displaces a run the user was
				// never shown. So re-read and re-classify immediately before breaking.
				//
				// This narrows the window from human thinking time to two registry calls;
				// it does not close it. Closing it needs a compare-and-break in the model
				// (`breakLease(name, { force, expected: { runId, pid } })`), which belongs
				// to the phase that touches jimothy — this one does not edit it.
				const latest = (await model.registry.snapshot()).managed.find((entry) => entry.path === record.path);
				const state = latest ? checkLease(latest, model.deps.isPidAlive, model.deps.now()) : { state: "free" as const };
				const sameHolder =
					state.state === "held" &&
					state.lease.runId === decision.lease.runId &&
					state.lease.pid === decision.lease.pid;
				if (!sameHolder) {
					// Released, reclaimed, or taken by someone else. Decide again from the
					// current facts and let the ordinary path have it — which asks afresh
					// naming the new holder, acquires if it is now free, or warns. Bounded
					// exactly as the retarget row is: once, so a worktree changing hands
					// under every prompt cannot loop the session.
					if (takeoverRetry) return await takeLease(active, ctx, retargetRetry, false);
					say(ctx, `worktree "${record.name}" changed hands again; leaving it unleased`, "warning");
					return true;
				}
				// Force, because the whole point of this row is that the holder is alive:
				// without it `breakLease` refuses. The displaced run is named, because
				// someone is losing a worktree they are still working in.
				const displaced = await model.registry.breakLease(record.name, { force: true });
				if (displaced) {
					say(ctx, `took over "${record.name}" from run ${displaced.runId} (pid ${displaced.pid})`, "warning");
				}
				return await applyDecision(active, ctx, model, record, { kind: "acquire" }, retargetRetry, takeoverRetry);
			}
		}
	};

	/**
	 * Lease the worktree this session will write to.
	 *
	 * The target is the restored focus when there is one, because every tool call
	 * is rewritten into it — leasing the cwd there would hold the worktree nobody
	 * is writing to. It is realpath'd because records store resolved paths, and an
	 * unresolved one silently matches nothing: a session in a symlinked worktree
	 * would decide it is unmanaged and take no lease at all.
	 *
	 * The snapshot, not `list()`: this runs in every pi session that opens a
	 * repository, and the reconciling read would take the registry's lock and
	 * rewrite `registry.json` for all of them.
	 *
	 * Everything here is reported and nothing is fatal: pi is already running.
	 * Returns whether the session should carry on starting — false only when the
	 * user answered the prompt row with "quit".
	 */
	const takeLease = async (
		active: WorktreeSession,
		ctx: ExtensionContext,
		retargetRetry = true,
		takeoverRetry = true,
	): Promise<boolean> => {
		const model = active.model;
		if (!model) return true;
		try {
			const target = await realpath(active.focus?.path ?? ctx.cwd);
			const record = (await model.registry.snapshot()).managed.find((entry) => entry.path === target);
			const decision = decideLease({
				record,
				state: record ? checkLease(record, model.deps.isPidAlive, model.deps.now()) : { state: "free" },
				launcherRunId: launcher?.runId,
				pid: process.pid,
				ppid: process.ppid,
				hasUI: ctx.hasUI,
			});
			return await applyDecision(active, ctx, model, record, decision, retargetRetry, takeoverRetry);
		} catch (error) {
			// Lock contention and a corrupt registry both arrive here as a UserError,
			// and a session never dies of either.
			say(ctx, `worktree lease unavailable: ${(error as Error).message}`, "warning");
			return true;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// Before anything can spawn a child: every subagent and every pi the model
		// starts from bash inherits this environment, and an inherited launcher would
		// retarget the live agent's lease onto a process about to exit.
		if (!launcherRead) {
			launcherRead = true;
			launcher = readLauncherEnv(process.env);
		}
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
		// A false answer means the user chose to quit rather than displace another
		// session, and `ctx.shutdown()` has already been called. Stop here: pi is
		// tearing this context down, and painting a footer and fetching git status
		// on the way out is work nobody asked for on a context that is going away —
		// the shutdown spike showed anything queued after that call may not run at
		// all, so a session that carries on is racing its own exit.
		if (!(await takeLease(active, ctx))) return;

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
		// This must run before replaceSession(undefined) below, not after: it reads
		// the session's leases and its model, and a session that has already dropped
		// its model cannot release anything.
		const model = session?.model;
		for (const lease of session?.leases ?? []) {
			if (!model || lease.provenance !== "ours") continue;
			// Reported, never fatal: pi is on its way out, and a lock we could not take
			// leaves a lease whose pid is about to be dead — which the next run reclaims.
			await model.registry.releaseLease(lease.name, lease.runId).catch((error: Error) => {
				say(ctx, `could not release the worktree lease: ${error.message}`, "warning");
			});
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
		getModel: () => session?.model,
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
