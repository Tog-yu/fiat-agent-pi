/**
 * P2-10 session-factory 单测。
 * 覆盖：allowedToolPredicate（闸门①纯函数）+ buildSession 组合根确实按角色裁剪 mcp-rag 注册工具。
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { McpClientLike, RagStatus } from "../src/server/host/l1b/mcp-rag.ts";
import { loadPolicies } from "../src/server/policy/engine.ts";
import { allowedToolPredicate, buildSession } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

const RAG_INPUT_SCHEMA = {
	type: "object",
	properties: { query: { type: "string" } },
	required: ["query"],
};

function mockClient(): McpClientLike {
	return {
		connect: async () => {},
		listTools: async () => ({
			tools: [{ name: "query_knowledge_hub", description: "查询知识库", inputSchema: RAG_INPUT_SCHEMA }],
		}),
		callTool: async () => ({ content: [{ type: "text", text: "x" }] }),
		close: async () => {},
	};
}

describe("allowedToolPredicate —— 闸门①（会话级工具裁剪）", () => {
	const policies = loadPolicies(POLICY_PATH);

	it("viewer + dev 允许 mcp_rag_query_knowledge_hub", () => {
		const p = allowedToolPredicate(policies, { user: { id: "u", role: "viewer" }, environment: "dev" });
		expect(p("mcp_rag_query_knowledge_hub")).toBe(true);
	});

	it("admin + dev 拒绝 mcp_rag_query_knowledge_hub（角色不在白名单）", () => {
		const p = allowedToolPredicate(policies, { user: { id: "u", role: "admin" }, environment: "dev" });
		expect(p("mcp_rag_query_knowledge_hub")).toBe(false);
	});

	it("ops + dev 允许 cashback_reconcile（无前缀逻辑名）", () => {
		const p = allowedToolPredicate(policies, { user: { id: "u", role: "ops" }, environment: "dev" });
		expect(p("cashback_reconcile")).toBe(true);
	});

	it("oncall + prod 拒绝 cashback_reconcile（仅 dev/staging）", () => {
		const p = allowedToolPredicate(policies, { user: { id: "u", role: "oncall" }, environment: "prod" });
		expect(p("cashback_reconcile")).toBe(false);
	});
});

describe("buildSession 组合根 —— ①裁剪真正落地到扩展", () => {
	it("admin 会话：mcp-rag 注册 0 个工具（模型根本看不到）", async () => {
		const registered: string[] = [];
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const statusReady = new Promise<{ s: RagStatus; d: string }>((resolve) => {
			notify = (s, d) => resolve({ s, d });
		});

		const pi = {
			registerTool: (t: { name: string }) => registered.push(t.name),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		const { hostTools } = await buildSession(
			{ user: { id: "u", role: "admin" }, environment: "dev" },
			{ policiesPath: POLICY_PATH, ragClientFactory: () => mockClient(), ragOnStatus: (s, d) => notify?.(s, d) },
		);

		// P9-42：mcp-rag 走 L1b hostTools 通道，白名单裁剪在工厂内完成
		const status = await statusReady;
		expect(status.s).toBe("ready");
		expect(hostTools.map((t) => t.name)).toEqual([]);
		void pi;
	});

	it("viewer 会话：mcp-rag 正常注册 1 个工具（mcp_rag_query_knowledge_hub）", async () => {
		const registered: string[] = [];
		let notify: ((s: RagStatus, d: string) => void) | undefined;
		const statusReady = new Promise<{ s: RagStatus; d: string }>((resolve) => {
			notify = (s, d) => resolve({ s, d });
		});

		const pi = {
			registerTool: (t: { name: string }) => registered.push(t.name),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		const { hostTools } = await buildSession(
			{ user: { id: "u", role: "viewer" }, environment: "dev" },
			{ policiesPath: POLICY_PATH, ragClientFactory: () => mockClient(), ragOnStatus: (s, d) => notify?.(s, d) },
		);

		const status = await statusReady;
		expect(status.s).toBe("ready");
		// hostTools 还包含 viewer 可用的 fiat 只读工具；这里只断言 mcp_rag 注册数量
		expect(hostTools.filter((t) => t.name.startsWith("mcp_rag_")).map((t) => t.name)).toEqual([
			"mcp_rag_query_knowledge_hub",
		]);
		void pi;
	});
});
