/**
 * 阶段 14 / P14-90：OTLP 编码器 + 脱敏（纯函数，零网络、零 Pi）。
 *
 * 这一层错了是**静默错**：OTLP 服务端拒收不会回灌到业务，只会表现为"Langfuse 里没数据"。
 * 所以断言口径尽量贴规范原文，而不是贴实现：
 *   1. traceId 必须 32 小写 hex、spanId 必须 16 小写 hex 且非全 0（OTLP 硬约束）
 *   2. 时间戳必须是**纳秒字符串**（uint64；JS number 精度不够，写 number 会被四舍五入）
 *   3. attribute 值按类型分派：int64 在 JSON 里也必须是字符串
 *   4. **trace 级属性出现在每一个 span 上**（Langfuse 官方要求：否则按 session/user 过滤会漏）
 *   5. 脱敏三档 + `redact_keys` 在任何档位都遮罩
 */

import { describe, expect, it } from "vitest";
import { InMemoryTracingClient } from "../src/server/tracing/client.ts";
import { isValidSpanId, isValidTraceId, msToNanos, randomSpanId, randomTraceId } from "../src/server/tracing/ids.ts";
import {
	encodeAttributes,
	encodeOtlp,
	LANGFUSE_KEYS,
	redactValue,
	SPAN_KIND_CODE,
	STATUS_CODE,
	serializeObservation,
	traceAttributesFor,
} from "../src/server/tracing/otlp.ts";
import { createTracer } from "../src/server/tracing/tracer.ts";
import { DEFAULT_TRACING_CONFIG, type TraceSpan, type TracingConfig } from "../src/server/tracing/types.ts";

const CFG: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };

function spanAt(span: TraceSpan, key: string) {
	return span.attributes[key];
}

describe("P14-83 ids：OTLP 标识与时间戳", () => {
	it("traceId 32 hex / spanId 16 hex，且自身校验通过", () => {
		for (let i = 0; i < 50; i += 1) {
			const t = randomTraceId();
			const s = randomSpanId();
			expect(t).toMatch(/^[0-9a-f]{32}$/);
			expect(s).toMatch(/^[0-9a-f]{16}$/);
			expect(isValidTraceId(t)).toBe(true);
			expect(isValidSpanId(s)).toBe(true);
		}
	});

	it("全 0 与长度不对的 id 一律非法（OTLP 明确不给过）", () => {
		expect(isValidTraceId("0".repeat(32))).toBe(false);
		expect(isValidSpanId("0".repeat(16))).toBe(false);
		expect(isValidTraceId("a".repeat(31))).toBe(false);
		expect(isValidSpanId("A".repeat(16))).toBe(false); // 必须小写
	});

	it("毫秒 → 纳秒**字符串**（number 会丢精度）", () => {
		expect(msToNanos(1)).toBe("1000000");
		expect(msToNanos(1_758_000_000_000)).toBe("1758000000000000000");
		expect(typeof msToNanos(1)).toBe("string");
		// 脏输入夹到 0 而不是抛 —— 一条 trace 的展示不值得把上报搞挂
		expect(msToNanos(-1)).toBe("0");
		expect(msToNanos(Number.NaN)).toBe("0");
	});
});

describe("P14-83 encodeAttributes：OTLP 值类型分派", () => {
	it("按类型分派，整数走 intValue 字符串，小数走 doubleValue", () => {
		const attrs = encodeAttributes({
			s: "x",
			i: 3,
			f: 1.5,
			b: true,
			arr: ["a", "b"],
		});
		const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
		expect(byKey.s).toEqual({ stringValue: "x" });
		expect(byKey.i).toEqual({ intValue: "3" }); // int64 在 OTLP/JSON 里必须是字符串
		expect(byKey.f).toEqual({ doubleValue: 1.5 });
		expect(byKey.b).toEqual({ boolValue: true });
		expect(byKey.arr).toEqual({ arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } });
	});

	it("attributes 按 key 排序 —— 产物逐字节确定", () => {
		expect(encodeAttributes({ z: 1, a: 2, m: 3 }).map((a) => a.key)).toEqual(["a", "m", "z"]);
	});
});

