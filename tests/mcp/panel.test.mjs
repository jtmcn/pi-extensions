import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { mcpPanelLines, publishMcpPanel, clearMcpPanel } = await loadExt("mcp/panel.ts");
const panels = await loadExt("lib/panels.ts");

const servers = [
	{ name: "linear", state: "connected", toolCount: 12 },
	{ name: "notion", state: "connected", toolCount: 12 },
	{ name: "databricks", state: "failed", toolCount: 8, detail: "spawn failed: ENOENT no such file or directory /usr/bin/mcp" },
	{ name: "old", state: "disabled", toolCount: 0 },
	{ name: "slow", state: "connecting", toolCount: 0 },
];

const lines = mcpPanelLines(servers, 120);
const text = lines.join("\n");
ok("shows connected servers", text.includes("linear"));
ok("shows tool counts", text.includes("12"));
ok("marks connected", text.includes("✓"));
ok("marks failed", text.includes("✗"));
ok("explains a failure", text.includes("spawn failed"));
ok("suggests the fix", text.includes("/mcp restart"));
ok("shows disabled servers", text.includes("old") && text.includes("disabled"));
ok("shows connecting servers", text.includes("slow") && text.includes("connecting"));
ok("only connected servers contribute tool counts", text.includes("24 tools"));
ok("header counts every server", text.includes("5 servers"));
ok("no line exceeds width", Math.max(...mcpPanelLines(servers, 80).map((l) => l.length)) <= 80);
ok("narrow width still fits", Math.max(...mcpPanelLines(servers, 60).map((l) => l.length)) <= 60);
ok("no servers yields no lines", mcpPanelLines([], 120).length === 0);

// Registry integration
panels.resetPanels("mcp");
publishMcpPanel(servers);
const registered = panels.listPanels().filter((p) => p.owner === "mcp");
ok("registers one panel", registered.length === 1);
ok("panel is titled MCP", registered[0].title === "MCP");
ok("panel renders the servers", registered[0].render(120).join("\n").includes("linear"));

publishMcpPanel([{ name: "linear", state: "connected", toolCount: 3 }]);
ok("republishing replaces rather than duplicates", panels.listPanels().filter((p) => p.owner === "mcp").length === 1);
ok("republishing shows new data", panels.listPanels().find((p) => p.owner === "mcp").render(120).join("\n").includes("3"));

clearMcpPanel();
ok("clear removes the panel", panels.listPanels().filter((p) => p.owner === "mcp").length === 0);

done();
