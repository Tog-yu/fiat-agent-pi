/**
 * 自进化存储（阶段 12 / P12-69 前置）—— 提案与 run 两张表的落点。
 *
 * 与 `audit/client.ts` / `eval/sink.ts` 完全同构的注入式模式：
 *   - InMemory*：测试 / 本地，零依赖，带 `entries()` 断言口
 *   - Pg*：真实 L2，注入 `query` 函数（不硬依赖 pg）
 *
 * ⚠️ **双写口径**（§10.9）：提案正文与状态进 `fiat_evolution_*`；每次**状态迁移**
 * 同时追加一条 `fiat_audit_log`。审计是合规事实（只追加、用于追责），提案表是可编辑的
 * 状态机 —— 与阶段 11 评测表 / 审计表分离的理由同源。双写的执行点在 `apply.ts`
 * （状态迁移的唯一入口），不在这里——存储层只负责持久化，不负责跨表一致性。
 *
 * 幂等键 = `hash(target + 归一化正文)`（§10.9）：同一 session 反复触发不会重复落盘。
 * 归一化在 `policy.ts` 的 `normalizeProposalText`（与相似度检测共用一套）。
 */

import { createHash } from "node:crypto";
import { normalizeProposalText } from "./policy.ts";
import type { EvolutionProposal, EvolutionRun, ProposalPayload, ProposalStatus } from "./types.ts";

/** 幂等键：`sha256(target + 归一化正文)`；kind 也进哈希，避免同名 target 的 skill/memory 撞键 */
export function proposalHash(kind: string, target: string, payload: ProposalPayload): string {
	const norm = normalizeProposalText(payload);
	return createHash("sha256").update(`${kind}\u0000${target}\u0000${norm}`).digest("hex");
}

export interface ProposalFilter {
	runId?: string;
	sessionId?: string;
	status?: ProposalStatus;
	kind?: EvolutionProposal["kind"];
}

export interface ProposalStore {
	insert(p: EvolutionProposal): Promise<void>;
	get(proposalId: string): Promise<EvolutionProposal | null>;
	update(p: EvolutionProposal): Promise<void>;
	findByHash(hash: string): Promise<EvolutionProposal | null>;
	list(filter?: ProposalFilter): Promise<EvolutionProposal[]>;
}

export interface RunFilter {
	sessionId?: string;
}

export interface EvolutionRunStore {
	insert(r: EvolutionRun): Promise<void>;
	update(r: EvolutionRun): Promise<void>;
	get(runId: string): Promise<EvolutionRun | null>;
	list(filter?: RunFilter): Promise<EvolutionRun[]>;
}

function matchProposal(p: EvolutionProposal, f?: ProposalFilter): boolean {
	if (!f) return true;
	if (f.runId && p.runId !== f.runId) return false;
	if (f.sessionId && p.sessionId !== f.sessionId) return false;
	if (f.status && p.status !== f.status) return false;
	if (f.kind && p.kind !== f.kind) return false;
	return true;
}

export class InMemoryProposalStore implements ProposalStore {
	readonly #m = new Map<string, EvolutionProposal>();

	async insert(p: EvolutionProposal): Promise<void> {
		this.#m.set(p.proposalId, p);
	}

	async get(proposalId: string): Promise<EvolutionProposal | null> {
		return this.#m.get(proposalId) ?? null;
	}

	async update(p: EvolutionProposal): Promise<void> {
		this.#m.set(p.proposalId, p);
	}

