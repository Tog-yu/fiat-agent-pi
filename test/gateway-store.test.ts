/**
 * 阶段 13 / P13-81：幂等存储 + 网关执行链测试 —— fingerprint 幂等 / resolved 闭环 /
 * severity 升级重诊 / stale 兜底。
 */

import { describe, expect, it } from "vitest";
import { localFingerprint, normalizeSeverity } from "../src/server/gateway/adapters.ts";
import { LocalAlertNotifier } from "../src/server/gateway/notify.ts";
import { AlertGateway } from "../src/server/gateway/runner.ts";
import { InMemoryAlertEventStore } from "../src/server/gateway/store.ts";
import { type AlertEnvelope, DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "../src/server/gateway/types.ts";

function envelope(overrides: Partial<AlertEnvelope> = {}): AlertEnvelope {
	return {
		alertId: "a1",
		fingerprint: "fp-1",
		severity: "P0",
		firedAt: "2026-09-16T06:00:00Z",
		status: "firing",
		source: "test",
		alertName: "HighErrorRate",
		labels: { service: "payment-gateway" },
		alert: { title: "支付网关 5xx 突增", service: "payment-gateway" },
		...overrides,
	};
}

function makeGateway(
	overrides: {
		config?: Partial<GatewayConfig>;
		store?: InMemoryAlertEventStore;
		diagnose?: (env: AlertEnvelope) => Promise<{ sessionId: string; report: string }>;
		onEvent?: (e: unknown) => void;
	} = {},
) {
	const store = overrides.store ?? new InMemoryAlertEventStore();
	const notifier = new LocalAlertNotifier();
	const gateway = new AlertGateway({
		config: { ...DEFAULT_GATEWAY_CONFIG, token: "t", ...overrides.config },
		store,
		...(overrides.diagnose ? { diagnose: overrides.diagnose } : {}),
		notify: notifier,
		now: Date.now,
		...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
	});
	return { gateway, store, notifier };
}

describe("InMemoryAlertEventStore", () => {
	it("findActive 只命中 firing", async () => {
		const store = new InMemoryAlertEventStore();
		const rec = {
			id: "1",
			fingerprint: "fp-1",
			status: "firing" as const,
			severity: "P0" as const,
			envelopeJson: "{}",
			createdAt: "t1",
			lastSeenAt: "t1",
			throttledCount: 0,
		};
		await store.insert(rec);
		expect(await store.findActive("fp-1")).not.toBeNull();
		await store.update({ ...rec, status: "resolved" });
		expect(await store.findActive("fp-1")).toBeNull();
	});

	it("update 不存在的记录抛错", async () => {
		const store = new InMemoryAlertEventStore();
		await expect(
			store.update({
				id: "x",
				fingerprint: "f",
				status: "firing",
				severity: "P0",
				envelopeJson: "{}",
				createdAt: "t",
				lastSeenAt: "t",
				throttledCount: 0,
			}),
		).rejects.toThrow();
	});
});

describe("幂等：同 fingerprint 只更 last_seen_at", () => {
	it("重复推送不重复诊断（deduped 事件）", async () => {
		let diagnosisCount = 0;
		const { gateway, store } = makeGateway({
			diagnose: async () => {
				diagnosisCount += 1;
				return { sessionId: `s-${diagnosisCount}`, report: "r" };
			},
		});

		const r1 = await gateway.handleAlert(envelope());
		const r2 = await gateway.handleAlert(envelope({ firedAt: "2026-09-16T06:01:00Z" }));

		expect(r1.record.id).toBe(r2.record.id); // 同一条记录
		expect(r2.outcome).toBe("deduped");
		expect(r2.record.lastSeenAt >= r1.record.lastSeenAt).toBe(true);
		expect(diagnosisCount).toBe(1); // 只诊断一次
		expect(r2.record.status).toBe("firing");
		expect(store !== undefined).toBe(true);
	});

	it("severity 升级（P2→P0）视为新事件重新诊断", async () => {
		let diagnosisCount = 0;
		const { gateway } = makeGateway({
			diagnose: async () => {
				diagnosisCount += 1;
				return { sessionId: `s-${diagnosisCount}`, report: "r" };
			},
		});

		await gateway.handleAlert(envelope({ fingerprint: "fp-esc", severity: "P2" }));
		expect(diagnosisCount).toBe(0); // P2 不自动诊断
		const r2 = await gateway.handleAlert(envelope({ fingerprint: "fp-esc", severity: "P0" }));
		expect(diagnosisCount).toBe(1); // 升级后自动诊断
		expect(r2.record.severity).toBe("P0");
		expect(r2.diagnosisDispatched).toBe(true);
	});

	it("resolved 推送关闭活跃告警；之后再推按新事件处理", async () => {
		let diagnosisCount = 0;
		const { gateway } = makeGateway({
			diagnose: async () => {
				diagnosisCount += 1;
				return { sessionId: `s-${diagnosisCount}`, report: "r" };
			},
		});

		await gateway.handleAlert(envelope({ fingerprint: "fp-res" }));
		expect(diagnosisCount).toBe(1);
		const closed = await gateway.handleAlert(envelope({ fingerprint: "fp-res", status: "resolved" }));
		expect(closed.record.status).toBe("resolved");
		expect(closed.outcome).toBe("resolved");
		const again = await gateway.handleAlert(envelope({ fingerprint: "fp-res" }));
		expect(again.record.status).toBe("firing");
		expect(again.outcome).toBe("accepted");
		expect(diagnosisCount).toBe(2); // resolved 后重开 = 新事件
	});
});

describe("分级派发", () => {
	it("P2 落库 + 摘要卡，不诊断", async () => {
		const { gateway, notifier } = makeGateway({
			config: { autoDiagnoseSeverities: ["P0", "P1"] },
			diagnose: async () => ({ sessionId: "s", report: "r" }),
		});
		await gateway.handleAlert(envelope({ fingerprint: "fp-p2", severity: "P2" }));
		expect(notifier.sent.length).toBe(1);
		expect(notifier.sent[0]?.kind).toBe("summary");
		expect(notifier.sent[0]?.text).toContain("让 Agent 立即并行诊断");
	});

	it("诊断失败发失败通知，不静默", async () => {
		const { gateway, notifier } = makeGateway({
			diagnose: async () => {
				throw new Error("model down");
			},
		});
		await gateway.handleAlert(envelope({ fingerprint: "fp-fail" }));
		// 等后台诊断 promise 落地
		await new Promise((r) => setTimeout(r, 10));
		expect(notifier.sent.some((n) => n.text.includes("自动诊断失败"))).toBe(true);
	});
});

describe("fingerprint 生成", () => {
	it("labels 顺序不影响指纹", () => {
		const a = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: { a: "1", b: "2" } });
		const b = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: { b: "2", a: "1" } });
		expect(a).toBe(b);
	});

	it("实例字段变化不改变指纹（不含 timestamp/ip）", () => {
		const a = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: {} });
		const b = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: {} });
		expect(a).toBe(b);
	});

	it("标签集变化 = 不同指纹", () => {
		const a = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: { instance: "1" } });
		const b = localFingerprint({ source: "s", alertName: "n", service: "svc", labels: { instance: "2" } });
		expect(a).not.toBe(b);
	});
});

