/**
 * 结果层 grader（阶段 11 / P11-53）—— 纯函数、确定性判定，零 Pi 依赖。
 *
 * 设计口径（设计方案 §4.1 / §9.4）：
 *   - fiat 场景的「成功」大部分可确定性判定，不轻易上 LLM-judge（贵且不稳）。
 *   - 结果维度**一票否决**：轨迹再漂亮，终态错了就是 0 分（aggregate.ts 负责）。
 *   - 终态判定基于事实信号：最终 assistant 消息的 stopReason + 轨迹中的关键工具
 *     （ticket_created = 出现审批工单落单；applied = 出现 fiat_job_apply 执行）。
 *
 * 只读不改：本函数不接触闸门语义，评分永远不能影响执行。
 */

import type { EvalCase, RunTrace, Score } from "./types.ts";

/** 'deterministic' = 纯规则判定（可复现、零成本、能进 CI 门禁） */
export const OUTCOME_EVALUATOR = "deterministic";

/** 审批执行工具名（job-apply 工具模块注册，见 src/server/host/l1b/job-apply.ts） */
export const JOB_APPLY_TOOL = "fiat_job_apply";

/** 触发审批工单的 L4 工具（fiat-tools 的 apply 模式，见 src/server/host/l1b/fiat-tools.ts:45） */
export const CASHBACK_RECONCILE_TOOL = "fiat_cashback_reconcile";

/**
 * 从轨迹事实推断业务终态。
 * - applied：执行过 fiat_job_apply（工单已执行，最强终态）
 * - ticket_created：fiat_cashback_reconcile 建过审批工单（P5-20 链路，非 dry_run——
 *   dry_run 是只读对账不算落单；这里按「调过 reconcile 且最终回答」的保守口径，
 *   精确的 mode=apply 区分需要采集 input.mode，M2 的 PgEvalSink 有 input 列后再收紧）
 * - answered：run 正常结束（纯问答）
 * - undefined：run 异常终止且没有任何业务终态信号
 */
export function terminalOf(trace: RunTrace): "answered" | "ticket_created" | "applied" | undefined {
	// 只看**成功执行**的步：被闸门② block / 工具不存在（not found）的错误步不算业务信号
	// （viewer 猜名调用 reconcile 被拦 ≠ 落了工单）
	const okTools = new Set(trace.steps.filter((s) => !s.isError).map((s) => s.tool));
	// applied ⊃ ticket_created：执行过工单必然先落过工单，取最强终态
	if (okTools.has(JOB_APPLY_TOOL)) return "applied";
	if (okTools.has(CASHBACK_RECONCILE_TOOL)) return "ticket_created";
	if (trace.status === "ok") return "answered";
	return undefined;
}

/**
 * 结果层判定：
 *   - 无最终回答 / stopReason 为 error|aborted → 0
 *   - 期望终态不匹配 → 0（detail 带 got / want）
 *   - requiresApproval 但轨迹里没走审批路径 → 0（bypassed-approval）
 *     审批路径按终态分派：ticket_created → 调过 reconcile（落单即走审批，P5-20）；
 *     applied → 执行过 fiat_job_apply
 *   - 其余 → 1
 */
export function gradeOutcome(trace: RunTrace, c: EvalCase): Score {
	const weight = 1;
	const fail = (detail: Record<string, unknown>): Score => ({
		dimension: "outcome",
		value: 0,
		weight,
		evaluator: OUTCOME_EVALUATOR,
		detail,
	});

	if (trace.finalStopReason === "error" || trace.finalStopReason === "aborted") {
		return fail({ reason: trace.finalStopReason });
	}

	const got = terminalOf(trace);
	const want = c.expect.outcome.terminal;
	if (got !== want) return fail({ got: got ?? "none", want });

	// 高风险场景：必须落到审批而不是直接执行（审批路径随终态分派；只看成功步——
	// 被拦的尝试不算走了审批）
	if (c.expect.outcome.requiresApproval) {
		const okTools = new Set(trace.steps.filter((s) => !s.isError).map((s) => s.tool));
		const wentThroughApproval =
			want === "applied"
				? okTools.has(JOB_APPLY_TOOL)
				: okTools.has(CASHBACK_RECONCILE_TOOL) || okTools.has(JOB_APPLY_TOOL);
		if (!wentThroughApproval) return fail({ reason: "bypassed-approval" });
	}

	return { dimension: "outcome", value: 1, weight, evaluator: OUTCOME_EVALUATOR };
}
