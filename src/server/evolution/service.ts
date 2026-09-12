/**
 * EvolutionService —— 自进化循环的编排层（阶段 12 / P12-63 + P12-66 + P12-69 的汇合点）。
 *
 * 它只做三件事，每件都必须是确定性的：
 *
 *   1. **汇合两个计数器**（§10.4）。L1a 的 `evolution-trigger` 只知道工具迭代，
 *      `PiHostLoop.runTurn` 只知道用户轮次——只有宿主同时掌握两者，也只有宿主
 *      掌握「本会话已经跑过几次评审」的预算。所以汇合判定在这里。
 *   2. **起评审并重置计数**。评审一旦触发，两个计数器归零（对齐 Hermes 把两个
 *      interval 置 0 的递归防护做法），否则会变成「每轮都评审」。
 *   3. **把提案按判定分发**：`auto_apply` → 落盘（+评测闸门）；`needs_approval` → 建工单；
 *      `reject` → 记拒绝。判定本身是纯函数（`policy.ts`），本层只做 IO 编排。
 *
 * ⚠️ **本层永不抛**。它是挂在 `chat.turn()` 之后的旁路：用户已经拿到回复了，
 * 评审失败的正确表现是「日志里多一行」，不是「抛出去把 CLI 打崩」。
 * 与 `EvolutionReviewer.review()` 的「永不抛」同源。
 *
 * 为什么落盘走「端口」（`EvolutionApplyPort`）而不是直接调 apply.ts：
 *   因为落盘有三种归宿（自动 / 审批 / 拒绝），而**审批需要 ApprovalService + Lark**——
 *   把这套依赖硬塞进编排层会让「只想测触发逻辑」的测试也得造一套审批脚手架。
 *   端口化之后，测试可以注入一个只记调用的假端口。
 */

import type { EvolutionTrigger } from "../host/l1a/evolution-trigger.ts";
import type { ApplyOutcome } from "./apply.ts";
import type { ExistingSkill } from "./policy.ts";
import { decide } from "./policy.ts";
import type { ProposalStore } from "./proposalStore.ts";
import type { EvolutionReviewer, ReviewResult } from "./reviewer.ts";
import type { EvolutionConfig, EvolutionProposal, ProposalStatus, TriggerKind } from "./types.ts";

/** 落盘端口：三种归宿各一个方法。实现见 chat.ts 的组合根。 */
export interface EvolutionApplyPort {
	/** 自动落盘（含评测闸门）；`decidedBy` 形如 `system:dev` */
	autoApply: (proposalId: string, decidedBy: string) => Promise<ApplyOutcome>;
	/** 判定拒绝：不改文件，只改状态 + 审计 */
	reject: (proposalId: string, decidedBy: string, reason: string) => Promise<ApplyOutcome>;
	/** 需要审批：建工单 + Lark 卡 */
	requestApproval: (
		proposal: EvolutionProposal,
		reason: string,
	) => Promise<{ ticketId: string; token: string; status: string }>;
}

export interface EvolutionServiceDeps {
	config: EvolutionConfig;
	/** L1a 计数器句柄（工具迭代） */
	trigger: EvolutionTrigger;
	reviewer: EvolutionReviewer;
	/** 落盘端口；**缺省时只判定不落盘**（dry-run 模式，便于本地观察判定结果） */
	applyPort?: EvolutionApplyPort;
	proposals: ProposalStore;
	/** 已有技能的判定投影（保护清单 / 重复检测的输入） */
	existingSkills: () => readonly ExistingSkill[];
	/** 触发会话的 userId（进提案的 proposer；审批人必须不同于它） */
	proposer: string;
	/** 触发会话 id（只用于日志与审计定位） */
	sessionId: string;
	/** 环境（决定自动落盘还是审批） */
	environment: string;
	now?: () => Date;
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

/** 一次会话内的状态（不持久化：预算随会话生命周期走） */
export interface SessionBudget {
	runs: number;
	turnsSinceMemory: number;
}

export type TriggerDecision =
	| { kind: "skip"; reason: "below_threshold" | "budget_exhausted" }
	| { kind: "run"; trigger: TriggerKind; toolSteps: number; turns: number };

export interface AfterTurnResult {
	trigger: TriggerKind;
	run: ReviewResult["run"];
	/** 判定后的分发结果（顺序与提案产出顺序一致） */
	outcomes: Array<{ proposalId: string; status: ProposalStatus; decision: string }>;
}

export class EvolutionService {
	private readonly deps: EvolutionServiceDeps;
	private readonly budget: SessionBudget = { runs: 0, turnsSinceMemory: 0 };

	constructor(deps: EvolutionServiceDeps) {
		this.deps = deps;
	}

