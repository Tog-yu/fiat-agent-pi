/**
 * Tracer（阶段 14 / P14-85）—— span 生命周期 + 采样决策，零 Pi 依赖。
 *
 * 三条设计口径：
 *
 * 1. **span 只在 `end()` 时进队列**。OTLP 没有 update 事件，span 一次成型；
 *    所以「开 span」是内存态草稿，`end()` 幂等（重复调用只生效一次）——钩子散落在
 *    `tool_call` / `tool_result` / `turn_end` 三个事件里，重复 end 是必然会发生的，
 *    幂等不是洁癖而是必需。
 *
 * 2. **采样在根做一次，子 span 跟随**。`startTrace` 掷一次骰子写进 `TraceContext.sampled`；
 *    未命中时 `startSpan` 返回**空句柄**（所有方法 no-op）。这样业务代码不需要写
 *    `if (tracer.enabled)`，也不会有半棵树的 trace。per-span 采样是反模式。
 *
 * 3. **trace 级属性在 `startSpan` 时并入每个 span**（官方要求：要按 session / user / tag
 *    过滤，属性必须出现在每个 span 上）。构造逻辑只有 `otlp.traceAttributesFor()` 一份。
 *    同名冲突时**子 span 显式属性优先**（局部信息比全局信息具体）。
 */

import type { TracingClient } from "./client.ts";
import { msToNanos, nowMs, randomSpanId, randomTraceId } from "./ids.ts";
import { LANGFUSE_KEYS, OBS_TYPE, serializeObservation, traceAttributesFor } from "./otlp.ts";
import type {
	AttributeValue,
	SpanHandle,
	SpanLevel,
	SpanOptions,
	SpanStatus,
	TokenUsage,
	TraceContext,
	TraceOptions,
	Tracer,
	TraceSpan,
	TracingConfig,
} from "./types.ts";

export interface TracerOptions {
	/** 随机源（采样决策）；测试注入以取得确定性 */
	random?: () => number;
	/** 时钟（毫秒）；测试注入 */
	now?: () => number;
	/** id 生成；测试注入以取得确定性 */
	newTraceId?: () => string;
	newSpanId?: () => string;
}

/** span 内部草稿：`end()` 之前的可变态 */
interface SpanDraft {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: TraceSpan["kind"];
	startMs: number;
	attributes: Record<string, AttributeValue>;
	status: SpanStatus;
	statusMessage?: string;
	level: SpanLevel;
	/** 显式设过 level 就不再被 status 推导覆盖 */
	levelExplicit: boolean;
	input?: unknown;
	output?: unknown;
	ended: boolean;
}

class SpanHandleImpl implements SpanHandle {
	readonly traceId: string;
	readonly spanId: string;
	readonly #draft: SpanDraft;
	readonly #cfg: TracingConfig;
	readonly #client: TracingClient;
	readonly #now: () => number;

	constructor(draft: SpanDraft, cfg: TracingConfig, client: TracingClient, now: () => number) {
		this.#draft = draft;
		this.traceId = draft.traceId;
		this.spanId = draft.spanId;
		this.#cfg = cfg;
		this.#client = client;
		this.#now = now;
	}

