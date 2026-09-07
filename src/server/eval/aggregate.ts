/**
 * 汇总与 pass 判定（阶段 11 / P11-55）—— 纯函数，零 Pi 依赖。
 *
 * 设计口径（设计方案 §4.4 / §9）：
 *   final_score = Σ(value_i × weight_i) / Σ(weight_i)
 *   passed      = final_score ≥ case.threshold 且 outcome 维度必须 = 1
 *
 * 结果维度一票否决：轨迹再漂亮，终态错了就是 0 分
 * （对应 LangSmith 的 "outcome is necessary, trajectory is diagnostic"）。
 */

import type { EvalCase, Score } from "./types.ts";

export interface EvalSummary {
	finalScore: number;
	passed: boolean;
	/** 结果层是否一票否决（outcome < 1） */
	vetoed: boolean;
	scores: Score[];
}

/** 加权汇总（weight 0 的维度不参与） */
export function aggregate(scores: Score[], c: EvalCase): EvalSummary {
	const counted = scores.filter((s) => s.weight > 0);
	const totalWeight = counted.reduce((sum, s) => sum + s.weight, 0);
	const finalScore = totalWeight > 0 ? counted.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight : 0;

	const outcome = scores.find((s) => s.dimension === "outcome");
	const vetoed = (outcome?.value ?? 0) < 1;

	return {
		finalScore,
		passed: !vetoed && finalScore >= c.threshold,
		vetoed,
		scores,
	};
}
