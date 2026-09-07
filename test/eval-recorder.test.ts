/**
 * P11-60 集成测试：eval-recorder（三层评测采集）。
 *
 * 手动组合（同 audit-hook.test.ts 范式）：permission-gate（②）+ mcp-rag + eval-recorder，
 * 经 setupEmbeddedExtensions + PiHostLoop + bridgeLifecycleEvents 跑完整会话。覆盖：
 *   - 闸门② block 场景：被拦调用进 step 且 blocked=true（turn_end.toolResults 口径）
 *   - 正常场景：step 采集、outcome/trajectory/first_step 三维评分、pass 判定落 sink
 *   - buildSession 组合根：evalSink 缺省不注册（fail-safe）；传入时追加在尾部
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import { InMemoryEvalSink } from "../src/server/eval/sink.ts";
import type { EvalCase } from "../src/server/eval/types.ts";
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { createAuditHook } from "../src/server/host/l1a/audit-hook.ts";
import { createEvalRecorder } from "../src/server/host/l1a/eval-recorder.ts";
import { createPermissionGate } from "../src/server/host/l1a/permission-gate.ts";
import { createMcpRagTools, type McpClientLike, type RagStatus } from "../src/server/host/l1b/mcp-rag.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { LocalPolicyClient } from "../src/server/policy/client.ts";
import { buildSession } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

const RAG_INPUT_SCHEMA = {
	type: "object",
	properties: { query: { type: "string", description: "检索词" } },
	required: ["query"],
};

function mockClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		connect: async () => {},
		listTools: async () => ({
			tools: [{ name: "query_knowledge_hub", description: "查询知识库", inputSchema: RAG_INPUT_SCHEMA }],
		}),
		callTool: async () => ({ content: [{ type: "text", text: "RAG 答案：返现规则如下…" }] }),
		close: async () => {},
		...overrides,
	};
}

/** 最小评测 case：answered 终态 + 首步 any_of */
const ANSWER_CASE: EvalCase = {
	id: "rag-answered",
	prompt: "查一下返现规则",
	subject: { role: "viewer", environment: "dev" },
	expect: {
		outcome: { terminal: "answered" },
		firstStep: { any_of: ["mcp_rag_query_knowledge_hub", "fiat_alert_diagnosis"] },
		trajectory: { milestones: [{ tool: "mcp_rag_query_knowledge_hub" }], forbid: ["fiat_refund_apply"], maxSteps: 5 },
	},
	threshold: 0.75,
};