describe("P14-83 traceAttributesFor：trace 级属性", () => {
	it("tags 顺序固定 [kind, environment, role, ...extra]，空值剔除", () => {
		const attrs = traceAttributesFor({
			name: "fiat.turn",
			kind: "chat",
			environment: "dev",
			role: "ops",
			extraTags: ["", "  ", "P0"],
		});
		expect(attrs[LANGFUSE_KEYS.traceTags]).toEqual(["chat", "dev", "ops", "P0"]);
		expect(attrs[LANGFUSE_KEYS.traceName]).toBe("fiat.turn");
	});

	it("session / user / metadata 各自落到对应键", () => {
		const attrs = traceAttributesFor({
			name: "fiat.alert.handle",
			kind: "gateway",
			sessionId: "fp-1",
			userId: "alertmanager",
			metadata: { fingerprint: "abc" },
		});
		expect(attrs[LANGFUSE_KEYS.sessionId]).toBe("fp-1");
		expect(attrs[LANGFUSE_KEYS.userId]).toBe("alertmanager");
		expect(attrs[`${LANGFUSE_KEYS.traceMetadataPrefix}fingerprint`]).toBe("abc");
		// 没给 environment / role → 不产生空 tag 分组
		expect(attrs).not.toHaveProperty(`${LANGFUSE_KEYS.traceMetadataPrefix}environment`);
	});
});

describe("P14-83 encodeOtlp：整包结构", () => {
	const span: TraceSpan = {
		traceId: "a".repeat(32),
		spanId: "b".repeat(16),
		parentSpanId: "c".repeat(16),
		name: "fiat.tool x",
		kind: "client",
		startNs: msToNanos(1000),
		endNs: msToNanos(1010),
		attributes: { "fiat.gate.tool_call": "allow" },
		status: "error",
		statusMessage: "boom",
	};

	it("resourceSpans / scopeSpans / span 三层，纳秒字符串，kind 与 status 走数字枚举", () => {
		const payload = encodeOtlp([span], CFG);
		const rs = payload.resourceSpans[0];
		expect(rs?.resource.attributes.map((a) => a.key).sort()).toEqual([
			"service.name",
			"telemetry.sdk.language",
			"telemetry.sdk.name",
		]);
		const out = rs?.scopeSpans[0]?.spans[0];
		expect(out?.traceId).toBe(span.traceId);
		expect(out?.spanId).toBe(span.spanId);
		expect(out?.parentSpanId).toBe(span.parentSpanId);
		expect(out?.startTimeUnixNano).toBe("1000000000"); // 1000ms = 1e9 ns
		expect(out?.endTimeUnixNano).toBe("1010000000");
		expect(out?.kind).toBe(SPAN_KIND_CODE.client);
		expect(out?.status).toEqual({ code: STATUS_CODE.error, message: "boom" });
	});

	it("无父 span 时不带 parentSpanId 字段（不带 null，OTLP 里 null 是脏值）", () => {
		// 同时去掉 parentSpanId 与 statusMessage，验证两个可选字段都不会以 null/空串形式出现
		const { parentSpanId: _p, statusMessage: _m, ...root } = span;
		const out = encodeOtlp([{ ...root, status: "unset" }], CFG).resourceSpans[0]?.scopeSpans[0]?.spans[0];
		expect(out).not.toHaveProperty("parentSpanId");
		expect(out?.status).toEqual({ code: STATUS_CODE.unset });
	});
});

describe("P14-83 脱敏：三档 + redact_keys 一律遮罩", () => {
	const keys = ["token", "api_key"];

	it("redacted（缺省）：长文本截断、数组截前 10、超深以 <max-depth> 占位", () => {
		const long = "x".repeat(200);
		expect(redactValue(long, "redacted", keys)).toBe(`${"x".repeat(61)}...`);
		expect(
			redactValue(
				Array.from({ length: 12 }, (_, i) => i),
				"redacted",
				keys,
			),
		).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "+2 more"]);
		let deep: unknown = 1;
		for (let i = 0; i < 10; i += 1) deep = { n: deep };
		expect(JSON.stringify(redactValue(deep, "redacted", keys))).toContain("<max-depth>");
	});

	it("full：文本不截断，但 **redact_keys 命中的键依旧遮罩**（硬约束，不分档位）", () => {
		expect(redactValue("y".repeat(200), "full", keys)).toBe("y".repeat(200));
		expect(redactValue({ api_key: "sk-live-123", ok: "fine" }, "full", keys)).toEqual({
			api_key: "[redacted]",
			ok: "fine",
		});
		// 命中判定是「键名包含 + 大小写不敏感」；子对象的键命中同样遮罩（值未必是字符串）
		expect(redactValue({ MyToken: "t" }, "redacted", keys)).toEqual({ MyToken: "[redacted]" });
	});

	it("off：payload 里一个业务文本都没有（serializeObservation → undefined）", () => {
		expect(serializeObservation({ anything: "secret" }, "off", keys)).toBeUndefined();
		expect(serializeObservation(undefined, "redacted", keys)).toBeUndefined();
	});

	it("serializeObservation 超长时换成合法 JSON（不硬截断出非法 JSON）", () => {
		const big = { blob: "z".repeat(30_000) };
		const s = serializeObservation(big, "full", []);
		expect(() => JSON.parse(s as string)).not.toThrow();
		expect(JSON.parse(s as string)).toMatchObject({ _truncated: true });
	});
});

