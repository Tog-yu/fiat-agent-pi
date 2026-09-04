/**
 * P2-9 permission-gate 端到端测试。
 *
 * 复用 mcp-rag 扩展（注册 mcp_rag_* 工具，用 mock MCP client），叠加 permission-gate：
 *   - 角色不在白名单（admin 不在 rag_query 的 allowed_roles）→ tool_call 被 block，工具不执行
 *   - 角色在白名单（viewer）→ 放行，工具正常执行
 *
 * 验证"三道闸门第二道"在真实 Pi 链路里确实能拦住 / 放行动作。第三道权威判定（canExecute）由
 * LocalPolicyClient 进程内直连 tool_policies.yaml 提供，零网络。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPermissionGate } from "../src/server/host/l1a/permission-gate.ts";
import { createMcpRagTools, type McpClientLike, type RagStatus } from "../src/server/host/l1b/mcp-rag.ts";
import { hostToolsAsFactory } from "../src/server/host/tools.ts";
import { LocalPolicyClient } from "../src/server/policy/client.ts";

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

function toolResultTexts(session: { messages: unknown[] }): string[] {
	const messages = session.messages as Array<{
		role: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
	return messages
		.filter((m) => m.role === "toolResult")
		.flatMap((m) => m.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text);
}

describe("P2-9 permission-gate 端到端（faux + LocalPolicyClient）", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-pg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(role: string) {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const client = mockClient({
			callTool: async (req) => {
				calls.push(req);
				return { content: [{ type: "text", text: "RAG 答案：返现规则如下…" }] };
			},
		});

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const statusReady = new Promise<{ status: RagStatus; detail: string }>((resolve) => {
			notify = (s, d) => resolve({ status: s, detail: d });
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						createPermissionGate({
							policy: new LocalPolicyClient(POLICY_PATH),
							user: { id: "u1", role },
							environment: "dev",
							sessionId: "sess-test",
						}),
						hostToolsAsFactory(
							await createMcpRagTools({
								config: { transport: "stdio" },
								clientFactory: () => client,
								onStatus: (s, d) => notify?.(s, d),
							}),
						),
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});
		const status = await statusReady;
		return { runtimeHost, calls, status };
	}

	it("① 角色不在白名单（admin）→ tool_call 被 block，工具不执行", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, status } = await setup("admin");
		expect(status.status).toBe("ready");

		await runtimeHost.session.prompt("查一下返现规则");

		// 工具从未执行
		expect(calls).toEqual([]);

		// 会话里出现 isError 的 toolResult，文本含拒绝原因（回灌给模型）
		const texts = toolResultTexts(runtimeHost.session);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.join("\n")).toContain("角色 admin 无权");

		runtimeHost.dispose();
	});

	it("② 角色在白名单（viewer）→ 放行，工具正常执行", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, status } = await setup("viewer");
		expect(status.status).toBe("ready");

		await runtimeHost.session.prompt("查一下返现规则");

		expect(calls).toEqual([{ name: "query_knowledge_hub", arguments: { query: "返现规则" } }]);

		const texts = toolResultTexts(runtimeHost.session);
		expect(texts.join("\n")).toContain("RAG 答案：返现规则如下…");

		runtimeHost.dispose();
	});
});
