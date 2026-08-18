/**
 * jimothy's worktree model, as this extension reaches it.
 *
 * The model is pi-free by construction: it runs in a bare shell for
 * `jimothy wt ls` and the picker. Everything it does to the outside world goes
 * through an injected `Deps`, and this file is the implementation of that
 * interface for a process that *is* pi.
 *
 * Why not `defaultDeps`: jimothy's own implementation puts a timed child in its
 * own process group and kills it from a `process.once("exit")` hook, which is
 * safe only because jimothy's terminal guard turns every signal into an explicit
 * exit. Inside pi neither is true, and the child that would be orphaned is the
 * long one — an install. `pi.exec` already owns child lifetime, cancellation and
 * timeouts in pi's process, so this hands all of that back to pi.
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
	type Deps,
	type JimothyConfig,
	loadConfig,
	readRepoInfo,
	Registry,
	type RepoInfo,
	type RunOptions,
	type RunResult,
} from "jimothy/worktrees";

/** Minimal surface this file needs: something that can run a command. */
export interface CommandRunner {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * The longest this extension lets a model-initiated child run.
 *
 * The model asks for fifteen minutes, which is right for a launcher sitting on a
 * terminal it has already cleared and wrong for a slash command: a session
 * wedged for a quarter of an hour on a credential prompt is unrecoverable, not
 * slow. Five minutes is long enough for a cold install of a large repository and
 * short enough that a wedged one is a delay rather than a lost afternoon.
 */
export const INSTALL_TIMEOUT_CEILING_MS = 5 * 60_000;

export interface DepsOptions {
	/**
	 * Aborted when the session that opened these deps ends. `session.ts` owns
	 * the controller and aborts it in `dispose()`, and `index.ts` hands its
	 * signal to `openModel` at `session_start`, so a child a model call starts
	 * here is cancelled the moment the session that started it is gone, rather
	 * than running to completion or its own timeout regardless.
	 */
	signal?: AbortSignal;
	/** Overridable for tests; defaults to `INSTALL_TIMEOUT_CEILING_MS`. */
	timeoutCeilingMs?: number;
}

/**
 * One signal for pi out of the two reasons a child here can be stopped: the
 * session ending, and the single call that started it being cancelled.
 *
 * `pi.exec` takes one `signal`, and neither reason may be dropped — a cancelled
 * `worktree` tool call must stop its install, and a session that ends under an
 * install must stop it too. The single-signal cases are passed through by
 * identity rather than wrapped, so a caller (and a test) can still see which
 * signal reached pi; `AbortSignal.any` is only for the case that needs it.
 */
const eitherSignal = (session?: AbortSignal, call?: AbortSignal): AbortSignal | undefined => {
	if (session === undefined) return call;
	if (call === undefined) return session;
	return AbortSignal.any([session, call]);
};

export function createDeps(runner: CommandRunner, options: DepsOptions = {}): Deps {
	const ceiling = options.timeoutCeilingMs ?? INSTALL_TIMEOUT_CEILING_MS;

	return {
		async run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
			// pi's `ExecOptions` has no way to set a child's environment — `signal`,
			// `timeout` and `cwd` are the whole surface. Refusing beats dropping
			// `env` silently and letting a caller that depends on it fail later,
			// somewhere that gives no hint the environment was ever the problem.
			if (opts.env !== undefined) {
				throw new Error(
					"worktree: pi's exec cannot set a child's environment; the model must not ask for one from inside pi",
				);
			}
			// Clamped rather than passed through: see INSTALL_TIMEOUT_CEILING_MS.
			const timeout = opts.timeoutMs === undefined ? undefined : Math.min(opts.timeoutMs, ceiling);
			// The caller's signal as well as the session's: the model forwards one to the
			// install alone, and that is how a cancelled tool call stops an install
			// instead of leaving it to run until the session ends.
			const signal = eitherSignal(options.signal, opts.signal);
			const result = await runner.exec(command, args, {
				...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
				...(timeout === undefined ? {} : { timeout }),
				...(signal === undefined ? {} : { signal }),
			});
			// `killed` covers a timeout and an abort alike, and the model tells the
			// user something different for each — so the distinction is made here,
			// where the two causes are still distinguishable. `aborted` is reported
			// rather than left for the model to infer from the signal, because a
			// signal stays aborted for the rest of its life: an abort arriving just
			// after a *successful* install must not turn it into a cancellation.
			// This is a snapshot at resolution time, not an ordering of the two
			// causes: a genuine timeout whose kill is raced by an abort that lands
			// just before `exec` resolves is reported as an abort, not a timeout.
			// Fixing that needs a local timer racing pi's own, which was rejected on
			// purpose — it would reintroduce the second source of truth for child
			// lifetime that this file exists to hand back to pi, to fix one misworded
			// message about a run somebody was cancelling anyway.
			const aborted = result.killed && signal?.aborted === true;
			const timedOut = result.killed && timeout !== undefined && !aborted;
			return {
				code: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
				...(timedOut ? { timedOut: true } : {}),
				...(aborted ? { aborted: true } : {}),
			};
		},

		spawn(): never {
			// Nothing reachable from `jimothy/worktrees` spawns: the launcher that
			// does is not part of the published model. Throwing beats returning a
			// fake, which would fail later and further away.
			throw new Error("worktree: the jimothy model must not spawn from inside pi");
		},

		isPidAlive(pid: number): boolean {
			if (!Number.isInteger(pid) || pid <= 0) return false;
			try {
				// Signal 0 performs the existence and permission checks without
				// delivering anything.
				process.kill(pid, 0);
				return true;
			} catch (error) {
				// EPERM means the process exists and belongs to another user.
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		},

		now(): Date {
			return new Date();
		},
	};
}

/** Everything a registry call needs, resolved once per session. */
export interface Model {
	registry: Registry;
	deps: Deps;
	/**
	 * jimothy's view of the repository, which is a different shape from the
	 * extension's `RepoInfo` in `lib/git.ts` and must not be confused with it:
	 * registry operations take this one, display keeps the extension's.
	 */
	info: RepoInfo;
	config: JimothyConfig;
}

/**
 * Open the model for a working directory.
 *
 * Rejects when the directory is not in a git repository, or when
 * `jimothy.config.json` is unreadable — both of which the caller reports and
 * neither of which is fatal to a session.
 */
export async function openModel(runner: CommandRunner, cwd: string, options: DepsOptions = {}): Promise<Model> {
	const deps = createDeps(runner, options);
	const info = await readRepoInfo(deps, cwd);
	// The main working tree, not the invoking one: config lives at the repository
	// root, and reading it from a linked worktree would make the layout depend on
	// where the session happens to be.
	const config = await loadConfig(info.mainWorktree);
	return { registry: Registry.open(deps, info, config), deps, info, config };
}