describe("P11-60 eval-recorder 集成", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(role: string, evalCase?: EvalCase) {
		const audit = new InMemoryAuditClient();
		const sink = new InMemoryEvalSink();
		const client = mockClient();

		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const statusReady = new Promise<{ status: RagStatus }>((resolve) => {
			notify = (s) => resolve({ status: s });
		});

		const tools = await createMcpRagTools({
			config: { transport: "stdio" },
			clientFactory: () => client,
			onStatus: (s, d) => notify?.(s, d),
		});

		const factories = [
			createPermissionGate({
				policy: new LocalPolicyClient(POLICY_PATH),
				user: { id: "u1", role },
				environment: "dev",
				sessionId: "sess-eval",
				audit,
			}),
			createAuditHook({ audit, user: { id: "u1", role }, environment: "dev", sessionId: "sess-eval" }),
			createEvalRecorder({
				sink,
				user: { id: "u1", role },
				environment: "dev",
				sessionId: "sess-eval",
				...(evalCase ? { evalCase } : {}),
				newRunId: () => "run-test-1",
			}),
		];

		const { runner } = await setupEmbeddedExtensions({ cwd: tempDir, agentDir: tempDir, factories });
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: "sess-eval",
			tools,
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		// P11-59：生命周期事件扇出（eval-recorder 的 turn_start/turn_end/agent_end 依赖）
		const unsub = bridgeLifecycleEvents(host.agent, runner);

		const status = await statusReady;
		return { host, sink, audit, status, unsub };
	}

	it("正常场景：工具执行 → step 采集 + 三维评分 + pass 落 sink", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("返现规则是……"),
		]);
		const { host, sink, status, unsub } = await setup("viewer", ANSWER_CASE);
		expect(status.status).toBe("ready");

		await host.runTurn("查一下返现规则");

		const runs = sink.entries() ?? [];
		expect(runs).toHaveLength(1);
		const rec = runs[0];
		if (!rec) throw new Error("no eval run recorded");
		// 事实：1 步工具调用
		expect(rec.steps).toHaveLength(1);
		expect(rec.steps[0]?.tool).toBe("mcp_rag_query_knowledge_hub");
		expect(rec.steps[0]?.blocked).toBe(false);
		// 判定：三维评分齐全，outcome=1，pass
		const dims = rec.scores.map((s) => s.dimension).sort();
		expect(dims).toEqual(["first_step", "outcome", "trajectory"]);
		expect(rec.scores.find((s) => s.dimension === "outcome")?.value).toBe(1);
		expect(rec.passed).toBe(true);
		unsub();
	});

	it("闸门② block 场景：admin 被拦调用进 step 且 blocked=true，轨迹分被扣", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("我无法查询。"),
		]);
		const caseForAdmin: EvalCase = {
			...ANSWER_CASE,
			expect: { outcome: { terminal: "answered" }, trajectory: { forbid: ["fiat_refund_apply"] } },
		};
		const { host, sink, audit, status, unsub } = await setup("admin", caseForAdmin);
		expect(status.status).toBe("ready");

		await host.runTurn("查一下返现规则");

		// 工具从未执行
		const runs = sink.entries() ?? [];
		expect(runs).toHaveLength(1);
		const rec = runs[0];
		if (!rec) throw new Error("no eval run recorded");
		// 被拦调用出现在 step 里（turn_end.toolResults 口径），blocked=true
		expect(rec.steps).toHaveLength(1);
		expect(rec.steps[0]?.tool).toBe("mcp_rag_query_knowledge_hub");
		expect(rec.steps[0]?.isError).toBe(true);
		expect(rec.steps[0]?.blocked).toBe(true);
		// 轨迹分被扣：1 - 0.1
		const traj = rec.scores.find((s) => s.dimension === "trajectory");
		expect(traj?.value).toBeCloseTo(0.9, 5);
		expect(traj?.detail?.blocked).toBe(1);
		// 审计侧照旧：permission-gate 自落 blocked 记录（评测不改审计语义）
		expect((audit.entries() ?? []).some((e) => e.outcome === "blocked")).toBe(true);
		unsub();
	});

	it("多轮轨迹：两次工具调用 stepIndex 单调递增", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "q1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "q2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("综合回答。"),
		]);
		const { host, sink, status, unsub } = await setup("viewer", ANSWER_CASE);
		expect(status.status).toBe("ready");

		await host.runTurn("查一下返现规则");

		const rec = (sink.entries() ?? [])[0];
		if (!rec) throw new Error("no eval run recorded");
		expect(rec.steps).toHaveLength(2);
		expect(rec.steps[0]?.stepIndex).toBe(0);
		expect(rec.steps[1]?.stepIndex).toBe(1);
		unsub();
	});
});

describe("P11-58 buildSession 组合根 —— evalSink 注入契约", () => {
	function mockClient(): McpClientLike {
		return {
			connect: async () => {},
			listTools: async () => ({ tools: [] }),
			callTool: async () => ({ content: [] }),
			close: async () => {},
		};
	}

	it("缺省（无 evalSink）不注册 eval-recorder —— factories 保持 3 个", async () => {
		const { extensionFactories } = await buildSession(
			{ user: { id: "u", role: "viewer" }, environment: "dev" },
			{ policiesPath: POLICY_PATH, ragClientFactory: () => mockClient() },
		);
		expect(extensionFactories).toHaveLength(3);
	});

	it("传入 evalSink → 追加在尾部（第 4 个，不插队）", async () => {
		const { extensionFactories } = await buildSession(
			{ user: { id: "u", role: "viewer" }, environment: "dev" },
			{ policiesPath: POLICY_PATH, ragClientFactory: () => mockClient(), evalSink: new InMemoryEvalSink() },
		);
		expect(extensionFactories).toHaveLength(4);
	});
});
