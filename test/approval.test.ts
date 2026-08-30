/**
 * P5-19/P5-20/P5-21/P5-22 审批工单逻辑（纯函数，无 Pi，快）。
 *
 * 覆盖：建单(pending)+Lark 推送、幂等键、approve 翻转、apply 前置拦截(pending_approval)、
 * 一次性 token 校验、过期、L2 再查 canExecute 拒绝、生命周期审计。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LarkClient, LocalLarkClient } from "../src/server/approval/lark.ts";
import { ApprovalService, InMemoryTicketStore } from "../src/server/approval/ticket.ts";
import { type AuditClient, InMemoryAuditClient } from "../src/server/audit/client.ts";
import { LocalFiatClient } from "../src/server/fiat-tools/client.ts";
import { LocalPolicyClient } from "../src/server/policy/client.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

function makeService() {
	const clock = { t: 1000 };
	const store = new InMemoryTicketStore();
	const larkCalls: Array<{ ticketId: string; title: string; summary: string }> = [];
	const lark: LarkClient = {
		async sendApprovalCard(card) {
			larkCalls.push(card);
			return { messageId: `lark-${card.ticketId}` };
		},
	};
	const fiat = new LocalFiatClient();
	const audit: AuditClient = new InMemoryAuditClient();
	const policy = new LocalPolicyClient(POLICY_PATH);
	const svc = new ApprovalService({
		store,
		policy,
		lark,
		fiat,
		audit,
		now: () => clock.t,
		genId: () => "T1",
		genToken: () => "TOK",
		sha256: (s) => `h(${s})`,
		tokenTtlMs: 1000,
		sessionId: "sess",
	});
	return { svc, store, larkCalls, audit, clock, fiat };
}

describe("P5-19 审批工单 + 一次性 token + 幂等键", () => {
	it("requestApply 建单(pending)+推 Lark 卡+返回 token，审计记 ticket_created", async () => {
		const { svc, larkCalls, audit } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x", systemOfRecord: "y" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		expect(r.status).toBe("pending");
		expect(r.token).toBe("TOK");
		expect(larkCalls).toHaveLength(1);
		expect(larkCalls[0]?.ticketId).toBe(r.ticketId);
		const outcomes = (audit.entries?.() ?? []).map((e) => e.outcome);
		expect(outcomes).toContain("ticket_created");
	});

	it("幂等：相同 idempotencyKey 不重复建单，重放返回同一 ticketId", async () => {
		const { svc } = makeService();
		const a = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		const b = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		expect(b.ticketId).toBe(a.ticketId);
		expect(b.token).toBe("TOK"); // 重签同一 token
	});

	it("apply 在审批前：返回 pending_approval（不执行、不报错重试）", async () => {
		const { svc } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		const res = await svc.apply(r.ticketId, r.token);
		expect(res).toEqual({ ok: false, code: "pending_approval", message: expect.any(String) });
	});

	it("审批通过后 apply（正确 token）：执行底层变更，状态 applied，审计 applied", async () => {
		const { svc, audit } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x", systemOfRecord: "y" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		await svc.approve(r.ticketId);
		const res = await svc.apply(r.ticketId, r.token);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.tool).toBe("fiat_cashback_reconcile");
		const outcomes = (audit.entries?.() ?? []).map((e) => e.outcome);
		expect(outcomes).toEqual(expect.arrayContaining(["ticket_created", "ticket_approved", "applied"]));
	});

	it("apply 用错误 token：返回 invalid_token（不执行）", async () => {
		const { svc } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		await svc.approve(r.ticketId);
		const res = await svc.apply(r.ticketId, "WRONG");
		expect(res).toEqual({ ok: false, code: "invalid_token", message: "invalid one-time token" });
	});

	it("过期后 apply：返回 expired", async () => {
		const { svc, clock } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		await svc.approve(r.ticketId);
		clock.t = 1000 + 2000; // 超过 tokenTtlMs(1000)
		const res = await svc.apply(r.ticketId, r.token);
		expect(res).toEqual({ ok: false, code: "expired", message: expect.any(String) });
	});

	it("L2 再查 canExecute：prod 环境的 cashback_reconcile 在 apply 时被拒（denied）", async () => {
		const { svc } = makeService();
		const r = await svc.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "prod" }, // 策略仅允许 dev/staging
			payload: { csv: "x", systemOfRecord: "y" },
			idempotencyKey: "k1",
			title: "t",
			summary: "s",
		});
		await svc.approve(r.ticketId);
		const res = await svc.apply(r.ticketId, r.token);
		expect(res).toEqual({ ok: false, code: "denied", message: expect.stringContaining("环境") });
	});
});

describe("P5-21 Lark 审批卡片 client", () => {
	it("LocalLarkClient 返回确定性 messageId", async () => {
		const lark = new LocalLarkClient();
		const r = await lark.sendApprovalCard({ ticketId: "T9", title: "x", summary: "y" });
		expect(r.messageId).toBe("lark-T9");
	});
});
