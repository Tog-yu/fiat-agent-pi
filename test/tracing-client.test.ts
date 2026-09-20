/**
 * 阶段 14 / P14-90：TracingClient 三实现 + 批处理队列（本地 stub HTTP server，零外网）。
 *
 * 这一层的验收全部围绕**背压与失败语义**，而不是"能不能发出去"：
 *   1. `enabled=false` → Noop：**零请求**（这是缺省路径，绝不能有任何网络副作用）
 *   2. Basic auth 头 = base64(pk:sk)；`x-langfuse-ingestion-version` 必带
 *      （不带则 Langfuse UI 最长 10 分钟才可见，是"看起来没数据"的经典原因）
 *   3. `max_batch` 切批 / `flush_interval_ms` 定时刷
 *   4. 队列满**丢最旧**并累加 `dropped`（新数据比旧数据有价值）
 *   5. 上报失败只重试 `max_retries` 次，**绝不抛**、绝不回队（回队会把"端点不可达"变成内存泄漏）
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTracingClient, InMemoryTracingClient, NoopTracingClient } from "../src/server/tracing/client.ts";
import { DEFAULT_TRACING_CONFIG, type TraceSpan, type TracingConfig } from "../src/server/tracing/types.ts";

interface Recv {
	auth?: string;
	version?: string;
	spans: WireSpan[];
}

/** 线上形状：attributes 是 `{key, value}` **数组**（不是对象），整数走 intValue 字符串 */
interface WireSpan {
	spanId: string;
	name: string;
	attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}

function attrInt(span: WireSpan | undefined, key: string): string | undefined {
	return span?.attributes.find((a) => a.key === key)?.value.intValue;
}

function mkSpan(i: number, traceId = "a".repeat(32)): TraceSpan {
	return {
		traceId,
		spanId: i.toString(16).padStart(16, "0"),
		name: "fiat.turn",
		kind: "internal",
		startNs: "1000000",
		endNs: "2000000",
		attributes: { "fiat.seq": i },
		status: "ok",
	};
}

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

/** 起一个本地 stub OTLP 端点；`respond` 决定每个请求回什么状态码 */
async function startStub(respond: () => number): Promise<{ endpoint: string; received: Recv[] }> {
	const received: Recv[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
				resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
			};
			received.push({
				auth: req.headers.authorization,
				version: req.headers["x-langfuse-ingestion-version"] as string | undefined,
				spans: parsed.resourceSpans[0]?.scopeSpans[0]?.spans ?? [],
			});
			res.writeHead(respond(), { "content-type": "application/json" });
			res.end("{}");
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { endpoint: `http://127.0.0.1:${port}/api/public/otel/v1/traces`, received };
}

/** 环境变量名按 tracing.yaml 的 `public_key_env` / `secret_key_env` 取（配置里只存名字） */
const CREDS = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-2" };

describe("P14-84 缺省关：NoopTracingClient 零网络零定时器", () => {
	it("enabled=false → Noop，且一次 fetch 都不发生", async () => {
		let calls = 0;
		const client = createTracingClient(DEFAULT_TRACING_CONFIG, {
			memory: true,
			fetchImpl: (() => {
				calls += 1;
				throw new Error("不该发生网络调用");
			}) as unknown as typeof fetch,
		});
		expect(client).toBeInstanceOf(NoopTracingClient);
		client.send([mkSpan(1)]);
		await client.flush();
		await client.shutdown();
		expect(calls).toBe(0);
		expect(client.stats()).toEqual({ queued: 0, sent: 0, batches: 0, dropped: 0, failed: 0 });
	});

	it("enabled=true 但凭据缺失 → 退回 Noop（client 不比配置更激进）", () => {
		const cfg: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };
		const client = createTracingClient(cfg, { env: {} });
		expect(client).toBeInstanceOf(NoopTracingClient);
	});

	it("memory=true → InMemoryTracingClient（测试 / 本地验证用，零网络）", () => {
		const cfg: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };
		const client = createTracingClient(cfg, { memory: true, env: CREDS });
		expect(client).toBeInstanceOf(InMemoryTracingClient);
	});
});

