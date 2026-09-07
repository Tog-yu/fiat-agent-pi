/**
 * 评测 sink（阶段 11 / P11-57）—— run / step / score 的落点。
 *
 * 设计口径（设计方案 §3）：
 *   - 两个实现共用同一接口（与 audit/client.ts 同构的注入式模式）：
 *       InMemoryEvalSink：CI / 本地 / 测试断言，零依赖
 *       PgEvalSink（后续 M2）：注入 query 函数，写三张 PG 表
 *   - 与审计表分离（不复用 fiat_audit_log）：审计是合规事实（不可删、只追加、用于追责）；
 *     评测是可重算的实验数据（同一 run 可用不同 evaluator 反复算）。两者共用采集事件，
 *     但语义与生命周期不同。
 *   - 字段与三张表一一对应：fiat_eval_run / fiat_eval_step / fiat_eval_score。
 */

import type { EvalCase, RunTrace, Score, StepRecord } from "./types.ts";

/** 一次 run 落库时的完整载荷（run 事实 + steps + scores） */
export interface EvalRunRecord {
	run: Omit<RunTrace, "steps">;
	/** 简化的 step 载荷（recorder 从 turn_end.toolResults 提取） */
	steps: StepRecord[];
	/** 本 run 的各维度评分（evaluator 算好后随 run 一起写） */
	scores: Score[];
	/** case 阈值 + pass 判定结果（CI 断言 / 看板展示用） */
	threshold?: number;
	passed?: boolean;
	/** 触发本 run 的用户输入（脱敏后；只存参数键与必要值） */
	prompt?: string;
}

export interface EvalSink {
	writeRun(record: EvalRunRecord): Promise<void>;
	/** 测试 / 调试：返回已记录的 run（可选） */
	entries?(): readonly EvalRunRecord[];
}

export class InMemoryEvalSink implements EvalSink {
	readonly #runs: EvalRunRecord[] = [];

	async writeRun(record: EvalRunRecord): Promise<void> {
		this.#runs.push(record);
	}

	entries(): readonly EvalRunRecord[] {
		return this.#runs;
	}
}

/** CI 便利函数：跑完一个 case 后组装 EvalRunRecord（评分 → 汇总 → 记录） */
export function buildRunRecord(args: {
	run: Omit<RunTrace, "steps">;
	steps: StepRecord[];
	scores: Score[];
	c?: EvalCase;
	prompt?: string;
}): EvalRunRecord {
	return {
		run: args.run,
		steps: args.steps,
		scores: args.scores,
		...(args.c ? { threshold: args.c.threshold } : {}),
		prompt: args.prompt,
	};
}
