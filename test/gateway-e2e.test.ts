/**
 * 阶段 13 / P13-81：网关端到端测试 —— HTTP 层 → 适配 → 幂等 → 分级 → 诊断（stub）→ 通知。
 * 不起真实端口、不用真实模型；诊断注入 stub、通知用 LocalAlertNotifier 收集。
 */

import { describe, expect, it } from "vitest";
import { LocalAlertNotifier } from "../src/server/gateway/notify.ts";
import { InflightGate } from "../src/server/gateway/policy.ts";
import { GatewayServer } from "../src/server/gateway/server.ts";
import { InMemoryAlertEventStore } from "../src/server/gateway/store.ts";
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "../src/server/gateway/types.ts";

function makeE2E(diagnose?: (env: { fingerprint: string }) => Promise<{ sessionId: string; report: string }>) {
	const config: GatewayConfig = {
		...DEFAULT_GATEWAY_CONFIG,
		token: "e2e-token",
		autoDiagnoseSeverities: ["P0", "P1"],
		maxInflightPerService: 1,
	};
	const store = new InMemoryAlertEventStore();
	const notifier = new LocalAlertNotifier();
	const server = new GatewayServer(
		{
			config,
			store,
			...(diagnose
				? {
						diagnose: async (env) => {
							const r = await diagnose(env);
							// 模拟真实延迟，让 inflight 闸有机会看到并发
							await new Promise((r2) => setTimeout(r2, 5));
							return r;
						},
					}
				: {}),
			notify: notifier,
		},
		new InflightGate(config.maxInflightPerService, config.maxQueuePerService),
	);
	return { server, store, notifier };
}

function push(title: string, overrides: Record<string, unknown> = {}) {
	return {
		method: "POST",
		url: "/hooks/alert",
		headers: { authorization: "Bearer e2e-token" },
		body: JSON.stringify({ title, service: "payment-gateway", severity: "P0", ...overrides }),
	};
}

describe("端到端：健康推送 → 幂等 → 诊断 → 通知", () => {
	it("完整链路：首次 202 + 落库 + 诊断报告卡；重推 200 deduped", async () => {
		let n = 0;
		const { server, store, notifier } = makeE2E(async () => {
			n += 1;
			return { sessionId: `sess-${n}`, report: `# 报告 ${n}` };
		});

		const r1 = await server.handleRequest(push("支付网关 5xx 突增"));
		expect([200, 202]).toContain(r1.status);
		await new Promise((r) => setTimeout(r, 20)); // 等后台诊断

		const events = await store.list();
		expect(events).toHaveLength(1);
		expect(events[0]?.diagnosisSessionId).toBe("sess-1");

		// 诊断报告经通知通道发出
		const report = notifier.sent.find((x) => x.kind === "report");
		expect(report?.report).toContain("# 报告 1");

		// 重推同一条（同 title/service/severity → 同 fingerprint）→ deduped，不重诊
		const r2 = await server.handleRequest(push("支付网关 5xx 突增"));
		expect(r2.status).toBe(200);
		expect(n).toBe(1);
	});

	it("P2 推送：不诊断，发摘要卡", async () => {
		const { server, store, notifier } = makeE2E(async () => {
			throw new Error("P2 不应诊断");
		});
		const r = await server.handleRequest(push("磁盘水位 85%", { severity: "P2" }));
		expect(r.status).toBe(200);
		await new Promise((r2) => setTimeout(r2, 10));
		expect(notifier.sent).toHaveLength(1);
		expect(notifier.sent[0]?.kind).toBe("summary");
		expect((await store.list())[0]?.severity).toBe("P2");
	});

	it("resolved 推送关闭告警；重复 resolved 落审计记录", async () => {
		const { server, store } = makeE2E(async () => ({ sessionId: "s", report: "r" }));
		await server.handleRequest(push("订单延迟", { severity: "P1" }));
		const r1 = await server.handleRequest(push("订单延迟", { severity: "P1", status: "resolved" }));
		expect(r1.status).toBe(200);
		const r2 = await server.handleRequest(push("订单延迟", { severity: "P1", status: "resolved" }));
		expect(r2.status).toBe(200);
		const all = await store.list();
		expect(all.filter((e) => e.status === "resolved")).toHaveLength(2); // 首个关闭 + 审计记录
	});

	it("鉴权失败不落库", async () => {
		const { server, store } = makeE2E();
		await server.handleRequest({ ...push("x"), headers: { authorization: "Bearer wrong" } });
		expect(await store.list()).toHaveLength(0);
	});

	it("风暴模拟：同服务并发 P0 超过 inflight → 排队，全数落库", async () => {
		const { server, store } = makeE2E(async (env) => ({
			sessionId: `sess-${env.fingerprint.slice(0, 6)}`,
			report: "r",
		}));
		// maxInflightPerService = 1；并发 3 条不同告警（不同 title = 不同指纹）
		const results = await Promise.all([
			server.handleRequest(push("风暴告警 A", { title: "风暴告警 A" })),
			server.handleRequest(push("风暴告警 B", { title: "风暴告警 B" })),
			server.handleRequest(push("风暴告警 C", { title: "风暴告警 C" })),
		]);
		for (const r of results) {
			expect([200, 202]).toContain(r.status);
		}
		await new Promise((r) => setTimeout(r, 30));
		// 三条全部落库（throttled/queued 也是留痕，绝不静默丢弃）
		expect(await store.list()).toHaveLength(3);
	});
});
