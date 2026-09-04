/**
 * P6-25 并行告警诊断测试。
 *
 * 分三层：
 *   1. plan（纯逻辑）：视角拆分、只读收敛、角色过滤、prompt 渲染
 *   2. fanout（纯逻辑，注入 runOne）：并发上限、单任务超时、部分失败、聚合
 *   3. alert-fanout 扩展：工具注册（闸门①）+ 执行产出报告
 *
 * fanout 与扩展都不起真实 AgentSession —— runOne / runAgent 注入假实现，
 * 因此并行、超时、失败这些关键路径可以确定性断言。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FanoutSummary, runFanout } from "../src/server/diagnosis/fanout.ts";
import {
	DEFAULT_ANGLES,
	type DiagnosisAngle,
	type DiagnosisTask,
	diagnosisPlan,
	READONLY_DIAGNOSIS_TOOLS,
	renderReport,
} from "../src/server/diagnosis/plan.ts";
import { createDiagnosisRunner } from "../src/server/diagnosis/sessionRunner.ts";
import { ALERT_DIAGNOSIS_TOOL, type AlertFanoutDeps, createAlertFanout } from "../src/server/host/l1b/alert-fanout.ts";
import { buildSession } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

interface CapturedTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

const ALERT = { title: "支付网关 5xx 突增", service: "payment-gateway", window: "最近 30 分钟" };

// ------------------------------------------------------------------ 1. plan

describe("P6-25 纯逻辑：诊断视角拆分", () => {
	it("默认拆出 DEFAULT_ANGLES 全部视角", () => {
		expect(diagnosisPlan(ALERT).map((t) => t.name)).toEqual(DEFAULT_ANGLES.map((a) => a.name));
	});

	it("工具收敛到只读白名单：绝不含写工具", () => {
		const allTools = diagnosisPlan(ALERT).flatMap((t) => t.tools);
		expect(allTools.length).toBeGreaterThan(0);
		for (const tool of allTools) expect(READONLY_DIAGNOSIS_TOOLS).toContain(tool);
		// 诊断只取证不改数据，这些一律不可出现
		expect(allTools).not.toContain("cashback_submit");
		expect(allTools).not.toContain("cashback_reconcile");
		expect(allTools).not.toContain("job_apply");
		expect(allTools).not.toContain("test_env");
	});

	it("角色谓词过滤：无工具可用的视角丢弃，部分可用的收敛后保留", () => {
		// 只允许 rag_query：
		//   - logs / dependency 只有 es_search_logs + db_query → 全被拒 → 整体丢弃
		//   - config_change 是 db_query + rag_query → 部分可用，收敛成 ["rag_query"] 后保留
		//   - history 只有 rag_query → 原样保留
		const tasks = diagnosisPlan(ALERT, { allowedTools: (t) => t === "rag_query" });
		expect(tasks.map((t) => t.name)).toEqual(["config_change", "history"]);
		expect(tasks.find((t) => t.name === "config_change")?.tools).toEqual(["rag_query"]);
	});

	it("一个工具都不剩 → 空计划", () => {
		expect(diagnosisPlan(ALERT, { allowedTools: () => false })).toEqual([]);
	});

	it("prompt 渲染注入告警与上下文，不残留占位符", () => {
		const logs = diagnosisPlan(ALERT)[0];
		expect(logs?.prompt).toContain("支付网关 5xx 突增");
		expect(logs?.prompt).toContain("payment-gateway");
		expect(logs?.prompt).toContain("最近 30 分钟");
		expect(logs?.prompt).not.toContain("{alert}");
		expect(logs?.prompt).not.toContain("{context}");
	});

	it("自定义视角可注入，替换默认拆分", () => {
		const angles: DiagnosisAngle[] = [
			{ name: "only", description: "d", tools: ["db_query"], promptTemplate: "查 {alert}" },
		];
		const tasks = diagnosisPlan(ALERT, { angles });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.tools).toEqual(["db_query"]);
	});
});

describe("P6-25 纯逻辑：报告聚合", () => {
	it("存在失败/超时时显式告警，不把「没查到」包装成「没问题」", () => {
		const report = renderReport(
			ALERT,
			[
				{ name: "logs", description: "错误日志", status: "failed", error: "ES 不可用" },
				{ name: "history", description: "历史经验", status: "ok", output: "曾出现过类似故障" },
			],
			{ total: 2, ok: 1, failed: 1, timeout: 0 },
		);
		expect(report).toContain("失败 1");
		expect(report).toContain("ES 不可用");
		expect(report).toContain("曾出现过类似故障");
		expect(report).toContain("请勿据此判定根因");
	});

	it("全部成功时不出现告警提示", () => {
		const report = renderReport(ALERT, [{ name: "logs", description: "错误日志", status: "ok", output: "无异常" }], {
			total: 1,
			ok: 1,
			failed: 0,
			timeout: 0,
		});
		expect(report).not.toContain("请勿据此判定根因");
	});
});

// ---------------------------------------------------------------- 2. fanout

const mkTasks = (n: number): DiagnosisTask[] =>
	Array.from({ length: n }, (_unused, i) => ({
		name: `t${i}`,
		description: `d${i}`,
		tools: [],
		prompt: `p${i}`,
	}));

describe("P6-25 纯逻辑：fanout 并发与容错", () => {
	it("全部成功：输出顺序与输入一致", async () => {
		const { results, summary } = await runFanout({
			tasks: mkTasks(5),
			runOne: async (t) => `out:${t.name}`,
		});
		expect(results.map((r) => r.name)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
		expect(results[2]?.output).toBe("out:t2");
		expect(summary).toEqual({ total: 5, ok: 5, failed: 0, timeout: 0 });
	});

	it("并发上限生效：同时在跑的任务数不超过 concurrency", async () => {
		let inFlight = 0;
		let peak = 0;
		const { summary } = await runFanout({
			tasks: mkTasks(10),
			concurrency: 3,
			runOne: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight -= 1;
				return "ok";
			},
		});
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1); // 确实并发了，不是串行退化
		expect(summary.ok).toBe(10);
	});

	it("单个视角失败：其余照常完成，整体不 reject", async () => {
		const { results, summary } = await runFanout({
			tasks: mkTasks(3),
			runOne: async (t) => {
				if (t.name === "t1") throw new Error("boom");
				return "ok";
			},
		});
		expect(results[1]?.status).toBe("failed");
		expect(results[1]?.error).toBe("boom");
		expect(results[0]?.status).toBe("ok");
		expect(results[2]?.status).toBe("ok");
		expect(summary).toEqual({ total: 3, ok: 2, failed: 1, timeout: 0 });
	});

	it("单个视角超时：标记 timeout，不拖垮整体", async () => {
		const { results, summary } = await runFanout({
			tasks: mkTasks(2),
			timeoutMs: 20,
			runOne: async (t) => {
				if (t.name === "t0") await new Promise(() => {}); // 永不 resolve
				return "ok";
			},
		});
		expect(results[0]?.status).toBe("timeout");
		expect(results[1]?.status).toBe("ok");
		expect(summary).toEqual({ total: 2, ok: 1, failed: 0, timeout: 1 });
	});

	it("onTaskDone 对每个视角都回调（含失败）", async () => {
		const seen: string[] = [];
		await runFanout({
			tasks: mkTasks(3),
			runOne: async (t) => {
				if (t.name === "t2") throw new Error("x");
				return "ok";
			},
			onTaskDone: (o) => seen.push(`${o.name}:${o.status}`),
		});
		expect(seen.sort()).toEqual(["t0:ok", "t1:ok", "t2:failed"]);
	});

	it("空任务列表不炸", async () => {
		const { results, summary } = await runFanout({ tasks: [], runOne: async () => "x" });
		expect(results).toEqual([]);
		expect(summary).toEqual({ total: 0, ok: 0, failed: 0, timeout: 0 });
	});
});

// -------------------------------------------------------------- 3. 扩展层

describe("P6-25 扩展：fiat_alert_diagnosis", () => {
	function fakePi() {
		const registered: CapturedTool[] = [];
		const pi = {
			registerTool: (t: CapturedTool) => registered.push(t),
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		return { pi, registered };
	}

	async function execFirst(registered: CapturedTool[], params: Record<string, unknown>) {
		const tool = registered[0];
		if (!tool) throw new Error("fiat_alert_diagnosis was not registered");
		return (await tool.execute("c1", params, undefined, undefined, {})) as {
			content: Array<{ type: string; text: string }>;
			details: { skipped?: string; summary?: FanoutSummary };
		};
	}

	it("注册名剥 fiat_ 前缀后命中既有 alert_diagnosis 策略（不新增策略条目）", () => {
		expect(ALERT_DIAGNOSIS_TOOL).toBe("fiat_alert_diagnosis");
	});

	it("闸门①允许时注册工具", () => {
		const { pi, registered } = fakePi();
		for (const t of createAlertFanout({ runAgent: async () => "x", allowedTools: () => true }))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);
		expect(registered.map((t) => t.name)).toEqual([ALERT_DIAGNOSIS_TOOL]);
	});

	it("闸门①拒绝 → 不注册，模型根本看不到", () => {
		const { pi, registered } = fakePi();
		const deps: AlertFanoutDeps = {
			runAgent: async () => "x",
			allowedTools: (n) => n !== ALERT_DIAGNOSIS_TOOL,
		};
		for (const t of createAlertFanout(deps))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);
		expect(registered).toEqual([]);
	});

	it("执行：并发跑完各视角并聚合成报告", async () => {
		const { pi, registered } = fakePi();
		for (const t of createAlertFanout({ runAgent: async (t) => `${t.name} 结论`, allowedTools: () => true }))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);

		const result = await execFirst(registered, { title: "支付网关 5xx 突增", service: "payment-gateway" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("支付网关 5xx 突增");
		expect(text).toContain("payment-gateway");
		expect(text).toContain("logs 结论");
		expect(text).toContain("history 结论");
		expect(result.details.summary).toEqual({ total: 4, ok: 4, failed: 0, timeout: 0 });
	});

	it("某视角失败照常出报告，并在正文标注失败", async () => {
		const { pi, registered } = fakePi();
		const deps: AlertFanoutDeps = {
			runAgent: async (t) => {
				if (t.name === "logs") throw new Error("ES 不可用");
				return "ok";
			},
			allowedTools: () => true,
		};
		for (const t of createAlertFanout(deps))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);

		const result = await execFirst(registered, { title: "支付告警" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("ES 不可用");
		expect(text).toContain("请勿据此判定根因");
		expect(result.details.summary).toEqual({ total: 4, ok: 3, failed: 1, timeout: 0 });
	});

	it("无可用只读工具 → skipped，一个 agent 都不派", async () => {
		const { pi, registered } = fakePi();
		let called = 0;
		// 只允许工具自身 → 各视角的取证工具全被过滤 → 空计划
		const deps: AlertFanoutDeps = {
			runAgent: async () => {
				called += 1;
				return "x";
			},
			allowedTools: (n) => n === ALERT_DIAGNOSIS_TOOL,
		};
		for (const t of createAlertFanout(deps))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);

		const result = await execFirst(registered, { title: "支付告警" });
		expect(result.details.skipped).toBe("no-available-tools");
		expect(called).toBe(0);
	});

	it("maxTasks 截断视角数量，防止 token 预算被打爆", async () => {
		const { pi, registered } = fakePi();
		const deps: AlertFanoutDeps = {
			runAgent: async () => "x",
			allowedTools: () => true,
			maxTasks: 2,
		};
		for (const t of createAlertFanout(deps))
			(pi.registerTool as (t: CapturedTool) => void)(t as unknown as CapturedTool);

		const result = await execFirst(registered, { title: "支付告警" });
		expect(result.details.summary?.total).toBe(2);
	});
});

// ---------------------------------------------------- 4. 真实 runner 端到端

describe("P6-25 端到端：createDiagnosisRunner 起真实子会话", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `diagnosis-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("子会话跑完单个视角并取回结论文本（走 buildSession，继承三道闸门）", async () => {
		const runner = createDiagnosisRunner({
			// 子会话由同一个 buildSession 构造 → 共享 subject 与三道闸门
			buildChildSession: async () =>
				await buildSession({ user: { id: "u1", role: "ops" }, environment: "dev" }, { policiesPath: POLICY_PATH }),
			model: faux.getModel(),
			authStorage: AuthStorage.inMemory(),
			runtimeApiKey: "faux-key",
			cwd: tempDir,
			agentDir: tempDir,
		});

		faux.setResponses([fauxAssistantMessage("支付网关 5xx 根因是下游超时")]);

		const out = await runner({
			name: "logs",
			description: "错误日志",
			tools: ["es_search_logs"],
			prompt: "排查支付网关 5xx",
		});

		expect(out).toContain("支付网关 5xx 根因是下游超时");
	});
});
