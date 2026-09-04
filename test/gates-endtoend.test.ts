/**
 * P9-48 三道闸门重跑（阶段 9 验收）：真实 buildSession 产物 + 内嵌 PiHostLoop 全链路。
 *
 * 阶段 2 的闸门测试（permission-gate.test.ts）走的是遗留 createAgentSession 路径；
 * 本文件是「阶段 0–6 验收标准在新架构下重跑」的权限部分：
 *
 *   闸门① 会话级裁剪 —— buildSession 按角色 + 环境裁剪 hostTools（模型看不到）
 *   闸门② tool_call 拦截 —— L1a 内建 extension（permission-gate）经 ExtensionRunner
 *          → bridgeAgentHooks → Agent options.beforeToolCall，block 时回灌 isError 文本
 *   闸门③ 服务端 canExecute —— LocalPolicyClient（进程内直连，零网络）为唯一权威；
 *          ③ 的纯函数与 HTTP 面不受阶段 9 影响（policy-engine.test.ts / approval.test.ts 仍全绿）
 *
 * 场景（config/tool_policies.yaml 实测口径）：
 *   - viewer + dev：rag_query 在白名单 → fiat_cashback_reconcile 不在 → ① 生效
 *   - ops + dev：reconcile 可注册，collection 越权由 ② 的 rewrite 拦/覆写（canExecute 唯一权威）
 *   - ops 调 reconcile mode=apply → 触发审批工单（不重试），fiat_job_apply 再走 apply 复核（闸门③双保险）
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import type { FiatToolClient } from "../src/server/fiat-tools/client.ts";
import { bridgeAgentHooks, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { buildSession, type SessionSubject } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

function toolResultTexts(messages: readonly unknown[]): string[] {
	return messages
		.filter((m): m is { role: "toolResult"; content?: Array<{ type: string; text?: string }> } => {
			return (m as { role?: string }).role === "toolResult";
		})
		.flatMap((m) => m.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text);
}

describe("P9-48 三道闸门重跑（buildSession + 内嵌 PiHostLoop 全链路）", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-p9-gates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/** 组合根装配 → L1a 钩子桥接 → 内嵌循环。返回宿主 + 执行记录 + 审计链 */
	async function setup(subject: SessionSubject, ragCalls: Array<{ name: string; arguments: Record<string, unknown> }>) {
		const audit = new InMemoryAuditClient();
		const fiatExecuted: Array<{ tool: string; input: Record<string, unknown> }> = [];
		const fiat: FiatToolClient = {
			execute: async (tool, input) => {
				fiatExecuted.push({ tool, input });
				return { content: [{ type: "text", text: `fiat ${tool} dry-run 完成` }] };
			},
			applyTool: async (tool, input) => {
				fiatExecuted.push({ tool: `${tool}#apply`, input });
				return { content: [{ type: "text", text: `fiat ${tool} apply 完成` }] };
			},
		};

		const { extensionFactories, hostTools, sessionId } = await buildSession(subject, {
			policiesPath: POLICY_PATH,
			auditClient: audit,
			fiatToolClient: fiat,
			ragClientFactory: () => ({
				connect: async () => {},
				listTools: async () => ({
					tools: [
						{
							name: "query_knowledge_hub",
							description: "查询知识库",
							inputSchema: {
								type: "object",
								properties: { query: { type: "string", description: "检索词" } },
								required: ["query"],
							},
						},
					],
				}),
				callTool: async (req) => {
					ragCalls.push(req);
					return { content: [{ type: "text", text: "RAG 答案：返现规则如下…" }] };
				},
				close: async () => {},
			}),
		});

		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: extensionFactories,
		});

		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId,
			tools: hostTools,
			...bridgeAgentHooks(runner),
		});
		return { host, audit, fiatExecuted };
	}

	it("闸门①：viewer + dev 会话只有 rag 类工具，fiat_cashback_reconcile 根本不注册", async () => {
		const { host } = await setup({ user: { id: "u1", role: "viewer" }, environment: "dev" }, []);

		const names = host.agent.state.tools.map((t) => t.name);
		// viewer 可用：mcp_rag_query_knowledge_hub + fiat 只读工具（parse/validate）
		expect(names).toContain("mcp_rag_query_knowledge_hub");
		expect(names).toContain("fiat_cashback_parse");
		// 生产写 / ops 专属：闸门①裁剪，模型根本看不到
		expect(names).not.toContain("fiat_cashback_reconcile");
		expect(names).not.toContain("fiat_es_search_logs");
		expect(names).not.toContain("fiat_job_apply");
		expect(names).not.toContain("fiat_test_env");
	});

	it("闸门②：viewer 绕过①（prompt 注入猜测工具名）→ agent-loop 'not found' 兜底，工具不执行", async () => {
		const ragCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const { host } = await setup({ user: { id: "u2", role: "viewer" }, environment: "dev" }, ragCalls);

		// 模型被注入诱导去调一个①已裁剪的工具：agent-loop 查不到 → 立即 error tool result（isError:true）
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("fiat_cashback_reconcile", { csv: "a,b", systemOfRecord: "a,b", mode: "apply" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await host.runTurn("帮我写返现对账");

		// 工具没有执行（agent-loop 直接 not found，未进入任何闸门）
		const texts = toolResultTexts(host.messages).join("\n");
		expect(texts).toContain("not found");

		// agent-loop 的 not found 兜底不经过 afterToolCall 钩子 → 无审计记录（与 0.80.3 实测一致，
		// 见 §9 差异表「被 block 的工具不发 tool_result 事件」同源行为）
	});

	it("闸门②：ops 对返现对账的 collection 越权被 canExecute 拦截，audit 落 blocked，工具不执行", async () => {
		const ragCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const { host, audit, fiatExecuted } = await setup(
			{ user: { id: "u3", role: "oncall" }, environment: "dev" },
			ragCalls,
		);

		// oncall 对 cashback_reconcile 只允许 cashback_readonly；请求 cashback_all → 闸门② block
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("fiat_cashback_reconcile", {
						csv: "sku,qty\nA,1",
						systemOfRecord: "sku,qty\nA,2",
						collection: "cashback_all",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已收到拒绝原因。"),
		]);

		const reply = await host.runTurn("按全量范围对账返现");

		// 工具没有执行
		expect(fiatExecuted).toEqual([]);
		// block 原因回灌模型（isError 文本），模型能看到并停止重试
		expect(toolResultTexts(host.messages).join("\n")).toContain("collection 越权");
		expect(reply).toBe("已收到拒绝原因。");

		// 审计：permission-gate 对被 block 的调用自落 blocked 记录（block 短路后 audit-hook 不可见）
		const blocked = audit.entries().filter((e) => e.outcome === "blocked");
		expect(blocked.length).toBe(1);
		expect(blocked[0].tool).toBe("fiat_cashback_reconcile");
		expect(blocked[0].user.role).toBe("oncall");
		expect(blocked[0].environment).toBe("dev");
		expect(blocked[0].isError).toBe(true);
	});

	it("闸门②放行 + 审计：oncall 在白名单内对账 → collection 覆写后执行，audit-hook 落 allowed", async () => {
		const ragCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const { host, audit, fiatExecuted } = await setup(
			{ user: { id: "u4", role: "oncall" }, environment: "dev" },
			ragCalls,
		);

		// oncall 请求未指明 collection → canExecute 覆写为角色默认（cashback_readonly）后放行
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("fiat_cashback_reconcile", { csv: "sku,qty\nA,1", systemOfRecord: "sku,qty\nA,2" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已收到结果。"),
		]);

		await host.runTurn("对账一下返现");

		// 工具执行一次，且 collection 已被覆写为 oncall 的允许范围（钩子就地改参真实生效）
		expect(fiatExecuted).toEqual([
			{
				tool: "fiat_cashback_reconcile",
				input: { csv: "sku,qty\nA,1", systemOfRecord: "sku,qty\nA,2", collection: "cashback_readonly" },
			},
		]);

		// 审计：放行的调用由 audit-hook 在 tool_result 阶段记录
		const allowed = audit.entries().filter((e) => e.outcome === "allowed");
		expect(allowed.length).toBe(1);
		expect(allowed[0].tool).toBe("fiat_cashback_reconcile");
		expect(allowed[0].isError).toBe(false);
		// input 里应该看到覆写后的 collection（审计记的就是实际执行的参数）
		expect((allowed[0].input as { collection?: string }).collection).toBe("cashback_readonly");
	});

	it("闸门②+③ 全链路：ops reconcile mode=apply → 建审批工单（不执行写）→ job_apply 未审批被拒", async () => {
		const ragCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const { host, audit } = await setup({ user: { id: "u5", role: "ops" }, environment: "dev" }, ragCalls);

		// 第 1 轮：mode=apply → 不写，建工单（ticket + token 回给模型）
		// 第 2 轮：等不到审批（测试里没人批），模型直接收尾
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("fiat_cashback_reconcile", {
						csv: "sku,qty\nA,1",
						systemOfRecord: "sku,qty\nA,2",
						mode: "apply",
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const last = [...context.messages].reverse().find((m) => (m as { role?: string }).role === "toolResult") as
					| { content?: Array<{ type: string; text?: string }> }
					| undefined;
				const text = last?.content?.find((c) => c.type === "text")?.text ?? "";
				let ticketId = "";
				try {
					ticketId = String(JSON.parse(text).ticket_id ?? "");
				} catch {
					// 工单未建出 → 让断言在最后显式失败
				}
				return fauxAssistantMessage([fauxToolCall("fiat_job_apply", { ticket_id: ticketId, token: "guess" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("审批流程未完成，结束。"),
		]);

		await host.runTurn("把对账差异写入系统记录");

		// 工单文本里拿到 ticket_id + token + next 指引（isError:false，不重试）
		const texts = toolResultTexts(host.messages);
		const ticketText = texts.find((t) => t.includes("ticket_id"));
		expect(ticketText).toBeDefined();
		if (!ticketText) return;
		const ticket = JSON.parse(ticketText) as { ticket_id: string; token: string; status: string; next: string };
		expect(ticket.status).toBe("pending");
		expect(ticket.token).toBeTruthy();
		expect(ticket.next).toContain("fiat_job_apply");

		// fiat_job_apply：工单仍是 pending → 业务失败但 isError:false 回灌（防重试绕行）
		const applyText = texts.find((t) => t.includes("pending_approval"));
		expect(applyText).toBeDefined();
		if (!applyText) return;
		const apply = JSON.parse(applyText) as { ok: boolean; code: string };
		expect(apply.ok).toBe(false);
		expect(apply.code).toBe("pending_approval");

		// 审计链：ticket_created（建单）+ allowed（job_apply 业务失败也执行了闸门链）
		const outcomes = audit.entries().map((e) => e.outcome);
		expect(outcomes).toContain("ticket_created");
		expect(outcomes).toContain("allowed");
		// 全程零写操作：没有任何 applied
		expect(outcomes).not.toContain("applied");
	});
});
