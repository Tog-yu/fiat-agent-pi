/**
 * 阶段 14 / P14-90：L1a trace-hook 全链路（faux provider，无网络）。
 *
 * 三个必须成立的口径：
 *   1. **树闭合**：`fiat.turn`（根）→ `fiat.llm.turn`（generation）→ `fiat.tool`，
 *      每个 `parentSpanId` 都能追到根；全部 span 同 traceId。
 *   2. **被闸门② block 的调用仍然出 span**（`fiat.gate.tool_call="block"` + WARNING）。
 *      这是本阶段最容易漏的一条：block 会让 `emitToolCall` 短路，trace-hook 收不到
 *      `tool_call`，只能靠 `turn_end.toolResults` 对账补出来（见 trace-hook 文件头）。
 *   3. **chat 的逐轮 trace**：多轮之间不复用预留根 spanId，`fiat.gate.build` 只落在第一条。
 *
 * ⚠️ 装配必须与 `session/factory.ts` 同构：`factories = [gate, hook]`（hook 在**最后**）+
 * `bridgeAgentHooks(runner)`（tool 事件）+ `bridgeLifecycleEvents(agent, runner)`（轮次事件）。
 * 少订 lifecycle 的话 generation 和对账全都不会发生——这正是本文件要钉住的集成契约。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { createTraceHook } from "../src/server/host/l1a/trace-hook.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { defineHostTool } from "../src/server/host/tools.ts";
import { InMemoryTracingClient } from "../src/server/tracing/client.ts";
import { LANGFUSE_KEYS, OBS_TYPE } from "../src/server/tracing/otlp.ts";
import { createTracer } from "../src/server/tracing/tracer.ts";
import {
	DEFAULT_TRACING_CONFIG,
	type Tracer,
	type TraceSpan,
	type TracingConfig,
	type TracingWiring,
} from "../src/server/tracing/types.ts";

const CFG: TracingConfig = { ...DEFAULT_TRACING_CONFIG, enabled: true };

const tmpDirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-tracing-"));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTool(name: string, runs: string[]) {
	return defineHostTool({
		name,
		label: name,
		description: `${name} 测试工具`,
		parameters: Type.Object({ message: Type.String() }),
		execute: async (_id, params) => {
			runs.push(`${name}:${params.message}`);
			return { content: [{ type: "text", text: `${name} done` }], details: undefined };
		},
	});
}

/** 建一个独立 cwd / agentDir（同 host-extensions.test.ts 的做法） */
function dirs(): { cwd: string; agentDir: string } {
	const dir = tmp();
	const cwd = join(dir, "proj");
	const agentDir = join(dir, "agent");
	mkdtempSync(cwd);
	mkdtempSync(agentDir);
	return { cwd, agentDir };
}

function byName(spans: readonly TraceSpan[], name: string): TraceSpan[] {
	return spans.filter((s) => s.name === name);
}

function treeIsClosed(spans: readonly TraceSpan[]): boolean {
	const ids = new Set(spans.map((s) => s.spanId));
	return spans.every((s) => s.parentSpanId === undefined || ids.has(s.parentSpanId));
}

