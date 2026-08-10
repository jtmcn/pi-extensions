/**
 * What the dashboard shows for MCP.
 *
 * The dashboard could infer connected servers from tool names, but a server
 * that failed to spawn exposes no tools and would simply be missing. Only this
 * extension knows the difference between "not configured" and "died on
 * startup, run /mcp restart".
 */

import { registerPanel, resetPanels } from "../lib/panels.ts";

const OWNER = "mcp";
const PANEL_ID = "mcp";

export interface ServerStatus {
	name: string;
	state: "connecting" | "connected" | "failed" | "disabled";
	toolCount: number;
	/** Present when state is "failed". */
	detail?: string;
}

function describe(server: ServerStatus): string {
	if (server.state === "connected") return `✓ ${server.toolCount}`;
	if (server.state === "disabled") return "· disabled";
	if (server.state === "connecting") return "… connecting";
	return `✗ ${server.detail ?? "failed"} — /mcp restart`;
}

export function mcpPanelLines(servers: ServerStatus[], width: number): string[] {
	if (servers.length === 0) return [];

	const connected = servers.filter((s) => s.state === "connected");
	const tools = connected.reduce((sum, s) => sum + s.toolCount, 0);
	const nameWidth = Math.max(...servers.map((s) => s.name.length));

	const lines = [`  ${servers.length} servers · ${tools} tools`];
	for (const server of servers) {
		lines.push(`  ${server.name.padEnd(nameWidth)}  ${describe(server)}`);
	}
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

export function publishMcpPanel(servers: ServerStatus[]): void {
	registerPanel({
		id: PANEL_ID,
		owner: OWNER,
		title: "MCP",
		order: 20,
		render: (width) => mcpPanelLines(servers, width),
	});
}

export function clearMcpPanel(): void {
	resetPanels(OWNER);
}
