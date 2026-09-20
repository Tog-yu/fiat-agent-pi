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
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../host/extensions.ts";
import { PiHostLoop } from "../host/loop.ts";
import { LANGFUSE_KEYS, OBS_TYPE } from "../tracing/otlp.ts";
import type { TracingWiring } from "../tracing/types.ts";
import type { RunOne } from "./fanout.ts";
import type { DiagnosisTask } from "./plan.ts";

/** 子会话所需产出；SessionFactoryResult 结构上满足（避免 import factory 形成循环依赖） */
export interface ChildSessionBundle {
	sessionId: string;
	/** P8-36 L1b 工具通道：直接注册进内嵌循环的工具集 */
	tools?: import("../host/tools.ts").HostTool[];
	/** P8-37 L1a 钩子通道：编译期注入的内建 extension 工厂（permission-gate / audit-hook / model-router） */
	extensionFactories?: Array<(pi: ExtensionAPI) => void>;
	/**
	 * 阶段 14（P14-88）：子会话的追踪接线（已带上视角 span 作 `parentSpanId`）。
	 * 不传 = 这个视角不进 trace（追踪已关）。
	 */
	tracing?: TracingWiring;
}

/**
 * 按视角构造子会话：视角的 tools 应在此收敛为只读子集（组合根 async，允许 Promise）。
 * 第二参 `tracing` 由 sessionRunner 现造（含视角 span 作父），组合根原样喂给 `buildSession`。
 */
export type BuildChildSession = (
	task: DiagnosisTask,
	tracing?: TracingWiring,
) => ChildSessionBundle | Promise<ChildSessionBundle>;

export interface DiagnosisRunnerDeps {
	buildChildSession: BuildChildSession;
	model: Model<Api>;
	/** provider 名 → API key（faux 测试注入固定值；生产缺省读环境变量） */
	getApiKey?: (provider: string) => string | undefined;
	cwd: string;
	agentDir: string;
	/**
	 * 阶段 14（P14-88）：蜂群视角的父 trace。**必传同一个 `TraceContext`**——
	 * 每个视角的 span 都挂在这条 trace 的 `fiat.fanout.angle` 下，
	 * 于是「一条告警 → N 个视角 → 各自的 generation/tool」在 Langfuse 里是**一棵树**。
	 */
	tracing?: TracingWiring;
}

export function createDiagnosisRunner(deps: DiagnosisRunnerDeps): RunOne {
	return async (task: DiagnosisTask) => {
		// 视角 span：整个视角（含子会话的 LLM 轮 + 工具调用）都长在它下面
		const angleSpan =
			deps.tracing?.trace.sampled === true
				? deps.tracing.tracer.startSpan(deps.tracing.trace, "fiat.fanout.angle", {
						kind: "internal",
						...(deps.tracing.parentSpanId ? { parentSpanId: deps.tracing.parentSpanId } : {}),
						attributes: {
							[LANGFUSE_KEYS.obsType]: OBS_TYPE.agent,
							"fiat.diagnosis.angle": task.name,
							"fiat.diagnosis.tools": task.tools,
						},
					})
				: undefined;
		// 子会话的默认父 = 视角 span（而不是主 trace 的根），这才叫"挂同一棵树"
		const childTracing: TracingWiring | undefined =
			deps.tracing && angleSpan
				? { tracer: deps.tracing.tracer, trace: deps.tracing.trace, parentSpanId: angleSpan.spanId }
				: deps.tracing;

		try {
			const bundle = await deps.buildChildSession(task, childTracing);

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
				...(bundle.tracing ? { tracing: bundle.tracing } : {}),
				...bridgeAgentHooks(runner),
			});

			// 阶段 14（P14-88）：`turn_start` / `turn_end` **只经 `Agent.subscribe()` 扇出**，
			// 不在 `bridgeAgentHooks` 里（见 host/extensions.ts 的说明）。不订的话，子会话的
			// `fiat.llm.turn` generation 与「被拦调用对账」两件事一个都不会发生——
			// trace 上只剩 tool span，恰好丢掉的又正是「这个视角烧了多少 token」。
			const unsub = bundle.tracing ? bridgeLifecycleEvents(host.agent, runner) : undefined;

			try {
				const r = await host.runTurnSafe(task.prompt);
				const reply = r.ok ? r.reply : `（视角执行失败：${r.error}）`;
				if (!r.ok) angleSpan?.setStatus("error", r.error);
				else angleSpan?.setStatus("ok");
				angleSpan?.setOutput(reply);
				return reply;
			} finally {
				unsub?.();
			}
		} catch (error) {
			angleSpan?.setStatus("error", error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			// inMemory 会话随 Agent 释放；无持久化句柄需要显式 dispose。
			// 视角 span 在这里收口——异常路径也要关，否则树上留洞。
			angleSpan?.end();
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
