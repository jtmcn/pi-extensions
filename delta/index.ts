/**
 * Delta-rendered diffs for pi.
 *
 * Wraps two built-in tools for *rendering only*: `parameters` and prompt
 * metadata are the built-in definition's, spread through untouched, and
 * `execute` delegates to a built-in definition built per call, so the model sees
 * no difference and result shapes are unchanged. What changes is the component
 * pi paints.
 *
 * Delegation, rather than spreading the built-in `execute` too: an extension
 * tool *replaces* the built-in in pi's execution registry, and pi builds its own
 * definitions with the session's cwd and the user's shell settings
 * (`createAllToolDefinitions(cwd, { bash: { commandPrefix, shellPath } })` in
 * agent-session.js). A definition built at factory time has the process's cwd
 * and no settings, so `execute` resolves them from the `ExtensionContext` it is
 * handed on every call instead. See `shell.ts`.
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
	type Theme,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { fill } from "./ansi.ts";
import { createBashResult } from "./bash-result.ts";
import { createDiffBody } from "./body.ts";
import { createCache } from "./cache.ts";
import { toolCollisions, type ToolSurvivor } from "./collision.ts";
import { configVersion, DEFAULT_CONFIG, type DeltaConfig, loadConfig } from "./config.ts";
import { compilePatterns } from "./detect.ts";
import { createEngine } from "./engine.ts";
import { bashWarnings, splitBashFooter } from "./footer.ts";
import {
	backgroundKey,
	bashCommand,
	displayPath,
	isOurComponent,
	resultText,
	timing,
	usesDelta,
} from "./render-rules.ts";
import { createRunner } from "./run.ts";
import { loadShellSettings, shellSettingsKey } from "./shell.ts";

/** Minimal shape of the theme pi hands a renderer. */
interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * A marker used only to split `theme.bg`'s output into its prefix and suffix.
 * A different Unicode Private Use Area code point than `FILL_SENTINEL` so the
 * two can never be confused mid-flight; it never reaches rendered output
 * because it is consumed by `.split()` in the same expression it is produced.
 */
const BG_PREFIX_MARKER = "\uE001";

/**
 * The ANSI prefix pi's own `Box.applyBg` puts at the start of a tool row —
 * `theme.bg(key, text)` is `${prefix}${text}\x1b[49m`, so running a marker
 * through it and splitting that back out gives the prefix without hardcoding
 * colour codes that change per theme. `key` is chosen the same way
 * `ToolExecutionComponent.updateDisplay` chooses `bgFn` — see `backgroundKey` in
 * `render-rules.ts`.
 */
