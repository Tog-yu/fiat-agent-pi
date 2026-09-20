/**
 * TracingClient（阶段 14 / P14-84）—— 上报落点，三个实现共用同一接口，工厂注入。
 *
 * 与 `audit/client.ts` / `eval/sink.ts` 完全同构，但多一层**背压与生命周期**：
 *
 *   NoopTracingClient     `enabled=false`：零网络、零定时器。**这是缺省实现。**
 *   InMemoryTracingClient 测试 / 本地验证：只收集，断言用（对齐 InMemoryAuditClient）
 *   HttpOtlpTracingClient 真实上报：原生 fetch → `{host}/api/public/otel/v1/traces`
 *
 * 三条不可破的性质（阶段 14 硬约束 1/2/3）：
 *   1. **任何方法都不抛**。队列满 / 网络错 / 超时只累加计数。观测系统挂掉不能把业务挂掉。
 *   2. **定时器必须 unref()**。否则一个 `fiat chat` 跑完进程不退出，用户会以为 CLI 卡死。
 *   3. **队列有界**。满了丢**最旧**（新数据比旧数据有价值），并累加 `dropped` 供 `fiat trace status` 暴露。
 *
 * 为什么用 `fetch` 而不是引 `@opentelemetry/exporter-trace-otlp-http`：那是一条完整的 OTel 依赖树，
 * 而我们的 span 语义（闸门 / 工单 / 蜂群）全是自研，SDK 的自动埋点一个也盖不到——
 * 引进来只是多一份依赖和一层难 mock 的黑盒。OTLP/JSON 本身就是一个普通的 JSON POST。
 */

import { resolveTracingCredentials } from "./config.ts";
import { encodeOtlp } from "./otlp.ts";
import type { TraceSpan, TracingConfig } from "./types.ts";

export interface TracingStats {
	/** 当前待发队列长度 */
	queued: number;
	/** 已成功上报的 span 数 */
	sent: number;
	/** 已成功上报的批次数 */
	batches: number;
	/** 因队列满被丢弃的 span 数（**丢最旧**） */
	dropped: number;
	/** 重试耗尽后放弃的批次数 */
	failed: number;
}

export interface TracingClient {
	/** 入队待上报。**同步、永不抛**——span 结束时调用，不能把业务拖进异步失败路径 */
	send(spans: readonly TraceSpan[]): void;
	/** 立即冲刷（单批最多 `maxBatch`，循环取到队列空为止） */
	flush(): Promise<void>;
	/** 冲刷 + 取消定时器，之后不再产生新上报 */
	shutdown(): Promise<void>;
	stats(): TracingStats;
}

const EMPTY_STATS: TracingStats = { queued: 0, sent: 0, batches: 0, dropped: 0, failed: 0 };

/** 关追踪时的实现：什么都不做，也不起定时器 */
export class NoopTracingClient implements TracingClient {
	send(_spans: readonly TraceSpan[]): void {}
	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}
	stats(): TracingStats {
		return { ...EMPTY_STATS };
	}
}

/** 测试 / 本地验证：只收集，零网络 */
export class InMemoryTracingClient implements TracingClient {
	readonly #spans: TraceSpan[] = [];
	#batches = 0;

	send(spans: readonly TraceSpan[]): void {
		this.#spans.push(...spans);
		if (spans.length > 0) this.#batches += 1;
	}

	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}

	entries(): readonly TraceSpan[] {
		return this.#spans;
	}

	stats(): TracingStats {
		return { queued: 0, sent: this.#spans.length, batches: this.#batches, dropped: 0, failed: 0 };
	}
}

export interface HttpOtlpOptions {
	cfg: TracingConfig;
	creds: { publicKey: string; secretKey: string };
	/** 测试注入；缺省全局 fetch */
	fetchImpl?: typeof fetch;
}

/**
 * OTLP/HTTP 上报实现。
 *
 * 批次时机：`send` 入队 → 排一个 `flushIntervalMs` 的定时器（unref）；定时器到点或
 * `flush()`/`shutdown()` 被显式调用时，按 `maxBatch` 切批发出。
 *
 * 失败处置：单个批次重试 `maxRetries` 次（间隔 50ms 起指数退避），仍失败则**丢弃该批**并
 * `failed += 1`。刻意不回队——回队会让「端点长期不可达」变成内存泄漏武器。
 */
