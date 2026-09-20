/**
 * OTLP/HTTP 编码器（阶段 14 / P14-83）—— 纯函数，零三方依赖。
 *
 * 为什么是 OTLP 而不是 Langfuse 的 batch ingestion API：后者的 `/api/public/ingestion`
 * 已被官方标 deprecated，Langfuse Cloud 自 **2026-11-16** 起只接受 `score-create`，
 * 其余事件类型一律拒绝。OTLP（`/api/public/otel/v1/traces`）是官方指定的迁移路径。
 *
 * 本文件只做两件事：
 *   1. **OTLP/JSON 编码**：`TraceSpan[]` → `{ resourceSpans: [{ resource, scopeSpans: [...] }] }`。
 *      时间戳用纳秒字符串、attribute 值按类型分派（stringValue / intValue / doubleValue /
 *      boolValue / arrayValue）；attributes 按 key 排序，产物**逐字节确定**（便于快照式断言）。
 *   2. **Langfuse 语义映射**：`langfuse.*`（trace 级 + observation 级）与 `gen_ai.*`
 *      （OpenTelemetry GenAI 语义约定 → Langfuse generation 的 model / token 面板）。
 *
 * ⚠️ Trace 级属性（`langfuse.session.id` / `langfuse.user.id` / `langfuse.trace.tags` ...）
 * 必须出现在**每一个** span 上，官方文档明确要求——只在根 span 设的话，按 session / user / tag
 * 过滤会漏掉整棵子树的子 span。落点在 `tracer.startSpan`（开 span 时并入），
 * 而 `traceAttributesFor()` 在这里提供唯一的一份构造逻辑，避免两处各写一遍。
 */

import type {
	AttributeValue,
	CaptureContent,
	SpanKind,
	SpanStatus,
	TraceOptions,
	TraceSpan,
	TracingConfig,
} from "./types.ts";

// ── OTLP 数字枚举（protobuf 的枚举在 JSON 里是数字）──────────────────────────

export const SPAN_KIND_CODE: Record<SpanKind, number> = {
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
};

export const STATUS_CODE: Record<SpanStatus, number> = { unset: 0, ok: 1, error: 2 };

// ── 属性键常量（拼字符串的地方一律用它们，避免手写出错）──────────────────────

export const LANGFUSE_KEYS = {
	traceName: "langfuse.trace.name",
	sessionId: "langfuse.session.id",
	userId: "langfuse.user.id",
	traceTags: "langfuse.trace.tags",
	traceMetadataPrefix: "langfuse.trace.metadata.",
	obsType: "langfuse.observation.type",
	obsLevel: "langfuse.observation.level",
	obsInput: "langfuse.observation.input",
	obsOutput: "langfuse.observation.output",
	obsMetadataPrefix: "langfuse.observation.metadata.",
	obsModelName: "langfuse.observation.model.name",
	obsUsageDetails: "langfuse.observation.usage_details",
} as const;

export const GEN_AI_KEYS = {
	operationName: "gen_ai.operation.name",
	requestModel: "gen_ai.request.model",
	system: "gen_ai.system",
	inputTokens: "gen_ai.usage.input_tokens",
	outputTokens: "gen_ai.usage.output_tokens",
} as const;

/** `langfuse.observation.type` 的取值（Langfuse 观察类型） */
export const OBS_TYPE = {
	span: "span",
	generation: "generation",
	agent: "agent",
	tool: "tool",
	event: "event",
} as const;

// ── OTLP 结构 ────────────────────────────────────────────────────────────────

export type OtlpValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean }
	| { arrayValue: { values: OtlpValue[] } };

export interface OtlpAttribute {
	key: string;
	value: OtlpValue;
}

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
	status: { code: number; message?: string };
}

export interface OtlpPayload {
	resourceSpans: Array<{
		resource: { attributes: OtlpAttribute[] };
		scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
	}>;
}

function toOtlpValue(v: AttributeValue): OtlpValue {
	// 先判数组：联合类型收窄时 `Array.isArray` 只对可变数组生效（见 types.ts 的说明）
	if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: String(s) })) } };
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "boolean") return { boolValue: v };
	// 整数走 intValue（**字符串**承载，OTLP int64 在 JSON 里必须是字符串）；
	// 小数走 doubleValue。分错会导致 Langfuse 侧类型异常。
	return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

/** attributes 按 key 排序 → 产物确定，测试可做逐字节断言 */
export function encodeAttributes(attrs: Record<string, AttributeValue>): OtlpAttribute[] {
	return Object.keys(attrs)
		.sort()
		.map((key) => ({ key, value: toOtlpValue(attrs[key] as AttributeValue) }));
}

function toOtlpSpan(span: TraceSpan): OtlpSpan {
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
		name: span.name,
		kind: SPAN_KIND_CODE[span.kind],
		startTimeUnixNano: span.startNs,
		endTimeUnixNano: span.endNs,
		attributes: encodeAttributes(span.attributes),
		status: {
			code: STATUS_CODE[span.status],
			...(span.statusMessage ? { message: span.statusMessage } : {}),
		},
	};
}

/**
 * 编成一份 OTLP/HTTP JSON 请求体。
 * 所有 span 放同一个 `resourceSpans`（同一进程 = 同一 resource）；span 按
 * `traceId → startNs → spanId` 排序，保证同一批次的 payload 稳定可断言。
 */
