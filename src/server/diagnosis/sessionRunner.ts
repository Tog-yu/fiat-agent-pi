/**
 * P6-25 真实子会话 runner：每个诊断视角起一个**独立**内嵌会话并发跑。
 *
 * P10-50 扩展加载器清理：子会话从遗留 `createAgentSession`（SDK 扩展注册路径）切换到
 * pi-host 内嵌循环（`PiHostLoop`，P8-34/37 装配链）—— 与 chat / 闸门测试完全同源：
 *   - 子会话由组合根用**同一个 buildSession** 构造 → 共享 subject 与三道闸门，
 *     L1a 钩子经 setupEmbeddedExtensions + bridgeAgentHooks 生效（闸门②），
 *     L1b 工具直接注册进循环（P8-36 通道），`hostToolsAsFactory` 过渡适配器随之删除
 *   - 会话用 inMemory：诊断子 agent 是一次性的取证过程，不需要落盘
 *   - 只读：可用工具由 DiagnosisTask.tools 收敛，由组合根经 toolFilter 生效
 *
 * buildChildSession 由外部注入而不是直接 import buildSession ——
 * 避免 sessionRunner ↔ session/factory 循环依赖。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bridgeAgentHooks, setupEmbeddedExtensions } from "../host/extensions.ts";
import { PiHostLoop } from "../host/loop.ts";
import type { RunOne } from "./fanout.ts";
import type { DiagnosisTask } from "./plan.ts";

/** 子会话所需产出；SessionFactoryResult 结构上满足（避免 import factory 形成循环依赖） */
export interface ChildSessionBundle {
	sessionId: string;
	/** P8-36 L1b 工具通道：直接注册进内嵌循环的工具集 */
	tools?: import("../host/tools.ts").HostTool[];
	/** P8-37 L1a 钩子通道：编译期注入的内建 extension 工厂（permission-gate / audit-hook / model-router） */
	extensionFactories?: Array<(pi: ExtensionAPI) => void>;
}

/** 按视角构造子会话：视角的 tools 应在此收敛为只读子集（组合根 async，允许 Promise） */
export type BuildChildSession = (task: DiagnosisTask) => ChildSessionBundle | Promise<ChildSessionBundle>;

export interface DiagnosisRunnerDeps {
	buildChildSession: BuildChildSession;
	model: Model<Api>;
	/** provider 名 → API key（faux 测试注入固定值；生产缺省读环境变量） */
	getApiKey?: (provider: string) => string | undefined;
	cwd: string;
	agentDir: string;
}

export function createDiagnosisRunner(deps: DiagnosisRunnerDeps): RunOne {
	return async (task: DiagnosisTask) => {
		const bundle = await deps.buildChildSession(task);

		const { runner } = await setupEmbeddedExtensions({
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			factories: bundle.extensionFactories ?? [],
		});

		const host = new PiHostLoop({
			model: deps.model,
			getApiKey: deps.getApiKey,
			sessionId: bundle.sessionId,
			tools: bundle.tools ?? [],
			...bridgeAgentHooks(runner),
		});

		try {
			const r = await host.runTurnSafe(task.prompt);
			return r.ok ? r.reply : `（视角执行失败：${r.error}）`;
		} finally {
			// inMemory 会话随 Agent 释放；无持久化句柄需要显式 dispose
		}
	};
}

/** 取最后一条 assistant 消息的文本作为该视角结论 */
export function extractFinalText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		const text = textOf(msg.content);
		if (text) return text;
	}
	return "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const part = item as { type?: string; text?: string } | undefined;
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}
