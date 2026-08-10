/**
 * Output for the worktree extension.
 *
 * Every path here exists because pi has three output situations, not one:
 *
 *  - **interactive** (`hasUI`): notifications, a widget, a status segment.
 *  - **print** (`pi -p`): `ctx.ui.*` are no-ops, so anything worth saying has to
 *    go to stdout or the user sees silence.
 *  - **headless / JSON**: no UI and not print — say nothing.
 *
 * Getting that matrix wrong is invisible in interactive use, which is why it is
 * isolated here and tested directly.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SayLevel = "info" | "warning" | "error";

export interface Ui {
	/** Emit a one-line message. */
	say: (ctx: ExtensionContext, message: string, level?: SayLevel) => void;
	/** Render a block of information: widget when interactive, stdout in print. */
	report: (ctx: ExtensionContext, title: string, lines: string[]) => void;
	/** Remove the report, if one is on screen. */
	clearReport: (ctx: ExtensionContext) => void;
	/** Paint the footer segment from already-composed parts, or clear it. */
	setStatus: (ctx: ExtensionContext, parts: string[]) => void;
	/** Write a parting message to stdout as the process exits. */
	farewell: (ctx: ExtensionContext, lines: string[]) => void;
	/** Drop both the segment and the widget, whether or not one was shown. */
	clearAll: (ctx: ExtensionContext) => void;
}

export interface UiOptions {
	/** Key for the status segment and widget slots. */
	statusKey: string;
	/** Prefix for one-line messages. */
	prefix: string;
	/** Injectable for tests. */
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

export function createUi(options: UiOptions): Ui {
	const { statusKey, prefix } = options;
	const stdout = options.stdout ?? ((text) => process.stdout.write(text));
	const stderr = options.stderr ?? ((text) => process.stderr.write(text));

	/** True while a report widget is on screen, so the next input can clear it. */
	let widgetShown = false;

	const say = (ctx: ExtensionContext, message: string, level: SayLevel = "info") => {
		if (ctx.hasUI) {
			ctx.ui.notify(`${prefix}: ${message}`, level);
			return;
		}
		if (ctx.mode === "print") {
			const write = level === "error" ? stderr : stdout;
			write(`${prefix}: ${message}\n`);
		}
	};

	/**
	 * The widget is cleared on the next user input rather than on a timer: a timer
	 * would fire with a captured `ctx`, which is stale after session replacement
	 * or shutdown and throws.
	 */
	const report = (ctx: ExtensionContext, title: string, lines: string[]) => {
		const block = [title, ...lines.map((line) => `  ${line}`)];
		if (ctx.hasUI) {
			ctx.ui.setWidget(statusKey, block);
			widgetShown = true;
			return;
		}
		if (ctx.mode === "print") stdout(`${block.join("\n")}\n`);
	};

	const clearReport = (ctx: ExtensionContext) => {
		if (!widgetShown || !ctx.hasUI) return;
		ctx.ui.setWidget(statusKey, undefined);
		widgetShown = false;
	};

	/**
	 * With no parts the segment is cleared rather than left showing something
	 * stale.
	 */
	const setStatus = (ctx: ExtensionContext, parts: string[]) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(statusKey, parts.length > 0 ? parts.join(" ") : undefined);
	};

	/**
	 * Say something on the way out.
	 *
	 * Deliberately *not* `say`: at quit the TUI is being torn down, so a notify
	 * lands on a surface that is about to be erased. stdout is the only channel
	 * that survives into the user's scrollback. This works because pi renders
	 * inline by default — under `tui.altScreen` fullscreen the write is lost with
	 * the alternate buffer, which is why this is a nicety and not a mechanism
	 * anything depends on.
	 *
	 * Silent outside `tui` and `print`: in `json` and `rpc` modes stdout is a
	 * protocol stream, and a stray human-readable line corrupts it.
	 */
	const farewell = (ctx: ExtensionContext, lines: string[]) => {
		if (lines.length === 0) return;
		if (ctx.mode !== "tui" && ctx.mode !== "print") return;
		stdout(`${lines.join("\n")}\n`);
	};

	/** Shutdown: leave nothing painted for the next session to inherit. */
	const clearAll = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(statusKey, undefined);
		ctx.ui.setWidget(statusKey, undefined);
		widgetShown = false;
	};

	return { say, report, clearReport, setStatus, farewell, clearAll };
}
