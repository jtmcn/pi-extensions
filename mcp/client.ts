/**
 * Minimal MCP client speaking JSON-RPC 2.0 over a child process's stdio.
 *
 * Deliberately dependency-free rather than using `@modelcontextprotocol/sdk`:
 * the stdio transport is newline-delimited JSON-RPC and the three calls we need
 * (`initialize`, `tools/list`, `tools/call`) are a few dozen lines, while the
 * SDK drags in an HTTP server stack. That matters here because this repo is
 * installed by `git clone` + symlink with no `npm install` step, and because
 * the SDK's own dependency (`@hono/node-server`) currently trips pnpm's
 * supply-chain trust check.
 *
 * Only what a client needs is implemented. Server-initiated requests are
 * refused politely (see `dispatch`) rather than handled, because we advertise
 * no capabilities.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** Protocol revision we advertise. Servers may negotiate down in their reply. */
export const PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 60_000;
const INITIALIZE_TIMEOUT_MS = 30_000;
/** Grace period between SIGTERM and SIGKILL when closing a server. */
const KILL_GRACE_MS = 2_000;
/** Stderr lines retained for diagnostics; servers log freely there. */
const STDERR_TAIL_LINES = 20;
/**
 * Cap on the un-terminated stdout tail.
 *
 * A server that streams a huge newline-free blob — binary output on the wrong
 * pipe, a runaway log line — would otherwise grow this buffer until the process
 * runs out of memory. Nothing that large is a frame we could act on, so the tail
 * is dropped and the next newline resynchronises the stream. Generous enough
 * that a legitimate multi-megabyte tool result (an inline image, say) is never
 * affected.
 */
const MAX_PENDING_STDOUT = 8 * 1024 * 1024;

export interface McpServerSpec {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/**
 * One block of tool output. `type` is open-ended in the spec ("text", "image",
 * "audio", "resource", "resource_link", ...), so it stays a string and the
 * bridge decides what it can render.
 */
export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface McpCallResult {
	content: McpContentBlock[];
	/**
	 * Tool-level failure. Distinct from a JSON-RPC error: the call succeeded,
	 * the tool reported a problem, and the text is meant for the model to read.
	 */
	isError?: boolean;
}

export interface McpServerInfo {
	name?: string;
	version?: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface McpClientOptions {
	/** Default per-request timeout. */
	timeoutMs?: number;
}

/** A JSON-RPC error returned by the server (as opposed to a transport failure). */
export class McpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "McpError";
	}
}

export class McpClient {
	private child?: ChildProcessWithoutNullStreams;
	private stdout = "";
	private readonly stderrTail: string[] = [];
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private stopped = false;
	/** Why the process is gone, used to explain in-flight request failures. */
	private exitReason?: string;
	private serverInfo?: McpServerInfo;
	private negotiatedVersion?: string;

	constructor(
		readonly name: string,
		private readonly spec: McpServerSpec,
		private readonly options: McpClientOptions = {},
	) {}

	get info(): McpServerInfo | undefined {
		return this.serverInfo;
	}

	get protocolVersion(): string | undefined {
		return this.negotiatedVersion;
	}

	get running(): boolean {
		return this.child !== undefined && !this.stopped;
	}

	/** Last lines the server wrote to stderr — the only useful crash diagnostic. */
	get stderrExcerpt(): string {
		return this.stderrTail.join("\n");
	}

	/** Spawn the server. Safe to call once; subsequent calls are no-ops. */
	start(): void {
		if (this.child) return;
		this.stopped = false;

		// Default stdio is "pipe" for all three streams, which also gives us the
		// non-null stream types.
		const child = spawn(this.spec.command, this.spec.args ?? [], {
			cwd: this.spec.cwd,
			env: { ...process.env, ...this.spec.env },
		});
		this.child = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

		// `error` fires instead of `exit` when the binary cannot be spawned at all
		// (ENOENT), which is the single most common misconfiguration.
		child.on("error", (error: Error) => {
			this.fail(`failed to spawn ${this.spec.command}: ${error.message}`);
		});

		child.on("exit", (code, signal) => {
			const how = signal ? `signal ${signal}` : `code ${code}`;
			const tail = this.stderrExcerpt;
			this.fail(`server exited (${how})${tail ? `\n${tail}` : ""}`);
		});
	}