describe("P14-86 trace-hook：一轮多工具（含 generation / token / tool 树）", () => {
	it("根 + generation + tool 树闭合，且 trace 级属性下发到每个 span", async () => {
		const { cwd, agentDir } = dirs();
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
		const wiring: TracingWiring = { tracer, trace: ctx };

		const hook = createTraceHook({
			source: wiring,
			// 构建事实：本应由 buildSession 在首轮补登（chat 是 per-turn trace，构建时还没有 trace）
			buildInfo: {
				startedMs: Date.now() - 5,
				role: "ops",
				environment: "dev",
				registeredTools: ["fiat_echo"],
				policiesLoaded: 3,
			},
		});
		const { runner } = await setupEmbeddedExtensions({ cwd, agentDir, factories: [hook] });

		const runs: string[] = [];
		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("fiat_echo", { message: "hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("全部完成"),
			]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				sessionId: "s-1",
				tools: [makeTool("fiat_echo", runs)],
				tracing: wiring,
				...bridgeAgentHooks(runner),
			});
			// ⚠️ 轮次事件只走 subscribe 扇出，漏订就没有 generation（见文件头）
			const unsub = bridgeLifecycleEvents(host.agent, runner);
			const reply = await host.runTurn("打个招呼");
			unsub();

			expect(reply).toBe("全部完成");
			expect(runs).toEqual(["fiat_echo:hi"]);
		} finally {
			faux.unregister();
		}

		const spans = client.entries();
		// ① 树闭合 + 同 traceId
		expect(spans.length).toBeGreaterThan(0);
		expect(treeIsClosed(spans)).toBe(true);
		expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([ctx.traceId]));

		// ② 根 span = fiat.turn，无父，且复用 startTrace 预留的 spanId
		const roots = spans.filter((s) => s.parentSpanId === undefined);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.name).toBe("fiat.turn");
		expect(roots[0]?.spanId).toBe(ctx.rootSpanId);

		// ③ 构建 span：首轮补登，startMs 用真实构建时刻（早于根 span）
		const build = byName(spans, "fiat.gate.build");
		expect(build).toHaveLength(1);
		expect(build[0]?.parentSpanId).toBe(ctx.rootSpanId);
		expect(build[0]?.attributes["fiat.tools.registered"]).toBe(1);
		expect(BigInt(build[0]?.startNs ?? "0")).toBeLessThan(BigInt(roots[0]?.startNs ?? "0"));

		// ④ 两轮 generation：第一轮带 tool，第二轮是收尾回复
		const gens = byName(spans, "fiat.llm.turn");
		expect(gens).toHaveLength(2);
		for (const g of gens) {
			expect(g.parentSpanId).toBe(ctx.rootSpanId);
			expect(g.attributes[LANGFUSE_KEYS.obsType]).toBe(OBS_TYPE.generation);
			expect(g.attributes["gen_ai.operation.name"]).toBe("chat");
			// token / model 面板的来源
			expect(g.attributes["gen_ai.request.model"]).toBe("faux-1");
			expect(g.attributes[LANGFUSE_KEYS.obsUsageDetails]).toBeTypeOf("string");
		}

		// ⑤ tool span：挂在**本轮 generation** 之下（不是根），且标 allow
		const tools = byName(spans, "fiat.tool fiat_echo");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.parentSpanId).toBe(gens[0]?.spanId);
		expect(tools[0]?.attributes[LANGFUSE_KEYS.obsType]).toBe(OBS_TYPE.tool);
		expect(tools[0]?.attributes["fiat.gate.tool_call"]).toBe("allow");
		expect(tools[0]?.attributes["fiat.tool.seq"]).toBe(1);
		expect(tools[0]?.status).toBe("ok");
		expect(tools[0]?.attributes[LANGFUSE_KEYS.obsOutput]).toContain("fiat_echo done");

		// ⑥ trace 级属性（Langfuse 过滤维度）必须出现在**每一个** span 上
		for (const s of spans) {
			expect(s.attributes[LANGFUSE_KEYS.sessionId]).toBe("s-1");
			expect(s.attributes[LANGFUSE_KEYS.userId]).toBe("u-1");
			expect(s.attributes[LANGFUSE_KEYS.traceTags]).toEqual(["chat", "dev", "ops"]);
		}
	});
});

