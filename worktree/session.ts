/**
 * Per-session state for the worktree extension.
 *
 * An extension factory runs once per process, but its state is almost all
 * *per session*: a session can be replaced under a live closure by `/new`,
 * `--resume`, or a fork. The old shape of this was a dozen `let`s in index.ts
 * reset field by field at the top of `session_start`, and that reset is where
 * the bugs were — a leftover timer firing mid-reset, a stale `focus` silently
 * redirecting a session that never asked for it.
 *
 * So state is an object with a lifetime instead. `session_start` disposes the
 * previous session and builds a new one; nothing is reset, because nothing is
 * reused. Forgetting a field is no longer possible, and ordering hazards in the
 * teardown are gone with it.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitRunner, RepoInfo } from "../lib/git.ts";
import { DEFAULT_CONFIG, type WorktreeConfig } from "./config.ts";
import type { FocusTarget } from "./focus.ts";
import type { Model } from "./jimothy.ts";
import { resolveTarget } from "./pr.ts";
import { createPrMonitor, type PrMonitor } from "./pr-monitor.ts";
import type { Ui } from "./ui.ts";

/**
 * A worktree lease this session is holding.
 *
 * A list of these rather than one, from the start: a session launched into one
 * worktree and then focused on another holds both, and a field widened later is
 * a field every earlier assertion has to be rewritten around.
 */
export interface HeldLease {
	/** The registry name, which is what every registry call takes. */
	name: string;
	/**
	 * Realpath of the worktree, because a focus transition is keyed by path: what
	 * it knows about the worktree it is leaving is where the agent was writing,
	 * and the name is the registry's business rather than focus's.
	 */
	path: string;
	/** The runId we hold it under — the launcher's, when delegated. */
	runId: string;
	/**
	 * Who will release it. `delegated` means jimothy's own `finally` owns it and
	 * matches on this runId, so the extension must leave it alone.
	 */
	provenance: "delegated" | "ours";
}

/** Custom entry holding focus state. Entries are durable; custom messages are not. */
export const FOCUS_ENTRY_TYPE = "worktree-focus";
/** Custom message announcing focus to the model. Carries no state. */
export const FOCUS_MESSAGE_TYPE = "worktree-focus-note";

/**
 * The pieces of `pi` a session needs, so a test can supply three functions
 * rather than a whole fake `pi`.
 *
 * Picked from `ExtensionAPI` rather than re-declared: hand-written signatures
 * drift from pi's, and the compiler only catches it at the call site.
 */
export type SessionPi = GitRunner & Pick<ExtensionAPI, "appendEntry" | "sendMessage">;

export interface SessionOptions {
	pi: SessionPi;
	ui: Ui;
	/** The live context for this session. */
	ctx: ExtensionContext;
	/** Undefined outside a git repository; the session still exists. */
	repo: RepoInfo | undefined;
	/**
	 * jimothy's worktree model, or undefined when it could not be opened.
	 *
	 * Per-session rather than per-process because the repository it is opened
	 * over is: a replaced session can be standing in a different repository, or
	 * the same one with different config, and must not inherit the old one's
	 * model. Its deps carry this session's `abort` signal, so a child it starts
	 * cannot outlive the session that started it. Stated explicitly, like `repo`,
	 * so a missed wiring cannot hide behind a default.
	 */
	model: Model | undefined;
	/**
	 * Aborted when this session ends, and handed to the model's deps so a child
	 * it started cannot outlive it. Owned by the session rather than created per
	 * call: a `/reload` replaces the session, and the replacement must not be
	 * able to cancel the outgoing one's work or inherit its cancellation.
	 */
	abort: AbortController;
	config?: WorktreeConfig;
	/** Config files that were applied, for `/worktree config`. */
	configSources?: string[];
	/**
	 * Called with the branch the session displays, whenever it is painted.
	 *
	 * A plain function rather than a herdr dependency: `session.ts` owns state
	 * with a lifetime, and what consumes that state is `index.ts`'s business.
	 */
	report?: (branch: string | undefined) => void;
}

