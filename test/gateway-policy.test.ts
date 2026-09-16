/**
 * 阶段 13 / P13-81：分级 + 限流纯函数测试 —— classify 分支 / inflight 计数 /
 * 有界队列 / P0 优先 / 溢出 throttled。
 */

import { describe, expect, it } from "vitest";
import { classify, InflightGate, inflightGateFromConfig } from "../src/server/gateway/policy.ts";
import { DEFAULT_GATEWAY_CONFIG } from "../src/server/gateway/types.ts";

describe("classify 分级", () => {
	const auto = ["P0", "P1"] as const;

	it("P0/P1 → auto_diagnose；P2/P3 → manual_only", () => {
		expect(classify("P0", auto)).toBe("auto_diagnose");
		expect(classify("P1", auto)).toBe("auto_diagnose");
		expect(classify("P2", auto)).toBe("manual_only");
		expect(classify("P3", auto)).toBe("manual_only");
	});

	it("配置可改自动诊断集", () => {
		expect(classify("P3", ["P3"])).toBe("auto_diagnose");
		expect(classify("P0", [])).toBe("manual_only");
	});
});

describe("InflightGate", () => {
	it("admit → release 循环：计数正确回收", () => {
		const gate = new InflightGate(2, 4);
		expect(gate.tryAcquire("svc", "fp1", "P0")).toBe("admit");
		expect(gate.tryAcquire("svc", "fp2", "P1")).toBe("admit");
		expect(gate.inflight("svc")).toBe(2);
		// release 无排队项 → 返回 undefined
		expect(gate.release("svc")).toBeUndefined();
		expect(gate.inflight("svc")).toBe(1);
		gate.release("svc");
		expect(gate.inflight("svc")).toBe(0);
	});

	it("inflight 满 → queued；队列满 → throttled（绝不静默）", () => {
		const gate = new InflightGate(1, 2);
		expect(gate.tryAcquire("svc", "fp1", "P0")).toBe("admit");
		expect(gate.tryAcquire("svc", "fp2", "P2")).toBe("queued");
		expect(gate.tryAcquire("svc", "fp3", "P2")).toBe("queued");
		expect(gate.tryAcquire("svc", "fp4", "P0")).toBe("throttled");
	});

	it("同 fingerprint 等待期内合并，不重复排队", () => {
		const gate = new InflightGate(1, 4);
		gate.tryAcquire("svc", "fp1", "P0");
		expect(gate.tryAcquire("svc", "fp2", "P2")).toBe("queued");
		expect(gate.tryAcquire("svc", "fp2", "P2")).toBe("queued"); // 合并
		expect(gate.queued("svc")).toBe(1);
	});

	it("release 按 FIFO 出队；P0 插队优先", () => {
		const gate = new InflightGate(1, 8);
		gate.tryAcquire("svc", "fp1", "P0");
		gate.tryAcquire("svc", "fp2", "P2");
		gate.tryAcquire("svc", "fp3", "P0");
		gate.tryAcquire("svc", "fp4", "P2");
		// P0 优先：fp3 先出
		expect(gate.release("svc")).toBe("fp3");
		expect(gate.release("svc")).toBe("fp2"); // 剩余 FIFO
		expect(gate.release("svc")).toBe("fp4");
		expect(gate.release("svc")).toBeUndefined();
	});

	it("release 过度调用不产生负计数", () => {
		const gate = new InflightGate(2, 2);
		gate.release("svc");
		gate.release("svc");
		expect(gate.inflight("svc")).toBe(0);
	});

	it("服务间隔离", () => {
		const gate = new InflightGate(1, 2);
		expect(gate.tryAcquire("a", "fp1", "P0")).toBe("admit");
		expect(gate.tryAcquire("b", "fp2", "P0")).toBe("admit");
		expect(gate.tryAcquire("a", "fp3", "P0")).toBe("queued");
	});

	it("inflightGateFromConfig 从配置构造", () => {
		const gate = inflightGateFromConfig(DEFAULT_GATEWAY_CONFIG);
		expect(gate.tryAcquire("svc", "fp1", "P0")).toBe("admit");
	});

	it("drainAll 丢弃队列并返回数量", () => {
		const gate = new InflightGate(1, 4);
		gate.tryAcquire("svc", "fp1", "P0");
		gate.tryAcquire("svc", "fp2", "P2");
		gate.tryAcquire("svc", "fp3", "P2");
		expect(gate.drainAll()).toBe(2);
		expect(gate.queued("svc")).toBe(0);
	});
});
