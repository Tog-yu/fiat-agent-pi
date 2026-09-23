/**
 * apply —— 提案落盘（阶段 12 / P12-69）。**自进化唯一的写磁盘入口。**
 *
 * 为什么单独一个模块承载「写」：因为这是整套设计里权限边界最实的一处。
 * 上游（fork / 模型）只能写 `fiat_evolution_proposal` 表；下游（`SkillStore` /
 * `MemoryStore`）只管文件原子性。**只有本模块把两者接起来**，所以在它身上能一眼审查：
 *
 *   snapshot()  →  写  →  proposal.status = applied  →  audit 双写
 *
 * 四条不可动摇的口径：
 *
 * 1. **写之前必拍快照**（skill 类）。没有快照就没有 rollback，而「能被回滚」是
 *    这套设计敢自动落盘的前提（§10.2 第 3 条）。记忆类不拍——它们是 append-only，
 *    回滚语义不成立（也不需要：追加一条事实的最坏后果是噪音，不是错误规则）。
 *
 * 2. **幂等**。`status === "applied"` 直接返回，不重复写。配合 build 阶段的
 *    `contentHash` 幂等键，同一内容无论触发几次都只落一次盘（§10.9）。
 *
 * 3. **双写审计**（§10.9）：提案正文与状态进 `fiat_evolution_*`，每次**状态迁移**
 *    同时追加一条 `fiat_audit_log`。审计是合规事实（只追加、用于追责），
 *    提案表是可编辑的状态机——自进化**本身**必须可审计。
 *    审计写失败**不回滚业务写**（否则一个日志故障会让技能库处于半状态），只记日志。
 *
 * 4. **只落 agent 技能库里的东西**。`AGENTS.md` / `tool_policies.yaml` / `eval_cases.yaml`
 *    是人写锚点，本模块**没有任何代码路径**能碰到它们（阶段 12 硬约束 3）。
 */

import type { AuditClient, AuditOutcome } from "../audit/client.ts";
import { resolveMemoryIdentity } from "../memory/identity.ts";
import type { MemoryStore } from "./memoryStore.ts";
import type { ProposalStore } from "./proposalStore.ts";
import type { SkillStore } from "./skillStore.ts";
import type { EvolutionConfig, EvolutionProposal, ProposalPayload, ProposalStatus } from "./types.ts";

