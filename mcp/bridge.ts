/**
 * Pure mapping between MCP and pi's tool surface.
 *
 * Kept free of I/O and of the pi API so every rule here — naming, allow-list
 * filtering, content translation — is directly testable.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { McpCallResult, McpContentBlock, McpTool } from "./client.ts";

/** Tool names the model sees: lowercase, digits and underscores. */
function sanitize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

/**
 * Build the pi tool name for an MCP tool.
 *
 * Namespaced by server because tool names collide across servers in practice
 * ("query", "search"). `taken` makes the result unique even after sanitizing
 * maps two distinct names onto one.
 */
export function toolName(server: string, tool: string, taken: Set<string> = new Set()): string {
	const base = [sanitize(server), sanitize(tool)].filter(Boolean).join("_") || "mcp_tool";
	// A leading digit is legal for us but reads like an index; prefix it.
	const safe = /^[0-9]/.test(base) ? `mcp_${base}` : base;
	if (!taken.has(safe)) return safe;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${safe}_${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export interface SelectionResult {
	selected: McpTool[];
	/** Allow-list entries that matched nothing — almost always a typo. */
	unknown: string[];
}

/**
 * Apply a server's tool allow-list.
 *
 * An absent allow-list means "everything", which is the permissive default MCP
 * clients normally have. A present one is exact-match, and unmatched entries
 * are reported rather than silently ignored: a typo would otherwise look
 * identical to a tool the server stopped offering.
 */
export function selectTools(tools: McpTool[], allow?: string[]): SelectionResult {
	if (!allow) return { selected: tools, unknown: [] };
	const available = new Set(tools.map((tool) => tool.name));
	return {
		selected: tools.filter((tool) => allow.includes(tool.name)),
		unknown: allow.filter((name) => !available.has(name)),
	};
}

/** Description shown to the model, with a fallback for servers that omit one. */
export function toolDescription(server: string, tool: McpTool): string {
	const text = tool.description?.trim() || tool.title?.trim();
	return text ? text : `MCP tool "${tool.name}" from the ${server} server.`;
}

/**
 * Input schema for the model.
 *
 * MCP hands over raw JSON Schema. Passing it through untouched is correct —
 * pi serializes tool parameters straight to the provider and does not run a
 * TypeBox `Value.Check` over arguments — but the object still has to be
 * *typed* as a TypeBox schema, which is what `Type.Unsafe` is for. The caller
 * wraps; this function only guarantees a sane object schema exists, since some
 * servers omit `inputSchema` for zero-argument tools.
 */
export function inputSchema(tool: McpTool): Record<string, unknown> {
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { type: "object", properties: {} };
	}
	if (schema.type !== "object") return { type: "object", properties: {}, ...schema };
	return schema;
}

/**
 * Translate MCP content blocks into pi's tool result content.
 *
 * pi accepts text and image blocks. Everything else is flattened to text
 * rather than dropped, because a resource the model cannot see is worse than
 * a description of it.
 */
export function toAgentContent(result: McpCallResult): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		const mapped = mapBlock(block);
		if (mapped) content.push(mapped);
	}

	if (content.length === 0) {
		content.push({ type: "text", text: result.isError ? "Tool failed with no output." : "(no content)" });
	}

	// Mark tool-level failures inline: the call itself succeeded, so pi has no
	// other signal that the model is looking at an error.
	if (result.isError) {
		const first = content[0];
		if (first?.type === "text") first.text = `MCP tool error: ${first.text}`;
		else content.unshift({ type: "text", text: "MCP tool error:" });
	}

	return content;
}

function mapBlock(block: McpContentBlock): TextContent | ImageContent | undefined {
	if (!block || typeof block !== "object") return undefined;

	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? { type: "text", text: block.text } : undefined;

		case "image":
			// pi's ImageContent is base64 + mimeType, the same shape MCP uses.
			return typeof block.data === "string"
				? { type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" }
				: undefined;

		case "audio":
			return { type: "text", text: `[audio content omitted: ${block.mimeType ?? "unknown type"}]` };

		case "resource": {
			const resource = block.resource as Record<string, unknown> | undefined;
			const uri = typeof resource?.uri === "string" ? resource.uri : "unknown";
			if (typeof resource?.text === "string") {
				return { type: "text", text: `[resource ${uri}]\n${resource.text}` };
			}
			return { type: "text", text: `[binary resource ${uri} omitted]` };
		}

		case "resource_link": {
			const uri = typeof block.uri === "string" ? block.uri : "unknown";
			const name = typeof block.name === "string" ? ` (${block.name})` : "";
			return { type: "text", text: `[resource link ${uri}${name}]` };
		}

		default:
			// Forward-compatible: a block type added after this was written still
			// reaches the model as something readable.
			return { type: "text", text: JSON.stringify(block) };
	}
}
