/**
 * MCP client for pi.
 *
 * pi ships no MCP support on purpose ("build an extension that adds MCP
 * support" — pi's README). This is that extension: it spawns configured stdio
 * MCP servers, lists their tools, and registers each one as a native pi tool.
 *
 * Lifecycle notes, both of which are load-bearing:
 *
 *  - Servers are spawned in `session_start`, never in the extension factory.
 *    Factories run in invocations that never start a session (`--list-models`,
 *    `--help`), and pi's extension docs are explicit that background resources
 *    must not start there. Doing it wrong leaks a child process per invocation.
 *  - Tools are registered once per process and dispatch through a mutable
 *    handler map. `session_start` fires again on reload/fork/resume, and
 *    re-registering the same tool name would be at best redundant; instead the
 *    reconnect swaps the handler the existing tool points at.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inputSchema, selectTools, toAgentContent, toolDescription, toolName } from "./bridge.ts";
import { McpClient, type McpServerSpec } from "./client.ts";
import {
	DEFAULT_STARTUP_TIMEOUT_MS,
	enabledServers,
	loadConfig,
	type McpServerConfig,
} from "./config.ts";

/** Tool count above which an allow-list is worth suggesting. */
const NOISY_TOOL_COUNT = 8;

interface Handler {
	client: McpClient;
	/** The tool's name on the server, which differs from its namespaced pi name. */
	remoteName: string;
	timeoutMs?: number;
}

interface ServerState {
	name: string;
	config: McpServerConfig;
	client?: McpClient;
	status: "connecting" | "ready" | "failed" | "disabled";
	toolNames: string[];
	error?: string;
}

