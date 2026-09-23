/**
 * P15-106 单测：检索侧断路器 + 有界 drain。
 *
 * 这两件事的共同点是**失效时都是静默的**：
 *   - 没有断路器的「降级」照样返回空结果，只是每次先等 30 秒 —— 测试里没人会等
 *   - 没有 drain 的 flush 照样 resolve，只是丢掉了最后一次写入
 *
 * 所以每个方向都配「故意让它坏」的用例，且**时钟全部注入**（不 sleep 120 秒，
 * 否则这组测试不会有人跑，逻辑也就等于没人测）。
 */

import { describe, expect, it } from "vitest";
import { MemoryCircuitBreaker } from "../src/server/memory/circuit.ts";
import { MemoryDrain } from "../src/server/memory/drain.ts";

/** 可控时钟：`advance(ms)` 显式推进，测试里没有真实时间流逝 */
function fakeClock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** 可手动结算的 promise（模拟一次在飞的写入） */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("P15-106① 记忆检索断路器", () => {
	it("缺省闭合，前 threshold-1 次失败不熔断（网络抖动不该累积成熔断）", () => {
		const c = new MemoryCircuitBreaker({ threshold: 5 });
		for (let i = 0; i < 4; i += 1) c.recordFailure();
		expect(c.snapshot().state).toBe("closed");
		expect(c.allow()).toBe(true);
	});

	it("连续失败达阈值 → 打开，且冷却期内直接短路（这才是「快速降级」）", () => {
		const clock = fakeClock();
		const c = new MemoryCircuitBreaker({ threshold: 3, cooldownMs: 120_000, now: clock.now });
		for (let i = 0; i < 3; i += 1) c.recordFailure("RAG MCP callTool 超时（30000ms）");

		expect(c.snapshot().state).toBe("open");
		expect(c.allow()).toBe(false); // ← 关键：不再去撞那 30s
		expect(c.allow()).toBe(false);
		expect(c.snapshot().shortCircuited).toBe(2);
	});

	it("★ 一次成功立刻把连续计数归零（成功过的服务不该被历史失败拖进熔断）", () => {
		const c = new MemoryCircuitBreaker({ threshold: 3 });
		c.recordFailure();
		c.recordFailure();
		c.recordSuccess();
		c.recordFailure();
		c.recordFailure();
		expect(c.snapshot().state).toBe("closed");
		expect(c.snapshot().consecutiveFailures).toBe(2);
	});

	it("冷却期未满不放行；期满放行**一次探测**（不预置成 closed，避免每次冷却漏 N 个超时）", () => {
		const clock = fakeClock();
		const c = new MemoryCircuitBreaker({ threshold: 2, cooldownMs: 10_000, now: clock.now });
		c.recordFailure();
		c.recordFailure();

		clock.advance(9_999);
		expect(c.allow()).toBe(false);
		// 探测中状态仍是 open —— 上层不该以为已经恢复
		expect(c.snapshot().state).toBe("open");

		clock.advance(1);
		expect(c.allow()).toBe(true);
	});

	it("探测失败 → 冷却期重新起算（不是「立刻再放行」）", () => {
		const clock = fakeClock();
		const c = new MemoryCircuitBreaker({ threshold: 1, cooldownMs: 10_000, now: clock.now });
		c.recordFailure();
		clock.advance(10_000);
		expect(c.allow()).toBe(true);
		c.recordFailure(); // 探测失败
		expect(c.allow()).toBe(false);
		expect(c.snapshot().remainingCooldownMs).toBe(10_000);
	});

	it("探测成功 → 回到 closed 并报 ready", () => {
		const clock = fakeClock();
		const events: Array<{ status: string; detail: string }> = [];
		const c = new MemoryCircuitBreaker({
			threshold: 1,
			cooldownMs: 10_000,
			now: clock.now,
			onStatus: (status, detail) => events.push({ status, detail }),
		});
		c.recordFailure();
		clock.advance(10_000);
		c.allow();
		c.recordSuccess();

		expect(c.snapshot().state).toBe("closed");
		expect(events.map((e) => e.status)).toEqual(["circuit_open", "ready"]);
	});

	it("状态回调只在**真的变化**时触发一次；冷却期内的重复失败不换窗口", () => {
		const clock = fakeClock();
		const events: string[] = [];
		const c = new MemoryCircuitBreaker({
			threshold: 2,
			cooldownMs: 10_000,
			now: clock.now,
			onStatus: (s) => events.push(s),
		});
		c.recordFailure();
		c.recordFailure(); // 打开（第 1 个窗口）
		c.recordFailure(); // 冷却期内重复失败：窗口没换
		c.recordFailure();
		expect(events).toEqual(["circuit_open"]);
		expect(c.snapshot().openedCount).toBe(1);
	});

	it("探测失败算**新窗口**（冷却重新起算），但状态面不重复报 circuit_open", () => {
		const clock = fakeClock();
		const events: string[] = [];
		const c = new MemoryCircuitBreaker({
			threshold: 1,
			cooldownMs: 10_000,
			now: clock.now,
			onStatus: (s) => events.push(s),
		});
		c.recordFailure();
		clock.advance(10_000);
		expect(c.allow()).toBe(true);
		c.recordFailure();
		expect(c.snapshot().openedCount).toBe(2);
		expect(events).toEqual(["circuit_open"]);
	});

	it("打开原因含「不再撞击超时」的人话 + 最后一次失败摘要（可观测性够用）", () => {
		const detail: string[] = [];
		const c = new MemoryCircuitBreaker({ threshold: 1, onStatus: (_s, d) => detail.push(d) });
		c.recordFailure("connect ECONNREFUSED 127.0.0.1:11434");
		expect(detail[0]).toContain("冷却期内检索直接返回空结果");
		expect(detail[0]).toContain("connect ECONNREFUSED");
	});

	it("缺省参数对齐 hermes：阈值 5 / 冷却 120s", () => {
		const clock = fakeClock();
		const c = new MemoryCircuitBreaker({ now: clock.now });
		for (let i = 0; i < 4; i += 1) c.recordFailure();
		expect(c.snapshot().state).toBe("closed");
		c.recordFailure();
		expect(c.snapshot().state).toBe("open");
		expect(c.snapshot().remainingCooldownMs).toBe(120_000);
	});
});

