/**
 * content.ts — MCP CallToolResult → Pi AgentToolResult 内容块解析。
 *
 * MCP 的 text/image 与 Pi 的 TextContent/ImageContent 字段一致，可直接映射；
 * 其余类型（audio / resource / …）MVP 降级为文本占位，不丢内容也不崩溃。
 */

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface McpCallResult {
	content?: McpContentBlock[];
	isError?: boolean;
}

export type PiContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function parseMcpContent(blocks: McpContentBlock[] | undefined): PiContentBlock[] {
	const out: PiContentBlock[] = [];
	for (const block of blocks ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			out.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else {
			out.push({ type: "text", text: `[未支持的 MCP 内容类型: ${block.type}]` });
		}
	}
	return out;
}

/** 多个 text 块拼成摘要（用于错误透传场景） */
export function textSummary(blocks: McpContentBlock[] | undefined): string {
	return (blocks ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}
