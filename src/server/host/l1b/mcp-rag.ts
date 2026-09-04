/**
 * mcp-rag — L1b 工具模块（P9-42，原 workspace/pi-extensions/mcp-rag）：MCP client 桥，
 * 把 RAG MCP server 的工具暴露为 `mcp_rag_*`。
 *
 * **P9-40 新契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`：
 *
 *   const tools = await createMcpRagTools(deps); // async：bootstrap 需 connect/listTools
 *
 * - 降级策略不变（见 DEV_SPEC §6）：
 *   connect / listTools 失败 → 返回空数组 + onStatus("unavailable")（不注册任何工具）
 *   callTool 超时 → 抛可重试错误（Agent 循环标记 isError 回灌模型）
 *   MCP isError → 抛 Error 透传摘要（isError，模型知道失败但不重试死循环由模型自行判断）
 * - 工具内不写权限/审计逻辑：闸门①（allowedTools 谓词，工厂内裁剪）、闸门②（L1a
 *   permission-gate 的 tool_call 钩子）、闸门③（L2 canExecute）都在外面。
 * - `defineTool` 仅作 TypeBox schema 工厂使用（与加载器无关），出口经 `defineHostTool`
 *   校验为 `HostTool`；promptSnippet（Pi 工具的 UI 提示字段）在纯 AgentTool 契约下
 *   不再携带——宿主侧系统提示词由 L2 显式下发，不依赖工具 snippet。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";
import { type McpCallResult, parseMcpContent, textSummary } from "./mcp-rag-content.ts";
import { mcpSchemaToTypeBox } from "./mcp-rag-schema.ts";
import { createTransport, type RagMcpConfig } from "./mcp-rag-transport.ts";

export type { RagMcpConfig } from "./mcp-rag-transport.ts";
export { ragConfigFromEnv } from "./mcp-rag-transport.ts";

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
	/** 工具白名单谓词（三道闸门之①：会话级裁剪，模型根本看不到被拒工具）。缺省不过滤 */
	allowedTools?: (registeredToolName: string) => boolean;
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

/**
 * bootstrap：connect → listTools →（白名单过滤）→ 生成 HostTool[]。
 * 任何失败都降级为空数组 + onStatus("unavailable")，不抛——与旧版语义一致。
 */
export async function createMcpRagTools(deps: McpRagDeps): Promise<HostTool[]> {
	const { config } = deps;
	const client = deps.clientFactory ? deps.clientFactory(config) : defaultClient(config);
	const timeoutMs = config.timeoutMs ?? 30_000;

	try {
		await client.connect();
	} catch (err) {
		deps.onStatus?.("unavailable", `connect 失败: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}

	let tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	try {
		const listed = await client.listTools();
		tools = listed.tools ?? [];
	} catch (err) {
		deps.onStatus?.("unavailable", `listTools 失败: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}

	const hostTools: HostTool[] = [];
	for (const t of tools) {
		const toolName = `mcp_rag_${t.name}`;
		// 闸门①：会话级工具裁剪。白名单谓词拒绝 → 不注册，模型根本看不到
		if (deps.allowedTools && !deps.allowedTools(toolName)) {
			deps.onStatus?.("ready", `工具 ${toolName} 不在角色白名单，跳过注册`);
			continue;
		}
		hostTools.push(
			hostToolFromDefinition(
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
							// 超时 / 网络错误：抛出 → Agent 循环标记 isError 回灌模型（文本含"可重试"提示）
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
			),
		);
	}

	deps.onStatus?.("ready", `已注册 ${tools.length} 个 RAG 工具`);
	return hostTools;
}