export interface WorktreeSession {
	readonly ctx: ExtensionContext;
	readonly repo: RepoInfo | undefined;
	readonly model: Model | undefined;
	readonly abort: AbortController;
	readonly config: WorktreeConfig;
	readonly configSources: string[];
	readonly focus: FocusTarget | undefined;
	/**
	 * The worktree leases this session holds.
	 *
	 * Deliberately not persisted, unlike focus: a lease is a fact about a live
	 * process, so one restored from a transcript would be a claim about a pid that
	 * died with the session that wrote it.
	 */
	readonly leases: readonly HeldLease[];
	readonly prMonitor: PrMonitor;
	/** Redirect (or stop redirecting) tool calls, persisting the choice. */
	setFocus: (ctx: ExtensionContext, target: FocusTarget | undefined, announce?: boolean) => void;
	/** Adopt focus restored from the transcript, without announcing or persisting it. */
	restoreFocus: (target: FocusTarget | undefined) => void;
	/**
	 * Record a lease this session took, replacing any it already held on that
	 * worktree and cancelling any release queued for it.
	 */
	addLease: (lease: HeldLease) => void;
	/** Forget a lease this session held, returning it so the caller can release it. */
	dropLease: (path: string) => HeldLease | undefined;
	/**
	 * Release this lease when the agent next settles, not now: focus is applied
	 * at `tool_call` time, so a call already in flight is still writing into that
	 * worktree, and releasing it would invite a second agent into a directory
	 * being written.
	 */
	deferRelease: (lease: HeldLease) => void;
	/**
	 * Take a queued release back out of the queue, if there is one for that path.
	 *
	 * The queue's other half: without it a pending release can only be drained, and
	 * two callers need to *see* one. A transition returning to a worktree whose
	 * release is still queued has to cancel it before it reads the registry — a
	 * drain landing in between frees the lease the transition then records. And
	 * `/worktree remove` has to hand our own lease back before jimothy will remove
	 * the worktree, which `dropLease` alone cannot do for a lease that is merely
	 * pending: the removal was refused, naming this very session as the holder.
	 *
	 * Returned rather than released, like `dropLease`: whoever cancels it decides
	 * whether it is being taken back or given away.
	 */
	cancelRelease: (path: string) => HeldLease | undefined;
	/**
	 * The releases still queued, for a test to observe without draining it.
	 *
	 * Tests only — nothing in this extension calls it. `readonly` is a
	 * compile-time label, not a runtime one: the array underneath is `deferred`
	 * itself, and the tests that read this are `.mjs`, so nothing stops one from
	 * mutating it. Do not wire production logic to it on the strength of the type.
	 */
	readonly deferredReleases: readonly HeldLease[];
	/**
	 * Take the next queued release, leaving the rest of the queue where it is.
	 *
	 * One at a time rather than all at once, because a release is not instant: it
	 * takes the registry's lock. Emptying the queue up front made every entry after
	 * the first invisible for the whole drain — `cancelRelease` would find nothing,
	 * so a transition returning to one of those worktrees could not take it back and
	 * the drain went on to free a worktree the session had just recorded as held.
	 * Popped one at a time, the rest of the queue stays cancellable while a release
	 * is in flight.
	 *
	 * Not empty after a dispose — `dispose()` never clears `deferred`, only
	 * `deferRelease` goes inert, so a transition that drops a lease after that point
	 * has nowhere left to queue it. An entry queued before the dispose is still
	 * handed back here: it is what `session_shutdown`'s own drain runs over. The
	 * existing test proves only the first half — that `deferRelease` refuses a new
	 * entry once disposed — not this one, since nothing there calls
	 * `nextDeferredRelease` after a dispose.
	 */
	nextDeferredRelease: () => HeldLease | undefined;
	/** Repaint the footer segment. */
	paint: (ctx: ExtensionContext) => void;
	/** Retire the session: its monitor stops and everything in flight goes inert. */
	dispose: () => void;
}

