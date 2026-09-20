/**
 * 阶段 14 / P14-87+88：L2 采集点（闸门③ 装饰器 + 审批工单）的 **父 span 归属**。
 *
 * 为什么单独一个文件、且**零 Pi 依赖**：这两个采集点都在 L2（平台侧），本身不需要 Pi 运行时，
 * 而它们恰恰是"最容易挂错父"的地方——父 span 由 `TracingWiring` 决定，有三种合法取值：
 *
 *   1. `turnSpanId`   —— 本轮的 `fiat.turn`（宿主开轮时登记）→ **正常路径**
 *   2. `parentSpanId` —— 会话默认父（蜂群视角的 `fiat.fanout.angle`）
 *   3. `rootSpanId`   —— 兜底：那一轮已经结束（人点审批卡的时刻）
 *
 * 第 3 种兜底最容易出事：蜂群的 trace 根是**告警** span，一旦退化到根，
 * `fiat.gate.can_execute` / `fiat.ticket.*` 会从子会话里**跳出去**、直接挂到告警上——
 * 树还是闭合的（测试不会失败），但"哪个视角在被反复 deny / 在建单"就永远看不出来了。
 * 本文件把三种取值都钉死。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LarkClient } from "../src/server/approval/lark.ts";
import { ApprovalService, InMemoryTicketStore } from "../src/server/approval/ticket.ts";
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import { LocalFiatClient } from "../src/server/fiat-tools/client.ts";
import { LocalPolicyClient, type PolicyClient } from "../src/server/policy/client.ts";
import { InMemoryTracingClient } from "../src/server/tracing/client.ts";
import { tracedPolicyClient } from "../src/server/tracing/decorators.ts";
import { LANGFUSE_KEYS } from "../src/server/tracing/otlp.ts";
import { createTracer } from "../src/server/tracing/tracer.ts";
import {
	DEFAULT_TRACING_CONFIG,
	type TraceContext,
	type TracingConfig,
	type TracingWiring,
} from "../src/server/tracing/types.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));
const CFG: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };

const REQ = {
	user: { id: "u1", role: "ops" },
	tool: "fiat_cashback_reconcile",
	environment: "dev",
	input: { csv: "x" },
};

function setup(): { client: InMemoryTracingClient; ctx: TraceContext; tracer: TracingWiring["tracer"] } {
	const client = new InMemoryTracingClient();
	const tracer = createTracer(CFG, client, { random: () => 0 });
	const ctx = tracer.startTrace({ name: "fiat.turn", kind: "chat", sessionId: "s-1" });
	return { client, ctx, tracer };
}

describe("P14-87 tracedPolicyClient：fiat.gate.can_execute 的父 span", () => {
	it("闸门③ 判定落 span（verdict / reason / 输入），父 = 本轮 fiat.turn", async () => {
		const { client, ctx, tracer } = setup();
		const turnSpanId = "turn-aaaa";
		const wiring: TracingWiring = { tracer, trace: ctx, turnSpanId };

		const inner: PolicyClient = { canExecute: async () => ({ allowed: false, reason: "角色无权" }) };
		const verdict = await tracedPolicyClient(inner, wiring).canExecute(REQ);

		// 装饰器必须**完全透明**：返回值一字不改
		expect(verdict).toEqual({ allowed: false, reason: "角色无权" });

		const spans = client.entries();
		expect(spans).toHaveLength(1);
		const s = spans[0];
		expect(s?.name).toBe("fiat.gate.can_execute");
		expect(s?.parentSpanId).toBe(turnSpanId);
		expect(s?.attributes["fiat.gate.verdict"]).toBe("deny");
		expect(s?.attributes["fiat.gate.reason"]).toBe("角色无权");
		expect(s?.attributes["fiat.tool.name"]).toBe("fiat_cashback_reconcile");
		// deny 不是故障：WARNING，不污染错误率
		expect(s?.attributes[LANGFUSE_KEYS.obsLevel]).toBe("WARNING");
	});

	it("没有当前轮 → 退化到会话默认父（蜂群视角 span），**不跳到 trace 根**", async () => {
		const { client, ctx, tracer } = setup();
		const angleSpanId = "angle-bbbb";
		const wiring: TracingWiring = { tracer, trace: ctx, parentSpanId: angleSpanId };

		await tracedPolicyClient({ canExecute: async () => ({ allowed: true }) }, wiring).canExecute(REQ);

		const s = client.entries()[0];
		expect(s?.parentSpanId).toBe(angleSpanId);
		// 明确钉住「不许是根」——这正是蜂群里最容易错的一格
		expect(s?.parentSpanId).not.toBe(ctx.rootSpanId);
	});

	it("两者都没有 → 兜底 trace 根；关追踪 → 零 span 且 inner 恰好被调一次", async () => {
		const { client, ctx, tracer } = setup();
		await tracedPolicyClient({ canExecute: async () => ({ allowed: true }) }, { tracer, trace: ctx }).canExecute(REQ);
		expect(client.entries()[0]?.parentSpanId).toBe(ctx.rootSpanId);

		const offClient = new InMemoryTracingClient();
		const offTracer = createTracer({ ...DEFAULT_TRACING_CONFIG, enabled: false }, offClient);
		const offCtx = offTracer.startTrace({ name: "fiat.turn", kind: "chat" });
		let calls = 0;
		await tracedPolicyClient(
			{
				canExecute: async () => {
					calls += 1;
					return { allowed: true };
				},
			},
			{ tracer: offTracer, trace: offCtx },
		).canExecute(REQ);
		expect(calls).toBe(1); // 透明性：不因追踪改动调用次数
		expect(offClient.entries()).toHaveLength(0);
	});
});

describe("P14-88 审批工单：fiat.ticket.create / approve / apply 的父 span", () => {
	function makeService(tracing?: TracingWiring) {
		const store = new InMemoryTicketStore();
		const lark: LarkClient = { sendApprovalCard: async (card) => ({ messageId: `lark-${card.ticketId}` }) };
		return new ApprovalService({
			store,
			policy: new LocalPolicyClient(POLICY_PATH),
			lark,
			fiat: new LocalFiatClient(),
			audit: new InMemoryAuditClient(),
			now: () => 1000,
			genId: () => "T1",
			genToken: () => "TOK",
			sha256: (s) => `h(${s})`,
			tokenTtlMs: 1000,
			sessionId: "sess",
			...(tracing ? { tracing } : {}),
		});
	}

	const request = {
		tool: "fiat_cashback_reconcile",
		subject: { userId: "u1", role: "ops", environment: "dev" },
		payload: { csv: "x", systemOfRecord: "y" },
		idempotencyKey: "k1",
		title: "t",
		summary: "s",
	};

	it("建单 / 审批 / 执行三个动作各出一条 span，全挂本轮 fiat.turn 之下", async () => {
		const { client, ctx, tracer } = setup();
		const wiring: TracingWiring = { tracer, trace: ctx, turnSpanId: "turn-cccc" };
		const svc = makeService(wiring);

		const created = await svc.requestApply(request);
		await svc.approve(created.ticketId);
		const applied = await svc.apply(created.ticketId, created.token);
		expect(applied.ok).toBe(true);

		const spans = client.entries();
		const byName = (n: string) => spans.filter((s) => s.name === n);
		for (const name of ["fiat.ticket.create", "fiat.ticket.approve", "fiat.ticket.apply"]) {
			expect(byName(name)).toHaveLength(1);
			expect(byName(name)[0]?.parentSpanId).toBe("turn-cccc");
		}
		// 幂等键与状态结论落在 span 上：排障时不必再翻工单表
		expect(byName("fiat.ticket.create")[0]?.attributes["fiat.ticket.idempotency_key"]).toBe("k1");
		expect(byName("fiat.ticket.create")[0]?.attributes["fiat.ticket.status"]).toBe("pending");
		expect(byName("fiat.ticket.apply")[0]?.attributes["fiat.ticket.status"]).toBe("applied");
		expect(byName("fiat.ticket.apply")[0]?.status).toBe("ok");
	});

	it("人点卡片的时刻可能已不在某一轮之内：退化到会话默认父，而不是 trace 根", async () => {
		const { client, ctx, tracer } = setup();
		const wiring: TracingWiring = { tracer, trace: ctx, parentSpanId: "angle-dddd" };
		const svc = makeService(wiring);

		const created = await svc.requestApply(request);
		await svc.approve(created.ticketId);

		for (const s of client.entries()) {
			expect(s.parentSpanId).toBe("angle-dddd");
			expect(s.parentSpanId).not.toBe(ctx.rootSpanId);
		}
	});

	it("关追踪：工单流程行为与结果一字不变、零 span", async () => {
		const svc = makeService();
		const created = await svc.requestApply(request);
		expect(created.status).toBe("pending");
		expect((await svc.approve(created.ticketId)).status).toBe("approved");

		// 缺省关：连 client 都不存在（无 tracer 注入）——这里只能断言业务流程本身
		expect((await svc.apply(created.ticketId, created.token)).ok).toBe(true);
	});
});