	async findByHash(hash: string): Promise<EvolutionProposal | null> {
		for (const p of this.#m.values()) if (p.contentHash === hash) return p;
		return null;
	}

	async list(filter?: ProposalFilter): Promise<EvolutionProposal[]> {
		return this.entries().filter((p) => matchProposal(p, filter));
	}

	/** 仅本地实现提供的同步列举（测试断言用） */
	entries(): EvolutionProposal[] {
		return [...this.#m.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
}

export class InMemoryRunStore implements EvolutionRunStore {
	readonly #m = new Map<string, EvolutionRun>();

	async insert(r: EvolutionRun): Promise<void> {
		this.#m.set(r.runId, r);
	}

	async update(r: EvolutionRun): Promise<void> {
		this.#m.set(r.runId, r);
	}

	async get(runId: string): Promise<EvolutionRun | null> {
		return this.#m.get(runId) ?? null;
	}

	async list(filter?: RunFilter): Promise<EvolutionRun[]> {
		return this.entries().filter((r) => !filter?.sessionId || r.sessionId === filter.sessionId);
	}

	entries(): EvolutionRun[] {
		return [...this.#m.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}
}

/** 真实 L2 PG 实现：注入 query，不硬依赖 pg */
export class PgProposalStore implements ProposalStore {
	private readonly query: (sql: string, params: unknown[]) => Promise<unknown>;

	constructor(query: (sql: string, params: unknown[]) => Promise<unknown>) {
		this.query = query;
	}

	private static fromRow(r: Record<string, unknown>): EvolutionProposal {
		const json = <T>(v: unknown): T | undefined => (v == null ? undefined : (JSON.parse(v as string) as T));
		return {
			proposalId: r.proposal_id as string,
			runId: r.run_id as string,
			sessionId: r.session_id as string,
			proposer: r.proposer as string,
			kind: r.kind as EvolutionProposal["kind"],
			target: r.target as string,
			title: r.title as string,
			payload: JSON.parse(r.payload as string) as ProposalPayload,
			contentHash: r.content_hash as string,
			status: r.status as ProposalStatus,
			decision: json<EvolutionProposal["decision"]>(r.decision),
			decisionRule: (r.decision_rule as EvolutionProposal["decisionRule"]) ?? undefined,
			decidedBy: (r.decided_by as string) ?? undefined,
			decidedAt: (r.decided_at as string) ?? undefined,
			appliedAt: (r.applied_at as string) ?? undefined,
			snapshotPath: (r.snapshot_path as string) ?? undefined,
			rolledBackAt: (r.rolled_back_at as string) ?? undefined,
			createdAt: r.created_at as string,
		};
	}

	async insert(p: EvolutionProposal): Promise<void> {
		await this.query(
			`INSERT INTO fiat_evolution_proposal
         (proposal_id, run_id, session_id, proposer, kind, target, title, payload, content_hash, status,
          decision, decision_rule, decided_by, decided_at, applied_at, snapshot_path, rolled_back_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			[
				p.proposalId,
				p.runId,
				p.sessionId,
				p.proposer,
				p.kind,
				p.target,
				p.title,
				JSON.stringify(p.payload),
				p.contentHash,
				p.status,
				p.decision ? JSON.stringify(p.decision) : null,
				p.decisionRule ?? null,
				p.decidedBy ?? null,
				p.decidedAt ?? null,
				p.appliedAt ?? null,
				p.snapshotPath ?? null,
				p.rolledBackAt ?? null,
				p.createdAt,
			],
		);
	}

	async get(proposalId: string): Promise<EvolutionProposal | null> {
		const rows = (await this.query("SELECT * FROM fiat_evolution_proposal WHERE proposal_id=$1", [
			proposalId,
		])) as Record<string, unknown>[];
		return rows[0] ? PgProposalStore.fromRow(rows[0]) : null;
	}

	async update(p: EvolutionProposal): Promise<void> {
		await this.query(
			`UPDATE fiat_evolution_proposal
         SET status=$2, decision=$3, decision_rule=$4, decided_by=$5, decided_at=$6,
             applied_at=$7, snapshot_path=$8, rolled_back_at=$9
       WHERE proposal_id=$1`,
			[
				p.proposalId,
				p.status,
				p.decision ? JSON.stringify(p.decision) : null,
				p.decisionRule ?? null,
				p.decidedBy ?? null,
				p.decidedAt ?? null,
				p.appliedAt ?? null,
				p.snapshotPath ?? null,
				p.rolledBackAt ?? null,
			],
		);
	}

	async findByHash(hash: string): Promise<EvolutionProposal | null> {
		const rows = (await this.query(
			"SELECT * FROM fiat_evolution_proposal WHERE content_hash=$1 ORDER BY created_at DESC LIMIT 1",
			[hash],
		)) as Record<string, unknown>[];
		return rows[0] ? PgProposalStore.fromRow(rows[0]) : null;
	}

	async list(filter?: ProposalFilter): Promise<EvolutionProposal[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		if (filter?.runId) {
			params.push(filter.runId);
			where.push(`run_id=$${params.length}`);
		}
		if (filter?.sessionId) {
			params.push(filter.sessionId);
			where.push(`session_id=$${params.length}`);
		}
		if (filter?.status) {
			params.push(filter.status);
			where.push(`status=$${params.length}`);
		}
		if (filter?.kind) {
			params.push(filter.kind);
			where.push(`kind=$${params.length}`);
		}
		const sql = `SELECT * FROM fiat_evolution_proposal${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
		const rows = (await this.query(sql, params)) as Record<string, unknown>[];
		return rows.map((r) => PgProposalStore.fromRow(r));
	}
}

export class PgRunStore implements EvolutionRunStore {
	private readonly query: (sql: string, params: unknown[]) => Promise<unknown>;

	constructor(query: (sql: string, params: unknown[]) => Promise<unknown>) {
		this.query = query;
	}

	private static fromRow(r: Record<string, unknown>): EvolutionRun {
		return {
			runId: r.run_id as string,
			sessionId: r.session_id as string,
			trigger: r.trigger as EvolutionRun["trigger"],
			toolSteps: Number(r.tool_steps ?? 0),
			turns: Number(r.turns ?? 0),
			model: (r.model as string) ?? undefined,
			promptVersion: r.prompt_version as string,
			proposalsN: Number(r.proposals_n ?? 0),
			status: r.status as EvolutionRun["status"],
			startedAt: r.started_at as string,
			finishedAt: (r.finished_at as string) ?? undefined,
			error: (r.error as string) ?? undefined,
		};
	}

	async insert(r: EvolutionRun): Promise<void> {
		await this.query(
			`INSERT INTO fiat_evolution_run
         (run_id, session_id, trigger, tool_steps, turns, model, prompt_version, proposals_n, status, started_at, finished_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			[
				r.runId,
				r.sessionId,
				r.trigger,
				r.toolSteps,
				r.turns,
				r.model ?? null,
				r.promptVersion,
				r.proposalsN,
				r.status,
				r.startedAt,
				r.finishedAt ?? null,
				r.error ?? null,
			],
		);
	}

	async update(r: EvolutionRun): Promise<void> {
		await this.query(
			`UPDATE fiat_evolution_run
         SET proposals_n=$2, status=$3, finished_at=$4, error=$5
       WHERE run_id=$1`,
			[r.runId, r.proposalsN, r.status, r.finishedAt ?? null, r.error ?? null],
		);
	}

	async get(runId: string): Promise<EvolutionRun | null> {
		const rows = (await this.query("SELECT * FROM fiat_evolution_run WHERE run_id=$1", [runId])) as Record<
			string,
			unknown
		>[];
		return rows[0] ? PgRunStore.fromRow(rows[0]) : null;
	}

	async list(filter?: RunFilter): Promise<EvolutionRun[]> {
		const params: unknown[] = [];
		let sql = "SELECT * FROM fiat_evolution_run";
		if (filter?.sessionId) {
			params.push(filter.sessionId);
			sql += " WHERE session_id=$1";
		}
		sql += " ORDER BY started_at";
		const rows = (await this.query(sql, params)) as Record<string, unknown>[];
		return rows.map((r) => PgRunStore.fromRow(r));
	}
}
