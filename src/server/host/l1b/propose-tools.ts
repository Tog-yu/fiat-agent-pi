/**
 * propose-tools —— L1b 提案工具（阶段 12 / P12-67）。
 *
 * ⚠️ **本模块的工具只在评审 fork 会话里注册，且只做一件事：写提案表。**
 * 这是整套自进化最关键的隔离边界（§10.2 第 1 条）：
 *
 *   Hermes 的 fork 能直接 `write_file` / `terminal` 落盘 —— 那个 fork 跑在 LLM 那一侧，
 *   给它写文件能力 = 把技能库 / 记忆目录暴露给 prompt 注入。
 *   fiat 的 fork **只有 propose 工具**：产物进 `fiat_evolution_proposal` 表，
 *   真正的落盘由 `evolution/apply.ts` 的**确定性代码**执行（原子写 + 快照 + 审计双写）。
 *
 * 因此这三个工具的 `execute` 里**没有一行文件系统调用**，只有 `proposals.insert(...)`。
 * 落盘路径的唯一入口是 `applyProposal`，它由人（审批）或环境策略（dev 自动）触发，
 * **永远不由模型触发**。
 *
 * 三个工具对应 §10.3 的三路沉淀：
 *   fiat_skill_propose       ① 程序性流程 → `workspace/pi-skills/<name>/SKILL.md`
 *   fiat_memory_propose      ② 事实性知识 → `workspace/memory/YYYY-MM-DD.md`
 *   fiat_role_facts_propose  ③ 运行约定   → `workspace/facts/roles/<role>.md`（默认关，policy 会拒）
 *
 * 白名单之外的任何工具都不注册 —— 尤其**生产写工具**（`fiat_job_apply` /
 * `fiat_cashback_reconcile`）一律不在 fork 里，模型的越权调用会得到 Pi 的
 * "Tool ... not found"（这也是验收标准里「白名单外工具被运行时拒绝」的落点）。
 */

import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ProposalStore, proposalHash } from "../../evolution/proposalStore.ts";
import type { EvolutionProposal, ProposalKind, ProposalPayload } from "../../evolution/types.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

export const SKILL_PROPOSE_TOOL = "fiat_skill_propose";
export const MEMORY_PROPOSE_TOOL = "fiat_memory_propose";
export const ROLE_FACTS_PROPOSE_TOOL = "fiat_role_facts_propose";

/**
 * fork 会话的运行时上下文：这三个值由宿主（reviewer）注入，模型改不了。
 *   - `runId`：本条提案属于哪次评审
 *   - `sessionId`：主会话（不是 fork 的临时 id）——审计与「同会话幂等」都靠它
 *   - `proposer`：提案人 = 触发会话的 userId。审批人必须不同于它（§10.5 第 7 条）
 */
export interface ForkContext {
	runId: string;
	sessionId: string;
	proposer: string;
}

export interface ProposeToolsDeps {
	proposals: ProposalStore;
	context: ForkContext;
	/** 注入式依赖，便于确定性测试 */
	genId?: () => string;
	now?: () => Date;
}

