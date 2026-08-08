/**
 * Tests for the mcp extension.
 *
 *   cd tests && npm install && node mcp/mcp.test.mjs
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
import { assertions, EXT_ROOT, loadExt } from "../harness.mjs";

const FAKE = join(EXT_ROOT, "tests/fixtures/fake-mcp-server.mjs");
const REAL_COMMAND = process.env.PI_TEST_MCP_COMMAND;

const { ok, skip, done } = assertions();
const { McpClient } = await loadExt("mcp/client.ts");
const bridge = await loadExt("mcp/bridge.ts");
const { loadConfig, enabledServers } = await loadExt("mcp/config.ts");

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

{
	// A server that dumps a huge newline-free blob must not grow the read buffer
	// without bound, and the stream must resynchronise at the next newline.
	const client = fakeClient(["--flood"]);
	client.start();
	await client.initialize();
	ok("client: resynchronises after a newline-free flood", client.info?.name === "fake", JSON.stringify(client.info));
	const echo = await client.callTool("echo", { message: "after flood" });
	ok("client: still usable after the flood", echo.content[0]?.text === "echo: after flood", JSON.stringify(echo));
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

// ----------------------------------------------------- extension lifecycle ---

{
	// `session_start` fires again on /new, /reload, fork and resume. The tools are
	// registered once per process and dispatch through a handler map, so a
	// reconnect has to recompute the *same* names: a renamed tool would leave the
	// original with no handler (permanently "not connected") and add a second copy
	// of every schema to the tool list.
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], timeoutMs: 5000 } });

	await h.fire("session_start");
	await h.fire("before_agent_start");
	const first = h.names();
	ok("ext: registers the server's tools", first.includes("fake_echo"), first.join());
	const before = await h.call("fake_echo", { message: "hi" });
	ok("ext: a registered tool reaches the server", before?.content[0]?.text === "echo: hi", JSON.stringify(before));

	// The reload.
	await h.fire("session_start");
	await h.fire("before_agent_start");
	const second = h.names();
	ok("ext: a reload does not rename tools", second.join() === first.join(), `${first.join()} -> ${second.join()}`);
	ok("ext: a reload registers no duplicate tool", h.registrations.length === first.length, h.registrations.join());
	ok("ext: no tool grew a dedupe suffix", !second.some((name) => /_\d+$/.test(name)), second.join());

	const after = await h.call("fake_echo", { message: "again" });
	ok("ext: the reload rebinds the handler", after?.content[0]?.text === "echo: again", JSON.stringify(after));

	await h.fire("session_shutdown");
	const dead = await h.call("fake_echo", { message: "gone" });
	ok("ext: after shutdown the tool reports a closed server", dead?.details?.connected === false, JSON.stringify(dead));

	await h.cleanup();
}

// ------------------------------------------------- teardown vs real failure ---

/**
 * Drive the extension against a server map, capturing everything it does.
 *
 * One harness for every extension-level test in this file: tools it registers,
 * commands it registers, and what it told the user. Deliberately does *not* await
 * connections — several cases are about what happens while a handshake is still
 * in flight — so tests call `fire("before_agent_start")` or `settle()` when they
 * want them resolved.
 */
async function extHarness(servers, { hasUI = true, startupTimeoutMs = 10_000 } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-mcp-ext-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ servers, startupTimeoutMs }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const notices = [];
	const events = new Map();
	const tools = new Map();
	const registrations = [];
	const commands = new Map();
	const pi = {
		on: (event, handler) => {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
		},
		registerTool: (spec) => {
			registrations.push(spec.name);
			tools.set(spec.name, spec);
		},
		registerCommand: (name, spec) => commands.set(name, spec),
	};
	const ctx = {
		cwd: root,
		hasUI,
		mode: "interactive",
		isProjectTrusted: () => false,
		ui: { notify: (message, level) => notices.push({ message, level }), setStatus: () => {}, setWidget: () => {} },
	};

	const extension = (await loadExt("mcp/index.ts")).default;
	extension(pi);

	return {
		root,
		notices,
		tools,
		registrations,
		messages: () => notices.map((n) => n.message),
		names: () => [...tools.keys()].sort(),
		fire: async (event) => {
			for (const handler of events.get(event) ?? []) await handler({}, ctx);
		},
		call: (name, params) => tools.get(name)?.execute("call-1", params, undefined),
		/** Invoke `/mcp <args>`. */
		command: (args = "") => commands.get("mcp")?.handler(args, ctx),
		settle: (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms)),
		cleanup: async () => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		},
	};
}

