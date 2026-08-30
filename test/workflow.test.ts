/**
 * P4-16/P4-17/P4-18 业务层单测（纯函数，无 IO）。
 *
 * 覆盖：返现 parse/reconcile/变更计划；物流 parse/validate；变更工作流状态机。
 * 这些逻辑是 L2 的「dry-run 不改数据」护栏，HttpFiatClient 上线后直接复用。
 */

import { describe, expect, it } from "vitest";
import {
	buildChangePlan,
	type CashbackSystemRecord,
	parseCashbackCsv,
	reconcileCashback,
} from "../src/server/workflow/cashback.ts";
import { parseLogisticsCsv, validateLogistics } from "../src/server/workflow/logistics.ts";
import { canTransition, WorkflowMachine, type WorkflowPhase } from "../src/server/workflow/stateMachine.ts";

const CSV = `order_id,user_id,amount,currency
o1,u1,100,USD
o2,u2,50,USD
o3,u3,20,USD`;

describe("返现 parse + reconcile + 变更计划", () => {
	it("解析缺列抛错（字段校验不放给 LLM）", () => {
		expect(() => parseCashbackCsv("a,b\n1,2")).toThrow(/缺少必需列/);
	});

	it("金额非法抛错", () => {
		expect(() => parseCashbackCsv("order_id,user_id,amount,currency\no1,u1,-5,USD")).toThrow(/金额非法/);
	});

	it("对账产出三种差异并汇总 totalDelta", () => {
		const csv = parseCashbackCsv(CSV);
		const sys: CashbackSystemRecord[] = [
			{ orderId: "o1", expectedAmount: 90, status: "ok" }, // 金额不符 +10
			{ orderId: "o2", expectedAmount: 50, status: "ok" }, // 一致
			{ orderId: "o9", expectedAmount: 999, status: "ok" }, // csv 缺失（missing_in_csv -999）
		];
		// csv 还有 o3（sys 缺失 → missing_in_system +20）
		const diffs = reconcileCashback(csv, sys);
		const kinds = diffs.map((d) => d.kind).sort();
		expect(kinds).toEqual(["amount_mismatch", "missing_in_csv", "missing_in_system"]);

		const plan = buildChangePlan(diffs);
		expect(plan.summary.amountMismatch).toBe(1);
		expect(plan.summary.missingInCsv).toBe(1);
		expect(plan.summary.missingInSystem).toBe(1);
		expect(plan.summary.totalDelta).toBe(10 + 20 - 999);
	});
});

describe("物流 parse + validate", () => {
	const LCSV = `shipment_id,carrier,status,eta
s1,SF,in_transit,2026-09-01
s2,SF,delivered,
s3,,xxx,2026-09-02`;

	it("解析出结构化记录", () => {
		const rows = parseLogisticsCsv(LCSV);
		expect(rows).toHaveLength(3);
		expect(rows[0]?.status).toBe("in_transit");
	});

	it("校验标出 error（缺 carrier / 非法状态）与 warn（delivered 缺 eta）", () => {
		const issues = validateLogistics(parseLogisticsCsv(LCSV));
		const errors = issues.filter((i) => i.severity === "error");
		const warns = issues.filter((i) => i.severity === "warn");
		expect(errors.some((e) => e.field === "carrier" && e.shipmentId === "s3")).toBe(true);
		expect(errors.some((e) => e.field === "status" && e.message.includes("非法状态"))).toBe(true);
		expect(warns.some((w) => w.field === "eta")).toBe(true);
	});
});

describe("变更工作流状态机", () => {
	it("只能沿白名单转移；非法跳变被拒", () => {
		const m = new WorkflowMachine();
		expect(canTransition("planned", "done")).toBe(false);
		expect(m.transition("planned")).toBe(false);
		expect(m.phase).toBe("idle");
	});

	it("dry-run 全流程停在 planned 等待审批", () => {
		const m = new WorkflowMachine();
		expect(m.runDryRun()).toBe(true);
		expect(m.phase).toBe("planned");
		expect(m.isTerminal).toBe(false);
	});

	it("planned → approved → applying → done 合法；rejected 终态", () => {
		const m = new WorkflowMachine();
		m.runDryRun();
		expect(m.transition("approved")).toBe(true);
		expect(m.transition("applying")).toBe(true);
		expect(m.transition("done")).toBe(true);
		expect(m.isTerminal).toBe(true);

		const r = new WorkflowMachine();
		expect(r.transition("parsing")).toBe(true);
		expect(r.transition("rejected")).toBe(true);
		expect(r.isTerminal).toBe(true);
	});

	it("done/rejected 为终态，无任何合法后继", () => {
		const all: WorkflowPhase[] = [
			"idle",
			"parsing",
			"reconciling",
			"planned",
			"approved",
			"applying",
			"done",
			"rejected",
		];
		for (const p of ["done", "rejected"] as WorkflowPhase[]) {
			for (const to of all) expect(canTransition(p, to)).toBe(false);
		}
	});
});
