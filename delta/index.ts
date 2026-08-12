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
 * else (containers, SSH) must not be combined with this one. `enabled: false` in
 * `delta.json` is the escape hatch.
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

/** Minimal shape of the render context pi hands a renderer. */
interface RenderContext {
	args: Record<string, unknown> | undefined;
	cwd: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	isError: boolean;
	lastComponent: unknown;
	executionStarted: boolean;
}

export default function deltaExtension(pi: ExtensionAPI): void {
	let config: DeltaConfig = { ...DEFAULT_CONFIG };
	let version = configVersion(DEFAULT_CONFIG);
	let patterns: RegExp[] = [];
	/** The live session, for the one notice this extension can emit. */
	let session: ExtensionContext | undefined;

	const cache = createCache();
	const runner = createRunner({ config: () => config });
	const engine = createEngine({
		cache,
		runner,
		config: () => config,
		version: () => version,
		onUnavailable: () => {
			const ctx = session;
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.notify(
					`delta: ${config.command} is not on PATH; using pi's built-in diff rendering.`,
					"warning",
				);
			} catch {
				// The session was replaced between scheduling and this callback.
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Everything below is per-session: a resumed or forked session re-fires
		// this against a different transcript and must not inherit state.
		session = ctx;
		engine.reset();

		const loaded = await loadConfig({ projectRoot: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
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
	});

	// ---- bash: our own result component, for diff commands only ------------

	const bash = createBashToolDefinition(process.cwd());
	type BashSlots = typeof bash;
	const bashRenderResult: NonNullable<BashSlots["renderResult"]> = (result, options, theme, context) => {
		const command = String((context.args as { command?: unknown } | undefined)?.command ?? "");
		// Errors keep pi's rendering: the text is a message, not a diff.
		if (context.isError || !isDiffCommand(command, patterns)) {
			return bash.renderResult!(result, options, theme, context);
		}

		const state = context.state as { startedAt?: number; endedAt?: number };
		if (!options.isPartial) state.endedAt ??= Date.now();

		const details = result.details as Parameters<typeof bashWarnings>[0];
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n")
			.trim();
		const { body } = splitBashFooter(text, details);

		const component =
			(context.lastComponent as ReturnType<typeof createBashResult> | undefined) ??
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

	const editComponent = (context: RenderContext, theme: RenderTheme): EditComponent => {
		const existing = context.lastComponent as EditComponent | undefined;
		if (existing) return existing;
		const body = createDiffBody({
			engine,
			fallback: (diff) => renderDiff(diff),
			invalidate: context.invalidate,
		});
		const component: EditComponent = {
			head: "",
			body,
			settled: false,
			invalidate() {},
			render(width: number): string[] {
				if (component.error !== undefined) {
					return [component.head, "", theme.fg("error", component.error)];
				}
				return [component.head, ...body.render(width)];
			},
		};
		return component;
	};

	const editRenderCall: NonNullable<EditSlots["renderCall"]> = (args, theme, context) => {
		const component = editComponent(context as unknown as RenderContext, theme);
		component.head = header(args as Record<string, unknown>, theme, context.cwd);
		// pi re-renders the call slot while arguments stream, and can render it
		// again after the result. Clearing unconditionally would blank a settled
		// diff, so the flag is what keeps the applied diff on screen.
		if (!component.settled) component.body.set(undefined, undefined);
		return component;
	};

	const editRenderResult: NonNullable<EditSlots["renderResult"]> = (result, _options, theme, context) => {
		const component = editComponent(context as unknown as RenderContext, theme);
		component.head = header(context.args as Record<string, unknown>, theme, context.cwd);
		component.settled = true;
		if (context.isError) {
			component.error = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			component.body.set(undefined, undefined);
			return component;
		}
		const details = result.details as { diff?: string; patch?: string } | undefined;
		component.error = undefined;
		component.body.set(details?.patch, details?.diff);
		return component;
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