describe("P14-87 tracer：trace 级属性必须出现在**每一个** span 上", () => {
	it("根 span 与各级子 span 都带上 session.id / user.id / tags", () => {
		const client = new InMemoryTracingClient();
		const tracer = createTracer(CFG, client, { random: () => 0 });
		const ctx = tracer.startTrace({
			name: "fiat.turn",
			kind: "chat",
			sessionId: "s-1",
			userId: "u-1",
			role: "ops",
			environment: "dev",
		});
		const root = tracer.startRootSpan(ctx);
		const child = tracer.startSpan(ctx, "fiat.llm.turn");
		const grand = tracer.startSpan(ctx, "fiat.tool x", { parentSpanId: child.spanId });
		grand.end();
		child.end();
		root.end();

		const spans = client.entries();
		expect(spans).toHaveLength(3);

		for (const s of spans) {
			expect(s.traceId).toBe(ctx.traceId);
			expect(spanAt(s, LANGFUSE_KEYS.sessionId)).toBe("s-1");
			expect(spanAt(s, LANGFUSE_KEYS.userId)).toBe("u-1");
			expect(spanAt(s, LANGFUSE_KEYS.traceTags)).toEqual(["chat", "dev", "ops"]);
		}

		// 树闭合：每个 parentSpanId 都能追到某个 span（根无父）
		const ids = new Set(spans.map((s) => s.spanId));
		const roots = spans.filter((s) => s.parentSpanId === undefined);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.spanId).toBe(ctx.rootSpanId);
		for (const s of spans) {
			if (s.parentSpanId) expect(ids.has(s.parentSpanId)).toBe(true);
		}
		// 根 span **不是自己的父**（曾经的坑：`?? ctx.rootSpanId` 会把 undefined 接住）
		expect(roots[0]?.parentSpanId).toBeUndefined();
	});

	it("采样在根做一次：未命中时全部 span 丢弃，且不产生半个树", () => {
		const client = new InMemoryTracingClient();
		// chat 采样降到 50% —— 缺省是 1.0（告警 / 评测链路必须全采，不可降）
		const lowRate: TracingConfig = { ...CFG, sampleRate: { ...CFG.sampleRate, chat: 0.5 } };
		const tracer = createTracer(lowRate, client, { random: () => 0.99 });
		const ctx = tracer.startTrace({ name: "fiat.turn", kind: "chat" });
		expect(ctx.sampled).toBe(false);
		// 未采样时 startSpan 返回空句柄：调用方无需写 if (tracer.enabled)，也不会有半棵树
		const child = tracer.startSpan(ctx, "fiat.llm.turn");
		expect(child.spanId).toBe("");
		tracer.startRootSpan(ctx).end();
		child.end();
		expect(client.entries()).toHaveLength(0);

		// 命中采样（同一档位、骰子更大）→ 整棵树都在
		const tracer2 = createTracer(lowRate, client, { random: () => 0.1 });
		const ctx2 = tracer2.startTrace({ name: "fiat.turn", kind: "chat" });
		expect(ctx2.sampled).toBe(true);
		tracer2.startRootSpan(ctx2).end();
		tracer2.startSpan(ctx2, "fiat.llm.turn").end();
		expect(client.entries()).toHaveLength(2);
	});

	it("end() 幂等：重复收口只上报一次（钩子散落三个事件，重复 end 是必然）", () => {
		const client = new InMemoryTracingClient();
		const tracer = createTracer(CFG, client, { random: () => 0 });
		const ctx = tracer.startTrace({ name: "fiat.turn", kind: "chat" });
		const span = tracer.startRootSpan(ctx);
		span.end();
		span.end();
		expect(client.entries()).toHaveLength(1);
	});
});
