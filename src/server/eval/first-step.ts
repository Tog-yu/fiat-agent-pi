/**
 * 单步层打分（阶段 11 / P11-55）—— 纯函数，零 Pi 依赖。
 *
 * 设计口径（设计方案 §4.3 / §9.3）：
 *   - 统计式（在线/离线都能跑）：first_step 命中率 = 首工具 ∈ any_of。
 *   - any_of 多解，避免「唯一正确答案」陷阱：先查知识库还是先拉告警可能都对。
 *   - 反事实式（CI 专用，faux 编排第 k 轮响应）不在此处——那是测试编排层的事，
 *     见 test/eval-first-step.test.ts。
 */

import type { EvalCase, RunTrace, Score } from "./types.ts";

export const FIRST_STEP_EVALUATOR = "deterministic";

/** 单步判定：1 if 实际首工具 ∈ any_of else 0 */
export function gradeFirstStep(trace: RunTrace, c: EvalCase): Score {
	const expected = c.expect.firstStep?.any_of ?? [];
	const actualFirst = trace.steps[0]?.tool;

	if (expected.length === 0) {
		// case 未配置单步期望 → 不计分（weight 0，不参与汇总）
		return { dimension: "first_step", value: 0, weight: 0, evaluator: FIRST_STEP_EVALUATOR };
	}

	const hit = actualFirst !== undefined && expected.includes(actualFirst);
	return {
		dimension: "first_step",
		value: hit ? 1 : 0,
		weight: 1,
		evaluator: FIRST_STEP_EVALUATOR,
		detail: { expected, actual: actualFirst ?? null },
	};
}
