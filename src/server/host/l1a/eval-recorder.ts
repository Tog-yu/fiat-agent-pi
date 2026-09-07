/**
 * eval-recorder —— L1a 内建 extension（阶段 11 / P11-58），三层评测的采集层。
 *
 * 与其他 L1a 钩子的分工（设计方案 §2）：
 *   permission-gate 负责挡、audit-hook 负责记、eval-recorder 负责**量**。
 *   三者都挂在闸门之后，只读不改——评测永远不能影响执行。
 *
 * ⚠️ 采集口径（0.80.3 实测更正，见 DEV_SPEC 阶段 11）：
 *   不走 `tool_call` / `tool_result` 钩子——`ExtensionRunner.emitToolCall` 对被 block 的
 *   调用短路返回（runner.js:639-657），尾部扩展收不到被闸门②拦截的调用，且被 block 不产生
 *   tool_result。改用三个生命周期事件：
 *     - turn_start：turnIndex 递增（turn_end 也有 turnIndex，双保险）
 *     - turn_end：携带本轮完整 toolResults（含被 block 调用的 isError 回灌结果，天然含 blocked 信号）
 *     - agent_end：携带完整 messages（outcome 判定输入）
 *
 * blocked 推断：turn_end.toolResults 中 isError=true 且文本命中拒绝语义
 * （permission-gate block 的 reason 文本，见 gate 的 "权限拒绝" 等）。
 *
 * fail-safe：没传 evalSink 就不注册（factory.ts 组合根控制）——符合本项目
 * 「注入式 + 缺依赖不注册」的通用模式，现有测试零改动。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aggregate } from "../../eval/aggregate.ts";
import { gradeFirstStep } from "../../eval/first-step.ts";
import { gradeOutcome } from "../../eval/outcome.ts";
import type { EvalRunRecord, EvalSink } from "../../eval/sink.ts";
import { scoreTrajectory } from "../../eval/trajectory.ts";
import type { EvalCase, RunTrace, Score, StepRecord } from "../../eval/types.ts";
import type { FiatUser } from "../../policy/engine.ts";

export interface EvalRecorderDeps {
	sink: EvalSink;
	user: FiatUser;
	environment: string;
	sessionId: string;
	/** CI 场景的 case（提供则算分并写 passed）；在线采集为空（只落事实，分后算） */
	evalCase?: EvalCase;
	/** P6-25 并行诊断子会话挂父 run */
	parentRunId?: string;
	/** P11-58: 评测 run 的标识（缺省每次 agent_end 生成）；测试注入保证确定性 */
	newRunId?: () => string;
}

/**
 * blocked 判定的文本特征（两类越权信号，设计方案 §4.2「blocked 计数是最有价值的信号」）：
 *   1. 闸门② block 的拒绝 reason（permission-gate："权限拒绝" / "无权" 等）
 *   2. 工具被闸门①裁剪后模型仍猜名调用 → agent-loop 的 "Tool x not found"
 *      （agent-loop.js:365）——同样是「模型试图调用它看不到的工具」的越权尝试
 */
const BLOCKED_PATTERN = /blocked|denied|权限|无权|拒绝|not found/i;

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

/** 脱敏：只保留参数键与必要值（沿用审计红线：不落 prompt 全文 / 业务敏感字段） */
function sanitizeInput(input: unknown): Record<string, unknown> {
	if (input === null || input === undefined) return {};
	if (typeof input !== "object") return { value: String(input) };
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		// 值只保留短标量（id / 名称 / 状态类），长文本与嵌套对象以键存在性表示
		if (typeof v === "string" && v.length <= 64) {
			out[k] = v;
		} else if (typeof v === "string") {
			out[k] = `${v.slice(0, 61)}...`;
		} else if (typeof v === "number" || typeof v === "boolean") {
			out[k] = v;
		} else {
			out[k] = `<${typeof v}>`;
		}
	}
	return out;
}

export function createEvalRecorder(deps: EvalRecorderDeps) {
	return (pi: ExtensionAPI) => {
		/** 跨 turn 累积的 step 草稿（全 run 单调） */
		const steps: StepRecord[] = [];
		let lastTurnIndex = 0;

		pi.on("turn_start", (event) => {
			lastTurnIndex = event.turnIndex;
		});

		pi.on("turn_end", (event) => {
			for (const tr of event.toolResults) {
				const text = textOf(tr.content);
				steps.push({
					stepIndex: steps.length,
					turnIndex: event.turnIndex,
					tool: tr.toolName,
					input: sanitizeInput(undefined),
					isError: tr.isError,
					blocked: tr.isError && BLOCKED_PATTERN.test(text),
				});
			}
			lastTurnIndex = Math.max(lastTurnIndex, event.turnIndex);
		});

		pi.on("agent_end", (event) => {
			// agent_end 可能在一轮里触发多次吗？Pi 语义：每次 run 结束各一次（事件即 run 终点）。
			// recorder 生命周期绑定单个 session 工厂产物，一次 writeRun 后清空累积。
			const messages = event.messages;
			const last = messages.at(-1) as { role?: string; stopReason?: string } | undefined;
			const finalStopReason = last?.role === "assistant" ? last.stopReason : undefined;

			const runId = deps.newRunId?.() ?? `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const trace: Omit<RunTrace, "steps"> & { steps?: StepRecord[] } = {
				runId,
				...(deps.evalCase ? { caseId: deps.evalCase.id } : {}),
				...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
				sessionId: deps.sessionId,
				userId: deps.user.id,
				role: deps.user.role,
				environment: deps.environment,
				source: deps.evalCase ? "ci" : "online",
				status: finalStopReason === "error" || finalStopReason === "aborted" ? finalStopReason : "ok",
				finalStopReason,
			};

			let scores: Score[] = [];
			let passed: boolean | undefined;
			if (deps.evalCase) {
				const fullTrace: RunTrace = { ...trace, steps } as RunTrace;
				const outcome = gradeOutcome(fullTrace, deps.evalCase);
				const trajectory = scoreTrajectory(fullTrace, deps.evalCase);
				const firstStep = gradeFirstStep(fullTrace, deps.evalCase);
				scores = [outcome, trajectory, firstStep];
				passed = aggregate(scores, deps.evalCase).passed;
			}

			const record: EvalRunRecord = {
				run: { ...trace, steps: undefined } as Omit<RunTrace, "steps">,
				steps: [...steps],
				scores,
				...(deps.evalCase ? { threshold: deps.evalCase.threshold } : {}),
				...(passed !== undefined ? { passed } : {}),
			};
			void deps.sink.writeRun(record).catch(() => {
				// 评测 sink 失败绝不影响会话（只读不拦的硬约束延伸：写失败也不能炸执行）
			});
			steps.length = 0;
		});
	};
}
