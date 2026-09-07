/**
 * P11-53 纯逻辑单测：outcome grader（结果层，一票否决维度）。
 */

import { describe, expect, it } from "vitest";
import { CASHBACK_RECONCILE_TOOL, gradeOutcome, JOB_APPLY_TOOL, terminalOf } from "../src/server/eval/outcome.ts";
import type { EvalCase, RunTrace, StepRecord } from "../src/server/eval/types.ts";

function step(tool: string, i: number, opts: Partial<StepRecord> = {}): StepRecord {
	return { stepIndex: i, turnIndex: 0, tool, input: {}, isError: false, blocked: false, ...opts };
}

function trace(steps: StepRecord[], finalStopReason?: string): RunTrace {
	return {
		runId: "r1",
		sessionId: "s1",
		userId: "u1",
		role: "ops",
		environment: "prod",
		source: "ci",
		status: finalStopReason === "error" ? "error" : "ok",
		steps,
		finalStopReason,
	};
}

function cs(expect: EvalCase["expect"], threshold = 0.75): EvalCase {
	return { id: "t-case", prompt: "p", subject: { role: "ops", environment: "prod" }, expect, threshold };
}

describe("terminalOf —— 终态推断", () => {
	it("出现 fiat_job_apply → applied", () => {
		expect(terminalOf(trace([step("x", 0), step(JOB_APPLY_TOOL, 1)]))).toBe("applied");
	});
	it("status ok 无工单 → answered", () => {
		expect(terminalOf(trace([step("x", 0)]))).toBe("answered");
	});
	it("status error → undefined", () => {
		expect(terminalOf(trace([step("x", 0)], "error"))).toBeUndefined();
	});
});

describe("gradeOutcome —— 结果层判定", () => {
	it("stopReason error → 0 分", () => {
		const s = gradeOutcome(trace([], "error"), cs({ outcome: { terminal: "answered" } }));
		expect(s.value).toBe(0);
		expect(s.detail?.reason).toBe("error");
	});

	it("stopReason aborted → 0 分", () => {
		const s = gradeOutcome(trace([], "aborted"), cs({ outcome: { terminal: "answered" } }));
		expect(s.value).toBe(0);
	});

	it("期望 answered 实际 answered → 1 分", () => {
		const s = gradeOutcome(trace([]), cs({ outcome: { terminal: "answered" } }));
		expect(s.value).toBe(1);
	});

	it("期望 ticket_created 实际 answered → 0 分（终态不匹配）", () => {
		const s = gradeOutcome(trace([]), cs({ outcome: { terminal: "ticket_created" } }));
		expect(s.value).toBe(0);
		expect(s.detail?.got).toBe("answered");
		expect(s.detail?.want).toBe("ticket_created");
	});

	it("requiresApproval 但没走 fiat_job_apply → 0 分（绕过审批）", () => {
		// 轨迹非空但没落工单也没执行（终态 answered ≠ ticket_created 也算绕过审批的一种）
		const s = gradeOutcome(
			trace([step("mcp_rag_query_knowledge_hub", 0)]),
			cs({ outcome: { terminal: "ticket_created", requiresApproval: true } }),
		);
		expect(s.value).toBe(0);
		// 终态不匹配时 detail 带 got/want；纯 bypass（终态匹配但没 apply）时才带 reason
		expect(s.detail?.got).toBe("answered");
	});

	it("requiresApproval 且走了 fiat_job_apply → 1 分", () => {
		const s = gradeOutcome(
			trace([step(JOB_APPLY_TOOL, 0)]),
			cs({ outcome: { terminal: "applied", requiresApproval: true } }),
		);
		expect(s.value).toBe(1);
	});

	it("requiresApproval + ticket_created：调过 reconcile（落单）→ 1 分（审批路径随终态分派）", () => {
		const s = gradeOutcome(
			trace([step(CASHBACK_RECONCILE_TOOL, 0)]),
			cs({ outcome: { terminal: "ticket_created", requiresApproval: true } }),
		);
		expect(s.value).toBe(1);
	});
});
