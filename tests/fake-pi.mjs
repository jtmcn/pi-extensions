/**
 * A fake `pi` for testing an extension's wiring.
 *
 * Most of a well-factored extension needs no fake `pi` at all — the units take
 * injected dependencies. What does need one is `index.ts`: event handlers, tool
 * and command registration, and everything that only happens because a session
 * started, ended, or was replaced.
 *
 *   const h = createFakePi({ cwd });
 *   extension(h.pi);
 *   await h.fire("session_start");
 *   ok("painted", /⑂/.test(h.status() ?? ""));
 *
 * ## Why `fire("session_start")` mints a new context
 *
 * pi builds a fresh `ExtensionContext` per session and the previous one goes
 * *stale*: touching it throws and takes the process down. An extension closure
 * outlives the session it was created for, so anything that captured a `ctx` —
 * a timer, an in-flight fetch, a `.catch()` — must not use it after replacement.
 *
 * A harness that reuses one `ctx` across sessions cannot see that class of bug.
 * This one hands out a new context per `session_start` and records what each was
 * asked to do separately, so a test can assert that a superseded session never
 * painted or warned again. Three hand-rolled harnesses in this repo shared a
 * single `ctx`; only one of them could catch a missing disposal, which is why
 * this exists.
 *
 * ## Why `setHeader` calls the factory eagerly
 *
 * Real pi calls `factory(tui, theme)` immediately inside `setHeader`
 * (interactive-mode.js:1782) and disposes the previous component first
 * (:1773-1775). A harness that stores the factory and invokes it lazily in
 * `header()` cannot detect: (a) the disposal invariant, (b) whether the
 * component reads live state or a snapshot captured at factory time.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * @param options.exec  Intercept `pi.exec`. Return a result to answer the call,
 *                      or `undefined` to fall through to a real subprocess.
 * @param options.entries  What `ctx.sessionManager.getBranch()` returns.
 * @param options.systemPrompt  What `ctx.getSystemPrompt()` returns. Accepts a
 *                              string (same for every session) or a zero-arg
 *                              function called per `getSystemPrompt()` invocation,
 *                              so the caller can change it between sessions.
 * @param options.sessionId  What `ctx.sessionManager.getSessionId()` returns.
 * @param options.mode  What `ctx.mode` returns. Accepts a string (same for
 *                      every session) or a zero-arg function called per
 *                      `session_start`, so the caller can change it between
 *                      sessions. Follow the same shape as `systemPrompt`.
 */