describe("P14-86 trace-hook：被闸门② block 的调用也要出 span", () => {
	it("block 的调用收不到 tool_call 钩子 → 由 turn_end 对账补 span，level=WARNING", async () => {
		const { cwd, agentDir } = dirs();
		const client = new InMemoryTracingClient();
		const tracer = createTracer(CFG, client, { random: () => 0 });
		const ctx = tracer.startTrace({ name: "fiat.turn", kind: "chat", sessionId: "s-2" });
		const wiring: TracingWiring = { tracer, trace: ctx };

		const gateCalls: string[] = [];
		// 闸门②：拦掉高风险工具；**排在 trace-hook 之前**——这正是"被拦的调用收不到钩子"的成因
		const gate: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				gateCalls.push(event.toolName);
				if (event.toolName === "fiat_danger") return { block: true, reason: "权限拒绝：当前角色无权调用该工具" };
				return undefined;
			});
		};
		const { runner } = await setupEmbeddedExtensions({
			cwd,
			agentDir,
			factories: [gate, createTraceHook({ source: wiring })],
		});

		const runs: string[] = [];
		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("fiat_danger", { message: "rm -rf /" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("已被拦下，改为人工介入。"),
			]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				tools: [makeTool("fiat_danger", runs)],
				tracing: wiring,
				...bridgeAgentHooks(runner),
			});
			const unsub = bridgeLifecycleEvents(host.agent, runner);
			const reply = await host.runTurn("删库");
			unsub();
			expect(reply).toBe("已被拦下，改为人工介入。");
		} finally {
			faux.unregister();
		}

		// 闸门确实拦了、工具确实没执行
		expect(gateCalls).toEqual(["fiat_danger"]);
		expect(runs).toEqual([]);

		const spans = client.entries();
		const tools = byName(spans, "fiat.tool fiat_danger");
		// **只有一条**（对账补出来的），不是两条（若 tool_call 钩子也触发了就会重复）
		expect(tools).toHaveLength(1);
		expect(tools[0]?.attributes["fiat.gate.tool_call"]).toBe("block");
		expect(tools[0]?.attributes["fiat.tool.reconciled"]).toBe(true);
		// 被拦是**安全信号**：WARNING 而不是 ERROR（不是故障，是闸门正常工作）
		expect(tools[0]?.attributes[LANGFUSE_KEYS.obsLevel]).toBe("WARNING");
		expect(tools[0]?.status).toBe("error");
		// 挂在被拦那一轮的 generation 之下
		expect(tools[0]?.parentSpanId).toBe(byName(spans, "fiat.llm.turn")[0]?.spanId);
		expect(treeIsClosed(spans)).toBe(true);
	});
});

describe("P14-87 perTurnTracing：chat 一轮一条 trace", () => {
	it("两轮产生两条独立 trace，各自一个根 span；构建 span 只落在第一条", async () => {
		const { cwd, agentDir } = dirs();
		const client = new InMemoryTracingClient();
		const tracer: Tracer = createTracer(CFG, client, { random: () => 0 });

		// 与 cli/chat.ts 同构：接线放可变引用里，每轮现开 trace
		let current: TracingWiring | undefined;
		const hook = createTraceHook({
			source: () => current,
			buildInfo: { startedMs: Date.now(), role: "ops", environment: "dev", registeredTools: [], policiesLoaded: 1 },
		});
		const { runner } = await setupEmbeddedExtensions({ cwd, agentDir, factories: [hook] });

		const faux = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("第二轮")]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				tools: [],
				perTurnTracing: () => {
					const trace = tracer.startTrace({ name: "fiat.turn", kind: "chat", sessionId: "s-repl" });
					current = { tracer, trace };
					return current;
				},
				...bridgeAgentHooks(runner),
			});
			const unsub = bridgeLifecycleEvents(host.agent, runner);
			expect(await host.runTurn("一")).toBe("第一轮");
			expect(await host.runTurn("二")).toBe("第二轮");
			unsub();
		} finally {
			faux.unregister();
		}

		const spans = client.entries();
		const traceIds = new Set(spans.map((s) => s.traceId));
		expect(traceIds.size).toBe(2);

		for (const tid of traceIds) {
			const inTrace = spans.filter((s) => s.traceId === tid);
			// 每条 trace **恰好一个**根 span，且 spanId 不与别的 trace 撞
			expect(inTrace.filter((s) => s.parentSpanId === undefined)).toHaveLength(1);
			expect(treeIsClosed(inTrace)).toBe(true);
			expect(byName(inTrace, "fiat.llm.turn")).toHaveLength(1);
			// 多轮聚合靠 session.id（Langfuse 的 Session 分组），不是靠共用 traceId
			expect(inTrace[0]?.attributes[LANGFUSE_KEYS.sessionId]).toBe("s-repl");
		}

		// 根 spanId 全局唯一（若沿用固定 wiring，第二轮会复用预留根 id → 这里会挂）
		const rootIds = spans.filter((s) => s.parentSpanId === undefined).map((s) => s.spanId);
		expect(new Set(rootIds).size).toBe(rootIds.length);

		// 构建 span 只补登一次（首轮），不会每轮重复
		expect(byName(spans, "fiat.gate.build")).toHaveLength(1);
	});
});
