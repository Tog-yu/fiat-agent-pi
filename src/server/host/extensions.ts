/**
 * P8-37 钩子通道（L1a）：打通 `extensionFactories` 编译期注入通道，替代扩展加载器。
 *
 * 设计口径（与阶段 8 铁律一致，呼应 §2.5「关键修正·二次」）：
 * - 弃用的是**目录自动发现**（原扩展加载器），**不是 ExtensionAPI**。
 *   钩子型扩展（permission-gate / audit-hook / model-router）保留 `ExtensionFactory`
 *   签名（`(pi) => void`），仅换装配方式：目录发现 → 编译期注入。
 * - 对标 openclaw `pi-embedded-runner/extensions.ts` 的 `buildEmbeddedExtensionFactories()`：
 *   `DefaultResourceLoader` 传 `noExtensions/noSkills/...: true` 关自动发现，但**仍传
 *   `extensionFactories`**；`ExtensionRunner` 用 Pi 官方执行器触发钩子（不自研钩子语义）。
 * - 桥接（Pi 官方类型实测，形状直通）：
 *   - Agent `beforeToolCall` 返回 `BeforeToolCallResult {block?, reason?}`
 *     ≡ extension `tool_call` 钩子返回 `ToolCallEventResult {block?, reason?}`（闸门②）。
 *   - Agent `afterToolCall` 返回 `{content?, details?, isError?, terminate?}` ⊇
 *     extension `tool_result` 钩子返回 `ToolResultEventResult {content?, details?, isError?}`。
 *   - 发给 runner 的事件：宿主工具均为自定义名 → `CustomToolCallEvent {toolName: string,
 *     input: Record<string, unknown>}`；`input` 传 validated args（可变引用，钩子可就地改参）。
 * - `before_agent_start`（model-router 用）桥接点在 Agent 无同名 options，留 P8-38 宿主职责移植。
 */

import type {
	AfterToolCallContext,
	AfterToolCallResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type {
	ExtensionFactory,
	LoadExtensionsResult,
	SettingsManager,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildEmbeddedExtensionFactories } from "./embedded-factories.ts";

/** 经 DefaultResourceLoader + ExtensionRunner 装配好的内建 extension 集合 */
export interface EmbeddedExtensions {
	/** Pi 官方钩子执行器（闸门② / 审计钩子的触发点） */
	runner: ExtensionRunner;
	/** 资源加载器（已注入 factories、关闭自动发现） */
	loader: DefaultResourceLoader;
	/** 加载结果（extensions + runtime + errors） */
	loaded: LoadExtensionsResult;
}

export interface EmbeddedExtensionsOptions {
	cwd: string;
	/** 独立 agent 目录（避免与个人 Pi 配置混杂） */
	agentDir: string;
	/** 编译期注入的内建 extension 工厂（L1a 白名单） */
	factories?: readonly ExtensionFactory[];
	/** 复用已有 SettingsManager（不传则 inMemory 空 settings） */
	settingsManager?: SettingsManager;
}

/**
 * 装配内建 extension：factory 编译期注入 → DefaultResourceLoader 加载 → 官方 Runner。
 * 关闭目录自动发现（no* 全 true），只有白名单里的 factory 会生效。
 *
 * P10-50：显式 `bindCore` 最小动作集。官方 `createAgentSession` 内部会绑
 * （agent-session.ts:1768），直驱路线没有 SDK 会话，须自绑——否则 `pi.setModel` /
 * `pi.registerProvider` 停留在 loader 的 pre-bind 桩（`Promise.reject("Extension
 * runtime not initialized")`），钩子里调用会抛并被 emitError 吞掉（P8-37 实测口径）。
 * 最小集 = 宿主真实持有的能力：modelRegistry 注册 + setModel 直通成功。
 */
export async function setupEmbeddedExtensions(opts: EmbeddedExtensionsOptions): Promise<EmbeddedExtensions> {
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		settingsManager: opts.settingsManager,
		extensionFactories: buildEmbeddedExtensionFactories(opts.factories ?? []),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const loaded = loader.getExtensions();
	// Runner 依赖：inMemory 的 Session / ModelRegistry / AuthStorage——宿主自持，不读个人配置。
	const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		opts.cwd,
		SessionManager.inMemory(opts.cwd),
		modelRegistry,
	);
	// 最小核心动作：注册/切模型走 runner 自持的 modelRegistry（与官方 providerActions
	// 语义一致）；其余 sendMessage / compact 等动作内嵌循环不消费，不绑。
	runner.bindCore(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async () => true,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		},
	);
	return { runner, loader, loaded };
}

/**
 * 把内建 extension 的钩子桥接为 `Agent` options 的 `beforeToolCall` / `afterToolCall`。
 * `beforeAgentStart` 单独透出（model-router 的 `before_agent_start` 桥接点，P10-50 起
 * 内嵌循环也触发模型路由；Agent 无同名 options，由宿主在每轮 prompt 前调用）。
 * 返回值直接可展开进 `new Agent({...})` / `HostLoopOptions`。
 */
export function bridgeAgentHooks(
	runner: ExtensionRunner,
	opts: { cwd: string } = { cwd: process.cwd() },
): {
	beforeToolCall: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** model-router 桥接点：每轮开始前触发 `before_agent_start`（路由决策经 pi.setModel 副作用生效） */
	beforeAgentStart: (prompt: string) => Promise<void>;
} {
	return {
		// 闸门②：tool_call 钩子可 block（结果形状与 BeforeToolCallResult 一致，直通）。
		beforeToolCall: async (context) => {
			const event = {
				type: "tool_call",
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				// 可变引用：钩子就地改参即生效（Pi 语义 "mutate event.input in place"）。
				input: context.args as Record<string, unknown>,
			} as ToolCallEvent;
			return runner.emitToolCall(event);
		},
		// audit-hook 桥接点：tool_result 钩子可改写 content/details/isError。
		afterToolCall: async (context) => {
			const event = {
				type: "tool_result",
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				input: context.args as Record<string, unknown>,
				content: context.result.content,
				isError: context.isError,
				details: context.result.details,
			} as ToolResultEvent;
			return runner.emitToolResult(event);
		},
		// model-router 桥接点：路由决策经 pi.setModel 副作用生效；返回值（message/systemPrompt）
		// 内嵌循环不消费（与 fiat 口径一致：不改 systemPrompt，避免与其他扩展抢覆写）。
		beforeAgentStart: async (prompt) => {
			await runner.emitBeforeAgentStart(prompt, undefined, "", { cwd: opts.cwd });
		},
	};
}

export type { ExtensionFactory };