describe("P14-84 HttpOtlpTracingClient：鉴权头 / 批次 / 背压 / 失败", () => {
	function cfgWith(over: Partial<TracingConfig["batch"]>, endpoint: string): TracingConfig {
		return {
			...DEFAULT_TRACING_CONFIG,
			enabled: true,
			endpoint,
			batch: { ...DEFAULT_TRACING_CONFIG.batch, ...over },
		};
	}

	it("Basic auth = base64(pk:sk)，且必带 x-langfuse-ingestion-version", async () => {
		const stub = await startStub(() => 200);
		const client = createTracingClient(cfgWith({ flushIntervalMs: 10_000 }, stub.endpoint), { env: CREDS });
		client.send([mkSpan(1)]);
		await client.flush();

		expect(stub.received).toHaveLength(1);
		expect(stub.received[0]?.auth).toBe(`Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`);
		expect(stub.received[0]?.version).toBe("4");
		expect(stub.received[0]?.spans.map((s) => s.spanId)).toEqual([mkSpan(1).spanId]);
		expect(client.stats()).toMatchObject({ queued: 0, sent: 1, batches: 1, failed: 0 });
	});

	it("max_batch 切批：5 个 span / 批上限 2 → 3 个请求（2+2+1）", async () => {
		const stub = await startStub(() => 200);
		const client = createTracingClient(cfgWith({ maxBatch: 2, flushIntervalMs: 10_000 }, stub.endpoint), {
			env: CREDS,
		});
		client.send([1, 2, 3, 4, 5].map((i) => mkSpan(i)));
		await client.flush();

		expect(stub.received.map((r) => r.spans.length)).toEqual([2, 2, 1]);
		expect(client.stats()).toMatchObject({ sent: 5, batches: 3 });
	});

	it("flush_interval_ms 定时刷：不显式 flush 也会发出（定时器 unref 但进程活着就会响）", async () => {
		const stub = await startStub(() => 200);
		createTracingClient(cfgWith({ flushIntervalMs: 20, maxBatch: 10 }, stub.endpoint), { env: CREDS }).send([
			mkSpan(1),
		]);
		await new Promise((r) => setTimeout(r, 200));
		expect(stub.received).toHaveLength(1);
	});

	it("队列满**丢最旧**并累加 dropped（留下的是最新 3 条）", async () => {
		const stub = await startStub(() => 200);
		const client = createTracingClient(cfgWith({ maxQueue: 3, maxBatch: 1, flushIntervalMs: 10_000 }, stub.endpoint), {
			env: CREDS,
		});
		for (const i of [1, 2, 3, 4, 5]) client.send([mkSpan(i)]);
		expect(client.stats().dropped).toBe(2);

		await client.flush();
		expect(stub.received.map((r) => attrInt(r.spans[0], "fiat.seq"))).toEqual(["3", "4", "5"]);
		expect(client.stats()).toMatchObject({ dropped: 2, sent: 3, failed: 0 });
	});

	it("端点 500：重试 max_retries 次后放弃 —— 不抛、不回队、只记 failed", async () => {
		const stub = await startStub(() => 500);
		const client = createTracingClient(
			cfgWith({ maxBatch: 10, maxRetries: 1, flushIntervalMs: 10_000, timeoutMs: 2000 }, stub.endpoint),
			{ env: CREDS },
		);
		client.send([mkSpan(1)]);
		await expect(client.flush()).resolves.toBeUndefined(); // 关键：不抛
		expect(stub.received).toHaveLength(2); // 首发 + 1 次重试
		expect(client.stats()).toMatchObject({ queued: 0, sent: 0, failed: 1 });
	});

	it("网络不可达（端口没人听）：同样不抛，记 failed", async () => {
		const client = createTracingClient(
			{
				...DEFAULT_TRACING_CONFIG,
				enabled: true,
				endpoint: "http://127.0.0.1:1/api/public/otel/v1/traces",
				batch: { ...DEFAULT_TRACING_CONFIG.batch, maxRetries: 0, flushIntervalMs: 10_000, timeoutMs: 500 },
			},
			{ env: CREDS },
		);
		client.send([mkSpan(1)]);
		await expect(client.flush()).resolves.toBeUndefined();
		expect(client.stats()).toMatchObject({ failed: 1, sent: 0 });
	});
});
