/**
 * 业务 CLI 测试（P6-26）。
 *
 * 整条命令链路（runCli）依赖全部注入：不依赖真实服务、不依赖模型、不读网络。
 * 验证「CLI 不含业务逻辑、与 L2 同源」—— 权限/审计/审批走的都是注入的同一批能力。
 */

import { describe, expect, it, vi } from "vitest";
import type { ApprovalTicketRecord } from "../src/server/approval/ticket.ts";
import type { AuditRecord } from "../src/server/audit/client.ts";
import { intFlag, parseArgs } from "../src/server/cli/args.ts";
import { allowedTools, HELP, renderTools } from "../src/server/cli/commands.ts";
import { type CliDeps, type DiagnosisInput, runCli } from "../src/server/cli/index.ts";

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
	const policies = new Map<
		string,
		{
			tool: string;
			risk_level: string;
			approval_required: boolean;
			allowed_roles: string[];
			allowed_environments: string[];
		}
	>();
	policies.set("es_search_logs", {
		tool: "es_search_logs",
		risk_level: "low",
		approval_required: false,
		allowed_roles: ["ops", "sre"],
		allowed_environments: ["dev", "prod"],
	});
	policies.set("cashback_submit", {
		tool: "cashback_submit",
		risk_level: "high",
		approval_required: true,
		allowed_roles: ["admin"],
		allowed_environments: ["prod"],
	});
	return {
		policies: policies as unknown as CliDeps["policies"],
		audit: { query: async () => [] },
		listTickets: async () => [],
		approveTicket: async (id) => ({ ticketId: id, status: "approved" }) as ApprovalTicketRecord,
		rejectTicket: async (id) => ({ ticketId: id, status: "rejected" }) as ApprovalTicketRecord,
		...overrides,
	};
}

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe("parseArgs", () => {
	it("首个裸词是 command，其余是 positional", () => {
		expect(parseArgs(["diagnose", "支付", "5xx"])).toEqual({
			command: "diagnose",
			positional: ["支付", "5xx"],
			flags: {},
		});
	});

	it("--k=v 与 --k v 都支持", () => {
		expect(parseArgs(["audit", "--tool", "es_search_logs", "--limit=5"])).toEqual({
			command: "audit",
			positional: [],
			flags: { tool: "es_search_logs", limit: "5" },
		});
	});

	it("未知短选项忽略，不整条失败", () => {
		expect(parseArgs(["audit", "-x", "--tool", "t"]).flags).toMatchObject({ tool: "t" });
	});

	it("intFlag 非法值回退默认", () => {
		expect(intFlag({ limit: "abc" }, "limit", 20)).toBe(20);
		expect(intFlag({}, "limit", 20)).toBe(20);
		expect(intFlag({ limit: "7" }, "limit", 20)).toBe(7);
	});
});