export function createProposeTools(deps: ProposeToolsDeps): HostTool[] {
	const genId = deps.genId ?? randomUUID;
	const now = deps.now ?? (() => new Date());

	/** 落库的公共部分：幂等键 + 状态机起点，三个工具共用 */
	async function record(args: {
		kind: ProposalKind;
		target: string;
		title: string;
		payload: ProposalPayload;
	}): Promise<{ proposalId: string; duplicated: boolean }> {
		const contentHash = proposalHash(args.kind, args.target, args.payload);
		// 幂等（§10.9）：同一内容（归一化后）反复提案不重复落盘；已存在则原样返回旧 id
		const existing = await deps.proposals.findByHash(contentHash);
		if (existing) return { proposalId: existing.proposalId, duplicated: true };

		const proposal: EvolutionProposal = {
			proposalId: genId(),
			runId: deps.context.runId,
			sessionId: deps.context.sessionId,
			proposer: deps.context.proposer,
			kind: args.kind,
			target: args.target,
			title: args.title,
			payload: args.payload,
			contentHash,
			status: "proposed",
			createdAt: now().toISOString(),
		};
		await deps.proposals.insert(proposal);
		return { proposalId: proposal.proposalId, duplicated: false };
	}

	return [
		hostToolFromDefinition(
			defineTool({
				name: SKILL_PROPOSE_TOOL,
				label: "Fiat Skill Propose",
				description:
					"提交一条技能提案（只写提案表，不落盘）。用于把本次会话里可复用的操作流程沉淀成技能。落盘由人工审批或环境策略决定。",
				promptSnippet: "提交技能提案：fiat_skill_propose(name, description, when_to_use, body, case_id?)。",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", description: "技能名 slug（小写字母/数字/连字符，2~48 字）" },
						description: { type: "string", description: "一句话说明，≤60 字（超了会被判定拒绝）" },
						when_to_use: {
							type: "array",
							items: { type: "string" },
							description: "何时使用（至少一条，每条 ≤30 字）",
						},
						body: {
							type: "string",
							description:
								"正文，固定章节顺序：## When to Use / ## Procedure / ## Pitfalls / ## Verification。只写「怎么调工具」，禁止写金额规则、状态机规则、字段校验。",
						},
						case_id: { type: "string", description: "可选：对应的 eval case id（用于落盘后跑评测准入）" },
					},
					required: ["name", "description", "when_to_use", "body"],
				},
				async execute(_toolCallId, params) {
					const p = params as {
						name: string;
						description: string;
						when_to_use: string[];
						body: string;
						case_id?: string;
					};
					const r = await record({
						kind: "skill",
						target: p.name,
						title: `技能提案：${p.name}`,
						payload: {
							description: p.description,
							whenToUse: p.when_to_use ?? [],
							body: p.body,
							...(p.case_id ? { caseId: p.case_id } : {}),
						},
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									proposal_id: r.proposalId,
									kind: "skill",
									target: p.name,
									duplicated: r.duplicated,
									note: r.duplicated ? "内容相同的提案已存在，未重复提交" : "已进提案表，等待落盘判定",
								}),
							},
						],
						details: { propose: SKILL_PROPOSE_TOOL, proposalId: r.proposalId },
					};
				},
			}),
		),

		hostToolFromDefinition(
			defineTool({
				name: MEMORY_PROPOSE_TOOL,
				label: "Fiat Memory Propose",
				description:
					"提交一条事实记忆提案（只写提案表，不落盘）。用于记下本次会话澄清的事实。注意：记忆是提示层，绝不能写成规则。",
				promptSnippet: "提交事实记忆提案：fiat_memory_propose(title, entries)。",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "这条记忆的短标题（如「返现表格列名约定」）" },
						entries: {
							type: "array",
							items: { type: "string" },
							description: "事实条目，一行一条；禁止含金额 / 订单号 / 手机号 / 卡号 / 用户标识",
						},
					},
					required: ["title", "entries"],
				},
				async execute(_toolCallId, params) {
					const p = params as { title: string; entries: string[] };
					const target = new Date(now()).toISOString().slice(0, 10);
					const r = await record({
						kind: "memory",
						target,
						title: p.title,
						payload: { entries: p.entries ?? [] },
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									proposal_id: r.proposalId,
									kind: "memory",
									target,
									duplicated: r.duplicated,
								}),
							},
						],
						details: { propose: MEMORY_PROPOSE_TOOL, proposalId: r.proposalId },
					};
				},
			}),
		),

		hostToolFromDefinition(
			defineTool({
				name: ROLE_FACTS_PROPOSE_TOOL,
				label: "Fiat Role Facts Propose",
				description:
					"提交一条「按 role 的运行约定」提案（只写提案表，不落盘；该路默认关闭，通常会被判定拒绝）。fiat 不做个人画像。",
				promptSnippet: "提交运行约定提案：fiat_role_facts_propose(role, title, entries)。",
				parameters: {
					type: "object",
					properties: {
						role: { type: "string", description: "角色名（如 ops / oncall / risk）" },
						title: { type: "string", description: "约定短标题" },
						entries: { type: "array", items: { type: "string" }, description: "约定条目，一行一条" },
					},
					required: ["role", "title", "entries"],
				},
				async execute(_toolCallId, params) {
					const p = params as { role: string; title: string; entries: string[] };
					const r = await record({
						kind: "role_facts",
						target: p.role,
						title: p.title,
						payload: { role: p.role, entries: p.entries ?? [] },
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									proposal_id: r.proposalId,
									kind: "role_facts",
									target: p.role,
									duplicated: r.duplicated,
								}),
							},
						],
						details: { propose: ROLE_FACTS_PROPOSE_TOOL, proposalId: r.proposalId },
					};
				},
			}),
		),
	];
}
