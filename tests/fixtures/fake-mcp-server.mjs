/**
 * A deliberately awkward MCP server, used to test the client against the
 * behaviours real servers exhibit:
 *
 *   - logs on stderr (gitnexus does this on every start)
 *   - prints a non-JSON banner on stdout before speaking protocol
 *   - paginates tools/list with a nextCursor
 *   - reports tool failure as `isError` rather than a JSON-RPC error
 *   - returns a JSON-RPC error for an unknown tool
 *   - sends the client a request, which a client must answer or it hangs
 *   - can hang on demand, to exercise timeouts and cancellation
 *   - can flood stdout with a newline-free blob, to exercise the read cap
 *
 * Modes via argv: `--no-banner`, `--crash-on-init`, `--flood`.
 */

const MODE = new Set(process.argv.slice(2));

process.stderr.write("fake-mcp-server: starting up\n");
if (!MODE.has("--no-banner")) process.stdout.write("not json, ignore me\n");

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
	{
		name: "echo",
		description: "Echo a message back",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
	},
	{ name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } },
	{ name: "hang", description: "Never replies", inputSchema: { type: "object", properties: {} } },
	{ name: "picture", description: "Returns an image", inputSchema: { type: "object", properties: {} } },
	// No inputSchema at all — some servers omit it for zero-arg tools.
	{ name: "no-schema" },
];

// Pad the list on demand, so a test can cross the "this server is noisy, consider
// an allow-list" threshold without inventing a second fixture.
const extra = Number(process.env.FAKE_EXTRA_TOOLS ?? 0);
for (let i = 0; i < extra; i++) {
	TOOLS.push({ name: `filler${i}`, description: "Padding", inputSchema: { type: "object", properties: {} } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});

function handle(msg) {
	const { id, method, params } = msg;

	if (method === "initialize") {
		if (MODE.has("--crash-on-init")) {
			process.stderr.write("fake-mcp-server: exploding as requested\n");
			process.exit(3);
		}
		if (MODE.has("--flood")) {
			// 9 MiB with no newline anywhere: past the client's cap for an
			// unterminated line. The trailing newline then resynchronises the stream,
			// so the handshake below must still succeed.
			process.stdout.write("x".repeat(9 * 1024 * 1024));
			process.stdout.write("\n");
		}
		reply(id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "fake", version: "9.9.9" },
		});
		return;
	}

	if (method === "notifications/initialized") {
		// A server-initiated request. If the client ignores it, a strict server
		// would stall; we only use it to check the client answers something.
		send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list", params: {} });
		return;
	}

	if (method === "tools/list") {
		// Page 1 returns the first tool plus a cursor; page 2 returns the rest.
		if (!params?.cursor) reply(id, { tools: TOOLS.slice(0, 1), nextCursor: "page2" });
		else reply(id, { tools: TOOLS.slice(1) });
		return;
	}

	if (method === "tools/call") {
		const name = params?.name;
		const args = params?.arguments ?? {};
		if (name === "echo") {
			reply(id, { content: [{ type: "text", text: `echo: ${args.message}` }] });
		} else if (name === "boom") {
			reply(id, { content: [{ type: "text", text: "it broke" }], isError: true });
		} else if (name === "picture") {
			reply(id, { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
		} else if (name === "no-schema") {
			reply(id, { content: [{ type: "text", text: "no args needed" }] });
		} else if (name === "hang") {
			// Intentionally no reply.
		} else {
			fail(id, -32602, `Unknown tool: ${name}`);
		}
		return;
	}

	if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}
