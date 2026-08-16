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
	/** Record a lease this session took, replacing any it already held on that worktree. */
	addLease: (lease: HeldLease) => void;
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
		},
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
