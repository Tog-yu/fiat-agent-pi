/**
 * 阶段 14 / P14-90：网关端到端 —— **一条告警 = 一条 trace**。
 *
 * 这是阶段 14 里唯一一个"跨进程边界"的验收点，也是最容易做错的一个：
 * 网关是**长驻进程**，它的链路边界不是进程而是「一条告警」，所以 `handleAlert`
 * 每条现开 trace；而诊断蜂群的每个视角是**独立子会话**（自己的 PiHostLoop + 自己的
 * trace-hook），必须靠 `parentSpanId` 钉在同一条 trace 上——若各开一条 trace，
 * Langfuse 里「一条告警 → 4 个视角 → 各自若干轮」会碎成 5 条互不相干的 trace，
 * 「哪条链路慢、哪个视角在烧 token」直接看不出来（硬约束 8）。
 *
 * 本用例把真实链路的形状跑通：HTTP → 适配 → 幂等 → 分级 → fan-out（4 视角）→
 * 子会话 faux 轮次 → 报告回推，然后断言整棵树。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { runFanout } from "../src/server/diagnosis/fanout.ts";
import { diagnosisPlan, renderReport } from "../src/server/diagnosis/plan.ts";
import { createDiagnosisRunner } from "../src/server/diagnosis/sessionRunner.ts";
import { LocalAlertNotifier } from "../src/server/gateway/notify.ts";
import { InflightGate } from "../src/server/gateway/policy.ts";
import { GatewayServer } from "../src/server/gateway/server.ts";
import { InMemoryAlertEventStore } from "../src/server/gateway/store.ts";
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "../src/server/gateway/types.ts";
import { createTraceHook } from "../src/server/host/l1a/trace-hook.ts";
import { InMemoryTracingClient } from "../src/server/tracing/client.ts";
import { LANGFUSE_KEYS } from "../src/server/tracing/otlp.ts";
import { createTracer } from "../src/server/tracing/tracer.ts";
import { DEFAULT_TRACING_CONFIG, type TraceSpan, type TracingConfig } from "../src/server/tracing/types.ts";

const CFG: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };
const ANGLES = 4; // DEFAULT_ANGLES 的视角数（logs / config_change / dependency / history）

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dirs(): { cwd: string; agentDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-tracing-e2e-"));
	tmpDirs.push(dir);
	const cwd = join(dir, "proj");
	const agentDir = join(dir, "agent");
	mkdtempSync(cwd);
	mkdtempSync(agentDir);
	return { cwd, agentDir };
}

function byName(spans: readonly TraceSpan[], name: string): TraceSpan[] {
	return spans.filter((s) => s.name === name);
}

/** 轮询等一个后台条件（诊断是 fire-and-forget，webhook 不等它） */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("等待超时：后台诊断未在预期时间内收口");
}

function push(title: string) {
	return {
		method: "POST",
		url: "/hooks/alert",
		headers: { authorization: "Bearer e2e-token" },
		body: JSON.stringify({ title, service: "payment-gateway", severity: "P0" }),
	};
}

