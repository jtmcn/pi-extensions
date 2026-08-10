/**
 * Reporting pi's branch to herdr, the terminal workspace manager.
 *
 * herdr labels a space from its pane's cwd and derives the branch the same way.
 * In a bare layout (`proj/.bare` + `proj/main`) that reads `main`, and it keeps
 * reading `main` when the session moves to a feature branch — and when
 * `/worktree focus` points pi at a worktree, since focus rewrites tool inputs
 * rather than changing `cwd`. pi knows the real answer; this hands it over.
 *
 * A factory over an injected runner, with no `ctx` anywhere: a report that
 * settles after its session was replaced must be incapable of painting through
 * a stale context.
 *
 * The CLI's argument shape is measured against herdr 0.8.0, not documented
 * upstream: the positional comes FIRST and flags take a space-separated value.
 * `herdr workspace report-metadata --source pi ... wF` fails with "unknown
 * option: wF", and `--source=pi` fails with "unknown option: --source=pi".
 * The token value is a single `NAME=VALUE` argument.
 */

import type { GitRunner } from "./git.ts";

/** Cap on a single herdr call. It is a local socket; this is a wedged-socket guard. */
export const HERDR_TIMEOUT_MS = 2_000;

/** Source id on every report, so herdr scopes what we set to us. */
const SOURCE = "pi";

/** Workspace metadata token the sidebar row layout renders as `$pi_branch`. */
const BRANCH_TOKEN = "pi_branch";

export interface HerdrTarget {
	workspaceId: string;
	paneId: string;
}

/**
 * herdr's ids for the pane pi is running in, or undefined when pi is not
 * running under herdr. Both are needed: the branch goes to the workspace, the
 * title to the pane.
 */
export function herdrTarget(env: Record<string, string | undefined>): HerdrTarget | undefined {
	const workspaceId = env.HERDR_WORKSPACE_ID;
	const paneId = env.HERDR_PANE_ID;
	if (!workspaceId || !paneId) return undefined;
	return { workspaceId, paneId };
}

export interface HerdrReporterOptions {
	runner: GitRunner;
	target: HerdrTarget;
	/**
	 * Stripped from the branch before display. It is on every branch the user
	 * creates and the sidebar is 18–36 columns wide.
	 */
	branchPrefix?: string;
	/**
	 * False once a newer reporter exists for this herdr target. Defaults to true.
	 *
	 * A report is two sequential spawns and `clear()` awaits up to four, while a
	 * session can be replaced (`/new`, `/fork`, resume) at any await point in
	 * between. Every surface is keyed by the same workspace and pane id and the
	 * same `--source pi`, so the last write wins: a retired session finishing its
	 * writes overwrites the branch the new session has already reported. Checked
	 * after every await.
	 *
	 * `disposed` cannot serve here. `clear()` runs *after* the reporter is
	 * disposed — that is how shutdown works — so it needs a signal that means
	 * "someone else owns these ids now" rather than "this reporter is retired".
	 * A predicate rather than a `ctx` or a generation of its own: the reporter
	 * still holds no session state, and index.ts owns which reporter is current.
	 */
	isCurrent?: () => boolean;
}

export interface HerdrReporter {
	/** Report the branch pi is displaying; undefined means detached HEAD. */
	report: (branch: string | undefined) => void;
	/** Remove what this session reported. Awaited at shutdown, then inert. */
	clear: () => Promise<void>;
	/** Retire the reporter: later reports do nothing. */
	dispose: () => void;
}

export function createHerdrReporter(options: HerdrReporterOptions): HerdrReporter {
	const { runner, target } = options;
	const branchPrefix = options.branchPrefix ?? "";
	const isCurrent = options.isCurrent ?? (() => true);

	/** Last branch actually sent, so an unchanged paint costs nothing. */
	let last: string | undefined;
	/** Whether anything has been sent at all; `undefined` is a real value. */
	let sent = false;
	/**
	 * Set the moment the first herdr spawn is issued, before its Promise resolves.
	 * Unlike `sent`, this is true even when only the workspace call succeeded and
	 * the pane call failed — we still have partial state on screen that must be
	 * cleared.
	 */
	let issued = false;
	/** One call at a time; a report arriving mid-flight is remembered, not dropped. */
	let busy = false;
	let pending: { branch: string | undefined } | undefined;
	/** The currently executing report IIFE, so clear() can await it. */
	let inFlight: Promise<void> | undefined;
	/** Cleared by the first failure: no herdr, dead socket, unknown workspace. */
	let available = true;
	let disposed = false;

	const display = (branch: string | undefined): string | undefined =>
		branch && branchPrefix && branch.startsWith(branchPrefix) ? branch.slice(branchPrefix.length) : branch;

	/** Run herdr. False on any failure, including a runner that throws. */
	const run = async (args: string[]): Promise<boolean> => {
		try {
			const result = await runner.exec("herdr", args, { timeout: HERDR_TIMEOUT_MS });
			return result.code === 0 && !result.killed;
		} catch {
			return false;
		}
	};

	const workspaceArgs = (value: string | undefined): string[] => [
		"workspace",
		"report-metadata",
		target.workspaceId,
		"--source",
		SOURCE,
		...(value ? ["--token", `${BRANCH_TOKEN}=${value}`] : ["--clear-token", BRANCH_TOKEN]),
	];

	const paneArgs = (value: string | undefined): string[] => [
		"pane",
		"report-metadata",
		target.paneId,
		"--source",
		SOURCE,
		...(value ? ["--title", `π - ${value}`] : ["--clear-title"]),
	];

	const send = async (branch: string | undefined): Promise<void> => {
		const value = display(branch);
		// Sequential, not Promise.all: two writes to the same socket for one
		// decoration, and the second is pointless once the first has failed.
		issued = true;
		const workspaceOk = await run(workspaceArgs(value));
		// A newer reporter took over while that spawn was in flight: it has already
		// reported its own branch, and the pane write below would put ours back on
		// top of it.
		if (!isCurrent()) return;
		const paneOk = workspaceOk && (await run(paneArgs(value)));
		if (!workspaceOk || !paneOk) {
			available = false;
			return;
		}
		last = branch;
		sent = true;
	};

	const report = (branch: string | undefined): void => {
		if (disposed || !available) return;
		if (sent && last === branch) return;
		if (busy) {
			pending = { branch };
			return;
		}
		busy = true;
		inFlight = (async () => {
			try {
				await send(branch);
			} finally {
				busy = false;
				const next = pending;
				pending = undefined;
				if (next) report(next.branch);
			}
		})().catch(() => {});
	};

	const clear = async (): Promise<void> => {
		// Retire first: a paint racing shutdown must not re-report after the clear.
		disposed = true;
		pending = undefined;
		// Let an in-flight report finish before clearing: the clear must land after
		// the report, not before it, or the report puts the branch straight back.
		// This also ensures `issued` is stable when we read it below.
		await inFlight;
		// No `available` check: a session that reported once and then hit a socket
		// error still has a stale branch on screen, and the clear is cheap.
		if (!issued) return;
		// The clear may have lost its race with the next session: `/new` fires
		// session_shutdown and then session_start, and the shutdown deadline
		// abandons — but cannot cancel — a slow clear. Clearing now would wipe the
		// branch the new session has already reported under the same ids.
		if (!isCurrent()) return;
		await run(workspaceArgs(undefined));
		if (!isCurrent()) return;
		await run(paneArgs(undefined));
	};

	return {
		report,
		clear,
		dispose: () => {
			disposed = true;
			pending = undefined;
		},
	};
}
