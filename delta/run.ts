/**
 * Running delta.
 *
 * Spawned without a shell: the command comes from config and the input is a
 * diff, so there is nothing a shell would add except a way to misparse it.
 *
 * Everything that can go wrong — missing binary, nonzero exit, timeout, empty
 * output — resolves to `undefined` rather than throwing. The caller's job is to
 * fall back to pi's rendering, and there is no failure here it should treat
 * differently.
 */

import { spawn } from "node:child_process";
import { sanitize } from "./ansi.ts";
import type { DeltaConfig } from "./config.ts";

export interface SpawnResult {
	code: number | null;
	stdout: string;
	timedOut: boolean;
}

export type SpawnFn = (
	command: string,
	args: string[],
	input: string,
	timeoutMs: number,
) => Promise<SpawnResult>;

export const nodeSpawn: SpawnFn = (command, args, input, timeoutMs) =>
	new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "", timedOut: false });
			return;
		}

		let stdout = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, timedOut });
		};

		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		// A missing binary surfaces here, not as a throw from spawn().
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
		// delta can exit before it has read the whole diff; that EPIPE is expected.
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});

export interface Runner {
	/** Whether the configured binary exists and runs. Memoized per session. */
	available(): Promise<boolean>;
	/** Delta's rendering of `text` at `width`, or undefined on any failure. */
	render(text: string, width: number): Promise<string | undefined>;
	/** Forget the availability probe. Called on session_start. */
	reset(): void;
}

/** Delta's own minimum useful width; narrower terminals get this instead. */
const MIN_WIDTH = 20;

export function createRunner(deps: { config: () => DeltaConfig; spawn?: SpawnFn }): Runner {
	const run = deps.spawn ?? nodeSpawn;
	let probe: Promise<boolean> | undefined;

	return {
		available() {
			// One probe per session: PATH does not change under us, and a missing
			// binary must not cost a process per diff.
			probe ??= run(deps.config().command, ["--version"], "", 2000).then((result) => result.code === 0 && !result.timedOut);
			return probe;
		},
		async render(text, width) {
			const config = deps.config();
			const args = [
				"--paging",
				"never",
				"--width",
				String(Math.max(MIN_WIDTH, Math.floor(width))),
				// User args last so they beat both these flags and git config.
				...config.args,
			];
			const result = await run(config.command, args, text, config.timeoutMs);
			if (result.timedOut || result.code !== 0) return undefined;
			const output = sanitize(result.stdout).replace(/\n+$/, "");
			return output.trim() ? output : undefined;
		},
		reset() {
			probe = undefined;
		},
	};
}