{
	// A server that spawns and then never answers `initialize`. Shutting the session
	// down closes the client, which rejects that pending handshake — but a close we
	// asked for is teardown, not a server failure, and reporting it means every
	// `pi -p` run ends with a scary line about a server that was fine.
	const h = await extHarness({ probe: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"], timeoutMs: 30000 } });
	await h.fire("session_start");
	await h.fire("session_shutdown");
	await h.settle();

	ok(
		"teardown: closing a handshake in flight reports no failure",
		!h.notices.some((n) => /failed/.test(n.message)),
		JSON.stringify(h.notices),
	);
	await h.cleanup();
}

{
	// The other half: a server that genuinely cannot start must still be reported,
	// or the fix above has just hidden every real problem.
	const h = await extHarness({ probe: { command: join(tmpdir(), "definitely-not-a-real-binary-xyz"), args: [], timeoutMs: 5000 } });
	await h.fire("session_start");
	await h.settle();

	ok(
		"a server that cannot start is still reported",
		h.notices.some((n) => /probe failed/.test(n.message)),
		JSON.stringify(h.notices),
	);
	await h.fire("session_shutdown");
	await h.cleanup();
}

// --------------------------------------------------------------- restart ---

{
	// `/mcp restart` closes every client and reconnects. It is the same hazard as a
	// reload — names must stay stable and handlers must rebind — plus a cycle guard
	// that must not swallow a genuine restart failure.
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], timeoutMs: 5000 } });
	await h.fire("session_start");
	await h.fire("before_agent_start");
	const before = h.names();
	const registrationsBefore = h.registrations.length;

	await h.command("restart");
	ok("restart: says so", h.messages().some((m) => /reconnecting/.test(m)), JSON.stringify(h.notices));
	await h.fire("before_agent_start");

	ok("restart: tool names are unchanged", h.names().join() === before.join(), `${before.join()} -> ${h.names().join()}`);
	ok("restart: registers no duplicate tool", h.registrations.length === registrationsBefore, h.registrations.join());
	const echoed = await h.call("fake_echo", { message: "after restart" });
	ok("restart: the handler is rebound to the new client", echoed?.content[0]?.text === "echo: after restart", JSON.stringify(echoed));

	const status = await statusText(h);
	ok("restart: status reports ready again", /fake v9\.9\.9 \[ready\]/.test(status), status);

	await h.fire("session_shutdown");
	await h.cleanup();
}

{
	// A restart whose server has become unstartable must show up in the status, or
	// the cycle guard added to that catch has hidden a real failure.
	const h = await extHarness({ probe: { command: join(tmpdir(), "gone-binary-xyz"), args: [], timeoutMs: 3000 } });
	await h.fire("session_start");
	await h.settle();
	await h.command("restart");
	await h.settle();

	const status = await statusText(h);
	ok("restart: a failing server is still reported as failed", /probe \[failed\]/.test(status), status);

	await h.fire("session_shutdown");
	await h.cleanup();
}

// ---------------------------------------------------------- startup gate ---

{
	// Tools are advertised as part of the request, so a tool registered mid-turn is
	// invisible until the next one. `before_agent_start` exists to stop a fast first
	// prompt racing the handshake.
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], timeoutMs: 5000 } });
	await h.fire("session_start");
	ok("gate: tools are not ready the instant the session starts", h.names().length === 0, h.names().join());

	await h.fire("before_agent_start");
	ok("gate: the first turn waits for the handshake", h.names().includes("fake_echo"), h.names().join());

	await h.fire("session_shutdown");
	await h.cleanup();
}

