/**
 * P9-40 两类新契约（阶段 9 分流的形式化定义）。
 *
 * 背景（依据 §3 分流表 + §2.5「关键修正·二次」）：
 * 阶段 8 弃用了扩展加载器（目录自动发现 + `pi -e`），7 个 L1 扩展按性质分流：
 *
 * ── L1a 内建 extension（钩子型：permission-gate / audit-hook / model-router）──────────
 *   契约：**保留** Pi `ExtensionFactory` 签名 `(pi) => void | Promise<void>`，仅换装配方式：
 *   目录发现 → `extensionFactories` 编译期注入（经 `buildEmbeddedExtensionFactories`
 *   白名单 → `setupEmbeddedExtensions` → 官方 ExtensionRunner）。
 *   - 钩子语义完全复用 Pi agent-loop：`tool_call` 返回 `{ block, reason }` 短路回灌（闸门②）、
 *     `tool_result` 可改写 content/details/isError（审计）、`before_agent_start` 可副作用切模型。
 *   - 内嵌模式与 `pi -e` 的差异：`pi.setModel` / `pi.registerProvider` 依赖宿主在 Runner 上
 *     `bindCore` / provider flush。宿主通过 `bindHostActions`（本文件）显式提供；未绑定时
 *     这些 action 走 Pi 默认的「not initialized」拒绝路径——安全降级，不炸。
 *
 * ── L1b 工具模块（工具型：mcp-rag / fiat-tools / job-apply / alert-fanout）────────────
 *   契约：**去掉 `ExtensionAPI` 依赖**，工厂直接返回 `HostTool[]`：
 *
 *     export function createXxxTools(deps: XxxDeps): HostTool[]
 *
 *   - `HostTool` = `AgentTool<TSchema>`（0.80.3 `pi-agent-core` 实测形状），注册走
 *     `registerTools(agent, tools)`（写入 `agent.state.tools`，赋值即拷贝顶层数组）。
 *   - 工具内**不写**权限/审计逻辑：闸门①（会话级裁剪，工厂内 allowedTools 谓词）、
 *     闸门②（L1a tool_call 钩子）、闸门③（L2 canExecute，执行前最后一查）都在外面。
 *   - `defineTool`（Pi 的 TypeBox schema 工厂）与加载器无关，L1b 仍可用于生成工具定义；
 *     但**模块出口类型必须是 `HostTool`**（`defineHostTool` 校验过 name/execute）。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { HostTool } from "./tools.ts";

/** L1b 工具模块出口类型：`defineHostTool` 校验后的 `AgentTool` */
export type { HostTool };

/**
 * L1a 内建 extension 契约：与 Pi `ExtensionFactory` 同签名（结构化等价，不重复声明类型）。
 * 装配方式见 `embedded-factories.ts`（白名单）+ `extensions.ts`（编译期注入）。
 */

/** 宿主为 model-router 等提供的 model 操作面（`ExtensionActions` 的最小子集） */
export interface HostModelActions {
	/** 切换当前模型（对应 AgentSession.setModel 语义：校验 auth → 写 agent.state.model） */
	setModel: (model: Model<Api>) => Promise<boolean>;
	/** 当前模型 */
	getModel: () => Model<Api> | undefined;
	/** thinking level（Pi Runner bindCore 必填；宿主固定 off——fiat 场景不启用 thinking） */
	getThinkingLevel: () => ThinkingLevel;
	setThinkingLevel: (level: ThinkingLevel) => void;
}

/** provider 注册配置（0.80.3 `ProviderConfig` 的宿主侧最小形状） */
export interface HostProviderConfig {
	baseUrl: string;
	apiKey: string;
	api: string;
	models: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		input: string[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	}>;
}

/**
 * 宿主 agent 操作句柄：把 L1a 需要的 action 桥到内嵌 Agent。
 * model-router 是唯一消费者（`pi.setModel` / `pi.registerProvider`）。
 */
export interface HostAgentHandle {
	actions: HostModelActions;
	/** provider 注册落点（直接写 ModelRegistry，与 Runner 默认 flush 行为一致） */
	registerProvider: (name: string, config: HostProviderConfig) => void;
}

/**
 * 从内嵌循环构件组装 HostAgentHandle。
 * `registerTools` 已由 P8-36 通道承担工具注册，这里只补 model 面。
 */
export function createHostAgentHandle(
	agent: { state: { model?: Model<Api> } },
	registerProvider: HostAgentHandle["registerProvider"],
): HostAgentHandle {
	return {
		actions: {
			setModel: async (model) => {
				agent.state.model = model;
				return true;
			},
			getModel: () => agent.state.model,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {
				/* fiat 场景固定 off，忽略 */
			},
		},
		registerProvider,
	};
}

/**
 * 工具模块防呆：校验数组内每项都过了 `defineHostTool` 的形状检查（name + execute）。
 * 工具模块出口用 `defineHostTools([...])` 包一层，防呆从单个工具升级到整组。
 */
export function defineHostTools(tools: readonly HostTool[]): HostTool[] {
	for (const t of tools) {
		if (!t || typeof t !== "object" || typeof t.name !== "string" || typeof t.execute !== "function") {
			throw new Error("defineHostTools: every tool must be a validated HostTool (name + execute)");
		}
	}
	return [...tools];
}

/** 工具 schema 类型再导出（工具模块签名声明用） */
export type { TSchema };
