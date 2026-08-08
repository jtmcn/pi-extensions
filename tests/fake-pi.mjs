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
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * @param options.exec  Intercept `pi.exec`. Return a result to answer the call,
 *                      or `undefined` to fall through to a real subprocess.
 * @param options.entries  What `ctx.sessionManager.getBranch()` returns.
 */
export function createFakePi({
	cwd = process.cwd(),
	hasUI = true,
	mode = "interactive",
	exec,
	entries = () => [],
	projectTrusted = false,
} = {}) {
	const events = new Map();
	const tools = new Map();
	const commands = new Map();
	const registrations = [];
	const execCalls = [];
	/** Everything written through any context, in order. */
	const statuses = [];
	const widgets = [];
	const notices = [];
	const appended = [];
	const sent = [];
	const contexts = [];

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
		appendEntry: (customType, data) => appended.push({ customType, data }),
		sendMessage: (message, options) => sent.push({ message, options }),
	};

	/** A context, recording its own writes as well as the aggregate ones. */
	const makeCtx = () => {
		const own = { statuses: [], widgets: [], notices: [] };
		const ctx = {
			cwd,
			hasUI,
			mode,
			/** Writes made through *this* context, so staleness is observable. */
			own,
			paints: own.statuses,
			isProjectTrusted: () => projectTrusted,
			sessionManager: { getBranch: () => entries(), getEntries: () => entries() },
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
			},
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
		widgets,
		notices,
		appended,
		sent,
		names: () => [...tools.keys()].sort(),
		messages: () => notices.map((n) => n.message),
		status: () => statuses.at(-1),
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