describe("runCli 离线命令", () => {
	it("help / 无命令 → 退出 0 并打印 HELP", async () => {
		const { io, out } = capture();
		expect(await runCli([], makeDeps(), io)).toBe(0);
		expect(out[0]).toBe(HELP);
		const { io: io2, out: out2 } = capture();
		expect(await runCli(["help"], makeDeps(), io2)).toBe(0);
		expect(out2[0]).toBe(HELP);
	});

	it("未知命令 → 退出 1，提示走 stderr", async () => {
		const { io, err } = capture();
		expect(await runCli(["frobnicate"], makeDeps(), io)).toBe(1);
		expect(err.join("\n")).toContain("未知命令");
	});

	it("audit → 渲染审计（含过滤 flag）", async () => {
		const audit = vi.fn(
			async () =>
				[
					{
						ts: "2026-08-31T00:00:00Z",
						sessionId: "s1",
						user: { id: "u", role: "ops" },
						environment: "dev",
						tool: "es_search_logs",
						input: {},
						isError: false,
						outcome: "allowed",
					},
				] as AuditRecord[],
		);
		const { io, out } = capture();
		const code = await runCli(
			["audit", "--tool", "es_search_logs", "--limit", "3"],
			makeDeps({ audit: { query: audit } }),
			io,
		);
		expect(code).toBe(0);
		expect(audit).toHaveBeenCalledWith({ tool: "es_search_logs", limit: 3 });
		expect(out[0]).toContain("es_search_logs");
	});

	it("tickets → 按 status 过滤", async () => {
		const listTickets = vi.fn(
			async () =>
				[
					{
						ticketId: "t1",
						status: "pending",
						subject: { userId: "u1", role: "ops", environment: "dev" },
						tool: "cashback_reconcile",
						payload: {},
						idempotencyKey: "k1",
						tokenHash: "h1",
						expiresAt: 0,
						createdAt: 0,
					},
					{
						ticketId: "t2",
						status: "approved",
						subject: { userId: "u2", role: "ops", environment: "dev" },
						tool: "logistics_change_plan",
						payload: {},
						idempotencyKey: "k2",
						tokenHash: "h2",
						expiresAt: 0,
						createdAt: 0,
					},
				] as ApprovalTicketRecord[],
		);
		const { io, out } = capture();
		const code = await runCli(["tickets", "--status", "approved"], makeDeps({ listTickets }), io);
		expect(code).toBe(0);
		expect(out[0]).toContain("t2");
		expect(out[0]).not.toContain("t1");
	});

	it("approve / reject → 调用 service", async () => {
		const approveTicket = vi.fn(async (id: string) => ({ ticketId: id, status: "approved" }) as ApprovalTicketRecord);
		const { io, out } = capture();
		expect(await runCli(["approve", "t9"], makeDeps({ approveTicket }), io)).toBe(0);
		expect(approveTicket).toHaveBeenCalledWith("t9");
		expect(out[0]).toContain("已通过：t9");

		const rejectTicket = vi.fn(async (id: string) => ({ ticketId: id, status: "rejected" }) as ApprovalTicketRecord);
		const { io: io2, out: out2 } = capture();
		expect(await runCli(["reject", "t9", "--reason", "风险"], makeDeps({ rejectTicket }), io2)).toBe(0);
		expect(rejectTicket).toHaveBeenCalledWith("t9", "风险");
		expect(out2[0]).toContain("已驳回：t9");
	});

	it("tools → 闸门①预览（角色 + 环境谓词）", async () => {
		const { io, out } = capture();
		// ops@dev 只能看到 es_search_logs（cashback_submit 限 admin/prod）
		expect(await runCli(["tools", "--role", "ops", "--env", "dev"], makeDeps(), io)).toBe(0);
		expect(out[0]).toContain("es_search_logs");
		expect(out[0]).not.toContain("cashback_submit");

		const { io: io2, out: out2 } = capture();
		// admin@prod 能看到 cashback_submit
		expect(await runCli(["tools", "--role", "admin", "--env", "prod"], makeDeps(), io2)).toBe(0);
		expect(out2[0]).toContain("cashback_submit");
	});

	it("allowedTools 纯函数：无工具时返回空并提示", () => {
		const rows = allowedTools(makeDeps().policies, "ops", "dev");
		expect(rows.map((r) => r.tool)).toContain("es_search_logs");
		expect(renderTools([])).toBe("（该角色在此环境下无任何可用工具）");
	});
});

describe("runCli diagnose", () => {
	it("未注入 diagnose → 明确提示「未配置模型」，退出 1（不静默失败）", async () => {
		const { io, err } = capture();
		expect(await runCli(["diagnose", "支付网关 5xx"], makeDeps({ diagnose: undefined }), io)).toBe(1);
		expect(err.join("\n")).toContain("未配置模型");
	});

	it("标题可多词（不加引号）", async () => {
		const diagnose = vi.fn(async (_i: DiagnosisInput) => "report");
		const { io } = capture();
		await runCli(
			["diagnose", "支付网关", "5xx", "突增", "--service", "pay", "--window", "30m"],
			makeDeps({ diagnose }),
			io,
		);
		expect(diagnose).toHaveBeenCalledWith({
			title: "支付网关 5xx 突增",
			service: "pay",
			window: "30m",
			detail: undefined,
		});
	});

	it("注入 diagnose → 跑通并退出 0", async () => {
		const diagnose = vi.fn(async () => "# 报告\n结论");
		const { io, out } = capture();
		expect(await runCli(["diagnose", "x"], makeDeps({ diagnose }), io)).toBe(0);
		expect(out[0]).toContain("结论");
	});

	it("diagnose 抛错 → 退出 1，错误信息走 stderr", async () => {
		const diagnose = vi.fn(async () => {
			throw new Error("model down");
		});
		const { io, err } = capture();
		expect(await runCli(["diagnose", "x"], makeDeps({ diagnose }), io)).toBe(1);
		expect(err.join("\n")).toContain("model down");
	});
});