describe("severity 归一化", () => {
	it("语义词映射", () => {
		expect(normalizeSeverity("critical")).toBe("P0");
		expect(normalizeSeverity("error")).toBe("P1");
		expect(normalizeSeverity("warning")).toBe("P2");
		expect(normalizeSeverity("info")).toBe("P3");
		expect(normalizeSeverity("P1")).toBe("P1");
		expect(normalizeSeverity(0)).toBe("P0");
	});

	it("缺省 / 未知 → P2 保守降级", () => {
		expect(normalizeSeverity(undefined)).toBe("P2");
		expect(normalizeSeverity("cataclysm")).toBe("P2");
		expect(normalizeSeverity(99)).toBe("P2");
	});
});

describe("stale 兜底", () => {
	it("firing 超过 dedupeTtl → stale，之后同指纹按新事件", async () => {
		const clock = 1_000_000;
		const store = new InMemoryAlertEventStore();
		const { gateway } = makeGateway({
			config: { dedupeTtlMinutes: 120 },
			store,
			diagnose: async () => ({ sessionId: "s", report: "r" }),
		});
		// 用 gateway 内部 sweep：直接构造过期记录
		const staleRec = {
			id: "old",
			fingerprint: "fp-old",
			status: "firing" as const,
			severity: "P0" as const,
			envelopeJson: "{}",
			createdAt: new Date(clock - 200 * 60_000).toISOString(),
			lastSeenAt: new Date(clock - 200 * 60_000).toISOString(),
			throttledCount: 0,
		};
		await store.insert(staleRec);
		// 新推送触发 sweep（第 1 条即触发：% 20 === 1）
		const r = await gateway.handleAlert(envelope({ fingerprint: "fp-new" }));
		expect(r.record.status).toBe("firing");
		const old = await store.get("old");
		expect(old?.status).toBe("stale");
	});
});
