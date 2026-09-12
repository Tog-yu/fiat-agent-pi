/**
 * approval —— 自进化的审批桥（阶段 12 / P12-69）。
 *
 * 职责：把 `needs_approval` 的提案接进**既有**的审批链路（§10.5 第 7 条 / §10.2 第 3 条）。
 * 「复用」到什么程度、不复用什么，这里必须写清楚，否则后来人很容易把两条链路搅在一起：
 *
 * ✅ **复用** `ApprovalService` 的票据生命周期：建单(pending) + 一次性 token(sha256 存库)
 *    + Lark 卡片 + `ticket_created` / `ticket_approved` 审计。理由：持牌业务里
 *    「agent 修改自己后续所有会话的行为」必须与生产写走**同一套**可审、可 diff、可回滚的流程，
 *    而不是第二套「自研审批」。
 *
 * ❌ **不复用** `ApprovalService.apply`。它的执行端是 `FiatToolClient`（业务系统写），
 *    而这里的执行端是**文件系统**（技能库 / 记忆目录）。硬套会引入一个假的业务工具名，
 *    反而模糊「谁在写什么」。因此落盘走 `applyProposal`（L2 确定性代码）。
 *
 * 作为补偿，审批桥自己补两道与 `ApprovalService.apply` 等价的检查——**「L2 再查一次」精神**：
 *   1. token 复核（sha256 比对，与建单时同一算法）；
 *   2. **审批人 = oncall/ops 且非提案人**（对齐 job-apply 的既有约束）。
 *
 * 不再重复做的：判定复核。`policy.decide` 是纯函数（输入只有提案 + 环境 + 配置 + 已有技能），
 * 审批通过后无需重算——它与「canExecute 依赖可变策略」的情况不同。
 */

import type { ApprovalService, TicketStatus } from "../approval/ticket.ts";
import type { ApplyOutcome } from "./apply.ts";
import { type ApplyDeps, applyProposal } from "./apply.ts";
import type { ProposalStore } from "./proposalStore.ts";
import type { EvolutionProposal } from "./types.ts";

/** 允许审批自进化提案的角色（与 `tool_policies.yaml` 里 job_apply 的 allowed_roles 对齐） */
export const DEFAULT_APPROVER_ROLES = ["oncall", "ops"] as const;

export interface EvolutionApprovalDeps {
	/** 既有审批服务（阶段 5）——票据生命周期唯一权威 */
	approval: ApprovalService;
	proposals: ProposalStore;
	/** 落盘依赖（透传给 applyProposal） */
	apply: Omit<ApplyDeps, "proposals">;
	/** 允许审批的角色；缺省 oncall / ops */
	approverRoles?: readonly string[];
	/** 与建单时同一算法（sha256 hex）；用于 token 复核 */
	sha256: (s: string) => string;
}

export interface RequestApprovalResult {
	ticketId: string;
	/** 一次性 token 明文（仅此处返回一次；Lark 卡片侧由回调携带） */
	token: string;
	status: TicketStatus;
}

export type ApproveOutcome =
	| { ok: true; ticketId: string; apply: ApplyOutcome }
	| {
			ok: false;
			ticketId: string;
			code: "ticket_missing" | "not_pending" | "bad_token" | "role_denied" | "self_approval";
			message: string;
	  };

export class EvolutionApprovalBridge {
	private readonly deps: EvolutionApprovalDeps;

	constructor(deps: EvolutionApprovalDeps) {
		this.deps = deps;
	}

	/** 提案 id → 工单幂等键（同一提案重放不建重复票） */
	private keyOf(proposalId: string): string {
		return `evolution:${proposalId}`;
	}

	/** `needs_approval` 的落点：建单 + Lark 卡。标题 / 摘要给审批人看的是**改什么**，不是内文全篇 */
	async requestApproval(proposal: EvolutionProposal, reason: string): Promise<RequestApprovalResult> {
		const subject = {
			userId: proposal.proposer,
			role: "agent",
			environment: this.deps.apply.environment,
		};
		const r = await this.deps.approval.requestApply({
			tool: `evolution_${proposal.kind}`,
			subject,
			payload: {
				proposalId: proposal.proposalId,
				kind: proposal.kind,
				target: proposal.target,
				contentHash: proposal.contentHash,
			},
			idempotencyKey: this.keyOf(proposal.proposalId),
			title: `自进化提案 · ${proposal.kind} · ${proposal.target}`,
			summary: `${reason}｜提案人 ${proposal.proposer}｜run ${proposal.runId}`,
		});
		return { ticketId: r.ticketId, token: r.token, status: r.status };
	}

	/**
	 * 审批人通过 → 复核 → 落盘。
	 * 顺序刻意是「先把关、再改状态、最后写盘」：`approval.approve` 会把票置成 approved，
	 * 若那之后再发现审批人不合法，票的状态就已经脏了。所以所有资格检查都在它之前。
	 */
	async approveAndApply(args: {
		ticketId: string;
		token: string;
		approver: { id: string; role: string };
	}): Promise<ApproveOutcome> {
		const ticket = await this.deps.approval.get(args.ticketId);
		if (!ticket) return fail(args.ticketId, "ticket_missing", `工单不存在：${args.ticketId}`);
		if (ticket.status !== "pending") {
			return fail(args.ticketId, "not_pending", `工单状态为 ${ticket.status}，非 pending`);
		}

		// 检查①：审批人资格（角色 + 非提案人）
		const roles = this.deps.approverRoles ?? DEFAULT_APPROVER_ROLES;
		if (!roles.includes(args.approver.role)) {
			return fail(args.ticketId, "role_denied", `角色 ${args.approver.role} 无自进化审批权（需 ${roles.join("/")}）`);
		}

		const proposalId = String((ticket.payload as Record<string, unknown>).proposalId ?? "");
		const proposal = await this.deps.proposals.get(proposalId);
		if (!proposal) return fail(args.ticketId, "ticket_missing", `提案不存在：${proposalId}`);
		if (proposal.proposer === args.approver.id) {
			// 自进化最坏的情况是「agent 说服自己」：提案人与审批人同一人 = 没有第二双眼睛
			return fail(args.ticketId, "self_approval", "审批人不能是提案人");
		}

		// 检查②：token 复核（与建单同一算法；挡住重放 / 猜票号）
		if (this.deps.sha256(args.token) !== ticket.tokenHash) {
			return fail(args.ticketId, "bad_token", "一次性 token 不匹配");
		}

		await this.deps.approval.approve(args.ticketId); // 会写 ticket_approved 审计
		const apply = await applyProposal(proposalId, args.approver.id, {
			...this.deps.apply,
			proposals: this.deps.proposals,
		});
		return { ok: true, ticketId: args.ticketId, apply };
	}

	/** 审批人驳回 */
	async reject(ticketId: string, reason: string): Promise<void> {
		await this.deps.approval.reject(ticketId, reason);
	}
}

function fail(ticketId: string, code: Extract<ApproveOutcome, { ok: false }>["code"], message: string): ApproveOutcome {
	return { ok: false, ticketId, code, message };
}
