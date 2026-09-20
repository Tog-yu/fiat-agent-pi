/**
 * trace / span 标识与时间戳（阶段 14 / P14-83）—— 纯函数，零依赖（除 node:crypto 的随机源）。
 *
 * OTLP 硬约束（写错会被服务端拒收，且是**静默**拒收）：
 *   - `traceId` 必须 16 字节 → **32 个小写 hex**
 *   - `spanId`  必须  8 字节 → **16 个小写 hex**，且**不允许全 0**
 *   - 时间戳是 uint64 **纳秒**；OTLP/JSON 里必须用**字符串**承载——JS number 只有 53 位尾数，
 *     1.7e18 量级会丢精度，直接变成 `1758000000000000000` 这种被四舍五入的假值。
 */

import { randomBytes } from "node:crypto";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

/** 32 小写 hex */
export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
/** 16 小写 hex */
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;

export function randomTraceId(): string {
	return randomBytes(TRACE_ID_BYTES).toString("hex");
}

export function randomSpanId(): string {
	// 理论上有 ~2^-64 概率全 0（OTLP 视为非法 spanId）；重摇一次，成本可忽略
	let id = randomBytes(SPAN_ID_BYTES).toString("hex");
	while (/^0+$/.test(id)) id = randomBytes(SPAN_ID_BYTES).toString("hex");
	return id;
}

export function isValidTraceId(id: string): boolean {
	return TRACE_ID_RE.test(id) && !/^0+$/.test(id);
}

export function isValidSpanId(id: string): boolean {
	return SPAN_ID_RE.test(id) && !/^0+$/.test(id);
}

/**
 * 毫秒 → 纳秒字符串。
 * 负值 / 非有限值一律夹到 0：脏时间戳只会毁掉一条 trace 的展示，不值得把上报整个搞挂。
 */
export function msToNanos(ms: number): string {
	const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
	return (BigInt(safe) * 1_000_000n).toString();
}

/** 当前时间（毫秒）。抽成函数便于测试注入 */
export function nowMs(): number {
	return Date.now();
}
