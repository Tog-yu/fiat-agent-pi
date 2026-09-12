/**
 * verify —— 评测闸门（阶段 12 / P12-70），本设计相对 Hermes 的**增量**（§10.10）。
 *
 * Hermes 只能靠**时间衰减**猜一个技能是否还有用——但时间不说明任何事：一个错误技能
 * 可能天天被用，一个正确技能可能一周才用一次。fiat 有阶段 11 的三层判分器，可以**直接证伪**：
 *
 *     落盘 ──► 跑对应 eval case ──┬─ score ≥ 基线 ► verified（回写 SKILL.md 的 verified_by）
 *                                 └─ score < 基线 ► 自动 rollback + 标 stale
 *
 * 一句话：**自进化不是「写了就算学会」，而是「评测通过才算学会」。**
 *
 * 三条边界：
 *
 * 1. **评测锚点人写，自进化只读**（§10.10）。`config/eval_cases.yaml` 与
 *    `tool_policies.yaml` 是判定基准，本模块只 `cases.find(...)`，没有任何写路径。
 *    「为了让评测通过而放宽权限」是阶段 11 就点名的作弊路径，这里再钉一次。
 *
 * 2. **失败不抛**。跑评测可能因为 provider / 环境失败——那不等于技能是坏的。
 *    拿不到分数时**不回滚**（宁可留一个 unverified 技能，也不要因为评测环境抖动把好技能删掉）。
 *
 * 3. **回滚是整目录还原**（skillStore 的 tar.gz 快照语义），因此本函数必须**紧随 apply**
 *    调用，且期间不允许其他 apply 落盘——否则会把别人的改动一起回滚掉。
 *    `EvolutionService` 把 apply → verify 串成一次不可分割的调用就是为了满足这条。
 */

import type { AuditClient } from "../audit/client.ts";
import type { EvalCase } from "../eval/types.ts";
import { type ApplyDeps, type ApplyOutcome, applyProposal, auditTransition } from "./apply.ts";
import type { ProposalStore } from "./proposalStore.ts";
import type { SkillStore } from "./skillStore.ts";
import type { EvolutionProposal } from "./types.ts";