function boxBackgroundPrefix(theme: Theme, key: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string {
	const [prefix] = theme.bg(key, BG_PREFIX_MARKER).split(BG_PREFIX_MARKER);
	return prefix ?? "";
}

export default function deltaExtension(pi: ExtensionAPI): void {
	/** The names this extension registers; surviving ownership is checked per session. */
	const OWNED_TOOLS = ["bash", "edit"] as const;
	/** This extension's own entry path, to compare against `getAllTools().sourceInfo`. */
	const ownPath = fileURLToPath(import.meta.url);

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

	/**
	 * Expand `sanitize`'s erase-in-line sentinel into the padding delta used it
	 * for. `visibleWidth` is pi's ANSI-aware width measurement, needed to know
	 * how much padding a coloured line is actually short of a full row; `fill`
	 * itself stays free of a `pi` import (see `delta/ansi.ts`).
	 */
	const fillWidth = (text: string, width: number): string => fill(text, width, visibleWidth);

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

	// ---- execution: pi's tools, built for the session rather than the process --
	//
	// The factory-time definitions below are only good for their render slots and
	// their schema/prompt metadata. Executing through them would pin the cwd to
	// whatever the process had when the extension loaded and drop the user's
	// `shellPath`/`shellCommandPrefix`, so `execute` builds (and memoizes) a
	// definition from the ExtensionContext it is handed instead.

	let bashDefinition: { key: string; tool: ReturnType<typeof createBashToolDefinition> } | undefined;
	let editDefinition: { key: string; tool: ReturnType<typeof createEditToolDefinition> } | undefined;

	const bashFor = async (ctx: ExtensionContext) => {
		const settings = await loadShellSettings({ projectRoot: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		const key = shellSettingsKey(ctx.cwd, settings);
		if (bashDefinition?.key !== key) {
			bashDefinition = { key, tool: createBashToolDefinition(ctx.cwd, settings) };
		}
		return bashDefinition.tool;
	};

	const editFor = (ctx: ExtensionContext) => {
		// `createEditToolDefinition` takes no shell options; only the cwd matters.
		if (editDefinition?.key !== ctx.cwd) {
			editDefinition = { key: ctx.cwd, tool: createEditToolDefinition(ctx.cwd) };
		}
		return editDefinition.tool;
	};

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
		// Built from the previous session's cwd and settings; both can differ now.
		bashDefinition = undefined;
		editDefinition = undefined;

		const loaded = await loadConfig({ projectRoot: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (generation !== sessionGeneration) return;

		config = loaded.config;
		version = loaded.version;

		const warnings = [...loaded.warnings];
		patterns = compilePatterns(config.extraCommands, warnings);

		// A second extension registering `bash` or `edit` beats us on the name
		// (first registration wins, and load order is readdir order), so delta's
		// renderer silently never runs for it. `getAllTools()` misses; the
		// survivor's `sourceInfo` reveals who to blame. Only checked when this
		// window is visible — `notify` needs `hasUI`, and print mode has no tools.
		if (ctx.hasUI) {
			try {
				const survivors: ToolSurvivor[] = (pi.getAllTools?.() ?? []).map((tool) => ({
					name: tool.name,
					path: tool.sourceInfo?.path ?? "",
					source: tool.sourceInfo?.source ?? "",
				}));
				for (const lost of toolCollisions(survivors, ownPath, OWNED_TOOLS)) {
					ctx.ui.notify(
						`delta: \`${lost.name}\` is owned by another extension (${lost.owner}); delta cannot render its diff.`,
						"warning",
					);
				}
			} catch {
				// A diagnostic; never take the session down over it.
			}
		}

		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(`delta: ${warning}`, "warning");
			else if (ctx.mode === "print") process.stdout.write(`delta: ${warning}\n`);
		}
	});

	pi.on("session_shutdown", () => {
		session = undefined;
		// The shutdown window is another chance for in-flight work to land in a
		// session that no longer exists, and there are two kinds of it. `engine.reset()`
		// bumps the *engine's* generation, so a delta subprocess still running is
		// dropped rather than cached or painted. `sessionGeneration` is the other one:
		// a `session_start` still awaiting `loadConfig` resumes after this and would
		// otherwise pass its generation check and notify through the ctx it captured,
		// which is stale once shutdown has fired.
		sessionGeneration += 1;
		engine.reset();
	});

	// ---- bash: our own result component, for diff commands only ------------

	const bash = createBashToolDefinition(process.cwd());
	type BashSlots = typeof bash;
	const bashExecute: BashSlots["execute"] = (toolCallId, params, signal, onUpdate, ctx) =>
		bashFor(ctx).then((tool) => tool.execute(toolCallId, params, signal, onUpdate, ctx));
	const bashRenderResult: NonNullable<BashSlots["renderResult"]> = (result, options, theme, context) => {
		// `lastComponent` can be ours even when this result has to go to pi's own
		// renderer, and handing pi our component crashes it — see `isOurComponent`.
		const previous = context.lastComponent as ReturnType<typeof createBashResult> | undefined;
		const ours = isOurComponent(previous);

		if (!usesDelta({ command: bashCommand(context.args), isError: context.isError, patterns })) {
			return bash.renderResult!(result, options, theme, ours ? { ...context, lastComponent: undefined } : context);
		}

		const state = context.state as { startedAt?: number; endedAt?: number };
		if (!options.isPartial) state.endedAt ??= Date.now();

		const details = result.details as Parameters<typeof bashWarnings>[0];
		const { body } = splitBashFooter(resultText(result.content), details);

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
				fill: fillWidth,
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
			// bash's Box wraps content + padding in one background span (see
			// restoreBackground's doc comment in delta/ansi.ts); this row's key
			// mirrors pi's own bgFn selection so the restored prefix matches
			// exactly what Box.applyBg would have painted at the row's start.
			// The error branch is unreachable today (isError returns above,
			// before this component is ever built) but mirrored for fidelity in
			// case that guard ever moves.
			bgPrefix: boxBackgroundPrefix(theme, backgroundKey({ isPartial: options.isPartial, isError: context.isError })),
			timing: timing({
				startedAt: state.startedAt,
				endedAt: state.endedAt,
				isPartial: options.isPartial,
				now: Date.now(),
			}),
		});
		return component;
	};
	pi.registerTool({
		...bash,
		execute: bashExecute,
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
	const editExecute: EditSlots["execute"] = (toolCallId, params, signal, onUpdate, ctx) =>
		editFor(ctx).execute(toolCallId, params, signal, onUpdate, ctx);

	/** `edit <path>`, in pi's colours. */
	const header = (args: Record<string, unknown> | undefined, theme: RenderTheme, cwd: string): string =>
		`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath(args, cwd))}`;

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
			fill: fillWidth,
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
			component.error = resultText(result.content);
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
		execute: editExecute,
		// No preview: computing one means forking pi's unexported computeEditsDiff,
		// and it would only be visible for the moment between the arguments
		// finishing and the edit landing.
		renderCall: editRenderCall,
		renderResult: editRenderResult,
	});
}
