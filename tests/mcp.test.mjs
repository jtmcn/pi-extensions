/**
 * Tests for the mcp extension.
 *
 *   cd ~/.pi/agent/extensions/tests && npm install && node mcp.test.mjs
 *
 * Covers the stdio client against a deliberately awkward fake server
 * (fixtures/fake-mcp-server.mjs), the pure bridge mappings, and config
 * precedence/validation. Everything is hermetic.
 *
 * Set PI_TEST_MCP_COMMAND to also run a smoke test against a real server, e.g.
 *   PI_TEST_MCP_COMMAND="gitnexus mcp" node mcp.test.mjs
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_ENTRY = process.env.PI_DIST ?? (await resolvePiEntry());
const FAKE = join(EXT, "tests/fixtures/fake-mcp-server.mjs");
const REAL_COMMAND = process.env.PI_TEST_MCP_COMMAND;

const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
});
const { McpClient } = await jiti.import(`${EXT}/mcp/client.ts`);
const bridge = await jiti.import(`${EXT}/mcp/bridge.ts`);
const { loadConfig, enabledServers } = await jiti.import(`${EXT}/mcp/config.ts`);

let fails = 0;
const ok = (name, cond, extra = "") => {
	if (cond) console.log(`ok    ${name}`);
	else {
		fails++;
		console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
	}
};

const fakeClient = (args = []) =>
	new McpClient("fake", { command: process.execPath, args: [FAKE, ...args] }, { timeoutMs: 5000 });

// ---------------------------------------------------------------- client ---

{
	const client = fakeClient();
	client.start();
	await client.initialize();

	ok("client: handshake reports serverInfo", client.info?.name === "fake", JSON.stringify(client.info));
	ok("client: negotiated protocol version", client.protocolVersion === "2025-06-18");
	ok("client: running after start", client.running === true);

	const tools = await client.listTools();
	ok("client: follows tools/list pagination", tools.length === 5, `got ${tools.length}`);
	ok("client: preserves tool order across pages", tools[0]?.name === "echo" && tools[1]?.name === "boom");

	const echo = await client.callTool("echo", { message: "hi" });
	ok("client: tool call round trip", echo.content[0]?.text === "echo: hi", JSON.stringify(echo));
	ok("client: successful call is not an error", echo.isError !== true);

	const boom = await client.callTool("boom", {});
	ok("client: isError surfaces as a flag, not a throw", boom.isError === true);

	let rpcError;
	try {
		await client.callTool("nope", {});
	} catch (error) {
		rpcError = error;
	}
	ok("client: JSON-RPC error rejects", rpcError !== undefined);
	ok("client: JSON-RPC error keeps its code", rpcError?.code === -32602, String(rpcError?.code));

	// The banner line the fake prints before the handshake must not break parsing.
	ok("client: non-JSON stdout banner ignored", tools.length === 5);

	// stderr is captured for diagnostics, never parsed as protocol.
	ok("client: stderr captured", client.stderrExcerpt.includes("starting up"), client.stderrExcerpt);

	client.close();
	ok("client: not running after close", client.running === false);
	client.close(); // Idempotent.
	ok("client: double close is safe", true);
}

{
	// Timeout path.
	const client = fakeClient();
	client.start();
	await client.initialize();
	let timeoutError;
	try {
		await client.callTool("hang", {}, { timeoutMs: 300 });
	} catch (error) {
		timeoutError = error;
	}
	ok("client: request timeout rejects", /timed out/.test(timeoutError?.message ?? ""), timeoutError?.message);

	// Abort path.
	const controller = new AbortController();
	const aborted = client.callTool("hang", {}, { signal: controller.signal });
	controller.abort();
	let abortError;
	try {
		await aborted;
	} catch (error) {
		abortError = error;
	}
	ok("client: abort rejects", /aborted/.test(abortError?.message ?? ""), abortError?.message);
	client.close();
}

{
	// Server dies during handshake: the failure must name the server and carry
	// the stderr tail, or debugging a bad command line is guesswork.
	const client = fakeClient(["--crash-on-init"]);
	client.start();
	let error;
	try {
		await client.initialize();
	} catch (err) {
		error = err;
	}
	ok("client: crash during init rejects", error !== undefined);
	ok("client: crash message names the server", /^fake:/.test(error?.message ?? ""), error?.message);
	ok("client: crash message includes stderr", /exploding as requested/.test(error?.message ?? ""));
	client.close();
}

{
	// A command that does not exist must fail cleanly rather than hang.
	const client = new McpClient("missing", { command: "definitely-not-a-real-binary-xyz" }, { timeoutMs: 3000 });
	client.start();
	let error;
	try {
		await client.initialize();
	} catch (err) {
		error = err;
	}
	ok("client: unspawnable command rejects", error !== undefined, error?.message);
	ok("client: unspawnable message is actionable", /failed to spawn|ENOENT|exited/.test(error?.message ?? ""), error?.message);
	client.close();
}

// ---------------------------------------------------------------- bridge ---

{
	ok("bridge: namespaces tool names", bridge.toolName("gitnexus", "query") === "gitnexus_query");
	ok("bridge: sanitizes separators", bridge.toolName("My Server", "do-thing") === "my_server_do_thing");
	ok("bridge: collapses repeats", bridge.toolName("a--b", "c__d") === "a_b_c_d");
	ok(
		"bridge: dedupes collisions",
		bridge.toolName("s", "a-b", new Set(["s_a_b"])) === "s_a_b_2",
	);
	ok(
		"bridge: dedupes repeatedly",
		bridge.toolName("s", "a-b", new Set(["s_a_b", "s_a_b_2"])) === "s_a_b_3",
	);
	ok("bridge: prefixes leading digit", bridge.toolName("9lives", "go").startsWith("mcp_"));

	const tools = [{ name: "query" }, { name: "cypher" }, { name: "check" }];
	const all = bridge.selectTools(tools);
	ok("bridge: no allow-list keeps everything", all.selected.length === 3 && all.unknown.length === 0);

	const some = bridge.selectTools(tools, ["query", "typo"]);
	ok("bridge: allow-list filters", some.selected.length === 1 && some.selected[0].name === "query");
	ok("bridge: allow-list reports typos", some.unknown.join() === "typo");

	ok(
		"bridge: description falls back",
		bridge.toolDescription("srv", { name: "t" }).includes('"t"'),
	);
	ok(
		"bridge: description prefers the server's own",
		bridge.toolDescription("srv", { name: "t", description: "Real one" }) === "Real one",
	);

	ok("bridge: missing inputSchema becomes an object schema", bridge.inputSchema({ name: "t" }).type === "object");
	ok(
		"bridge: existing object schema passes through untouched",
		bridge.inputSchema({ name: "t", inputSchema: { type: "object", properties: { a: { type: "string" } } } })
			.properties.a.type === "string",
	);

	const text = bridge.toAgentContent({ content: [{ type: "text", text: "hello" }] });
	ok("bridge: text maps through", text[0].type === "text" && text[0].text === "hello");

	const image = bridge.toAgentContent({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
	ok("bridge: image maps to pi ImageContent", image[0].type === "image" && image[0].data === "aGk=");

	const errored = bridge.toAgentContent({ content: [{ type: "text", text: "it broke" }], isError: true });
	ok("bridge: isError is marked inline", errored[0].text.startsWith("MCP tool error:"), errored[0].text);

	const empty = bridge.toAgentContent({ content: [] });
	ok("bridge: empty content still yields a block", empty.length === 1);

	const emptyError = bridge.toAgentContent({ content: [], isError: true });
	ok("bridge: empty error content mentions failure", /failed/i.test(emptyError[0].text));

	const resource = bridge.toAgentContent({
		content: [{ type: "resource", resource: { uri: "file:///x", text: "body" } }],
	});
	ok("bridge: embedded resource flattens to text", resource[0].text === "[resource file:///x]\nbody");

	const unknown = bridge.toAgentContent({ content: [{ type: "future_type", blob: 1 }] });
	ok("bridge: unknown block type is not dropped", unknown[0].type === "text" && unknown[0].text.includes("future_type"));
}

// ---------------------------------------------------------------- config ---

{
	const root = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(project, ".pi"), { recursive: true });

	const load = (projectTrusted) =>
		loadConfig({ cwd: project, projectTrusted, agentDir, home: root });

	// Empty: no config anywhere.
	const none = await load(true);
	ok("config: no files means no servers and no sources", none.sources.length === 0 && Object.keys(none.config.servers).length === 0);

	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				alpha: { command: "a", args: ["1"], tools: ["x"] },
				beta: { command: "b", disabled: true },
				bad: { args: ["no command"] },
				remote: { url: "https://example.com/mcp" },
			},
		}),
	);

	const global = await load(false);
	ok("config: accepts the mcpServers key", global.config.servers.alpha?.command === "a");
	ok("config: keeps the tools allow-list", global.config.servers.alpha?.tools?.join() === "x");
	ok("config: rejects a server with no command", global.config.servers.bad === undefined);
	ok("config: warns about the bad server", global.warnings.some((w) => w.includes('"bad"')), global.warnings.join("|"));
	ok("config: rejects remote servers explicitly", global.warnings.some((w) => /remote\/HTTP/.test(w)));
	ok("config: disabled servers are parsed but filtered", enabledServers(global.config).every(([n]) => n !== "beta"));
	ok("config: enabled list excludes invalid entries", enabledServers(global.config).map(([n]) => n).join() === "alpha");

	// Project config overrides global, but only when trusted.
	await writeFile(
		join(project, ".pi/mcp.json"),
		JSON.stringify({ servers: { alpha: { command: "overridden" }, gamma: { command: "g", cwd: "sub" } } }),
	);

	const untrusted = await load(false);
	ok("config: untrusted project config is ignored", untrusted.config.servers.alpha?.command === "a");
	ok("config: untrusted project adds nothing", untrusted.config.servers.gamma === undefined);

	const trusted = await load(true);
	ok("config: trusted project overrides global", trusted.config.servers.alpha?.command === "overridden");
	ok("config: relative server cwd resolves against session cwd", trusted.config.servers.gamma?.cwd === join(project, "sub"));
	ok("config: both sources reported in order", trusted.sources.length === 2 && trusted.sources[1].includes("project"));

	// extends: pull a server map out of a foreign config file (e.g. ~/.claude.json).
	await writeFile(join(root, "claude.json"), JSON.stringify({ mcpServers: { inherited: { command: "i" } } }));
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({ extends: "~/claude.json", mcpServers: { own: { command: "o" } } }),
	);
	const extended = await load(false);
	ok("config: extends pulls in foreign servers", extended.config.servers.inherited?.command === "i");
	ok("config: own servers survive extends", extended.config.servers.own?.command === "o");

	// Own definition must win over the inherited one.
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({ extends: "~/claude.json", mcpServers: { inherited: { command: "mine" } } }),
	);
	const shadowed = await load(false);
	ok("config: own definition shadows extends", shadowed.config.servers.inherited?.command === "mine");

	// Malformed JSON is a warning, not a crash.
	await writeFile(join(agentDir, "mcp.json"), "{ not json");
	const broken = await load(false);
	ok("config: invalid JSON warns instead of throwing", broken.warnings.some((w) => /invalid JSON/.test(w)));

	await rm(root, { recursive: true, force: true });
}

// ------------------------------------------------------- real server (opt) ---

if (REAL_COMMAND) {
	const [command, ...args] = REAL_COMMAND.split(" ");
	const client = new McpClient("real", { command, args, cwd: process.env.PI_TEST_MCP_CWD }, { timeoutMs: 60000 });
	client.start();
	await client.initialize();
	const tools = await client.listTools();
	ok(`real: ${REAL_COMMAND} handshake`, client.info?.name !== undefined, JSON.stringify(client.info));
	ok(`real: ${REAL_COMMAND} lists tools`, tools.length > 0, `${tools.length} tools`);
	ok(
		"real: every tool has a usable schema",
		tools.every((tool) => bridge.inputSchema(tool).type === "object"),
	);
	ok(
		"real: every tool name survives sanitizing",
		tools.every((tool) => /^[a-z0-9_]+$/.test(bridge.toolName("real", tool.name))),
	);
	client.close();
} else {
	console.log("skip  real server checks (set PI_TEST_MCP_COMMAND to enable)");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);

async function resolvePiEntry() {
	const { execSync } = await import("node:child_process");
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent/dist/index.js");
}
