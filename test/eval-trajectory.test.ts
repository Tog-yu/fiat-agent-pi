/**
 * P11-54 纯逻辑单测：轨迹层打分（LCP / 路标 / 硬约束 / 部分分）。
 */

import { describe, expect, it } from "vitest";
import { commonPrefixLen, milestoneCoverage, scoreTrajectory } from "../src/server/eval/trajectory.ts";
import type { EvalCase, RunTrace, StepRecord } from "../src/server/eval/types.ts";

function step(tool: string, i: number, opts: Partial<StepRecord> = {}): StepRecord {
	return { stepIndex: i, turnIndex: 0, tool, input: {}, isError: false, blocked: false, ...opts };
}

function trace(steps: StepRecord[]): RunTrace {
	return {
		runId: "r1",
		sessionId: "s1",
		userId: "u1",
		role: "ops",
		environment: "prod",
		source: "ci",
		status: "ok",
		steps,
	};
}

function cs(trajectory: EvalCase["expect"]["trajectory"], threshold = 0.75): EvalCase {
	return {
		id: "t-case",
		prompt: "p",
		subject: { role: "ops", environment: "prod" },
		expect: { outcome: { terminal: "answered" }, trajectory },
		threshold,
	};
}

describe("commonPrefixLen —— LCP", () => {
	it("完全一致", () => {
		expect(commonPrefixLen(["a", "b"], ["a", "b"])).toBe(2);
	});
	it("中途跑偏", () => {
		expect(commonPrefixLen(["a", "x", "c"], ["a", "b", "c"])).toBe(1);
	});
	it("实际更短", () => {
		expect(commonPrefixLen(["a"], ["a", "b"])).toBe(1);
	});
});

describe("milestoneCoverage —— 路标相对顺序", () => {
	it("按顺序全中", () => {
		const steps = [step("a", 0), step("free", 1), step("b", 2)];
		expect(milestoneCoverage(steps, [{ tool: "a" }, { tool: "b" }])).toEqual({ covered: 2 });
	});
	it("顺序颠倒不算覆盖（只向后找）", () => {
		const steps = [step("b", 0), step("a", 1)];
		const r = milestoneCoverage(steps, [{ tool: "a" }, { tool: "b" }]);
		expect(r.covered).toBe(1);
		expect(r.firstMiss).toBe(1);
	});
	it("after 约束生效", () => {
		const steps = [step("b", 0), step("a", 1)];
		// b 必须在 a 之后：b 先出现 → 不满足
		const r = milestoneCoverage(steps, [{ tool: "b", after: "a" }]);
		expect(r.covered).toBe(0);
	});
});

describe("scoreTrajectory —— 打分公式", () => {
	it("forbid 命中 → 0 分", () => {
		const s = scoreTrajectory(trace([step("fiat_refund_apply", 0)]), cs({ forbid: ["fiat_refund_apply"] }));
		expect(s.value).toBe(0);
		expect(s.detail?.violated).toBe("forbid");
	});

	it("milestone 全中无惩罚 → 0.6（prefix 未配置时其权重不并入，公式: 0.6×1）", () => {
		const steps = [step("mcp_rag_query_knowledge_hub", 0), step("fiat_job_apply", 1)];
		const s = scoreTrajectory(
			trace(steps),
			cs({ milestones: [{ tool: "mcp_rag_query_knowledge_hub" }, { tool: "fiat_job_apply" }] }),
		);
		expect(s.value).toBeCloseTo(0.6, 5);
	});

	it("milestone 全中 + prefix 全中 → 1.0", () => {
		const steps = [step("a", 0), step("b", 1)];
		const s = scoreTrajectory(trace(steps), cs({ toolPrefix: ["a", "b"], milestones: [{ tool: "b" }] }));
		expect(s.value).toBeCloseTo(1.0, 5);
	});

	it("LCP 部分分：前缀 2 步中中 1 步 + 无 milestone → 0.4×0.5=0.2", () => {
		const s = scoreTrajectory(trace([step("a", 0), step("x", 1)]), cs({ toolPrefix: ["a", "b"] }));
		expect(s.value).toBeCloseTo(0.2, 5);
		expect(s.detail?.firstWrong).toBe("x");
	});

	it("blocked 惩罚：0.1/次", () => {
		const steps = [step("a", 0, { isError: true, blocked: true }), step("b", 1)];
		const s = scoreTrajectory(trace(steps), cs({ milestones: [{ tool: "b" }] }));
		expect(s.value).toBeCloseTo(0.6 * 1 - 0.1, 5);
	});

	it("超步惩罚：0.02/步（max_steps=1，实际 3 步）", () => {
		const steps = [step("a", 0), step("b", 1), step("c", 2)];
		const s = scoreTrajectory(trace(steps), cs({ milestones: [{ tool: "a" }], maxSteps: 1 }));
		expect(s.value).toBeCloseTo(0.6 - 0.04, 5);
		expect(s.detail?.redundant).toBe(2);
	});

	it("无正向期望：blocked + 超步连续扣，不重复扣 blocked（1 − 0.1×5 − 0.02×4 = 0.42）", () => {
		const steps = Array.from({ length: 5 }, (_, i) => step("a", i, { isError: true, blocked: true }));
		const s = scoreTrajectory(trace(steps), cs({ maxSteps: 1 }));
		expect(s.value).toBeCloseTo(0.42, 5);
	});
});
