import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { createTraceHook } from "../src/server/host/l1a/trace-hook.ts";
import { createMcpRagTools, type McpClientLike, type RagStatus } from "../src/server/host/l1b/mcp-rag.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { InMemoryTracingClient } from "../src/server/tracing/client.ts";
import { createTracer } from "../src/server/tracing/tracer.ts";
import { DEFAULT_TRACING_CONFIG, type TracingWiring } from "../src/server/tracing/types.ts";

interface CapturedTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

const RAG_INPUT_SCHEMA = {
	type: "object",
	properties: { query: { type: "string", description: "检索词" } },
	required: ["query"],
};

function mockClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		connect: async () => {},
		listTools: async () => ({
			tools: [
				{
					name: "query_knowledge_hub",
					description: "查询知识库",
					inputSchema: RAG_INPUT_SCHEMA,
				},
			],
		}),
		callTool: async () => ({ content: [{ type: "text", text: "RAG 答案：返现规则如下…" }] }),
		close: async () => {},
		...overrides,
	};
}

describe("P1-5/P1-6/P1-7 mcp-rag 扩展", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-mcp-rag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("① P1-6 Type.Unsafe 端到端：faux 模型经真实 Pi 链路调用 MCP 工具", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const client = mockClient({
			callTool: async (req) => {
				calls.push(req);
				return { content: [{ type: "text", text: "RAG 答案：返现规则如下…" }] };
			},
		});

		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		// 先挂好 notify 再装配：createMcpRagTools 的 bootstrap 会触发 onStatus
		const statusReady = new Promise<{ status: RagStatus; detail: string }>((resolve) => {
			notify = (s, d) => resolve({ status: s, detail: d });
		});

		const tools = await createMcpRagTools({
			config: { transport: "stdio" },
			clientFactory: () => client,
			onStatus: (s, d) => notify?.(s, d),
		});
		await setupEmbeddedExtensions({ cwd: tempDir, agentDir: tempDir });
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			tools,
		});

		// 等 bootstrap 注册完成再驱动会话
		const status = await statusReady;
		expect(status.status).toBe("ready");

		await host.runTurn("查一下返现规则");

		// MCP callTool 收到的参数经 Type.Unsafe schema 校验后原样透传
		expect(calls).toEqual([{ name: "query_knowledge_hub", arguments: { query: "返现规则" } }]);

		// 工具结果回灌进会话
		const toolResultText = (host.messages as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>)
			.filter((m) => m.role === "toolResult")
			.flatMap((m) => m.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(toolResultText).toContain("RAG 答案：返现规则如下…");

		faux.unregister();
	});

	it("② P1-7 connect 失败 → 降级：不注册工具，状态 unavailable", async () => {
		const statuses: Array<{ status: RagStatus; detail: string }> = [];

		const tools = await createMcpRagTools({
			config: { transport: "stdio" },
			clientFactory: () =>
				mockClient({
					connect: async () => {
						throw new Error("ECONNREFUSED");
					},
				}),
			onStatus: (s, d) => {
				statuses.push({ status: s, detail: d });
			},
		});

		expect(statuses[0]?.status).toBe("unavailable");
		expect(statuses[0]?.detail).toContain("ECONNREFUSED");
		expect(tools.filter((t) => t.name.startsWith("mcp_rag_"))).toEqual([]);
	});

	it("③ P1-7 callTool isError 透传 + 超时抛可重试错误", async () => {
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const registered: CapturedTool[] = [];
		const pi = {
			registerTool: (t: CapturedTool) => registered.push(t),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		// isError 场景（P9-42：工厂 await 化后 onStatus 在返回前已同步触发，无需再等）
		for (const t of await createMcpRagTools({
			config: { transport: "stdio" },
			clientFactory: () =>
				mockClient({
					callTool: async () => ({
						isError: true,
						content: [{ type: "text", text: "collection denied: prod_finance" }],
					}),
				}),
			onStatus: (s, d) => notify?.(s, d),
		})) {
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);
		}
		const deniedTool = registered.find((t) => t.name === "mcp_rag_query_knowledge_hub");
		expect(deniedTool).toBeDefined();
		if (!deniedTool) throw new Error("denied tool not registered");
		await expect(deniedTool.execute("c1", { query: "x" }, undefined, undefined, {})).rejects.toThrow(
			"collection denied: prod_finance",
		);

		// 超时场景（不 resolve 的 promise + 极短超时）
		registered.length = 0;
		// 闭包先建、再重置 notify——避免 TS 把 notify 窄化成 undefined（?. 调用目标变 never）
		const timeoutNotify = (s: RagStatus, d: string) => notify?.(s, d);
		notify = undefined;
		for (const t of await createMcpRagTools({
			config: { transport: "stdio", timeoutMs: 20 },
			clientFactory: () =>
				mockClient({
					callTool: () => new Promise(() => {}),
				}),
			onStatus: timeoutNotify,
		})) {
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);
		}
		const timeoutTool = registered.find((t) => t.name === "mcp_rag_query_knowledge_hub");
		expect(timeoutTool).toBeDefined();
		if (!timeoutTool) throw new Error("timeout tool not registered");
		await expect(timeoutTool.execute("c2", { query: "x" }, undefined, undefined, {})).rejects.toThrow("超时");
	});

	it("④ P14-88 追踪：fiat.mcp.call 挂在**它那次调用**的 fiat.tool 之下（不是根）", async () => {
		const client = new InMemoryTracingClient();
		const tracer = createTracer({ ...DEFAULT_TRACING_CONFIG, enabled: true }, client, { random: () => 0 });
		const ctx = tracer.startTrace({ name: "fiat.turn", kind: "chat", sessionId: "s-mcp" });
		const wiring: TracingWiring = { tracer, trace: ctx };

		const tools = await createMcpRagTools({
			config: { transport: "stdio" },
			clientFactory: () => mockClient(),
			onStatus: () => {},
			tracing: wiring,
		});
		// trace-hook 是 `trace.toolSpans` 的**唯一写方**；不注册它，MCP span 就只能挂根
		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: [createTraceHook({ source: wiring })],
		});

		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				tools,
				tracing: wiring,
				...bridgeAgentHooks(runner),
			});
			// 轮次事件只经 subscribe 扇出（见 host/extensions.ts）：漏订就没有 fiat.llm.turn
			const unsub = bridgeLifecycleEvents(host.agent, runner);
			await host.runTurn("查一下返现规则");
			unsub();
		} finally {
			faux.unregister();
		}

		const spans = client.entries();
		const tool = spans.find((s) => s.name === "fiat.tool mcp_rag_query_knowledge_hub");
		const gen = spans.find((s) => s.name === "fiat.llm.turn");
		const mcp = spans.find((s) => s.name === "fiat.mcp.call");
		expect(tool).toBeDefined();
		expect(mcp).toBeDefined();
		// 「tool → mcp」这一跳正是「RAG 慢在哪一跳」的答案来源：
		// 父取 `trace.toolSpans.get(toolCallId)`（toolCallId 每次唯一，并行诊断下天然并发安全）
		expect(tool?.parentSpanId).toBe(gen?.spanId);
		expect(mcp?.parentSpanId).toBe(tool?.spanId);
		expect(mcp?.attributes["fiat.mcp.tool"]).toBe("query_knowledge_hub");
		expect(mcp?.attributes["fiat.mcp.transport"]).toBe("stdio");

		// 树闭合：每个 parentSpanId 都能追到根
		const ids = new Set(spans.map((s) => s.spanId));
		for (const s of spans) {
			expect(s.traceId).toBe(ctx.traceId);
			if (s.parentSpanId) expect(ids.has(s.parentSpanId)).toBe(true);
		}
	});
});
