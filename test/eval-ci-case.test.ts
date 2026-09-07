/**
 * P11-61 CI case 闭环：真实 tool_policies.yaml（不放宽）+ stub Lark/Fiat client，
 * cashback-reconcile-approval case 全链路出分 ≥ threshold。
 *
 * 链路（P5-20 范式）：buildSession（组合根，eval-recorder 尾部追加）→ faux 驱动
 * 「parse → reconcile(落工单) → 汇报」→ InMemoryEvalSink 断言三维评分与 pass。
 * 铁律：CI 里跑真实 policy —— 「为了让评测通过而放宽权限」是最容易的作弊路径。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEvalCases } from "../src/server/eval/cases.ts";
import { InMemoryEvalSink } from "../src/server/eval/sink.ts";
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { buildSession } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));
const CASES_PATH = fileURLToPath(new URL("../config/eval_cases.yaml", import.meta.url));

const CSV = "id,amount\n1,100\n2,200";
const SOR = "id,amount\n1,100\n2,250";

describe("P11-61 CI case 闭环（cashback-reconcile-approval）", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-eval-ci-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("case 配置可加载且通过校验", () => {
		const cases = loadEvalCases(CASES_PATH);
		expect(cases.map((c) => c.id)).toContain("cashback-reconcile-approval");
	});

	it("全链路：parse → reconcile 落工单 → 三维评分 ≥ threshold 且 pass", async () => {
		const evalCase = loadEvalCases(CASES_PATH).find((c) => c.id === "cashback-reconcile-approval");
		if (!evalCase) throw new Error("case not found");

		const sink = new InMemoryEvalSink();
		const sess = await buildSession(
			{ user: { id: "u1", role: evalCase.subject.role }, environment: evalCase.subject.environment },
			{ policiesPath: POLICY_PATH, evalSink: sink, evalCase },
		);

		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: sess.extensionFactories,
		});
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: sess.sessionId,
			tools: sess.hostTools,
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		const unsub = bridgeLifecycleEvents(host.agent, runner);

		// faux 模拟「正确轨迹」：先解析 → 再对账（apply 落工单）→ 汇报
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_cashback_parse", { content: CSV })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("fiat_cashback_reconcile", { csv: CSV, systemOfRecord: SOR, mode: "apply" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("对账完成，差异已生成审批工单，等待人工审批。"),
		]);

		await host.runTurn(evalCase.prompt);

		const runs = sink.entries() ?? [];
		expect(runs).toHaveLength(1);
		const rec = runs[0];
		if (!rec) throw new Error("no eval run recorded");

		// 事实：两步工具调用，均未 blocked
		expect(rec.steps.map((s) => s.tool)).toEqual(["fiat_cashback_parse", "fiat_cashback_reconcile"]);
		expect(rec.steps.every((s) => !s.blocked)).toBe(true);

		// 判定：三维齐全
		const dims = rec.scores.map((s) => s.dimension).sort();
		expect(dims).toEqual(["first_step", "outcome", "trajectory"]);

		// 结果层：ticket_created 且审批路径走了（reconcile 落单）→ 1
		const outcome = rec.scores.find((s) => s.dimension === "outcome");
		if (!outcome) throw new Error("outcome score missing");
		expect(outcome.value).toBe(1);

		// 轨迹层：milestone 全中（parse → reconcile 顺序正确）+ 无 blocked + 未超步
		const traj = rec.scores.find((s) => s.dimension === "trajectory");
		if (!traj) throw new Error("trajectory score missing");
		expect(traj.value).toBeCloseTo(1.0, 5);

		// 单步层：首工具 fiat_cashback_parse ∈ any_of → 1
		const first = rec.scores.find((s) => s.dimension === "first_step");
		if (!first) throw new Error("first_step score missing");
		expect(first.value).toBe(1);

		// 汇总：final = 1.0 ≥ threshold(0.75)，outcome=1 → pass
		expect(rec.threshold).toBe(0.75);
		expect(rec.passed).toBe(true);
		unsub();
	});

	it("越权轨迹：viewer 角色调 reconcile 被 gate ② block（真实 policy 不放宽），blocked 进 step 扣分", async () => {
		// viewer 不在 cashback_reconcile 的 allowed_roles（ops/oncall）→ 闸门①裁剪后模型看不到；
		// 但模型猜测工具名仍会被闸门②拦 —— 这正是 blocked 信号的价值（设计方案 §4.2）。
		const evalCase = loadEvalCases(CASES_PATH).find((c) => c.id === "cashback-reconcile-approval");
		if (!evalCase) throw new Error("case not found");
		const viewerCase = { ...evalCase, subject: { role: "viewer", environment: "dev" } };

		const sink = new InMemoryEvalSink();
		const sess = await buildSession(
			{ user: { id: "u2", role: "viewer" }, environment: "dev" },
			{ policiesPath: POLICY_PATH, evalSink: sink, evalCase: viewerCase },
		);
		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: sess.extensionFactories,
		});
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: sess.sessionId,
			tools: sess.hostTools,
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		const unsub = bridgeLifecycleEvents(host.agent, runner);

		// viewer 越权猜工具名：parse 可见，reconcile 被裁剪 → 猜测调用被闸门② block
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_cashback_parse", { content: CSV })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("fiat_cashback_reconcile", { csv: CSV, systemOfRecord: SOR })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("无法完成对账。"),
		]);

		await host.runTurn(evalCase.prompt);

		const rec = (sink.entries() ?? [])[0];
		if (!rec) throw new Error("no eval run recorded");
		const blocked = rec.steps.find((s) => s.tool === "fiat_cashback_reconcile");
		if (!blocked) throw new Error("reconcile step missing");
		expect(blocked.isError).toBe(true);
		expect(blocked?.blocked).toBe(true);

		// 轨迹层扣分：milestone reconcile 未中（被 block 不算完成）+ blocked 惩罚
		const traj = rec.scores.find((s) => s.dimension === "trajectory");
		if (!traj) throw new Error("trajectory score missing");
		expect(traj.value).toBeLessThan(1);
		expect(traj.detail?.blocked).toBe(1);

		// 结果层一票否决：viewer 场景没落工单 → outcome 0 → 不 pass（无论分数）
		const outcome = rec.scores.find((s) => s.dimension === "outcome");
		if (!outcome) throw new Error("outcome score missing");
		expect(outcome.value).toBe(0);
		expect(rec.passed).toBe(false);
		unsub();
	});
});
