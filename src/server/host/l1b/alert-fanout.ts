/**
 * alert-fanout —— L1b 并行告警诊断工具模块（P9-47，原 workspace/pi-extensions/alert-fanout）。
 *
 * **P9-40 新契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`。
 * ⚠️ 名字像钩子，实测是**纯工具**（零 `pi.on`、单个 defineTool）——「fanout」指 L2 侧
 * `diagnosis/{plan,fanout}.ts` 的并发编排，本模块只暴露 `fiat_alert_diagnosis` 一个工具
 * 并渲染报告。分流依据见 §3。
 *
 * **为什么不复用 Pi 官方 subagent 扩展**：它走子进程（`pi --mode json -p --no-session`），
 * 子进程从磁盘加载原扩展加载器目录，而本仓库所有 fiat 扩展都是依赖注入工厂、
 * 没有 default 自配置入口 —— 子进程里权限闸门与审计整条丢失。法币场景不可接受。
 * 所以这里只做「暴露一个工具 + 编排」，真正的并发由 L2 进程内 fan-out 完成：
 * 每个视角一个独立子会话，共享 subject 与三道闸门，审计落在同一条链上。
 *
 * 职责边界（与权限闸门同构）：
 *   - L2 `src/server/diagnosis/{plan,fanout}.ts` 算拆分与并发编排（纯函数、可离线测）
 *   - L1b 本模块只做两件事：暴露 `fiat_alert_diagnosis`、把结果渲染成报告返回给模型
 *
 * 注册名 `fiat_alert_diagnosis`：policyToolName 剥前缀后命中
 * config/tool_policies.yaml 既有的 `alert_diagnosis`（L1，oncall/ops/viewer 全环境可用），
 * 因此天然经过三道闸门，不新增策略条目。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	type FanoutSummary,
	type RunOne,
	runFanout,
	type TaskOutcome,
	type TaskStatus,
} from "../../diagnosis/fanout.ts";
import {
	type AlertInput,
	DEFAULT_ANGLES,
	type DiagnosisAngle,
	diagnosisPlan,
	renderReport,
} from "../../diagnosis/plan.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

/** Pi 注册名；剥前缀后命中 tool_policies.yaml 的 alert_diagnosis */
export const ALERT_DIAGNOSIS_TOOL = "fiat_alert_diagnosis";

/** 视角数量上限：每个视角都是一次完整 agent run，防止配置塞太多视角炸掉 token 预算 */
export const DEFAULT_MAX_TASKS = 8;

/** 工具 details 的统一形状：两条返回路径必须是同一类型，否则 defineTool 推不出泛型 */
export interface AlertDiagnosisDetails {
	alertDiagnosis: true;
	/** 无可用只读工具时跳过诊断的原因 */
	skipped?: string;
	summary?: FanoutSummary;
	angles?: Array<{ name: string; status: TaskStatus }>;
}

export interface AlertFanoutDeps {
	/** 跑单个视角的 agent；生产注入真实子会话 runner，测试注入 fake */
	runAgent: RunOne;
	/** 诊断视角；缺省 DEFAULT_ANGLES */
	angles?: DiagnosisAngle[];
	/** 并发上限；缺省 4 */
	concurrency?: number;
	/** 单个视角超时（ms）；缺省 120_000 */
	timeoutMs?: number;
	/** 闸门①谓词（registered tool name → 是否可用）；用于收敛子 agent 工具集与自身注册判断 */
	allowedTools?: (registeredToolName: string) => boolean;
	/** 视角结束回调（审计 / 进度上报）；失败与超时同样回调 */
	onTask?: (outcome: TaskOutcome) => void;
	maxTasks?: number;
}

export function createAlertFanout(deps: AlertFanoutDeps): HostTool[] {
	// 闸门①：角色白名单拒绝 → 不注册，模型根本看不到
	if (deps.allowedTools && !deps.allowedTools(ALERT_DIAGNOSIS_TOOL)) return [];

	return [
		hostToolFromDefinition(
			defineTool({
				name: ALERT_DIAGNOSIS_TOOL,
				label: "Fiat Alert Diagnosis",
				description:
					"并行告警诊断：把一条告警拆成多个只读视角（日志/变更/依赖/历史经验）并发取证，聚合成分视角报告。全程只读，不修改任何系统。",
				promptSnippet: "并行诊断告警（只读取证，多视角聚合）",
				parameters: Type.Object({
					title: Type.String({ description: "告警标题或现象描述" }),
					service: Type.Optional(Type.String({ description: "服务名，如 payment-gateway" })),
					window: Type.Optional(Type.String({ description: "时间窗，如 最近 30 分钟" })),
					detail: Type.Optional(Type.String({ description: "补充信息（告警原文、指标等）" })),
				}),
				async execute(_toolCallId, params) {
					const p = params as Record<string, unknown>;
					const alert: AlertInput = { title: String(p.title ?? "") };
					if (typeof p.service === "string") alert.service = p.service;
					if (typeof p.window === "string") alert.window = p.window;
					if (typeof p.detail === "string") alert.detail = p.detail;

					let tasks = diagnosisPlan(alert, {
						angles: deps.angles ?? DEFAULT_ANGLES,
						allowedTools: deps.allowedTools,
					});

					if (tasks.length === 0) {
						const details: AlertDiagnosisDetails = {
							alertDiagnosis: true,
							skipped: "no-available-tools",
						};
						return {
							content: [
								{
									type: "text",
									text: "当前角色/环境下没有任何可用的只读诊断工具，无法开展并行诊断。",
								},
							],
							details,
						};
					}

					const maxTasks = deps.maxTasks ?? DEFAULT_MAX_TASKS;
					if (tasks.length > maxTasks) tasks = tasks.slice(0, maxTasks);

					const { results, summary } = await runFanout({
						tasks,
						runOne: deps.runAgent,
						concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY,
						timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
						onTaskDone: deps.onTask,
					});

					const details: AlertDiagnosisDetails = {
						alertDiagnosis: true,
						summary,
						angles: results.map((r) => ({ name: r.name, status: r.status })),
					};
					return {
						content: [{ type: "text", text: renderReport(alert, results, summary) }],
						details,
					};
				},
			}),
		),
	];
}