export interface VerifyDeps {
	skills: SkillStore;
	proposals: ProposalStore;
	audit?: AuditClient;
	/** 评测 case 集（`loadEvalCases` 的产物）—— **人写锚点，只读** */
	cases: readonly EvalCase[];
	/** 跑一个 case，返回最终分（0..1）；跑不起来返回 undefined（例如 provider 不可用） */
	runCase: (caseId: string) => Promise<number | undefined>;
	sessionId: string;
	environment: string;
	now?: () => Date;
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

export interface VerifyOutcome {
	proposalId: string;
	skill: string;
	caseId?: string;
	score?: number;
	/** 基线 = case.threshold（人写） */
	baseline?: number;
	verified: boolean;
	rolledBack: boolean;
	reason?: "no_case" | "case_not_found" | "runner_failed" | "below_baseline" | "skill_missing" | "not_applied";
}

/** 对一条**已落盘**的技能提案跑准入评测 */
export async function verifySkill(proposalId: string, deps: VerifyDeps): Promise<VerifyOutcome> {
	const now = deps.now ?? (() => new Date());
	const proposal = await deps.proposals.get(proposalId);
	if (!proposal) return { proposalId, skill: "", verified: false, rolledBack: false, reason: "skill_missing" };
	if (proposal.status !== "applied") {
		return { proposalId, skill: proposal.target, verified: false, rolledBack: false, reason: "not_applied" };
	}

	const skill = deps.skills.get(proposal.target);
	if (!skill)
		return { proposalId, skill: proposal.target, verified: false, rolledBack: false, reason: "skill_missing" };

	// case 来源：落盘时写进 frontmatter 的 case_id 优先（apply 时由提案载荷带过来）
	const caseId = skill.verifiedBy?.caseId ?? caseOf(proposal.payload);
	if (!caseId) {
		// 没锚点 = unverified。不拒绝、不回滚——它仍可注入，只是排在 verified 之后（§10.10）
		return { proposalId, skill: proposal.target, verified: false, rolledBack: false, reason: "no_case" };
	}

	const evalCase = deps.cases.find((c) => c.id === caseId);
	if (!evalCase) {
		return { proposalId, skill: proposal.target, caseId, verified: false, rolledBack: false, reason: "case_not_found" };
	}
	const baseline = evalCase.threshold;

	let score: number | undefined;
	try {
		score = await deps.runCase(caseId);
	} catch (e) {
		deps.log?.("warn", `评测 runner 失败，保守不动技能：${e instanceof Error ? e.message : String(e)}`, {
			proposalId,
			caseId,
		});
	}
	if (score === undefined) {
		return {
			proposalId,
			skill: proposal.target,
			caseId,
			baseline,
			verified: false,
			rolledBack: false,
			reason: "runner_failed",
		};
	}

	if (score < baseline) {
		// 证伪：分数低于人写基线 → 整目录回滚 + 标 stale
		const rolledBack = rollbackAndStale(proposal, deps, { caseId, score, baseline, now });
		return {
			proposalId,
			skill: proposal.target,
			caseId,
			score,
			baseline,
			verified: false,
			rolledBack,
			reason: "below_baseline",
		};
	}

	// 通过：回写 verified_by（只动 frontmatter，正文不动）
	deps.skills.setVerified(proposal.target, {
		caseId,
		score,
		verifiedAt: now().toISOString(),
	});
	return { proposalId, skill: proposal.target, caseId, score, baseline, verified: true, rolledBack: false };
}

/** 取提案载荷里的 caseId（skill 类才有） */
function caseOf(payload: unknown): string | undefined {
	const p = payload as { caseId?: unknown } | null | undefined;
	return typeof p?.caseId === "string" && p.caseId ? p.caseId : undefined;
}

function rollbackAndStale(
	proposal: EvolutionProposal,
	deps: VerifyDeps,
	_info: { caseId: string; score: number; baseline: number; now: () => Date },
): boolean {
	const target = proposal.target;
	try {
		if (proposal.snapshotPath) deps.skills.rollback(proposal.snapshotPath);
		// 回滚可能把「本次新建的技能」整个删掉——那时 setState 无事可做，不算失败
		deps.skills.setState(target, "stale");
	} catch (e) {
		deps.log?.("error", `回滚失败（技能库可能处于中间态，需人工介入）：${e instanceof Error ? e.message : String(e)}`, {
			proposalId: proposal.proposalId,
			snapshot: proposal.snapshotPath,
		});
		return false;
	}
	return true;
}

/**
 * apply → verify 的串行封装（口径③：两者之间不允许插入其他 apply）。
 * 返回 verify 结果；`apply` 失败时不做评测（没落盘就没什么可准入的）。
 */
export async function applyThenVerify(
	proposalId: string,
	decidedBy: string,
	applyDeps: Omit<ApplyDeps, "proposals"> & { proposals: ProposalStore },
	verifyDeps: VerifyDeps,
): Promise<{ apply: ApplyOutcome; verify?: VerifyOutcome }> {
	const applied = await applyProposal(proposalId, decidedBy, { ...applyDeps, proposals: applyDeps.proposals });
	if (!applied.ok || applied.status !== "applied") return { apply: applied };

	// 记忆 / 运行约定没有 eval case，不跑闸门（它们不参与判定，只是提示层）
	const proposal = await applyDeps.proposals.get(proposalId);
	if (!proposal || proposal.kind !== "skill") return { apply: applied };

	const verify = await verifySkill(proposalId, verifyDeps);
	if (verify.rolledBack) {
		proposal.status = "rolled_back";
		proposal.rolledBackAt = (verifyDeps.now ?? (() => new Date()))().toISOString();
		await applyDeps.proposals.update(proposal);
		await auditTransition(
			{
				audit: verifyDeps.audit,
				sessionId: verifyDeps.sessionId,
				environment: verifyDeps.environment,
				...(verifyDeps.now ? { now: verifyDeps.now } : {}),
				...(verifyDeps.log ? { log: verifyDeps.log } : {}),
			},
			proposal,
			"evolution_rolled_back",
			`case ${verify.caseId} score ${verify.score} < baseline ${verify.baseline}`,
		);
	}
	return { apply: applied, verify };
}