export function createSession(options: SessionOptions): WorktreeSession {
	const { pi, ui, ctx, repo, model, abort } = options;
	const config = options.config ?? { ...DEFAULT_CONFIG };
	const configSources = options.configSources ?? [];
	const report = options.report ?? (() => {});

	let focus: FocusTarget | undefined;
	const leases: HeldLease[] = [];
	/** Leases dropped by a transition, waiting for the agent to settle. */
	const deferred: HeldLease[] = [];
	let disposed = false;

	/**
	 * Paint the footer segment: focused worktree, PR, or both.
	 *
	 * Unfocused sessions show the PR alone — pi's own footer line already reads
	 * `<pwd> (<branch>)`, so the branch is not lost.
	 */
	const paint = (target: ExtensionContext) => {
		if (disposed) return;
		const parts: string[] = [];
		if (focus) {
			const label = focus.branch ? `${basename(focus.path)} (${focus.branch})` : basename(focus.path);
			parts.push(`⑂ ${label}`);
		}
		const pr = prMonitor.label();
		if (pr) parts.push(pr);
		ui.setStatus(target, parts);
		// The branch on screen, not the session's: while focused, the footer and
		// herdr both show the focused worktree's branch. Undefined is a real
		// value here — a detached HEAD clears rather than showing a SHA.
		report(focus ? focus.branch : repo?.branch);
	};

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
		paint: () => paint(ctx),
		hasUI: () => !disposed && ctx.hasUI,
	});

	const setFocus = (target: ExtensionContext, next: FocusTarget | undefined, announce = true) => {
		focus = next;
		paint(target);
		// Repaint from cache above, then reconcile the new target in background.
		prMonitor.refresh();

		// State lives in a custom *entry*: it is written to the transcript now.
		// A custom message with deliverAs "nextTurn" is only queued in memory, so
		// focus would be lost by a /reload before the next prompt.
		pi.appendEntry(FOCUS_ENTRY_TYPE, next ? { path: next.path, branch: next.branch } : {});

		if (!announce) return;

		const content = next
			? `Working directory is now the git worktree \`${next.path}\`` +
				(next.branch ? ` (branch \`${next.branch}\`).` : ".") +
				` Relative paths and bash commands resolve there. Absolute paths outside that worktree are unchanged.`
			: `Worktree focus cleared. Working directory is back to \`${repo?.worktreeRoot ?? target.cwd}\`.`;

		pi.sendMessage({ customType: FOCUS_MESSAGE_TYPE, content, display: true }, { deliverAs: "nextTurn" });
	};

	return {
		ctx,
		repo,
		model,
		abort,
		config,
		configSources,
		get focus() {
			return focus;
		},
		get leases() {
			return leases;
		},
		prMonitor,
		setFocus,
		restoreFocus: (target) => {
			focus = target;
		},
		// Replaced rather than appended: the retarget path can re-decide against the
		// worktree's current owner and end up holding the same one twice, and a
		// duplicate would be released twice — the second release landing on whatever
		// lease had been taken in between.
		addLease: (lease) => {
			const existing = leases.findIndex((held) => held.name === lease.name);
			if (existing === -1) leases.push(lease);
			else leases[existing] = lease;
			// Taking a worktree back cancels the release it was queued for, and this is
			// the symmetrical partner of the replace-by-name rule above: one place owns
			// "this session holds it again". Two transitions inside one non-idle turn —
			// focus beta, then focus off — leave alpha queued from the first and
			// re-acquired by the second, and a drain that still named it would release a
			// worktree the agent is writing in, which is exactly the unleased-agent
			// failure the transition exists to prevent. The runId guard does not help:
			// both leases are this session's, under the same run id.
			for (let index = deferred.length - 1; index >= 0; index--) {
				if (deferred[index].name === lease.name) deferred.splice(index, 1);
			}
		},
		// Returned rather than released here: this object owns state, not the
		// registry, and whoever dropped the lease is the one who knows whether it can
		// be given back now or has to wait for the agent to settle.
		dropLease: (path) => {
			const index = leases.findIndex((held) => held.path === path);
			return index === -1 ? undefined : leases.splice(index, 1)[0];
		},
		// Inert once disposed, like paint(): a replaced session will never drain this
		// queue, and a lease parked on it would be one nothing releases. A caller that
		// got this far with a disposed session has already lost its race — every one of
		// them re-checks first — so dropping it here is the last line of that defence,
		// not the only one.
		deferRelease: (lease) => {
			if (disposed) return;
			deferred.push(lease);
		},
		// By path, like `dropLease`, because both callers know where the agent was
		// writing rather than what the registry calls it — and the two are
		// interchangeable here, since `addLease` keeps at most one entry per worktree.
		cancelRelease: (path) => {
			const index = deferred.findIndex((lease) => lease.path === path);
			return index === -1 ? undefined : deferred.splice(index, 1)[0];
		},
		get deferredReleases() {
			return deferred;
		},
		nextDeferredRelease: () => deferred.shift(),
		paint,
		dispose: () => {
			// Before the monitor, so anything awaiting a model call sees the
			// cancellation rather than a disposed monitor's error.
			abort.abort();
			disposed = true;
			prMonitor.dispose();
		},
	};
}
