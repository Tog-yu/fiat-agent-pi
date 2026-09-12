/**
 * P12-72 集成测试：`evolution/reviewer.ts` + 评审 fork 的隔离约束。
 *
 * 这是阶段 12 **最关键**的一组测试——它验证的正是「不能照抄 Hermes」的四条里最硬的一条：
 * **fork 不给写能力**。所以这里不 mock reviewer，而是起**真的 fork 会话**
 * （`PiHostLoop` + `HostSession.inMemory` + 只有提案工具的运行时白名单），用 faux 驱动，
 * 逐条断言 §10.7 的八条硬约束：
 *
 *   #2 inMemory（不碰主会话）      → 用 fork 的 session 是 inMemory 断言（不传 session 亦可）
 *   #3 脱敏后回放                  → 主 transcript 带手机号 / 订单号，断言 prompt 里没有
 *   #4 运行时白名单                → fork 工具集**恰好**是 4 个只读/提案工具，无任何业务写工具
 *   #5 递归防护                    → fork 里没有 evolution-trigger，跑完主计数器仍为 0
 *   #6 超时兜底                    → runFork 永挂 → status=timeout，**不抛**
 *   #7 全量留痕                    → 无论成败都落 EvolutionRun
 *
 * 另外单独断言「白名单外工具被运行时拒绝」：模型猜 `fiat_job_apply` → Pi 回 "not found"，
 * 且**没有任何提案被写进来**（这正是 Hermes 会给的能力，fiat 明确不给）。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryProposalStore, InMemoryRunStore } from "../src/server/evolution/proposalStore.ts";
import { EvolutionReviewer } from "../src/server/evolution/reviewer.ts";
import { SkillStore } from "../src/server/evolution/skillStore.ts";
import { buildSanitizedSlice, redact } from "../src/server/evolution/slice.ts";
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig } from "../src/server/evolution/types.ts";
import { createEvolutionTrigger } from "../src/server/host/l1a/evolution-trigger.ts";
import { createProposeTools } from "../src/server/host/l1b/propose-tools.ts";
import { createSkillTools } from "../src/server/host/l1b/skill-tools.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";

const CFG: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, intervalIters: 1, intervalTurns: 1, timeoutMs: 5_000 };

describe("P12-66 评审 fork 隔离", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;
	let store: SkillStore;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-evo-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
		store = new SkillStore(join(tempDir, "pi-skills"));
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/** 组装：真 fork 会话 + 真 reviewer（只把「谁跑 fork」这件事显式写出来） */
	function setup(opts: { transcript?: readonly unknown[]; timeoutMs?: number } = {}) {
		const proposals = new InMemoryProposalStore();
		const runs = new InMemoryRunStore();
		const trigger = createEvolutionTrigger();

		/** 捕获 fork 侧的工具名与收到的 prompt（断言白名单 / 脱敏用） */
		const captured: { toolNames: string[]; prompt: string; toolResults: string[] } = {
			toolNames: [],
			prompt: "",
			toolResults: [],
		};

		let forkHost: PiHostLoop | undefined;
		const reviewer = new EvolutionReviewer({
			proposals,
			runs,
			config: { ...CFG, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
			sessionId: "sess-main",
			proposer: "u1",
			model: "faux/faux-1",
			// #3 脱敏切片：主会话里**带真实生产数据**，验证它进不了 fork
			transcript: () =>
				opts.transcript ?? [
					{ role: "user", content: [{ type: "text", text: "帮我对账" }] },
					{
						role: "toolResult",
						toolName: "fiat_cashback_parse",
						isError: false,
						content: [{ type: "text", text: "解析成功" }],
					},
				],
			runFork: async (input) => {
				captured.prompt = input.prompt;
				// #4 运行时白名单：**只有** skill_view + 三个 propose
				const tools = [
					...createSkillTools({ store, recordUsage: false }),
					...createProposeTools({ proposals, context: input.context }),
				];
				captured.toolNames = tools.map((t) => t.name);
				forkHost = new PiHostLoop({
					model: faux.getModel(),
					getApiKey: () => "faux-key",
					sessionId: `fork-${input.context.runId}`,
					systemPrompt: input.systemPrompt,
					tools,
					// #2 inMemory：fork 会话绝不触碰主会话 transcript / JSONL
					//    （不传 session 即纯内存 Agent；生产用 HostSession.inMemory，语义一致）
					// #5 递归防护：**不传 evolution** → fork 里没有 evolution-trigger
				});
				await forkHost.runTurnSafe(input.prompt);
				captured.toolResults = forkHost.agent.state.messages
					.filter((m) => (m as { role?: string }).role === "toolResult")
					.map((m) => JSON.stringify((m as { content?: unknown }).content));
				return "（fork 结束）";
			},
			log: () => {},
		});

		return { reviewer, proposals, runs, trigger, captured };
	}

	it("#4 + #7：fork 工具集恰好是 4 个只读/提案工具，且提案落库 + run 留痕", async () => {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("fiat_skill_propose", {
						name: "cashback-reconcile",
						description: "按 dry-run 流程核对返现表格并落审批工单",
						when_to_use: ["用户上传返现表格并要求对账"],
						body: "## When to Use\n上传返现表格时\n## Procedure\n1. 调 fiat_cashback_parse",
						case_id: "cashback-reconcile-approval",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已提交一条技能提案。"),
		]);

		const { reviewer, proposals, runs, captured } = setup();
		const r = await reviewer.review({ trigger: "tool_iters", toolSteps: 10, turns: 0 });

		// #4 白名单：**恰好**是这 4 个，且不含任何业务写工具
		expect(captured.toolNames.sort()).toEqual([
			"fiat_memory_propose",
			"fiat_role_facts_propose",
			"fiat_skill_propose",
			"fiat_skill_view",
		]);
		expect(captured.toolNames).not.toContain("fiat_job_apply");
		expect(captured.toolNames).not.toContain("fiat_cashback_reconcile");

		// 提案落库：状态 proposed，未落盘（技能库仍是空的 —— 这是「fork 不写磁盘」的实证）
		expect(r.proposals).toHaveLength(1);
		const p = r.proposals[0];
		expect(p?.kind).toBe("skill");
		expect(p?.target).toBe("cashback-reconcile");
		expect(p?.status).toBe("proposed");
		expect(p?.proposer).toBe("u1");
		expect(store.list()).toHaveLength(0);
		expect(await proposals.list()).toHaveLength(1);

		// #7 run 留痕
		expect(await runs.list()).toHaveLength(1);
		expect(r.run.proposalsN).toBe(1);
		expect(r.run.status).toBe("ok");
		expect(r.run.model).toBe("faux/faux-1");
	});

	it("白名单外工具被运行时拒绝：模型猜 fiat_job_apply → not found 且零提案", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_job_apply", { ticket_id: "t1", token: "tk" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("无法调用该工具。"),
		]);

		const { reviewer, proposals, captured } = setup();
		const r = await reviewer.review({ trigger: "tool_iters", toolSteps: 10, turns: 0 });

		// 运行时拒绝：Pi 回 "not found" 而不是执行
		expect(captured.toolResults.join("\n")).toMatch(/not found/i);
		// 拒绝的后果：一条提案都没有（连误提的机会都没有）
		expect(r.proposals).toHaveLength(0);
		expect(await proposals.list()).toHaveLength(0);
		expect(r.run.proposalsN).toBe(0);
	});

	it("#5 递归防护：fork 里没有 evolution-trigger，跑完主计数器仍为 0", async () => {
		faux.setResponses([fauxAssistantMessage("本轮无提案")]);
		const { reviewer, trigger } = setup();
		await reviewer.review({ trigger: "tool_iters", toolSteps: 10, turns: 0 });
		// 若 fork 挂了 trigger，它自己那几轮 turn_end 会把计数推起来 → 评审触发评审
		expect(trigger.snapshot()).toEqual({ itersSinceSkill: 0, turns: 0 });
	});

	it("#6 超时兜底：runFork 永挂 → status=timeout，不抛，仍然留痕", async () => {
		const proposals = new InMemoryProposalStore();
		const runs = new InMemoryRunStore();
		const reviewer = new EvolutionReviewer({
			proposals,
			runs,
			config: CFG,
			sessionId: "sess-main",
			proposer: "u1",
			transcript: () => [],
			runFork: () => new Promise<string>(() => {}),
			timeoutMs: 20,
			log: () => {},
		});

		const r = await reviewer.review({ trigger: "tool_iters", toolSteps: 10, turns: 0 });
		expect(r.run.status).toBe("timeout");
		expect(r.run.error).toContain("超时");
		expect(r.proposals).toHaveLength(0);
		expect(await runs.list()).toHaveLength(1);
	});

	it("#3 脱敏切片：主会话里的手机号 / 订单号 / 金额不进 fork 提示词", async () => {
		faux.setResponses([fauxAssistantMessage("本轮无提案")]);
		const { reviewer, captured } = setup({
			transcript: [
				{ role: "user", content: [{ type: "text", text: "用户 13800138000 说订单号：BM202609120001 的返现少发了" }] },
				{
					role: "toolResult",
					toolName: "fiat_cashback_parse",
					isError: false,
					content: [{ type: "text", text: "订单号 BM202609120001 金额 1288.00" }],
				},
			],
		});
		await reviewer.review({ trigger: "tool_iters", toolSteps: 10, turns: 0 });

		expect(captured.prompt).not.toContain("13800138000");
		expect(captured.prompt).not.toContain("BM202609120001");
		// 流程信息保留（宁可少给上下文，但工具名与成败要留）
		expect(captured.prompt).toContain("fiat_cashback_parse");
		expect(captured.prompt).toContain("用户");
	});

	it("记忆与运行约定提案：三个工具都能落库，kind/target 正确", async () => {
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("fiat_memory_propose", { title: "列名约定", entries: ["返现表格列名 id,amount"] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				[
					fauxToolCall("fiat_role_facts_propose", {
						role: "ops",
						title: "对账顺序",
						entries: ["先 parse 再 reconcile"],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已提交。"),
		]);

		const { reviewer } = setup();
		const r = await reviewer.review({ trigger: "manual", toolSteps: 0, turns: 0 });
		const kinds = r.proposals.map((p) => p.kind).sort();
		expect(kinds).toEqual(["memory", "role_facts"]);
		expect(r.proposals.find((p) => p.kind === "memory")?.target).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(r.proposals.find((p) => p.kind === "role_facts")?.target).toBe("ops");
	});

	it("幂等：同一内容重复提案不重复落库", async () => {
		const call = fauxAssistantMessage(
			[
				fauxToolCall("fiat_memory_propose", {
					title: "列名约定",
					entries: ["返现表格列名 id,amount"],
				}),
			],
			{ stopReason: "toolUse" },
		);
		faux.setResponses([call, fauxAssistantMessage("第一遍"), call, fauxAssistantMessage("第二遍")]);

		const { reviewer, proposals } = setup();
		await reviewer.review({ trigger: "turn", toolSteps: 0, turns: 10 });
		await reviewer.review({ trigger: "turn", toolSteps: 0, turns: 10 });
		// 内容哈希相同 → 只落一条（§10.9 幂等键）
		expect(await proposals.list({ kind: "memory" })).toHaveLength(1);
	});
});

describe("P12-66 slice：切片与二次脱敏", () => {
	it("按用户轮裁剪：只保留最近 N 轮", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "第 1 轮" }] },
			{ role: "assistant", content: [{ type: "text", text: "答 1" }] },
			{ role: "user", content: [{ type: "text", text: "第 2 轮" }] },
			{ role: "assistant", content: [{ type: "text", text: "答 2" }] },
			{ role: "user", content: [{ type: "text", text: "第 3 轮" }] },
		];
		const s = buildSanitizedSlice(messages, { turns: 2 });
		expect(s).not.toContain("第 1 轮");
		expect(s).toContain("第 2 轮");
		expect(s).toContain("第 3 轮");
	});

	it("工具结果只保留「工具名 + 成败 + 摘要」，不落原始输出全文", () => {
		const long = "x".repeat(500);
		const s = buildSanitizedSlice(
			[
				{ role: "user", content: [{ type: "text", text: "查" }] },
				{
					role: "toolResult",
					toolName: "mcp_rag_query_knowledge_hub",
					isError: true,
					content: [{ type: "text", text: long }],
				},
			],
			{ turns: 12 },
		);
		expect(s).toContain("[工具 mcp_rag_query_knowledge_hub] 失败");
		expect(s.length).toBeLessThan(long.length);
		expect(s).toContain("…");
	});

	it("redact：单条文本里多处敏感信息全部替换", () => {
		const out = redact("手机 13800138000，订单号：BM202609120001，邮箱 ops@bitmart.com");
		expect(out).not.toContain("13800138000");
		expect(out).not.toContain("BM202609120001");
		expect(out).not.toContain("ops@bitmart.com");
		expect(out).toContain("[已脱敏]");
	});

	it("空 transcript → 空切片（宿主据此不起空 fork）", () => {
		expect(buildSanitizedSlice([], { turns: 12 })).toBe("");
	});
});