export function encodeOtlp(spans: readonly TraceSpan[], cfg: TracingConfig): OtlpPayload {
	const ordered = [...spans].sort((a, b) => {
		if (a.traceId !== b.traceId) return a.traceId < b.traceId ? -1 : 1;
		if (a.startNs !== b.startNs) return BigInt(a.startNs) < BigInt(b.startNs) ? -1 : 1;
		return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
	});

	return {
		resourceSpans: [
			{
				resource: {
					attributes: encodeAttributes({
						"service.name": cfg.serviceName,
						"telemetry.sdk.name": "fiat-agent.otlp",
						"telemetry.sdk.language": "nodejs",
					}),
				},
				scopeSpans: [
					{
						scope: { name: "fiat-agent" },
						spans: ordered.map(toOtlpSpan),
					},
				],
			},
		],
	};
}

// ── Langfuse 属性构造 ────────────────────────────────────────────────────────

/**
 * 构造 trace 级属性表（**同一条 trace 的每个 span 都要带上**）。
 * tags 顺序固定为 `[kind, environment, role, ...extraTags]`；空值一律剔除，
 * 避免 Langfuse 里出现空 tag 分组。
 */
export function traceAttributesFor(opts: TraceOptions): Record<string, AttributeValue> {
	const tags = [opts.kind, opts.environment, opts.role, ...(opts.extraTags ?? [])]
		.filter((t): t is string => typeof t === "string" && t.trim() !== "")
		.map((t) => t.trim());

	const attrs: Record<string, AttributeValue> = {
		[LANGFUSE_KEYS.traceName]: opts.name,
		[LANGFUSE_KEYS.traceTags]: tags,
	};
	if (opts.sessionId) attrs[LANGFUSE_KEYS.sessionId] = opts.sessionId;
	if (opts.userId) attrs[LANGFUSE_KEYS.userId] = opts.userId;
	if (opts.environment) attrs[`${LANGFUSE_KEYS.traceMetadataPrefix}environment`] = opts.environment;
	if (opts.role) attrs[`${LANGFUSE_KEYS.traceMetadataPrefix}role`] = opts.role;
	for (const [k, v] of Object.entries(opts.metadata ?? {})) {
		attrs[`${LANGFUSE_KEYS.traceMetadataPrefix}${k}`] = v;
	}
	return attrs;
}

/** `gen_ai.*` + `langfuse.observation.usage_details`（Langfuse 的 token / cost 面板来源） */
export function usageAttributes(usage: {
	input: number;
	output: number;
	total?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
}): Record<string, AttributeValue> {
	const details: Record<string, number> = { input: usage.input, output: usage.output };
	if (usage.cacheRead !== undefined && usage.cacheRead > 0) details.cache_read = usage.cacheRead;
	if (usage.cacheWrite !== undefined && usage.cacheWrite > 0) details.cache_write = usage.cacheWrite;
	if (usage.reasoning !== undefined && usage.reasoning > 0) details.reasoning = usage.reasoning;

	const attrs: Record<string, AttributeValue> = {
		[GEN_AI_KEYS.inputTokens]: usage.input,
		[GEN_AI_KEYS.outputTokens]: usage.output,
		[LANGFUSE_KEYS.obsUsageDetails]: JSON.stringify(details),
	};
	if (usage.total !== undefined) attrs["gen_ai.usage.total_tokens"] = usage.total;
	return attrs;
}

// ── 脱敏（三档 + redact_keys 一律遮罩）──────────────────────────────────────

const MAX_STR = 64;
const MAX_ARRAY = 10;
const MAX_DEPTH = 6;
const MAX_SERIALIZED = 16_384;

function keyMatches(key: string, redactKeys: readonly string[]): boolean {
	if (key === "") return false;
	const k = key.toLowerCase();
	return redactKeys.some((r) => {
		const needle = r.toLowerCase();
		return needle !== "" && k.includes(needle);
	});
}

/**
 * 递归脱敏。
 *   - `off`     → 由调用方在更外层短路（这里返回 undefined）
 *   - `redacted`→ 长文本截断到 61 字 + `...`；数组只留前 10 项；嵌套以 `<type>` 占位；深度上限 6
 *   - `full`    → 文本不截断，但 `redact_keys` 命中的键**依旧遮罩**（这是硬约束，不分档位）
 */
export function redactValue(
	value: unknown,
	mode: CaptureContent,
	redactKeys: readonly string[],
	key = "",
	depth = 0,
): unknown {
	if (mode === "off") return undefined;
	if (keyMatches(key, redactKeys)) return "[redacted]";
	if (depth > MAX_DEPTH) return "<max-depth>";
	if (value === null || value === undefined) return null;

	if (typeof value === "string") {
		if (mode === "full") return value;
		return value.length <= MAX_STR ? value : `${value.slice(0, MAX_STR - 3)}...`;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return String(value);

	if (Array.isArray(value)) {
		const head = value.slice(0, MAX_ARRAY).map((v, i) => redactValue(v, mode, redactKeys, `${key}[${i}]`, depth + 1));
		if (value.length > MAX_ARRAY) head.push(`+${value.length - MAX_ARRAY} more`);
		return head;
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactValue(v, mode, redactKeys, k, depth + 1);
		}
		return out;
	}
	return `<${typeof value}>`;
}

/**
 * observation input / output 的落库形态：脱敏后 JSON 字符串。
 * `off` → undefined（**payload 里一个业务文本都没有**）。
 * 超长时不用硬截断（会产出非法 JSON，Langfuse 侧解析降级），而是换成带预览的合法对象。
 */
export function serializeObservation(
	value: unknown,
	mode: CaptureContent,
	redactKeys: readonly string[],
): string | undefined {
	if (mode === "off" || value === undefined) return undefined;
	const redacted = redactValue(value, mode, redactKeys);
	let s: string;
	try {
		s = JSON.stringify(redacted) ?? String(redacted);
	} catch {
		return "[unserializable]";
	}
	if (s.length > MAX_SERIALIZED) {
		return JSON.stringify({ _truncated: true, bytes: s.length, preview: s.slice(0, MAX_SERIALIZED) });
	}
	return s;
}
