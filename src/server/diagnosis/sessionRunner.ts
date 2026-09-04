/**
 * P6-25 真实子会话 runner：每个诊断视角起一个**独立** AgentSession 并发跑。
 *
 * 这是选「L2 进程内 fan-out」而不用 Pi 官方 subagent 扩展的关键兑现点：
 *   - 子会话由组合根用**同一个 buildSession** 构造 → 共享 subject 与三道闸门，
 *     审计落在同一条链上；子进程方案做不到（扩展是依赖注入工厂，磁盘加载等于没注册）
 *   - 会话用 inMemory：诊断子 agent 是一次性的取证过程，不需要落盘
 *   - 只读：可用工具由 DiagnosisTask.tools 收敛，由组合根经 toolFilter 生效
 *
 * buildChildSession 由外部注入而不是直接 import buildSession ——
 * 避免 sessionRunner ↔ session/factory 循环依赖。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { hostToolsAsFactory } from "../host/tools.ts";
import type { RunOne } from "./fanout.ts";
import type { DiagnosisTask } from "./plan.ts";

/** 子会话所需产出；SessionFactoryResult 结构上满足（避免 import factory 形成循环依赖） */
export interface ChildSessionBundle {
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
	sessionId: string;
	/** P9-42：L1b 工具通道产物（过渡期经 hostToolsAsFactory 注册进遗留会话路径）；缺省无工具 */
	hostTools?: import("../host/tools.ts").HostTool[];
}

/** 按视角构造子会话：视角的 tools 应在此收敛为只读子集（P9-42 起组合根 async，允许 Promise） */
export type BuildChildSession = (task: DiagnosisTask) => ChildSessionBundle | Promise<ChildSessionBundle>;

export interface DiagnosisRunnerDeps {
	buildChildSession: BuildChildSession;
	model: Model<Api>;
	authStorage: AuthStorage;
	cwd: string;
	agentDir: string;
	/** 注入 provider 的 runtime key（faux 测试用；生产由 AuthStorage 自己解析 env） */
	runtimeApiKey?: string;
}

export function createDiagnosisRunner(deps: DiagnosisRunnerDeps): RunOne {
	return async (task: DiagnosisTask) => {
		const bundle = await deps.buildChildSession(task);
		if (deps.runtimeApiKey !== undefined) {
			deps.authStorage.setRuntimeApiKey(deps.model.provider, deps.runtimeApiKey);
		}

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: deps.agentDir,
				authStorage: deps.authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						...bundle.extensionFactories,
						...(bundle.hostTools ? [hostToolsAsFactory(bundle.hostTools)] : []),
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: deps.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const host = await createAgentSessionRuntime(createRuntime, {
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			await host.session.bindExtensions({});
			await host.session.prompt(task.prompt);
			return extractFinalText(host.session.messages);
		} finally {
			host.dispose();
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
