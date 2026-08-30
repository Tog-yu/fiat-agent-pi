/**
 * mcp-rag — MCP client 桥：把 RAG MCP server 的工具注册为 `mcp_rag_*`。
 *
 * 工厂注入模式：client 可注入（测试 mock / TUI 真实 SDK / Web 进程内），
 * 扩展业务代码三处共用。降级策略见 DEV_SPEC：
 *   connect / listTools 失败 → 不注册任何工具，onStatus("unavailable")
 *   callTool 超时 → 抛可重试错误（Pi 标记 isError 回灌模型）
 *   MCP isError → 抛 Error 透传摘要（Pi isError，模型知道失败但不重试死循环由模型自行判断）
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type McpCallResult, parseMcpContent, textSummary } from "./content.ts";
import { mcpSchemaToTypeBox } from "./schema.ts";
import { createTransport, type RagMcpConfig } from "./transport.ts";

export { ragConfigFromEnv } from "./transport.ts";

export type RagStatus = "ready" | "unavailable";

/** 最小 client 接口：真实 SDK 与测试 mock 都满足 */
export interface McpClientLike {
	connect(): Promise<void>;
	listTools(): Promise<{
		tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	}>;
	callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
	close(): Promise<void>;
}

export interface McpRagDeps {
	config: RagMcpConfig;
	/** 测试注入 mock；缺省用真实 MCP SDK（按 config 建 transport） */
	clientFactory?: (cfg: RagMcpConfig) => McpClientLike;
	/** 状态回调：ready（含注册数量）/ unavailable（含原因） */
	onStatus?: (status: RagStatus, detail: string) => void;
}

function defaultClient(cfg: RagMcpConfig): McpClientLike {
	const client = new Client({ name: "fiat-mcp-rag", version: "0.0.1" });
	const transport = createTransport(cfg);
	return {
		connect: () => client.connect(transport),
		listTools: () => client.listTools(),
		callTool: async (req) => (await client.callTool(req)) as McpCallResult,
		close: () => client.close(),
	};
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`RAG MCP ${label} 超时（${ms}ms），可重试`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

export function createMcpRag(deps: McpRagDeps): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		void bootstrap(pi, deps).catch((err: unknown) => {
			deps.onStatus?.("unavailable", err instanceof Error ? err.message : String(err));
		});
	};
}

async function bootstrap(pi: ExtensionAPI, deps: McpRagDeps): Promise<void> {
	const { config } = deps;
	const client = deps.clientFactory ? deps.clientFactory(config) : defaultClient(config);
	const timeoutMs = config.timeoutMs ?? 30_000;

	try {
		await client.connect();
	} catch (err) {
		deps.onStatus?.("unavailable", `connect 失败: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	let tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	try {
		const listed = await client.listTools();
		tools = listed.tools ?? [];
	} catch (err) {
		deps.onStatus?.("unavailable", `listTools 失败: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	for (const t of tools) {
		const toolName = `mcp_rag_${t.name}`;
		pi.registerTool(
			defineTool({
				name: toolName,
				label: `RAG ${t.name}`,
				description: t.description ?? "",
				promptSnippet: t.description ?? "",
				parameters: mcpSchemaToTypeBox(t.inputSchema),
				async execute(_toolCallId, params) {
					let result: McpCallResult;
					try {
						result = await withTimeout(
							client.callTool({ name: t.name, arguments: params as Record<string, unknown> }),
							timeoutMs,
							`callTool(${t.name})`,
						);
					} catch (err) {
						// 超时 / 网络错误：抛出 → Pi 标记 isError 回灌模型（文本含"可重试"提示）
						throw err instanceof Error ? err : new Error(String(err));
					}
					const content = parseMcpContent(result.content);
					if (result.isError) {
						// MCP 业务错误：透传摘要，不当可信知识；抛出 → isError
						throw new Error(textSummary(result.content) || "RAG MCP 返回 isError");
					}
					return { content, details: { mcpTool: t.name } };
				},
			}),
		);
	}

	deps.onStatus?.("ready", `已注册 ${tools.length} 个 RAG 工具`);
}
