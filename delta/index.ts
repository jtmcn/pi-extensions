/**
 * Delta-rendered diffs for pi.
 *
 * Wraps two built-in tools for *rendering only*: `execute`, `parameters`, and
 * prompt metadata are the built-in definition's, spread through untouched, so
 * the model sees no difference and result shapes are unchanged. What changes is
 * the component pi paints.
 *
 * Why a wrapper at all: pi resolves each render slot as
 * `extensionDefinition.renderX ?? builtInDefinition.renderX`, and there is no
 * renderer-only registration API. Registering a tool named `bash` is the only
 * way to reach that slot — which means an extension that routes bash somewhere
 * else (containers, SSH) must not be combined with this one. Registration
 * happens unconditionally at factory time, before any config is loaded, so
 * `enabled: false` cannot help here: it only stops text reaching delta. The
 * only way to avoid the conflict is to not load this extension.
 *
 * `write` is not wrapped: it has no diff. Its `execute` returns
 * `details: undefined` and its result renders only errors.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	renderDiff,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { plain } from "./ansi.ts";
import { createBashResult } from "./bash-result.ts";
import { createDiffBody } from "./body.ts";
import { createCache } from "./cache.ts";
import { configVersion, DEFAULT_CONFIG, type DeltaConfig, loadConfig } from "./config.ts";
import { compilePatterns, isDiffCommand } from "./detect.ts";
import { createEngine } from "./engine.ts";
import { bashWarnings, splitBashFooter } from "./footer.ts";
import { createRunner } from "./run.ts";

/** Minimal shape of the theme pi hands a renderer. */
interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export default function deltaExtension(pi: ExtensionAPI): void {
	let config: DeltaConfig = { ...DEFAULT_CONFIG };
	let version = configVersion(DEFAULT_CONFIG);
	let patterns: RegExp[] = [];
	/** The live session, for the one notice this extension can emit. */
	let session: ExtensionContext | undefined;
	/**
	 * Bumped synchronously at the top of every `session_start`. A handler's
	 * continuation compares its own snapshot against this after the `await`;
	 * a mismatch means a newer session has already started, and the older
	 * handler must not assign module state or touch its (now stale) `ctx`.
	 */
	let sessionGeneration = 0;

	/**
	 * Wrap text to a render width, ANSI-aware.
	 *
	 * pi's renderer throws "Rendered line N exceeds terminal width" and stops the
	 * TUI when a component emits a line wider than the width it was handed;
	 * `Box.render` pads but never clips. pi's own renderers avoid this by putting
	 * text in a `Text`, which wraps — and `truncateToVisualLines` is a `Text`
	 * render underneath, so with an unbounded line budget it is exactly that
	 * wrapper.
	 */
	const wrap = (text: string, width: number): string[] =>
		truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width).visualLines;

	const cache = createCache();
	const runner = createRunner({ config: () => config });
	const engine = createEngine({
		cache,
		runner,
		config: () => config,
		version: () => version,
		onUnavailable: () => {
			const ctx = session;
			if (!ctx) return;
			try {
				const message = `delta: ${config.command} is not on PATH; using pi's built-in diff rendering.`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else if (ctx.mode === "print") process.stdout.write(`${message}\n`);
			} catch {
				// The session was replaced between scheduling and this callback.
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Everything below is per-session: a resumed or forked session re-fires
		// this against a different transcript and must not inherit state. The
		// generation snapshot guards the *other* half of that: a session_start
		// whose config load is still in flight when a newer one starts must not
		// assign config/version/patterns or touch `ctx` after the newer session
		// has already superseded it — that ctx is stale by then.
		sessionGeneration += 1;
		const generation = sessionGeneration;
		session = ctx;
		engine.reset();

		const loaded = await loadConfig({ projectRoot: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (generation !== sessionGeneration) return;

		config = loaded.config;
		version = loaded.version;

		const warnings = [...loaded.warnings];
		patterns = compilePatterns(config.extraCommands, warnings);
		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(`delta: ${warning}`, "warning");
			else if (ctx.mode === "print") process.stdout.write(`delta: ${warning}\n`);
		}
	});

	pi.on("session_shutdown", () => {
		session = undefined;
		// The shutdown window is another chance for an in-flight run to land in a
		// session that no longer exists: bump the generation here too, so anything
		// still running is dropped rather than cached or painted.
		engine.reset();
	});

	// ---- bash: our own result component, for diff commands only ------------

	const bash = createBashToolDefinition(process.cwd());
	type BashSlots = typeof bash;
	const bashRenderResult: NonNullable<BashSlots["renderResult"]> = (result, options, theme, context) => {
		const command = String((context.args as { command?: unknown } | undefined)?.command ?? "");
		// pi's bash `execute` calls `onUpdate` immediately, so a diff command's
		// partial result is rendered — by us — before an error can arrive, and
		// `lastComponent` is then ours. pi's built-in does
		// `context.lastComponent ?? new BashResultRenderComponent()` and then
		// `component.clear()`, so handing it our component throws a TypeError
		// inside pi's renderer; pi catches that and dumps the whole untruncated
		// output with no preview, hint, warning, or timing.
		// `git diff --exit-code`, `git diff --quiet`, `git show <bad-ref>` and
		// `git diff` outside a repo all take this path.
		const previous = context.lastComponent as ReturnType<typeof createBashResult> | undefined;
		const ours = typeof (previous as { update?: unknown } | undefined)?.update === "function";

		// Errors keep pi's rendering: the text is a message, not a diff.
		if (context.isError || !isDiffCommand(command, patterns)) {
			return bash.renderResult!(result, options, theme, ours ? { ...context, lastComponent: undefined } : context);
		}

		const state = context.state as { startedAt?: number; endedAt?: number };
		if (!options.isPartial) state.endedAt ??= Date.now();

		const details = result.details as Parameters<typeof bashWarnings>[0];
		// `plain` matches pi's `getTextOutput`, which strips ANSI and carriage
		// returns before styling. Without it, `git -c color.ui=always diff` feeds
		// its own escapes to delta and to the fallback styler, and a CRLF repo puts
		// raw `\r` into pi's frame.
		const text = plain(
			result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n"),
		).trim();
		const { body } = splitBashFooter(text, details);

		const component =
			(ours ? previous : undefined) ??
			createBashResult({
				engine,
				theme,
				fallback: (value) =>
					value
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
						.join("\n"),
				invalidate: context.invalidate,
				truncate: (value, maxLines, width) => truncateToVisualLines(value, maxLines, width),
				wrap,
				// Same wording as pi's own hint (bash.js), minus its width clamp:
				// the hint is short enough that truncating it never applies.
				expandHint: (skipped) =>
					`${theme.fg("muted", `... (${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
			});

		component.update({
			body,
			warnings: bashWarnings(details),
			expanded: options.expanded,
			timing:
				state.startedAt === undefined
					? undefined
					: {
							label: options.isPartial ? "Elapsed" : "Took",
							ms: (state.endedAt ?? Date.now()) - state.startedAt,
						},
		});
		return component;
	};
	pi.registerTool({
		...bash,
		renderResult: bashRenderResult,
	});

	// ---- edit: header while pending, delta diff once settled ---------------
	//
	// pi keeps the call and result renderer components separate
	// (`callRendererComponent` / `resultRendererComponent` in
	// tool-execution.js's `ToolExecutionComponent`): each slot gets its own
	// `lastComponent`, and once a result exists pi paints *both* into the same
	// container. `context.state`, in contrast, is one object shared by both
	// slots for the whole tool call. So our one on-screen component has to live
	// in `context.state`, not `lastComponent` — a component built from
	// `lastComponent` in the result slot never sees the call slot's component,
	// and a real session then shows the header (and, once settled, the diff)
	// twice. pi's own built-in `edit` definition solves this the same way:
	// `context.state.callComponent`, mutated from `renderResult`, with
	// `renderResult` itself returning nothing to display
	// (`core/tools/edit.js`'s `formatEditResult`/`getEditCallRenderComponent`).

	const edit = createEditToolDefinition(process.cwd());
	type EditSlots = typeof edit;

	/** `edit <path>`, in pi's colours. */
	const header = (args: Record<string, unknown> | undefined, theme: RenderTheme, cwd: string): string => {
		const raw = String(args?.path ?? args?.file_path ?? "");
		const display = raw.startsWith(`${cwd}/`) ? raw.slice(cwd.length + 1) : raw || "...";
		return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", display)}`;
	};

	interface EditComponent {
		render(width: number): string[];
		invalidate(): void;
		head: string;
		body: ReturnType<typeof createDiffBody>;
		/** Set once the result lands, so a later renderCall cannot wipe the diff. */
		settled: boolean;
		error?: string;
	}

	/** The one component both slots share, reached through `context.state`. */
	const editComponent = (state: Record<string, unknown>, theme: RenderTheme, invalidate: () => void): EditComponent => {
		const existing = state.editComponent as EditComponent | undefined;
		if (existing) return existing;
		const body = createDiffBody({
			engine,
			fallback: (diff) => renderDiff(diff),
			invalidate,
			wrap,
		});
		const component: EditComponent = {
			head: "",
			body,
			settled: false,
			invalidate() {},
			render(width: number): string[] {
				// Every line goes through `wrap`: an unwrapped header (a long path) or
				// error message is as fatal to pi's renderer as an unwrapped diff.
				const head = wrap(component.head, width);
				if (component.error !== undefined) {
					return [...head, "", ...wrap(theme.fg("error", component.error), width)];
				}
				return [...head, ...body.render(width)];
			},
		};
		state.editComponent = component;
		return component;
	};

	const editRenderCall: NonNullable<EditSlots["renderCall"]> = (args, theme, context) => {
		const component = editComponent(context.state, theme, context.invalidate);
		component.head = header(args as Record<string, unknown>, theme, context.cwd);
		// pi re-renders the call slot while arguments stream, and can render it
		// again after the result. Clearing unconditionally would blank a settled
		// diff, so the flag is what keeps the applied diff on screen.
		if (!component.settled) component.body.set(undefined, undefined);
		return component;
	};

	const editRenderResult: NonNullable<EditSlots["renderResult"]> = (result, _options, theme, context) => {
		const component = editComponent(context.state, theme, context.invalidate);
		component.head = header(context.args as Record<string, unknown>, theme, context.cwd);
		component.settled = true;
		if (context.isError) {
			component.error = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			component.body.set(undefined, undefined);
		} else {
			const details = result.details as { diff?: string; patch?: string } | undefined;
			component.error = undefined;
			component.body.set(details?.patch, details?.diff);
		}
		// The shared component above (reached through context.state) carries all
		// the content; the result slot itself must paint nothing, or a real
		// session shows the header and diff twice — once from each slot.
		return { render: () => [], invalidate() {} };
	};

	pi.registerTool({
		...edit,
		// No preview: computing one means forking pi's unexported computeEditsDiff,
		// and it would only be visible for the moment between the arguments
		// finishing and the edit landing.
		renderCall: editRenderCall,
		renderResult: editRenderResult,
	});
}