	/**
	 * 用户轮次 +1。**由 `PiHostLoop.runTurn` 末尾的 `onUserTurn` 钩子驱动**
	 * （§10.4：用户轮次只有宿主知道，所以计数点必须在宿主，而不是在 L1a）。
	 */
	noteUserTurn(): void {
		this.budget.turnsSinceMemory += 1;
	}

	/** 当前会话预算快照（测试 / 可观测） */
	snapshot(): SessionBudget & { itersSinceSkill: number } {
		return { ...this.budget, itersSinceSkill: this.deps.trigger.snapshot().itersSinceSkill };
	}

	/** 纯判定：现在该不该触发？不产生任何副作用（可安全地在任意时刻调用） */
	shouldTrigger(): TriggerDecision {
		const snap = this.deps.trigger.snapshot();
		const { intervalIters, intervalTurns, maxRunsPerSession } = this.deps.config;

		const hit =
			snap.itersSinceSkill >= intervalIters
				? ({ trigger: "tool_iters", toolSteps: snap.itersSinceSkill } as const)
				: this.budget.turnsSinceMemory >= intervalTurns
					? ({ trigger: "turn", toolSteps: snap.itersSinceSkill } as const)
					: null;
		if (!hit) return { kind: "skip", reason: "below_threshold" };
		if (this.budget.runs >= maxRunsPerSession) return { kind: "skip", reason: "budget_exhausted" };
		return { kind: "run", trigger: hit.trigger, toolSteps: hit.toolSteps, turns: this.budget.turnsSinceMemory };
	}

	/**
	 * 一轮结束后的钩子：判定 → 评审 → 分发。**永不抛。**
	 * 返回 null = 本轮没触发（低于阈值 / 预算用尽 / 评审整体失败）。
	 */
	async afterTurn(): Promise<AfterTurnResult | null> {
		try {
			const verdict = this.shouldTrigger();
			if (verdict.kind === "skip") {
				if (verdict.reason === "budget_exhausted") {
					this.deps.log?.("warn", `本会话评审预算已用尽（${this.budget.runs} 次），跳过`, {
						sessionId: this.deps.sessionId,
					});
				}
				return null;
			}

			this.budget.runs += 1;
			// 汇合后立刻归零两个计数器（递归防护 / 防止每轮都触发）
			this.deps.trigger.reset();
			this.budget.turnsSinceMemory = 0;

			const result = await this.deps.reviewer.review({
				trigger: verdict.trigger,
				toolSteps: verdict.toolSteps,
				turns: verdict.turns,
			});
			const outcomes = await this.dispatch(result.proposals);
			return { trigger: verdict.trigger, run: result.run, outcomes };
		} catch (e) {
			// 编排层的最后一道兜底：宁可漏一次进化，也不能让一次评审把会话打崩
			this.deps.log?.("error", `自进化编排失败：${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	/** 按 `policy.decide` 分发提案；单条失败不影响其他条 */
	private async dispatch(
		proposals: readonly EvolutionProposal[],
	): Promise<Array<{ proposalId: string; status: ProposalStatus; decision: string }>> {
		const out: Array<{ proposalId: string; status: ProposalStatus; decision: string }> = [];
		for (const proposal of proposals) {
			try {
				out.push(await this.dispatchOne(proposal));
			} catch (e) {
				this.deps.log?.("error", `提案分发失败：${e instanceof Error ? e.message : String(e)}`, {
					proposalId: proposal.proposalId,
				});
			}
		}
		return out;
	}

	private async dispatchOne(
		proposal: EvolutionProposal,
	): Promise<{ proposalId: string; status: ProposalStatus; decision: string }> {
		const verdict = decide({
			proposal,
			environment: this.deps.environment,
			config: this.deps.config,
			existing: this.deps.existingSkills(),
		});

		proposal.decision = verdict.decision;
		proposal.decisionRule = verdict.rule;
		await this.deps.proposals.update(proposal);

		const port = this.deps.applyPort;
		if (!port) {
			// dry-run：只把判定写进提案（本地观察用；不落任何文件）
			return { proposalId: proposal.proposalId, status: proposal.status, decision: verdict.decision.kind };
		}

		if (verdict.decision.kind === "reject") {
			const r = await port.reject(proposal.proposalId, `system:${this.deps.environment}`, verdict.decision.reason);
			return { proposalId: proposal.proposalId, status: r.status, decision: "reject" };
		}

		if (verdict.decision.kind === "auto_apply") {
			const r = await port.autoApply(proposal.proposalId, `system:${this.deps.environment}`);
			// 落盘后可能被评测闸门回滚成 rolled_back，以实际状态为准
			const after = await this.deps.proposals.get(proposal.proposalId);
			return { proposalId: proposal.proposalId, status: after?.status ?? r.status, decision: "auto_apply" };
		}

		const ticket = await port.requestApproval(proposal, verdict.decision.reason);
		return { proposalId: proposal.proposalId, status: proposal.status, decision: `needs_approval:${ticket.ticketId}` };
	}
}
