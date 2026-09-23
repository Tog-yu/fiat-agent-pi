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
import { LANGFUSE_KEYS, OBS_TYPE } from "../../tracing/otlp.ts";
import { resolveTracing, type TracingSource } from "../../tracing/types.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";
import { type McpCallResult, parseMcpContent, textSummary } from "./mcp-rag-content.ts";
import { mcpSchemaToTypeBox } from "./mcp-rag-schema.ts";
import { createTransport, type RagMcpConfig } from "./mcp-rag-transport.ts";

export type { RagMcpConfig } from "./mcp-rag-transport.ts";
export { ragConfigFromEnv } from "./mcp-rag-transport.ts";
/**
 * RAG 侧（知识库 + 记忆检索）对外暴露的**统一状态词汇**。
 *
 * - `ready` / `unavailable`：**装配期**状态，由本模块的 bootstrap 报出（connect / listTools 结果）。
 * - `circuit_open`：**运行期**状态，由记忆检索侧的断路器（P15-106，`memory/circuit.ts`）报出。
 *
 * 为什么两种状态共用一个类型：设计文档 §2.7 要求熔断状态与 `RagStatus`
 * **合并展示** —— 用户视角的问题永远是「记忆/知识库现在能不能用」，
 * 把它拆成两套词汇只会让上层又要做一次归并。加值不改语义，既有消费点
 * 只比较 `"ready"` / `"unavailable"`，因此是纯增量。
 */
export type RagStatus = "ready" | "unavailable" | "circuit_open";

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
	/**
	 * 阶段 14（P14-88）：全链路追踪。**缺省 undefined = 不开**（零开销）。
	 * 挂了之后每次 `callTool` 出一个 `fiat.mcp.call` 子 span，父 span 由
	 * `trace.toolSpans`（toolCallId → tool span）解析——这样「tool → mcp」的嵌套才在树里。
	 */
	tracing?: TracingSource;
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
					async execute(toolCallId, params) {
						// 阶段 14（P14-88）：MCP 一跳单独成 span。父 span 从注册表取——
						// 此刻我们只有 toolCallId，tool span 的 id 在 trace-hook 手里。
						// 现取（不是构建时钉住）：chat 是 per-turn trace，工具执行在某一轮之内。
						const wiring = resolveTracing(deps.tracing);
						const parentSpanId = wiring?.trace.toolSpans?.get(toolCallId);
						const span =
							wiring?.trace.sampled === true
								? wiring.tracer.startSpan(wiring.trace, "fiat.mcp.call", {
										kind: "client",
										...(parentSpanId ? { parentSpanId } : {}),
										attributes: {
											[LANGFUSE_KEYS.obsType]: OBS_TYPE.span,
											"fiat.mcp.tool": t.name,
											"fiat.mcp.transport": config.transport,
											"fiat.mcp.timeout_ms": timeoutMs,
										},
									})
								: undefined;
						span?.setInput(params);
						let result: McpCallResult;
						try {
							result = await withTimeout(
								client.callTool({ name: t.name, arguments: params as Record<string, unknown> }),
								timeoutMs,
								`callTool(${t.name})`,
							);
						} catch (err) {
							// 超时 / 网络错误：抛出 → Agent 循环标记 isError 回灌模型（文本含"可重试"提示）
							span?.setStatus("error", err instanceof Error ? err.message : String(err));
							span?.end();
							throw err instanceof Error ? err : new Error(String(err));
						}
						const content = parseMcpContent(result.content);
						if (result.isError) {
							// MCP 业务错误：透传摘要，不当可信知识；抛出 → isError
							span?.setStatus("error", "MCP returned isError");
							span?.end();
							throw new Error(textSummary(result.content) || "RAG MCP 返回 isError");
						}
						span?.setOutput(textSummary(result.content));
						span?.setStatus("ok");
						span?.end();
						return { content, details: { mcpTool: t.name } };
					},
				}),
			),
		);
	}

	deps.onStatus?.("ready", `已注册 ${tools.length} 个 RAG 工具`);
	return hostTools;
}
