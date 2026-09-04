/**
 * P8-36 工具注册通道（L1b）：把工具**直接**注册进内嵌循环，替代扩展加载器。
 *
 * 设计口径（与阶段 8 铁律一致）：
 * - 阶段 8 弃用的是扩展加载器（目录自动发现 + `pi -e`），不是「工具」本身。
 *   4 个工具型扩展（mcp-rag / fiat-tools / job-apply / alert-fanout）在阶段 9 改写为
 *   **工具模块**：去掉 `ExtensionAPI` 依赖，直接暴露 `AgentTool`（正式契约 P9-40 定）。
 * - 本模块就是那条通道：`defineHostTool` 是工具模块的无 ExtensionAPI 落点（雏形契约），
 *   `registerTools` 把工具写入 `agent.state.tools`——赋值即拷贝顶层数组，模型当轮可见。
 * - 拦截/审计**不在这里做**：闸门② 走 L1a 钩子通道（P8-37 `extensionFactories` 的
 *   `tool_call` 钩子），服务端 `canExecute` 在 L2。工具通道只管「注册 + 可见 + 可执行」。
 *
 * `AgentTool`（0.80.3 实测 d.ts）= `Tool<TSchema>`（name/description/parameters）+ `label`
 * + `execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>`，
 * 可选 `prepareArguments` / `executionMode`（"sequential" | "parallel"）。
 * LLM 侧只见 `Tool` 形状（`Context.tools?: Tool[]`），execute 由 Agent 循环在本地调用。
 */

import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/** pi-host 工具模块暴露的工具形状（去掉 ExtensionAPI 的 L1b 契约雏形，正式契约 P9-40） */
// biome-ignore lint/suspicious/noExplicitAny: 对齐 pi 自身口径——AgentState.tools 即 AgentTool<any>[]，具体 schema 工具可赋入通用列表
export type HostTool = AgentTool<any>;

/**
 * ToolDefinition（Pi 扩展工具定义，execute 5 参含 ctx）→ AgentTool（宿主 4 参）。
 * 对标官方 `wrapToolDefinition`（core/tools/tool-definition-wrapper.js，未从包入口导出）：
 * 丢弃 renderCall/renderResult 等 TUI 渲染字段，execute 末参补 undefined ctx。
 * P9-40 契约下 L1b 工具模块用它把 `defineTool` 产物收编为 `HostTool`。
 */
export function hostToolFromDefinition<TDetails = unknown>(
	// biome-ignore lint/suspicious/noExplicitAny: 对齐 pi 自身口径——ToolDefinition 泛型默认 any，收编时抹平为 HostTool
	definition: ToolDefinition<any, TDetails>,
): HostTool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
	};
}

/**
 * 过渡兼容（P9-40~P9-49）：把 HostTool[] 包成 extension factory（`(pi) => void`），
 * 供仍走 `createAgentSession` 扩展注册路径的调用方（旧测试 / pi -e 遗留入口）使用。
 * 入口切换（P9-49）后内嵌循环直接消费 HostTool[]，此适配器可删。
 */
export function hostToolsAsFactory(tools: readonly HostTool[]): (pi: ExtensionAPI) => void {
	return (pi) => {
		for (const tool of tools) pi.registerTool(tool);
	};
}

/**
 * 工具模块契约落点：恒等返回并做最小防呆校验。
 * 工具模块用它声明自己的工具（阶段 9 的 4 个工具模块都以它为出口类型）。
 * 泛型透传 TParameters / TDetails，execute 的 params 保留具体 schema 推断类型。
 */
export function defineHostTool<TParameters extends TSchema, TDetails = unknown>(
	tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
	if (!tool || typeof tool !== "object") {
		throw new Error("defineHostTool: tool must be an object");
	}
	if (typeof tool.name !== "string" || tool.name.length === 0) {
		throw new Error("defineHostTool: tool.name is required");
	}
	if (typeof tool.execute !== "function") {
		throw new Error(`defineHostTool(${tool.name}): execute must be a function`);
	}
	return tool;
}

/**
 * 把工具注册进内嵌循环：写入 `agent.state.tools`（赋值即拷贝顶层数组）。
 * 幂等覆盖式——每次注册替换整组工具，与「编译期注入、受控白名单」的阶段口径一致。
 */
export function registerTools(agent: Agent, tools: readonly HostTool[]): void {
	agent.state.tools = [...tools];
}