export default function mcpExtension(pi: ExtensionAPI) {
	const servers = new Map<string, ServerState>();
	/** pi tool name -> where to send the call. Rebound on reconnect. */
	const handlers = new Map<string, Handler>();
	const registered = new Set<string>();
	/** Guards against overlapping connect cycles (e.g. reload during startup). */
	let generation = 0;
	/** In-flight connects, awaited once before the first turn of a session. */
	let connecting: Promise<unknown>[] = [];
	let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;

	/**
	 * Wait for pending connects, but never longer than the configured budget.
	 *
	 * Tools are advertised to the provider as part of the request, so a tool
	 * registered mid-turn is invisible until the next one. Without this gate a
	 * fast first prompt races the handshake and the model reports no MCP tools.
	 */
	async function awaitConnections(): Promise<void> {
		if (connecting.length === 0) return;
		const pending = Promise.allSettled(connecting);
		if (startupTimeoutMs <= 0) {
			connecting = [];
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			pending.then(() => {
				connecting = [];
			}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, startupTimeoutMs);
				timer.unref?.();
			}),
		]);
		if (timer) clearTimeout(timer);
	}

	function closeAll(): void {
		for (const state of servers.values()) {
			state.client?.close();
			state.client = undefined;
		}
		handlers.clear();
	}

	/** Register a pi tool that forwards to whatever handler is currently bound. */
	function registerBridgedTool(piName: string, server: string, remoteDescription: string, schema: Record<string, unknown>): void {
		if (registered.has(piName)) return;
		registered.add(piName);

		pi.registerTool({
			name: piName,
			label: `MCP: ${server}`,
			description: remoteDescription,
			// Raw JSON Schema from the server. pi forwards tool parameters to the
			// provider without running a TypeBox check over them, so Type.Unsafe
			// is both sufficient and what pi-ai itself uses for hand-written
			// JSON Schema (see its StringEnum helper).
			parameters: Type.Unsafe<Record<string, unknown>>(schema),
			async execute(_toolCallId, params, signal) {
				const handler = handlers.get(piName);
				if (!handler || !handler.client.running) {
					return {
						content: [
							{
								type: "text",
								text: `MCP server "${server}" is not connected. Run /mcp restart to retry.`,
							},
						],
						details: { server, connected: false },
					};
				}

				const args = (params ?? {}) as Record<string, unknown>;
				try {
					const result = await handler.client.callTool(handler.remoteName, args, {
						signal,
						timeoutMs: handler.timeoutMs,
					});
					return {
						content: toAgentContent(result),
						details: { server, tool: handler.remoteName, isError: result.isError === true },
					};
				} catch (error) {
					// Transport-level failure (crash, timeout, abort). Surface it as
					// tool output so the model can react instead of the turn dying.
					return {
						content: [{ type: "text", text: `MCP call failed: ${(error as Error).message}` }],
						details: { server, tool: handler.remoteName, failed: true },
					};
				}
			},
		});
	}

	async function connect(state: ServerState, ctx: ExtensionContext, cycle: number): Promise<void> {
		const spec: McpServerSpec = {
			command: state.config.command,
			args: state.config.args,
			env: state.config.env,
			cwd: state.config.cwd ?? ctx.cwd,
		};
		const client = new McpClient(state.name, spec, { timeoutMs: state.config.timeoutMs });
		state.client = client;
		state.status = "connecting";

		client.start();
		await client.initialize();
		const tools = await client.listTools();

		// A reload may have started a newer cycle while we were handshaking.
		if (cycle !== generation) {
			client.close();
			return;
		}

		const { selected, unknown } = selectTools(tools, state.config.tools);
		const taken = new Set(registered);
		const names: string[] = [];

		for (const tool of selected) {
			const piName = toolName(state.name, tool.name, taken);
			taken.add(piName);
			names.push(piName);
			handlers.set(piName, {
				client,
				remoteName: tool.name,
				timeoutMs: state.config.timeoutMs,
			});
			registerBridgedTool(piName, state.name, toolDescription(state.name, tool), inputSchema(tool));
		}

		state.toolNames = names;
		state.status = "ready";

		if (unknown.length > 0) {
			warn(ctx, `mcp: ${state.name} has no tool named ${unknown.map((n) => `"${n}"`).join(", ")}`);
		}
		if (!state.config.tools && selected.length > NOISY_TOOL_COUNT) {
			warn(
				ctx,
				`mcp: ${state.name} exposes ${selected.length} tools; consider a "tools" allow-list to save context`,
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Reload/fork/resume re-fire this. Drop the previous generation first.
		generation++;
		const cycle = generation;
		closeAll();
		servers.clear();

		const { config, sources, warnings } = await loadConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		for (const warning of warnings) warn(ctx, `mcp: ${warning}`);
		if (sources.length === 0) return; // Not configured; stay silent.
		startupTimeoutMs = config.startupTimeoutMs;

		for (const [name, server] of Object.entries(config.servers)) {
			servers.set(name, {
				name,
				config: server,
				status: server.disabled ? "disabled" : "connecting",
				toolNames: [],
			});
		}

		// Connect in parallel without blocking session startup. `before_agent_start`
		// gates the first turn on these, so nothing races the initial tool list.
		connecting = [];
		for (const [name] of enabledServers(config)) {
			const state = servers.get(name);
			if (!state) continue;
			connecting.push(
				connect(state, ctx, cycle).catch((error: Error) => {
					state.status = "failed";
					state.error = error.message;
					state.client?.close();
					state.client = undefined;
					warn(ctx, `mcp: ${name} failed — ${error.message.split("\n")[0]}`);
				}),
			);
		}
	});

	// Awaited by pi, so this is the one place a turn can be held back until the
	// servers have reported their tools.
	pi.on("before_agent_start", async () => {
		await awaitConnections();
	});

	pi.on("session_shutdown", () => {
		generation++;
		closeAll();
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status, or /mcp restart to reconnect",
		handler: async (args, ctx) => {
			if (args.trim() === "restart") {
				generation++;
				closeAll();
				const cycle = generation;
				connecting = [];
				for (const state of servers.values()) {
					if (state.status === "disabled") continue;
					state.status = "connecting";
					connecting.push(
						connect(state, ctx, cycle).catch((error: Error) => {
							state.status = "failed";
							state.error = error.message;
						}),
					);
				}
				ctx.ui.notify("mcp: reconnecting", "info");
				return;
			}

			if (servers.size === 0) {
				ctx.ui.notify("mcp: no servers configured (~/.pi/agent/mcp.json)", "info");
				return;
			}

			const lines = [...servers.values()].map((state) => {
				const detail =
					state.status === "ready"
						? `${state.toolNames.length} tools: ${state.toolNames.join(", ")}`
						: (state.error?.split("\n")[0] ?? state.status);
				const version = state.client?.info?.version ? ` v${state.client.info.version}` : "";
				return `${state.name}${version} [${state.status}] ${detail}`;
			});
			ctx.ui.notify(`mcp:\n${lines.join("\n")}`, "info");
		},
	});
}

/** Notify when there is a UI, otherwise fall back to stderr (headless runs). */
function warn(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.error(message);
}