describe("P15-106② 记忆写入的有界 drain", () => {
	it("无在飞写入 → 立刻返回 0/0（不产生无谓等待）", async () => {
		const d = new MemoryDrain({ timeoutMs: 10_000 });
		expect(await d.run()).toEqual({ drained: 0, abandoned: 0, inFlight: 0 });
	});

	it("在飞写入结算后 drain 等到它（正常路径）", async () => {
		const d = new MemoryDrain();
		const write = deferred();
		d.track(write.promise);
		const run = d.run();
		write.resolve();
		expect(await run).toEqual({ drained: 1, abandoned: 0, inFlight: 1 });
		expect(d.snapshot().inFlight).toBe(0);
	});

	it("★ 超时即放弃 + 记 abandoned（不假装成功，也不继续等）", async () => {
		const logs: Array<{ level: string; message: string; detail?: Record<string, unknown> }> = [];
		const d = new MemoryDrain({
			timeoutMs: 5,
			log: (level, message, detail) => logs.push({ level, message, detail }),
		});
		d.track(deferred().promise); // 永远不结算：模拟 RAG server 挂了
		const r = await d.run();

		expect(r).toEqual({ drained: 0, abandoned: 1, inFlight: 1 });
		expect(logs).toHaveLength(1);
		expect(logs[0]?.level).toBe("warn");
		expect(logs[0]?.message).toContain("drain 超时");
		expect(logs[0]?.message).toContain("放弃 1 条");
		expect(d.snapshot().abandonedTotal).toBe(1);
	});

	it("部分结算：已完成的算 drained，剩下的算 abandoned（计数不混）", async () => {
		const d = new MemoryDrain({ timeoutMs: 5 });
		const ok = deferred();
		d.track(ok.promise);
		d.track(deferred().promise);
		const run = d.run();
		ok.resolve();
		expect(await run).toEqual({ drained: 1, abandoned: 1, inFlight: 2 });
	});

	it("写入**失败**也算结算完毕（等的是结算，不是成功）", async () => {
		const d = new MemoryDrain({ timeoutMs: 5 });
		const bad = deferred();
		d.track(bad.promise);
		const run = d.run();
		bad.reject(new Error("RAG 500"));
		expect(await run).toEqual({ drained: 1, abandoned: 0, inFlight: 1 });
	});

	it("track 透传原 promise 的语义（加观测不改行为）", async () => {
		const d = new MemoryDrain();
		await expect(d.track(Promise.resolve(7))).resolves.toBe(7);
		await expect(d.track(Promise.reject(new Error("x")))).rejects.toThrow("x");
	});

	it("close() 后登记的写入不再被等待（flush 不能被随后到来的写入无限拖住）", async () => {
		const d = new MemoryDrain();
		d.close();
		d.track(deferred().promise);
		expect(d.snapshot()).toEqual({ inFlight: 0, abandonedTotal: 0, closed: true });
		expect(await d.run()).toEqual({ drained: 0, abandoned: 0, inFlight: 0 });
	});

	it("reopen() 让长驻进程可以周期性 flush 后继续写入", async () => {
		const d = new MemoryDrain();
		d.close();
		d.reopen();
		const w = deferred();
		d.track(w.promise);
		const run = d.run();
		w.resolve();
		expect(await run).toEqual({ drained: 1, abandoned: 0, inFlight: 1 });
	});

	it("drain 永不抛（写入侧的错误不外溢到退出路径）", async () => {
		const d = new MemoryDrain({ timeoutMs: 5 });
		d.track(Promise.reject(new Error("boom")));
		await expect(d.run()).resolves.toBeDefined();
	});
});