{
	// ...but one hung server must not hold the session hostage: the wait is bounded
	// by startupTimeoutMs.
	const h = await extHarness(
		{ slow: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"], timeoutMs: 30_000 } },
		{ startupTimeoutMs: 300 },
	);
	await h.fire("session_start");
	const started = Date.now();
	await h.fire("before_agent_start");
	const waited = Date.now() - started;

	ok("gate: a hung server does not block the turn forever", waited < 5_000, `waited ${waited}ms`);
	ok("gate: and the wait respects the configured budget", waited >= 250, `waited ${waited}ms`);

	await h.fire("session_shutdown");
	await h.cleanup();
}

// -------------------------------------------------------------- warnings ---

{
	// An allow-list naming a tool the server does not have is almost always a typo,
	// and the tool would otherwise just silently not appear.
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], tools: ["echo", "nope"], timeoutMs: 5000 } });
	await h.fire("session_start");
	await h.fire("before_agent_start");

	ok(
		"warns about a tool the server does not have",
		h.messages().some((m) => /has no tool named "nope"/.test(m)),
		JSON.stringify(h.notices),
	);
	ok("and still registers the ones it does have", h.names().includes("fake_echo"), h.names().join());
	ok("while honouring the allow-list", !h.names().includes("fake_boom"), h.names().join());

	await h.fire("session_shutdown");
	await h.cleanup();
}

{
	// Every exposed tool's schema is spent from the system prompt budget, so a
	// server offering a lot of them without an allow-list is worth a nudge.
	process.env.FAKE_EXTRA_TOOLS = "10";
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], timeoutMs: 5000 } });
	await h.fire("session_start");
	await h.fire("before_agent_start");
	ok(
		"suggests an allow-list for a noisy server",
		h.messages().some((m) => /consider a "tools" allow-list/.test(m)),
		JSON.stringify(h.notices),
	);
	await h.fire("session_shutdown");
	await h.cleanup();
	delete process.env.FAKE_EXTRA_TOOLS;
}

{
	process.env.FAKE_EXTRA_TOOLS = "10";
	const h = await extHarness({ fake: { command: process.execPath, args: [FAKE], tools: ["echo"], timeoutMs: 5000 } });
	await h.fire("session_start");
	await h.fire("before_agent_start");
	ok(
		"no nudge when an allow-list is already set",
		!h.messages().some((m) => /allow-list/.test(m)),
		JSON.stringify(h.notices),
	);
	await h.fire("session_shutdown");
	await h.cleanup();
	delete process.env.FAKE_EXTRA_TOOLS;
}

// ---------------------------------------------------------- /mcp status ---

{
	const h = await extHarness({});
	await h.fire("session_start");
	await h.command();
	ok(
		"status: says when nothing is configured",
		h.messages().some((m) => /no servers configured/.test(m)),
		JSON.stringify(h.notices),
	);
	await h.cleanup();
}

{
	const h = await extHarness({
		fake: { command: process.execPath, args: [FAKE], timeoutMs: 5000 },
		off: { command: "never-run", args: [], disabled: true },
	});
	await h.fire("session_start");
	await h.fire("before_agent_start");
	const status = await statusText(h);

	ok("status: lists a ready server with its version and tools", /fake v9\.9\.9 \[ready\] \d+ tools: /.test(status), status);
	ok("status: names the tools it registered", /fake_echo/.test(status), status);
	ok("status: shows a disabled server as disabled", /off \[disabled\]/.test(status), status);
	ok("status: never connects a disabled server", !h.names().some((n) => n.startsWith("off_")), h.names().join());

	await h.fire("session_shutdown");
	await h.cleanup();
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
	skip("real server checks (set PI_TEST_MCP_COMMAND to enable)");
}

done();

/** Run `/mcp` and return the status block it emitted. */
async function statusText(h) {
	const before = h.notices.length;
	await h.command();
	return h.notices
		.slice(before)
		.map((n) => n.message)
		.join("\n");
}
