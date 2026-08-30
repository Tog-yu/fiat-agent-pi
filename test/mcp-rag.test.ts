import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRag, type McpClientLike, type RagStatus } from "../workspace/pi-extensions/mcp-rag/index.ts";

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

/** 等待扩展 bootstrap 完成（onStatus 首次回调） */
function waitForStatus(
	onStatus: (fn: (s: RagStatus, d: string) => void) => void,
): Promise<{ status: RagStatus; detail: string }> {
	return new Promise((resolve) => {
		onStatus((status, detail) => resolve({ status, detail }));
	});
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
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		// 先挂好 notify 再建会话：bootstrap 在会话创建阶段就会触发 onStatus
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
						createMcpRag({
							config: { transport: "stdio" },
							clientFactory: () => client,
							onStatus: (s, d) => notify?.(s, d),
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

		// 等 bootstrap 注册完成再驱动会话
		const status = await statusReady;
		expect(status.status).toBe("ready");

		await runtimeHost.session.prompt("查一下返现规则");

		// MCP callTool 收到的参数经 Type.Unsafe schema 校验后原样透传
		expect(calls).toEqual([{ name: "query_knowledge_hub", arguments: { query: "返现规则" } }]);

		// 工具结果回灌进会话
		const toolResultText = runtimeHost.session.messages
			.filter((m) => m.role === "toolResult")
			.flatMap((m) => m.content)
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(toolResultText).toContain("RAG 答案：返现规则如下…");

		runtimeHost.dispose();
		faux.unregister();
	});

	it("② P1-7 connect 失败 → 降级：不注册工具，状态 unavailable", async () => {
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const statuses: Array<{ status: RagStatus; detail: string }> = [];

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const statusReady = new Promise<void>((resolve) => {
			notify = () => resolve();
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				createMcpRag({
					config: { transport: "stdio" },
					clientFactory: () =>
						mockClient({
							connect: async () => {
								throw new Error("ECONNREFUSED");
							},
						}),
					onStatus: (s, d) => {
						statuses.push({ status: s, detail: d });
						notify?.(s, d);
					},
				}),
			],
		});
		await resourceLoader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		if (!model) throw new Error("test model unavailable");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});
		await statusReady;

		expect(statuses[0]?.status).toBe("unavailable");
		expect(statuses[0]?.detail).toContain("ECONNREFUSED");
		expect(
			session
				.getAllTools()
				.map((t) => t.name)
				.filter((n) => n.startsWith("mcp_rag_")),
		).toEqual([]);

		session.dispose();
	});

	it("③ P1-7 callTool isError 透传 + 超时抛可重试错误", async () => {
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const registered: CapturedTool[] = [];
		const pi = {
			registerTool: (t: CapturedTool) => registered.push(t),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		// isError 场景
		createMcpRag({
			config: { transport: "stdio" },
			clientFactory: () =>
				mockClient({
					callTool: async () => ({
						isError: true,
						content: [{ type: "text", text: "collection denied: prod_finance" }],
					}),
				}),
			onStatus: (s, d) => notify?.(s, d),
		})(pi);
		await waitForStatus((fn) => {
			notify = fn;
		});
		const deniedTool = registered.find((t) => t.name === "mcp_rag_query_knowledge_hub");
		expect(deniedTool).toBeDefined();
		if (!deniedTool) throw new Error("denied tool not registered");
		await expect(deniedTool.execute("c1", { query: "x" }, undefined, undefined, {})).rejects.toThrow(
			"collection denied: prod_finance",
		);

		// 超时场景（不 resolve 的 promise + 极短超时）
		registered.length = 0;
		notify = undefined;
		createMcpRag({
			config: { transport: "stdio", timeoutMs: 20 },
			clientFactory: () =>
				mockClient({
					callTool: () => new Promise(() => {}),
				}),
			onStatus: (s, d) => notify?.(s, d),
		})(pi);
		await waitForStatus((fn) => {
			notify = fn;
		});
		const timeoutTool = registered.find((t) => t.name === "mcp_rag_query_knowledge_hub");
		expect(timeoutTool).toBeDefined();
		if (!timeoutTool) throw new Error("timeout tool not registered");
		await expect(timeoutTool.execute("c2", { query: "x" }, undefined, undefined, {})).rejects.toThrow("超时");
	});
});