	/** Handshake. Must complete before any other call. */
	async initialize(options: RequestOptions = {}): Promise<void> {
		const result = (await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-mcp", version: "0.1.0" },
			},
			{ timeoutMs: INITIALIZE_TIMEOUT_MS, ...options },
		)) as { protocolVersion?: string; serverInfo?: McpServerInfo } | undefined;

		this.serverInfo = result?.serverInfo;
		this.negotiatedVersion = result?.protocolVersion;
		this.notify("notifications/initialized");
	}

	/** All tools, following `nextCursor` pagination to the end. */
	async listTools(options: RequestOptions = {}): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		// Bounded so a server that returns a constant cursor cannot spin forever.
		for (let page = 0; page < 50; page++) {
			const result = (await this.request("tools/list", cursor ? { cursor } : {}, options)) as
				| { tools?: McpTool[]; nextCursor?: string }
				| undefined;
			for (const tool of result?.tools ?? []) {
				if (tool && typeof tool.name === "string") tools.push(tool);
			}
			cursor = result?.nextCursor;
			if (!cursor) break;
		}
		return tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options: RequestOptions = {},
	): Promise<McpCallResult> {
		const result = (await this.request("tools/call", { name, arguments: args }, options)) as
			| { content?: McpContentBlock[]; isError?: boolean }
			| undefined;
		return { content: result?.content ?? [], isError: result?.isError === true };
	}

	/** Terminate the server and fail anything in flight. Idempotent. */
	close(): void {
		if (this.stopped) return;
		this.stopped = true;
		const child = this.child;
		this.child = undefined;
		this.rejectAll(new Error(this.exitReason ?? "client closed"));
		if (!child || child.exitCode !== null || child.signalCode !== null) return;

		try {
			child.stdin.end();
		} catch {
			// Already closed; nothing to flush.
		}
		child.kill("SIGTERM");
		// Escalate if it ignores SIGTERM. `unref` so a pending kill timer cannot
		// hold the process open during shutdown.
		const timer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, KILL_GRACE_MS);
		timer.unref?.();
	}

	private request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
		if (!this.child || this.stopped) {
			return Promise.reject(new Error(this.exitReason ?? `${this.name}: server is not running`));
		}
		const id = ++this.nextId;
		const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		return new Promise<unknown>((resolve, reject) => {
			const settle = (fn: () => void) => {
				const entry = this.pending.get(id);
				if (entry) {
					clearTimeout(entry.timer);
					this.pending.delete(id);
				}
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};

			const onAbort = () => {
				// Tell the server to stop working; it is not obliged to reply.
				this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" });
				settle(() => reject(new Error(`${this.name}: ${method} aborted`)));
			};

			if (options.signal?.aborted) {
				reject(new Error(`${this.name}: ${method} aborted`));
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				settle(() => reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`)));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
				timer,
			});

			if (!this.write({ jsonrpc: "2.0", id, method, params })) {
				settle(() => reject(new Error(`${this.name}: failed to write ${method} to server`)));
			}
		});
	}

	private notify(method: string, params?: unknown): void {
		this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	private write(message: unknown): boolean {
		const child = this.child;
		if (!child || child.stdin.destroyed) return false;
		try {
			// Newline-delimited: the payload is JSON, so it cannot contain a raw \n.
			child.stdin.write(`${JSON.stringify(message)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	private onStdout(chunk: string): void {
		this.stdout += chunk;
		// Split on \n ONLY. Splitting on any Unicode line separator (what generic
		// line readers do) would corrupt payloads containing U+2028/U+2029.
		let index = this.stdout.indexOf("\n");
		while (index >= 0) {
			const line = this.stdout.slice(0, index).replace(/\r$/, "");
			this.stdout = this.stdout.slice(index + 1);
			if (line.trim()) this.handleLine(line);
			index = this.stdout.indexOf("\n");
		}
		// Whatever is left is an unterminated line; it must stay bounded.
		if (this.stdout.length > MAX_PENDING_STDOUT) this.stdout = "";
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			// Some servers print banners to stdout before speaking protocol.
			// Ignoring is strictly better than crashing the session.
			return;
		}
		if (message && typeof message === "object") this.dispatch(message as Record<string, unknown>);
	}

	private dispatch(message: Record<string, unknown>): void {
		const id = message.id;

		// A request from the server (has both id and method). We advertised no
		// capabilities, so refuse rather than leave the server waiting forever.
		if (typeof message.method === "string") {
			if (id !== undefined && id !== null) {
				this.write({
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `Method not found: ${message.method}` },
				});
			}
			return; // Notifications are ignored.
		}

		if (typeof id !== "number") return;
		const entry = this.pending.get(id);
		if (!entry) return; // Late reply to a timed-out or cancelled request.

		const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
		if (error) {
			entry.reject(
				new McpError(`${this.name}: ${error.message ?? "unknown error"}`, error.code, error.data),
			);
			return;
		}
		entry.resolve(message.result);
	}

	private onStderr(chunk: string): void {
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			this.stderrTail.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
		}
		while (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
	}

	/** Record why the server died and fail everything waiting on it. */
	private fail(reason: string): void {
		this.exitReason = `${this.name}: ${reason}`;
		this.child = undefined;
		this.stopped = true;
		this.rejectAll(new Error(this.exitReason));
	}

	private rejectAll(error: Error): void {
		for (const [, entry] of [...this.pending]) entry.reject(error);
		this.pending.clear();
	}
}