describe("P14-89 网关 e2e：一条 P0 告警 → 同一棵 trace", () => {
	// 显式放宽超时：本用例要等后台诊断（fire-and-forget）收口，
	// 且本机首次 import 本地 pi 源码很慢（vitest 把 import 计入文件时长，不计入用例，但安全起见给足余量）
	const CASE_TIMEOUT = 30_000;

	it(
		"alert 根 + dedupe/classify/diagnose + N 个视角 span + 子会话 generation 链",
		async () => {
			const { cwd, agentDir } = dirs();
			const client = new InMemoryTracingClient();
			const tracer = createTracer(CFG, client, { random: () => 0 });

			const config: GatewayConfig = {
				...DEFAULT_GATEWAY_CONFIG,
				token: "e2e-token",
				autoDiagnoseSeverities: ["P0", "P1"],
				maxInflightPerService: 2,
			};
			const store = new InMemoryAlertEventStore();
			const notifier = new LocalAlertNotifier();

			const faux = registerFauxProvider();
			try {
				// 每个视角一个独立子会话 → 4 次 LLM 调用（子会话无工具，各只跑一轮）
				faux.setResponses(Array.from({ length: ANGLES + 4 }, () => fauxAssistantMessage("视角结论：未找到异常")));

				const server = new GatewayServer(
					{
						config,
						store,
						notify: notifier,
						// 阶段 14：网关是长驻进程，注入的是 Tracer，trace 由 handleAlert 每条现开
						tracer,
						diagnose: async (envelope, wiring) => {
							// 与 entry.ts 的 makeDiagnose 同构：子系统经 createDiagnosisRunner 起子会话，
							// 接线（含视角父 span）原样透传 —— 蜂群因此挂同一条 trace。
							const runOne = createDiagnosisRunner({
								buildChildSession: async (task, childTracing) => ({
									sessionId: `child-${task.name}`,
									tools: [],
									// 子会话的 L1a 通道只挂 trace-hook（本用例只验追踪契约，闸门链另有专测）
									extensionFactories: childTracing ? [createTraceHook({ source: childTracing })] : [],
									...(childTracing ? { tracing: childTracing } : {}),
								}),
								model: faux.getModel(),
								getApiKey: () => "faux-key",
								cwd,
								agentDir,
								...(wiring ? { tracing: wiring } : {}),
							});
							const alert = {
								title: envelope.alert.title,
								...(envelope.alert.service ? { service: envelope.alert.service } : {}),
							};
							const tasks = diagnosisPlan(alert, { allowedTools: () => true });
							const { results, summary } = await runFanout({ tasks, runOne });
							return {
								sessionId: `gw-${envelope.fingerprint.slice(0, 8)}`,
								report: renderReport(alert, results, summary),
							};
						},
					},
					new InflightGate(config.maxInflightPerService, config.maxQueuePerService),
				);

				const res = await server.handleRequest(push("支付网关 5xx 突增"));
				expect([200, 202]).toContain(res.status);
				// 诊断在后台跑：等报告卡推出（= 整条链路收口）
				await waitFor(() => notifier.sent.some((n) => n.kind === "report"));

				const spans = client.entries();
				// ① **只有一条 trace**（硬约束 8）
				expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
				const traceId = spans[0]?.traceId as string;

				// ② 根 span = fiat.alert.handle，无父
				const roots = spans.filter((s) => s.parentSpanId === undefined);
				expect(roots).toHaveLength(1);
				expect(roots[0]?.name).toBe("fiat.alert.handle");
				// sessionId 用 fingerprint：同一条告警的重复推送 / 升级在 Langfuse 里聚成一组
				const records = await store.list();
				expect(roots[0]?.attributes[LANGFUSE_KEYS.sessionId]).toBe(records[0]?.fingerprint);
				// userId 用告警来源（langfuse.user.id）——与信封里的 source 同源，不另造口径
				const envelope = JSON.parse(records[0]?.envelopeJson ?? "{}") as { source?: string };
				expect(envelope.source).toBe("webhook"); // 网关缺省 source 标识
				expect(roots[0]?.attributes[LANGFUSE_KEYS.userId]).toBe(envelope.source);
				expect(roots[0]?.attributes[LANGFUSE_KEYS.traceTags]).toContain("gateway");
				expect(roots[0]?.attributes[LANGFUSE_KEYS.traceTags]).toContain("P0");

				// ③ 处理链三段子 span 都挂在根下
				for (const name of ["fiat.alert.dedupe", "fiat.alert.classify", "fiat.alert.diagnose"]) {
					const seg = byName(spans, name);
					expect(seg).toHaveLength(1);
					expect(seg[0]?.parentSpanId).toBe(roots[0]?.spanId);
				}
				expect(byName(spans, "fiat.alert.classify")[0]?.attributes["fiat.alert.action"]).toBe("auto_diagnose");

				// ④ N 个视角 span：挂根下（不是新 trace）
				const angles = byName(spans, "fiat.fanout.angle");
				expect(angles).toHaveLength(ANGLES);
				for (const a of angles) expect(a.parentSpanId).toBe(roots[0]?.spanId);
				// 视角名各自不同（logs / config_change / dependency / history）
				expect(new Set(angles.map((a) => a.attributes["fiat.diagnosis.angle"])).size).toBe(ANGLES);

				// ⑤ 每个视角下都挂着它自己的子会话完整子链路：fiat.turn → fiat.llm.turn
				const childTurns = byName(spans, "fiat.turn");
				expect(childTurns).toHaveLength(ANGLES);
				const angleSpanIds = new Set(angles.map((a) => a.spanId));
				for (const t of childTurns) expect(angleSpanIds.has(t.parentSpanId ?? "")).toBe(true);

				const gens = byName(spans, "fiat.llm.turn");
				expect(gens).toHaveLength(ANGLES);
				const childTurnIds = new Set(childTurns.map((t) => t.spanId));
				for (const g of gens) expect(childTurnIds.has(g.parentSpanId ?? "")).toBe(true);

				// ⑥ 树闭合 + 全部同 traceId
				const ids = new Set(spans.map((s) => s.spanId));
				for (const s of spans) {
					expect(s.traceId).toBe(traceId);
					if (s.parentSpanId) expect(ids.has(s.parentSpanId)).toBe(true);
				}
			} finally {
				faux.unregister();
			}
		},
		CASE_TIMEOUT,
	);

	it(
		"关追踪（缺省）时网关零 span、链路行为一字不变",
		async () => {
			const { cwd, agentDir } = dirs();
			const off: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: false };
			const client = new InMemoryTracingClient();
			const tracer = createTracer(off, client, { random: () => 0 });

			const config: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, token: "e2e-token", maxInflightPerService: 2 };
			const store = new InMemoryAlertEventStore();
			const notifier = new LocalAlertNotifier();
			const faux = registerFauxProvider();
			try {
				faux.setResponses(Array.from({ length: ANGLES }, () => fauxAssistantMessage("结论")));
				const server = new GatewayServer(
					{
						config,
						store,
						notify: notifier,
						// enabled=false 时 entry.ts 根本不注入 tracer；这里**故意注入**一个关掉的 tracer，
						// 验证第二层保险：即使被注入，采样为 false ⇒ 所有采集点退化成 no-op、零 span。
						tracer,
						diagnose: async (envelope, wiring) => {
							// 关追踪时不存在"当前轮接线"——采集点全部走 no-op
							expect(wiring?.trace.sampled === true).toBe(false);
							const runOne = createDiagnosisRunner({
								buildChildSession: async (task, childTracing) => ({
									sessionId: `child-${task.name}`,
									tools: [],
									extensionFactories: childTracing ? [createTraceHook({ source: childTracing })] : [],
								}),
								model: faux.getModel(),
								getApiKey: () => "faux-key",
								cwd,
								agentDir,
							});
							const alert = { title: envelope.alert.title };
							const tasks = diagnosisPlan(alert, { allowedTools: () => true });
							const { results, summary } = await runFanout({ tasks, runOne });
							return { sessionId: "gw-off", report: renderReport(alert, results, summary) };
						},
					},
					new InflightGate(config.maxInflightPerService, config.maxQueuePerService),
				);

				const res = await server.handleRequest(push("磁盘水位告警"));
				expect([200, 202]).toContain(res.status);
				await waitFor(() => notifier.sent.some((n) => n.kind === "report"));
				// 零 span —— 关追踪就是关追踪，不是"少采一点"
				expect(client.entries()).toHaveLength(0);
				expect((await store.list())[0]?.diagnosisSessionId).toBe("gw-off");
			} finally {
				faux.unregister();
			}
		},
		CASE_TIMEOUT,
	);
});
