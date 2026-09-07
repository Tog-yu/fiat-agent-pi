/**
 * P11-55 纯逻辑单测：单步 any_of 命中 + aggregate 加权汇总（一票否决）。
 */

import { describe, expect, it } from "vitest";
import { aggregate } from "../src/server/eval/aggregate.ts";
import { gradeFirstStep } from "../src/server/eval/first-step.ts";
import type { EvalCase, RunTrace, Score, StepRecord } from "../src/server/eval/types.ts";

function step(tool: string, i: number): StepRecord {
	return { stepIndex: i, turnIndex: 0, tool, input: {}, isError: false, blocked: false };
}

function trace(tools: string[]): RunTrace {
	return {
		runId: "r1",
		sessionId: "s1",
		userId: "u1",
		role: "ops",
		environment: "prod",
		source: "ci",
		status: "ok",
		steps: tools.map(step),
	};
}

function cs(firstStep: string[] | undefined, threshold = 0.75): EvalCase {
	return {
		id: "t-case",
		prompt: "p",
		subject: { role: "ops", environment: "prod" },
		expect: { outcome: { terminal: "answered" }, ...(firstStep ? { firstStep: { any_of: firstStep } } : {}) },
		threshold,
	};
}

describe("gradeFirstStep —— 单步 any_of", () => {
	it("首工具命中任一解 → 1", () => {
		const s = gradeFirstStep(
			trace(["fiat_alert_diagnosis", "x"]),
			cs(["fiat_alert_diagnosis", "mcp_rag_query_knowledge_hub"]),
		);
		expect(s.value).toBe(1);
	});

	it("首工具不在 any_of → 0", () => {
		const s = gradeFirstStep(trace(["fiat_refund_apply"]), cs(["fiat_alert_diagnosis"]));
		expect(s.value).toBe(0);
		expect(s.detail?.actual).toBe("fiat_refund_apply");
	});

	it("空轨迹 → 0（actual null）", () => {
		const s = gradeFirstStep(trace([]), cs(["a"]));
		expect(s.value).toBe(0);
		expect(s.detail?.actual).toBeNull();
	});

	it("未配置 first_step → weight 0（不参与汇总）", () => {
		const s = gradeFirstStep(trace(["a"]), cs(undefined));
		expect(s.weight).toBe(0);
	});
});

describe("aggregate —— 加权汇总 + 一票否决", () => {
	const base = (outcome: number, others: Score[] = []): Score[] => [
		{ dimension: "outcome", value: outcome, weight: 1, evaluator: "deterministic" },
		...others,
	];

	it("加权平均：(1×1 + 0.5×0.4)/1.4 ≈ 0.857", () => {
		const summary = aggregate(
			base(1, [{ dimension: "trajectory", value: 0.5, weight: 0.4, evaluator: "deterministic" }]),
			cs(undefined, 0.75),
		);
		expect(summary.finalScore).toBeCloseTo(0.857142857, 5);
		expect(summary.passed).toBe(true);
	});

	it("outcome < 1 → 一票否决（分数再高也不 pass）", () => {
		const summary = aggregate(
			base(0, [
				{ dimension: "trajectory", value: 1, weight: 0.4, evaluator: "deterministic" },
				{ dimension: "first_step", value: 1, weight: 1, evaluator: "deterministic" },
			]),
			cs(undefined, 0.5),
		);
		expect(summary.vetoed).toBe(true);
		expect(summary.passed).toBe(false);
	});

	it("分数低于 threshold → 不 pass", () => {
		const summary = aggregate(
			base(1, [{ dimension: "trajectory", value: 0.2, weight: 1, evaluator: "deterministic" }]),
			cs(undefined, 0.75),
		);
		expect(summary.finalScore).toBeCloseTo(0.6, 5);
		expect(summary.passed).toBe(false);
	});

	it("weight 0 的维度不参与汇总", () => {
		const summary = aggregate(
			base(1, [{ dimension: "first_step", value: 0, weight: 0, evaluator: "deterministic" }]),
			cs(undefined, 0.9),
		);
		expect(summary.finalScore).toBe(1);
		expect(summary.passed).toBe(true);
	});
});