export interface ApplyDeps {
	skills: SkillStore;
	memory: MemoryStore;
	proposals: ProposalStore;
	audit?: AuditClient;
	config: EvolutionConfig;
	/** 主会话 id（审计字段；提案自带 sessionId，这里只兜底） */
	sessionId: string;
	environment: string;
	now?: () => Date;
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

export interface ApplyOutcome {
	ok: boolean;
	proposalId: string;
	status: ProposalStatus;
	/** 实际写入的文件路径（skill = SKILL.md；memory / role_facts = md 文件） */
	appliedPath?: string;
	/** 落盘前的 tar.gz 快照（skill 类才有） */
	snapshotPath?: string;
	/** ok=false 的原因；失败时提案状态不变（保持可重试） */
	error?: string;
}

/**
 * 落盘一个提案。
 * `decidedBy`：`system:dev`（自动落盘）或审批人 id（人工审批）——进审计，可追责。
 */
export async function applyProposal(proposalId: string, decidedBy: string, deps: ApplyDeps): Promise<ApplyOutcome> {
	const now = deps.now ?? (() => new Date());
	const proposal = await deps.proposals.get(proposalId);
	if (!proposal) {
		return { ok: false, proposalId, status: "proposed", error: `提案不存在：${proposalId}` };
	}

	// 幂等②：已落盘直接返回（重复触发 / 审批回调重放都不该再写一次）
	if (proposal.status === "applied") {
		return {
			ok: true,
			proposalId,
			status: "applied",
			...(proposal.snapshotPath ? { snapshotPath: proposal.snapshotPath } : {}),
		};
	}
	if (proposal.status === "rejected" || proposal.status === "rolled_back") {
		return { ok: false, proposalId, status: proposal.status, error: `提案已终态（${proposal.status}），不可落盘` };
	}

	let snapshotPath: string | undefined;
	let appliedPath: string;
	try {
		if (proposal.kind === "skill") {
			// 口径①：skill 落盘前必拍快照 —— 评测不达标时要能整目录回滚
			snapshotPath = deps.skills.snapshot(now().toISOString());
			const p = proposal.payload as Extract<ProposalPayload, { body: string }>;
			appliedPath = deps.skills.upsertSkill({
				name: proposal.target,
				description: p.description,
				whenToUse: p.whenToUse,
				body: p.body,
				...(p.caseId ? { caseId: p.caseId } : {}),
				now: now().toISOString(),
			}).path;
		} else if (proposal.kind === "memory") {
			const p = proposal.payload as Extract<ProposalPayload, { entries: string[] }>;
			// P15-103：记忆落在**蒸出它的那个人**名下 —— 用 `proposal.proposer`（提案生成时记下的
			// 触发会话 userId，types.ts:121），而不是 apply 那一刻的会话主体：审批落盘可能发生在
			// 别人的会话里（approval.ts:132 传的是 `args.approver.id`），用会话主体会写错分区。
			appliedPath = deps.memory.appendFacts(
				resolveMemoryIdentity({ user: { id: proposal.proposer } }),
				{ title: proposal.title, entries: p.entries },
				now(),
			);
		} else {
			const p = proposal.payload as Extract<ProposalPayload, { role: string; entries: string[] }>;
			appliedPath = deps.memory.appendRoleFacts(p.role, { title: proposal.title, entries: p.entries }, now());
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		deps.log?.("error", `落盘失败：${message}`, { proposalId, kind: proposal.kind, target: proposal.target });
		return { ok: false, proposalId, status: proposal.status, error: message };
	}

	const iso = now().toISOString();
	proposal.status = "applied";
	proposal.decidedBy = decidedBy;
	proposal.decidedAt ??= iso;
	proposal.appliedAt = iso;
	if (snapshotPath) proposal.snapshotPath = snapshotPath;
	await deps.proposals.update(proposal);

	// 口径③：状态迁移 → 审计双写（审计失败不回滚业务写，只记日志）
	await auditTransition(deps, proposal, "evolution_applied", `→ ${appliedPath}`);

	return {
		ok: true,
		proposalId,
		status: "applied",
		appliedPath,
		...(snapshotPath ? { snapshotPath } : {}),
	};
}

/** 判定拒绝：把结果写进提案状态与审计（拒绝也是状态迁移，也要留痕） */
export async function rejectProposal(
	proposalId: string,
	decidedBy: string,
	reason: string,
	deps: ApplyDeps,
): Promise<ApplyOutcome> {
	const now = deps.now ?? (() => new Date());
	const proposal = await deps.proposals.get(proposalId);
	if (!proposal) return { ok: false, proposalId, status: "proposed", error: `提案不存在：${proposalId}` };
	if (proposal.status === "applied") {
		return { ok: false, proposalId, status: "applied", error: "提案已落盘，不能改为拒绝" };
	}
	proposal.status = "rejected";
	proposal.decidedBy = decidedBy;
	proposal.decidedAt = now().toISOString();
	await deps.proposals.update(proposal);
	await auditTransition(deps, proposal, "evolution_rejected", reason);
	return { ok: true, proposalId, status: "rejected" };
}

/** 状态迁移的审计追加（apply / reject / rollback 三条路径共用一份格式） */
export async function auditTransition(
	deps: Pick<ApplyDeps, "audit" | "sessionId" | "environment" | "now" | "log">,
	proposal: EvolutionProposal,
	outcome: AuditOutcome,
	detail?: string,
): Promise<void> {
	if (!deps.audit) return;
	const now = deps.now ?? (() => new Date());
	try {
		await deps.audit.record({
			ts: now().toISOString(),
			sessionId: proposal.sessionId || deps.sessionId,
			user: { id: proposal.proposer, role: "agent" },
			environment: deps.environment,
			// 自进化自己占一个 tool 命名空间，审计查询一眼能把「改自己行为」的操作捞出来
			tool: `fiat_evolution_${proposal.kind}`,
			input: {
				proposalId: proposal.proposalId,
				runId: proposal.runId,
				target: proposal.target,
				contentHash: proposal.contentHash,
				decidedBy: proposal.decidedBy,
			},
			isError: false,
			outcome,
			...(detail ? { detail } : {}),
		});
	} catch (e) {
		deps.log?.("error", `审计双写失败：${e instanceof Error ? e.message : String(e)}`, {
			proposalId: proposal.proposalId,
			outcome,
		});
	}
}
