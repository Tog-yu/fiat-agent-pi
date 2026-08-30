/**
 * P2-11 / P2-12 集成测试：audit-hook（三道闸门之后落审计）+ 三道闸门联动。
 *
 * 手动组合 permission-gate（②）+ mcp-rag + audit-hook（不走 buildSession 的①，否则 admin 的
 * 工具会被①直接裁掉、测不到②的 block）。覆盖：
 *   - viewer（在白名单）：工具放行执行，审计记 allowed
 *   - admin（不在白名单）：gate ② block，审计记 isError + 拒绝原因
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
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import { LocalPolicyClient } from "../src/server/policy/client.ts";
import { createAuditHook } from "../workspace/pi-extensions/audit-hook/index.ts";
import { createMcpRag, type McpClientLike, type RagStatus } from "../workspace/pi-extensions/mcp-rag/index.ts";
import { createPermissionGate } from "../workspace/pi-extensions/permission-gate/index.ts";

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

describe("P2-11/P2-12 audit-hook + 三道闸门联动", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(role: string) {
		const audit = new InMemoryAuditClient();
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
							audit,
						}),
						createMcpRag({
							config: { transport: "stdio" },
							clientFactory: () => client,
							onStatus: (s, d) => notify?.(s, d),
						}),
						createAuditHook({
							audit,
							user: { id: "u1", role },
							environment: "dev",
							sessionId: "sess-test",
						}),
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
		return { runtimeHost, calls, audit, status };
	}

	it("① viewer 在白名单：放行执行，审计记 allowed", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, audit, status } = await setup("viewer");
		expect(status.status).toBe("ready");

		await runtimeHost.session.prompt("查一下返现规则");

		expect(calls).toHaveLength(1);
		const entries = audit.entries() ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.tool).toBe("mcp_rag_query_knowledge_hub");
		expect(entries[0]?.outcome).toBe("allowed");
		expect(entries[0]?.isError).toBe(false);

		runtimeHost.dispose();
	});

	it("② admin 不在白名单：gate ② block，审计记 isError + 拒绝原因", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_rag_query_knowledge_hub", { query: "返现规则" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, audit, status } = await setup("admin");
		expect(status.status).toBe("ready");

		await runtimeHost.session.prompt("查一下返现规则");

		// 工具从未执行
		expect(calls).toEqual([]);
		const entries = audit.entries() ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.tool).toBe("mcp_rag_query_knowledge_hub");
		expect(entries[0]?.isError).toBe(true);
		expect(entries[0]?.detail).toContain("角色 admin 无权");

		runtimeHost.dispose();
	});
});