export class HttpOtlpTracingClient implements TracingClient {
	readonly #cfg: TracingConfig;
	readonly #auth: string;
	readonly #fetch: typeof fetch;
	readonly #queue: TraceSpan[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inflight: Promise<void> = Promise.resolve();
	#sent = 0;
	#batches = 0;
	#dropped = 0;
	#failed = 0;

	constructor(opts: HttpOtlpOptions) {
		this.#cfg = opts.cfg;
		this.#auth = `Basic ${Buffer.from(`${opts.creds.publicKey}:${opts.creds.secretKey}`).toString("base64")}`;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	send(spans: readonly TraceSpan[]): void {
		if (spans.length === 0) return;
		try {
			for (const s of spans) this.#queue.push(s);
			// 有界队列：丢最旧（新数据更有价值）
			while (this.#queue.length > this.#cfg.batch.maxQueue) {
				this.#queue.shift();
				this.#dropped += 1;
			}
			this.#schedule();
		} catch {
			// 永不抛（硬约束 2）
		}
	}

	#schedule(): void {
		if (this.#timer) return;
		const t = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, this.#cfg.batch.flushIntervalMs);
		// 关键：不 unref 的话，CLI 跑完会被这个定时器钉住不退出
		if (typeof t.unref === "function") t.unref();
		this.#timer = t;
	}

	async flush(): Promise<void> {
		// 串行化：并发 flush 会打乱批次边界，也让重试计数难以解释
		this.#inflight = this.#inflight.then(() => this.#drain());
		await this.#inflight;
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0) {
			const batch = this.#queue.splice(0, this.#cfg.batch.maxBatch);
			const ok = await this.#post(batch);
			if (ok) {
				this.#sent += batch.length;
				this.#batches += 1;
			} else {
				// 丢弃该批（不回队），只记失败计数
				this.#failed += 1;
			}
		}
	}

	async #post(batch: readonly TraceSpan[]): Promise<boolean> {
		let body: string;
		try {
			body = JSON.stringify(encodeOtlp(batch, this.#cfg));
		} catch {
			return false;
		}

		for (let attempt = 0; attempt <= this.#cfg.batch.maxRetries; attempt += 1) {
			try {
				const res = await this.#fetch(this.#cfg.endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: this.#auth,
						// 不带这个头，Langfuse 走旧兼容路径，UI 里最长 10 分钟才可见
						"x-langfuse-ingestion-version": this.#cfg.ingestionVersion,
					},
					body,
					signal: AbortSignal.timeout(this.#cfg.batch.timeoutMs),
				});
				if (res.ok) return true;
			} catch {
				// 网络错 / 超时：吞掉，走重试
			}
			if (attempt < this.#cfg.batch.maxRetries) {
				await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
			}
		}
		return false;
	}

	async shutdown(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		await this.flush();
	}

	stats(): TracingStats {
		return {
			queued: this.#queue.length,
			sent: this.#sent,
			batches: this.#batches,
			dropped: this.#dropped,
			failed: this.#failed,
		};
	}
}

export interface CreateTracingClientOptions {
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	/** 即使 `enabled=true` 也走内存实现（测试 / 本地验证，不发网络） */
	memory?: boolean;
}

/**
 * 工厂：`enabled=false` → Noop（缺省路径）；`memory=true` → InMemory；
 * 其余 → HttpOtlp。凭据缺失时**退回 Noop**——`loadTracingConfig` 已经在 enabled=true 时
 * fail-fast 过，这里只是防御（client 不该比配置更激进）。
 */
export function createTracingClient(cfg: TracingConfig, opts: CreateTracingClientOptions = {}): TracingClient {
	if (!cfg.enabled) return new NoopTracingClient();
	if (opts.memory) return new InMemoryTracingClient();
	const creds = resolveTracingCredentials(cfg, opts.env ?? process.env);
	if (!creds) return new NoopTracingClient();
	return new HttpOtlpTracingClient({ cfg, creds, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
}