	setAttribute(key: string, value: AttributeValue): void {
		if (this.#draft.ended) return;
		this.#draft.attributes[key] = value;
	}

	setInput(value: unknown): void {
		if (this.#draft.ended) return;
		this.#draft.input = value;
	}

	setOutput(value: unknown): void {
		if (this.#draft.ended) return;
		this.#draft.output = value;
	}

	setModel(model: string, provider?: string): void {
		if (this.#draft.ended) return;
		this.#draft.attributes["gen_ai.request.model"] = model;
		this.#draft.attributes[LANGFUSE_KEYS.obsModelName] = model;
		if (provider) this.#draft.attributes["gen_ai.system"] = provider;
	}

	setUsage(usage: TokenUsage): void {
		if (this.#draft.ended) return;
		const details: Record<string, number> = { input: usage.input, output: usage.output };
		if (usage.cacheRead !== undefined && usage.cacheRead > 0) details.cache_read = usage.cacheRead;
		if (usage.cacheWrite !== undefined && usage.cacheWrite > 0) details.cache_write = usage.cacheWrite;
		if (usage.reasoning !== undefined && usage.reasoning > 0) details.reasoning = usage.reasoning;
		this.#draft.attributes["gen_ai.usage.input_tokens"] = usage.input;
		this.#draft.attributes["gen_ai.usage.output_tokens"] = usage.output;
		if (usage.total !== undefined) this.#draft.attributes["gen_ai.usage.total_tokens"] = usage.total;
		this.#draft.attributes[LANGFUSE_KEYS.obsUsageDetails] = JSON.stringify(details);
	}

	setLevel(level: SpanLevel): void {
		if (this.#draft.ended) return;
		this.#draft.level = level;
		this.#draft.levelExplicit = true;
	}

	setStatus(status: SpanStatus, message?: string): void {
		if (this.#draft.ended) return;
		this.#draft.status = status;
		if (message) this.#draft.statusMessage = message;
		if (status === "error" && !this.#draft.levelExplicit) this.#draft.level = "ERROR";
	}

	/** 幂等：第二次调用直接返回 */
	end(endMs?: number): void {
		const d = this.#draft;
		if (d.ended) return;
		d.ended = true;

		const mode = this.#cfg.captureContent;
		const keys = this.#cfg.redactKeys;
		const input = serializeObservation(d.input, mode, keys);
		const output = serializeObservation(d.output, mode, keys);
		if (input !== undefined) d.attributes[LANGFUSE_KEYS.obsInput] = input;
		if (output !== undefined) d.attributes[LANGFUSE_KEYS.obsOutput] = output;
		if (d.level !== "DEFAULT") d.attributes[LANGFUSE_KEYS.obsLevel] = d.level;

		const endMs0 = endMs ?? this.#now();
		const span: TraceSpan = {
			traceId: d.traceId,
			spanId: d.spanId,
			...(d.parentSpanId ? { parentSpanId: d.parentSpanId } : {}),
			name: d.name,
			kind: d.kind,
			startNs: msToNanos(d.startMs),
			endNs: msToNanos(Math.max(endMs0, d.startMs)),
			attributes: d.attributes,
			status: d.status,
			...(d.statusMessage ? { statusMessage: d.statusMessage } : {}),
		};
		// client.send 契约上永不抛；这里再兜一层，杜绝「追踪把业务炸了」的最后一种可能
		try {
			this.#client.send([span]);
		} catch {
			/* 观测系统挂掉不能把业务挂掉 */
		}
	}
}

/** 未采样 / 关追踪时的空句柄：调用方无需分支 */
class NoopSpanHandle implements SpanHandle {
	readonly traceId = "";
	readonly spanId = "";
	setAttribute(_key: string, _value: AttributeValue): void {}
	setInput(_value: unknown): void {}
	setOutput(_value: unknown): void {}
	setModel(_model: string, _provider?: string): void {}
	setUsage(_usage: TokenUsage): void {}
	setLevel(_level: SpanLevel): void {}
	setStatus(_status: SpanStatus, _message?: string): void {}
	end(_ms?: number): void {}
}

const NOOP_HANDLE = new NoopSpanHandle();

class TracerImpl implements Tracer {
	readonly enabled: boolean;
	readonly #cfg: TracingConfig;
	readonly #client: TracingClient;
	readonly #random: () => number;
	readonly #now: () => number;
	readonly #newTraceId: () => string;
	readonly #newSpanId: () => string;

	constructor(cfg: TracingConfig, client: TracingClient, opts: TracerOptions) {
		this.#cfg = cfg;
		this.#client = client;
		this.#random = opts.random ?? Math.random;
		this.#now = opts.now ?? nowMs;
		this.#newTraceId = opts.newTraceId ?? randomTraceId;
		this.#newSpanId = opts.newSpanId ?? randomSpanId;
		this.enabled = cfg.enabled;
	}

	startTrace(opts: TraceOptions): TraceContext {
		const rate = this.#cfg.sampleRate[opts.kind] ?? 1;
		// 采样只在这里掷一次骰子；子 span 跟随，避免 trace 被采成半棵树
		const sampled = this.enabled && this.#random() < rate;
		return {
			traceId: this.#newTraceId(),
			rootSpanId: this.#newSpanId(),
			name: opts.name,
			sampled,
			traceAttributes: traceAttributesFor(opts),
			// L1b 工具据此把下游调用（MCP 等）挂成自己的子 span（见 types.ts 的说明）
			toolSpans: new Map<string, string>(),
		};
	}

	startRootSpan(ctx: TraceContext, opts: Omit<SpanOptions, "parentSpanId"> = {}): SpanHandle {
		// 根 span 复用 `startTrace` 预留的 id，保证「根 span = trace」一一对应；
		// `forceRoot` 而不是传 `parentSpanId: undefined`——后者会被 `?? ctx.rootSpanId` 接住，
		// 变成「自己是自己的父」。
		return this.#open(ctx, ctx.name, { ...opts, spanId: ctx.rootSpanId }, true);
	}

	startSpan(ctx: TraceContext, name: string, opts: SpanOptions = {}): SpanHandle {
		return this.#open(ctx, name, opts);
	}

	#open(ctx: TraceContext, name: string, opts: SpanOptions & { spanId?: string }, forceRoot = false): SpanHandle {
		if (!ctx.sampled) return NOOP_HANDLE;
		const parentSpanId = forceRoot ? undefined : (opts.parentSpanId ?? ctx.rootSpanId);
		const draft: SpanDraft = {
			traceId: ctx.traceId,
			spanId: opts.spanId ?? this.#newSpanId(),
			...(parentSpanId ? { parentSpanId } : {}),
			name,
			kind: opts.kind ?? "internal",
			startMs: opts.startMs ?? this.#now(),
			// trace 级属性并入**每一个** span（Langfuse 过滤依赖），子 span 显式属性优先
			attributes: { ...ctx.traceAttributes, ...(opts.attributes ?? {}) },
			status: "unset",
			level: "DEFAULT",
			levelExplicit: false,
			ended: false,
		};
		return new SpanHandleImpl(draft, this.#cfg, this.#client, this.#now);
	}

	async withSpan<T>(
		ctx: TraceContext,
		name: string,
		opts: SpanOptions,
		fn: (span: SpanHandle) => Promise<T> | T,
	): Promise<T> {
		const span = this.startSpan(ctx, name, opts);
		try {
			const result = await fn(span);
			span.setStatus("ok");
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.setStatus("error", message);
			// 追踪绝不吞业务异常：记完必须原样抛出去
			throw error;
		} finally {
			span.end();
		}
	}

	async flush(): Promise<void> {
		await this.#client.flush();
	}

	async shutdown(): Promise<void> {
		await this.#client.shutdown();
	}
}

/** 组装 Tracer：配置 + client → 可用的 tracer（配置关着时等价于 no-op） */
export function createTracer(cfg: TracingConfig, client: TracingClient, opts: TracerOptions = {}): Tracer {
	return new TracerImpl(cfg, client, opts);
}

/** 供 trace-hook 复用的观察类型常量（避免各处手写字符串） */
export { OBS_TYPE };