export function createFakePi({
	cwd = process.cwd(),
	hasUI = true,
	mode: modeInput = "interactive",
	exec,
	entries = () => [],
	projectTrusted = false,
	systemPrompt: systemPromptInput = "",
	commands: commandInfos = () => [],
	sessionId = "fake-session-id",
	confirms = [],
	selects = [],
	inputs = [],
} = {}) {
	// A static string is the common case; a function lets tests change the
	// prompt between session_start fires without rebuilding the whole harness.
	const resolvePrompt = typeof systemPromptInput === "function"
		? systemPromptInput
		: () => systemPromptInput;
	// Same for mode: a function lets the same pi run TUI and non-TUI sessions.
	const resolveMode = typeof modeInput === "function" ? modeInput : () => modeInput;

	const events = new Map();
	const tools = new Map();
	const commands = new Map();
	const registrations = [];
	const execCalls = [];
	/** Everything written through any context, in order. */
	const statuses = [];
	const headers = [];
	const widgets = [];
	const notices = [];
	const appended = [];
	const sent = [];
	const contexts = [];
	/** Every prompt any context showed, in order, with what answered it. */
	const prompts = { confirm: [], select: [], input: [] };
	/** Contexts that called `ctx.shutdown()`. Recorded, never performed. */
	const shutdowns = [];
	// Queues rather than single values: a take-over asks, breaks the lease and
	// can ask again, and a test that silently reuses one answer for both would
	// pass while the code asked once.
	const answers = { confirm: [...confirms], select: [...selects], input: [...inputs] };

	const pi = {
		on(event, handler) {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
		},
		async exec(command, args, options = {}) {
			execCalls.push({ command, args, options });
			if (exec) {
				const answer = await exec(command, args, options);
				if (answer !== undefined) return answer;
			}
			try {
				const { stdout, stderr } = await pexec(command, args, { cwd: options.cwd });
				return { stdout, stderr, code: 0, killed: false };
			} catch (error) {
				return {
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? String(error),
					code: typeof error.code === "number" ? error.code : 1,
					killed: false,
				};
			}
		},
		registerTool(spec) {
			registrations.push(spec.name);
			tools.set(spec.name, spec);
		},
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
		getCommands: () => commandInfos(),
		appendEntry: (customType, data) => appended.push({ customType, data }),
		sendMessage: (message, options) => sent.push({ message, options }),
	};

	/**
	 * The component produced by the most recent `setHeader` call.
	 *
	 * Real pi stores exactly one header component and disposes the previous when
	 * `setHeader` is called again. This mirrors that behaviour so tests that
	 * check disposal or live-model reads see the real invariant.
	 */
	let currentComponent = undefined;

	/** Number of `requestRender` calls received across all header components. */
	let renderRequestCount = 0;

	/** Identity theme and a no-op tui, shared across all sessions. */
	const headerTheme = { fg: (_color, text) => text, bold: (text) => text };
	const headerTui = { requestRender() { renderRequestCount++; }, invalidate() {} };

	/** A context, recording its own writes as well as the aggregate ones. */
	const makeCtx = () => {
		const mode = resolveMode();
		const own = { statuses: [], widgets: [], notices: [], headers: [] };
		const ctx = {
			cwd,
			hasUI,
			mode,
			/** Writes made through *this* context, so staleness is observable. */
			own,
			paints: own.statuses,
			isProjectTrusted: () => projectTrusted,
			// One id for every context this pi hands out: pi mints a session id per
			// *session file*, and `/reload` reopens the same one, so a harness that
			// minted a fresh id per `session_start` would make a reloaded session look
			// like a different run to anything keyed on it.
			sessionManager: { getBranch: () => entries(), getEntries: () => entries(), getSessionId: () => sessionId },
			getSystemPrompt: resolvePrompt,
			ui: {
				setStatus: (_key, value) => {
					own.statuses.push(value);
					statuses.push(value);
				},
				setWidget: (_key, value) => {
					own.widgets.push(value);
					widgets.push(value);
				},
				notify: (message, level) => {
					own.notices.push({ message, level });
					notices.push({ message, level });
				},
				setHeader: (factory) => {
					own.headers.push(factory);
					headers.push(factory);
					// Dispose the previous component as real pi does
					// (interactive-mode.js:1773-1775), then call the factory eagerly
					// (:1782) so tests can observe disposal and live-model reads.
					currentComponent?.dispose?.();
					currentComponent = factory(headerTui, headerTheme);
				},
				confirm: async (title, message) => {
					const answer = answers.confirm.length ? answers.confirm.shift() : false;
					prompts.confirm.push({ title, message, answer, ctx });
					return answer;
				},
				select: async (title, options) => {
					const answer = answers.select.length ? answers.select.shift() : undefined;
					prompts.select.push({ title, options, answer, ctx });
					return answer;
				},
				input: async (title, placeholder) => {
					const answer = answers.input.length ? answers.input.shift() : undefined;
					prompts.input.push({ title, placeholder, answer, ctx });
					return answer;
				},
			},
			// Recorded, not performed: a test that really shut pi down would take the
			// test process with it.
			shutdown: () => shutdowns.push(ctx),
		};
		contexts.push(ctx);
		return ctx;
	};

	let current = makeCtx();

	return {
		pi,
		/** Contexts handed out so far, oldest first. */
		contexts,
		/** The context of the current session. */
		ctx: () => current,
		/** The context of the session before the current one, if any. */
		previousCtx: () => contexts[contexts.length - 2],
		tools,
		commands,
		registrations,
		execCalls,
		statuses,
		headers,
		widgets,
		notices,
		appended,
		sent,
		prompts,
		shutdowns,
		names: () => [...tools.keys()].sort(),
		messages: () => notices.map((n) => n.message),
		status: () => statuses.at(-1),
		/** The component created by the most recent `setHeader` call. */
		header: () => currentComponent,
		/** Total number of `requestRender` calls from all header components so far. */
		renderRequests: () => renderRequestCount,
		/**
		 * Deliver an event. `session_start` mints a fresh context first, because pi
		 * does: see the note at the top of this file.
		 */
		fire: async (event, payload = {}) => {
			if (event === "session_start") current = makeCtx();
			for (const handler of events.get(event) ?? []) await handler(payload, current);
		},
		/** Invoke a registered tool. */
		call: (name, params, signal) => tools.get(name)?.execute("call-1", params, signal),
		/** Invoke a registered slash command. */
		command: (name, args = "") => commands.get(name)?.handler(args, current),
		/** Let fire-and-forget work settle. */
		settle: (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}
