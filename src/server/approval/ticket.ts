/**
 * 审批工单（阶段 5 / P5-19）—— L2 审批链的唯一权威实现。
 *
 * 设计（见 DEV_SPEC §4 审批链路、§6 数据流）：
 *
 *   dry-run → requestApply → 建 ticket(pending) + 签发一次性 token(sha256 存储) + 推 Lark 卡
 *           → 人点通过 → approve → status=approved
 *           → fiat_job_apply(ticket_id, token) → apply：复核 canExecute + token 匹配 + 未过期
 *             → 执行底层变更（FiatToolClient.applyTool）→ status=applied → 写审计
 *
 * 关键隔离边界：
 *   - token 明文只回给模型一次（requestApply 返回），库里只存 sha256；job_apply 必须
 *     status==approved 且 token 匹配且未过期，模型无法在审批前写数据。
 *   - apply 时 L2 再调一次 canExecute（「再查一次」），不信任 L1 的放行结论。
 *   - 幂等键：相同 (tool+idempotencyKey) 不建重复 ticket；pending 重放会重签 token。
 *
 * 纯逻辑、可注入时钟/哈希/ID，便于离线单测；PgTicketStore 仅注入 query 函数，不硬依赖 pg。
 */

import type { AuditClient, AuditOutcome } from "../audit/client.ts";
import type { FiatToolClient, FiatToolResult } from "../fiat-tools/client.ts";
import type { PolicyClient } from "../policy/client.ts";

export type TicketStatus = "pending" | "approved" | "rejected" | "applied" | "expired";

export interface TicketSubject {
	userId: string;
	role: string;
	environment: string;
}

export interface ApprovalTicketRecord {
	ticketId: string;
	/** 底层 L4 工具名（如 cashback_reconcile），apply 时复核 canExecute 用 */
	tool: string;
	subject: TicketSubject;
	/** 待执行的变更参数（变更计划） */
	payload: Record<string, unknown>;
	status: TicketStatus;
	/** 幂等键：相同键不重复建单 */
	idempotencyKey: string;
	/** token 的 sha256；明文不落库 */
	tokenHash: string;
	expiresAt: number;
	createdAt: number;
	approvedAt?: number;
	appliedAt?: number;
	larkMessageId?: string;
}

/** 存储抽象：InMemory 实现供测试；Pg 实现供真实 L2（注入 query 函数）。 */
export interface TicketStore {
	insert(t: ApprovalTicketRecord): Promise<void>;
	get(ticketId: string): Promise<ApprovalTicketRecord | null>;
	update(t: ApprovalTicketRecord): Promise<void>;
	findByKey(key: string): Promise<ApprovalTicketRecord | null>;
}

export class InMemoryTicketStore implements TicketStore {
	readonly #m = new Map<string, ApprovalTicketRecord>();
	readonly #byKey = new Map<string, string>();

	async insert(t: ApprovalTicketRecord): Promise<void> {
		this.#m.set(t.ticketId, t);
		this.#byKey.set(t.idempotencyKey, t.ticketId);
	}

	async get(ticketId: string): Promise<ApprovalTicketRecord | null> {
		return this.#m.get(ticketId) ?? null;
	}

	async update(t: ApprovalTicketRecord): Promise<void> {
		this.#m.set(t.ticketId, t);
	}

	async findByKey(key: string): Promise<ApprovalTicketRecord | null> {
		const id = this.#byKey.get(key);
		return id ? (this.#m.get(id) ?? null) : null;
	}
}

/** 真实 L2 PG 实现：注入 query 函数（pg.Pool.query 适配），不硬依赖 pg。 */
export class PgTicketStore implements TicketStore {
	private readonly query: (sql: string, params: unknown[]) => Promise<unknown>;

	constructor(query: (sql: string, params: unknown[]) => Promise<unknown>) {
		this.query = query;
	}

	private static fromRow(r: Record<string, unknown>): ApprovalTicketRecord {
		return {
			ticketId: r.ticket_id as string,
			tool: r.tool as string,
			subject: JSON.parse(r.subject as string) as TicketSubject,
			payload: JSON.parse(r.payload as string) as Record<string, unknown>,
			status: r.status as TicketStatus,
			idempotencyKey: r.idempotency_key as string,
			tokenHash: r.token_hash as string,
			expiresAt: Number(r.expires_at),
			createdAt: Number(r.created_at),
			approvedAt: r.approved_at == null ? undefined : Number(r.approved_at),
			appliedAt: r.applied_at == null ? undefined : Number(r.applied_at),
			larkMessageId: (r.lark_message_id as string) ?? undefined,
		};
	}

	async insert(t: ApprovalTicketRecord): Promise<void> {
		await this.query(
			`INSERT INTO fiat_approval_tickets
         (ticket_id, tool, subject, payload, status, idempotency_key, token_hash, expires_at, created_at, lark_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				t.ticketId,
				t.tool,
				JSON.stringify(t.subject),
				JSON.stringify(t.payload),
				t.status,
				t.idempotencyKey,
				t.tokenHash,
				t.expiresAt,
				t.createdAt,
				t.larkMessageId ?? null,
			],
		);
	}

	async get(ticketId: string): Promise<ApprovalTicketRecord | null> {
		const rows = (await this.query("SELECT * FROM fiat_approval_tickets WHERE ticket_id=$1", [ticketId])) as Record<
			string,
			unknown
		>[];
		return rows[0] ? PgTicketStore.fromRow(rows[0]) : null;
	}

	async update(t: ApprovalTicketRecord): Promise<void> {
		await this.query(
			`UPDATE fiat_approval_tickets
         SET status=$2, approved_at=$3, applied_at=$4, lark_message_id=$5
       WHERE ticket_id=$1`,
			[t.ticketId, t.status, t.approvedAt ?? null, t.appliedAt ?? null, t.larkMessageId ?? null],
		);
	}

	async findByKey(key: string): Promise<ApprovalTicketRecord | null> {
		const rows = (await this.query(
			"SELECT * FROM fiat_approval_tickets WHERE idempotency_key=$1 ORDER BY created_at DESC LIMIT 1",
			[key],
		)) as Record<string, unknown>[];
		return rows[0] ? PgTicketStore.fromRow(rows[0]) : null;
	}
}

export interface LarkClientLike {
	sendApprovalCard(card: { ticketId: string; title: string; summary: string }): Promise<{ messageId: string }>;
}

export interface ApprovalDeps {
	store: TicketStore;
	policy: PolicyClient;
	lark: LarkClientLike;
	fiat: FiatToolClient;
	audit?: AuditClient;
	/** 注入式依赖，便于离线确定性测试 */
	now: () => number;
	genId: () => string;
	genToken: () => string;
	sha256: (s: string) => string;
	tokenTtlMs: number;
	/** 审计用的 sessionId（与 tool_result 审计对齐） */
	sessionId: string;
}

export interface RequestApplyInput {
	tool: string;
	subject: TicketSubject;
	payload: Record<string, unknown>;
	idempotencyKey: string;
	/** Lark 卡片标题 + 变更摘要 */
	title: string;
	summary: string;
}

export interface RequestApplyResult {
	ticketId: string;
	/** 一次性 token 明文（仅此处返回一次） */
	token: string;
	status: TicketStatus;
}

export type ApplyResult =
	| { ok: true; appliedAt: number; tool: string; result: FiatToolResult }
	| {
			ok: false;
			code: "not_found" | "expired" | "pending_approval" | "invalid_token" | "denied";
			message: string;
	  };

export class ApprovalService {
	private readonly store: TicketStore;
	private readonly policy: PolicyClient;
	private readonly lark: LarkClientLike;
	private readonly fiat: FiatToolClient;
	private readonly audit?: AuditClient;
	private readonly now: () => number;
	private readonly genId: () => string;
	private readonly genToken: () => string;
	private readonly sha256: (s: string) => string;
	private readonly tokenTtlMs: number;
	private readonly sessionId: string;

	constructor(d: ApprovalDeps) {
		this.store = d.store;
		this.policy = d.policy;
		this.lark = d.lark;
		this.fiat = d.fiat;
		this.audit = d.audit;
		this.now = d.now;
		this.genId = d.genId;
		this.genToken = d.genToken;
		this.sha256 = d.sha256;
		this.tokenTtlMs = d.tokenTtlMs;
		this.sessionId = d.sessionId;
	}

	/** dry-run 之后调用：建单(pending) + 一次性 token + 推 Lark 卡。 */
	async requestApply(input: RequestApplyInput): Promise<RequestApplyResult> {
		// 幂等：相同键已存在则重放（pending 重签 token，避免重复 Lark 推送）
		const existing = await this.store.findByKey(input.idempotencyKey);
		if (existing) {
			if (existing.status === "applied" || existing.status === "rejected") {
				return { ticketId: existing.ticketId, token: "", status: existing.status };
			}
			if (existing.status === "expired") {
				// 过期单不重放，重新建单
			} else {
				const token = this.genToken();
				existing.tokenHash = this.sha256(token);
				existing.expiresAt = this.now() + this.tokenTtlMs;
				await this.store.update(existing);
				return { ticketId: existing.ticketId, token, status: existing.status };
			}
		}

		const now = this.now();
		const token = this.genToken();
		const ticket: ApprovalTicketRecord = {
			ticketId: this.genId(),
			tool: input.tool,
			subject: input.subject,
			payload: input.payload,
			status: "pending",
			idempotencyKey: input.idempotencyKey,
			tokenHash: this.sha256(token),
			expiresAt: now + this.tokenTtlMs,
			createdAt: now,
		};
		await this.store.insert(ticket);
		const { messageId } = await this.lark.sendApprovalCard({
			ticketId: ticket.ticketId,
			title: input.title,
			summary: input.summary,
		});
		ticket.larkMessageId = messageId;
		await this.store.update(ticket);
		await this.#audit("ticket_created", ticket, `Lark card ${messageId}`);
		return { ticketId: ticket.ticketId, token, status: "pending" };
	}

	/** Lark 卡片「通过」回调（L2 内部调用，非模型）：pending → approved。 */
	async approve(ticketId: string): Promise<ApprovalTicketRecord> {
		const t = await this.store.get(ticketId);
		if (!t) throw new Error(`ticket ${ticketId} not found`);
		if (t.status !== "pending") throw new Error(`ticket ${ticketId} not pending (${t.status})`);
		if (this.now() > t.expiresAt) {
			t.status = "expired";
			await this.store.update(t);
			throw new Error(`ticket ${ticketId} expired`);
		}
		t.status = "approved";
		t.approvedAt = this.now();
		await this.store.update(t);
		await this.#audit("ticket_approved", t);
		return t;
	}

	async reject(ticketId: string, reason = "rejected by approver"): Promise<ApprovalTicketRecord> {
		const t = await this.store.get(ticketId);
		if (!t) throw new Error(`ticket ${ticketId} not found`);
		if (t.status !== "pending") throw new Error(`ticket ${ticketId} not pending (${t.status})`);
		t.status = "rejected";
		await this.store.update(t);
		await this.#audit("ticket_rejected", t, reason);
		return t;
	}

	/**
	 * fiat_job_apply 调用：复核 + 执行。返回结构化结果，业务失败也 ok:false（不抛），
	 * 工具侧以 isError:false 回灌模型，避免重试绕行。
	 */
	async apply(ticketId: string, token: string): Promise<ApplyResult> {
		const t = await this.store.get(ticketId);
		if (!t) return { ok: false, code: "not_found", message: `ticket ${ticketId} not found` };
		if (this.now() > t.expiresAt) {
			t.status = "expired";
			await this.store.update(t);
			return { ok: false, code: "expired", message: `ticket ${ticketId} expired` };
		}
		if (t.status !== "approved") {
			return { ok: false, code: "pending_approval", message: `ticket ${ticketId} pending approval` };
		}
		if (this.sha256(token) !== t.tokenHash) {
			return { ok: false, code: "invalid_token", message: "invalid one-time token" };
		}
		// L2 再查一次：不信任 L1 放行结论
		const verdict = await this.policy.canExecute({
			user: { id: t.subject.userId, role: t.subject.role },
			tool: t.tool,
			environment: t.subject.environment,
			input: t.payload,
		});
		if (!verdict.allowed) {
			return { ok: false, code: "denied", message: verdict.reason ?? "denied by policy" };
		}
		const result = await this.fiat.applyTool(t.tool, t.payload);
		t.status = "applied";
		t.appliedAt = this.now();
		await this.store.update(t);
		await this.#audit("applied", t);
		return { ok: true, appliedAt: t.appliedAt, tool: t.tool, result };
	}

	async get(ticketId: string): Promise<ApprovalTicketRecord | null> {
		return this.store.get(ticketId);
	}

	async #audit(outcome: string, t: ApprovalTicketRecord, detail?: string): Promise<void> {
		if (!this.audit) return;
		await this.audit.record({
			ts: new Date(this.now()).toISOString(),
			sessionId: this.sessionId,
			user: { id: t.subject.userId, role: t.subject.role },
			environment: t.subject.environment,
			tool: t.tool,
			input: { ticketId: t.ticketId, idempotencyKey: t.idempotencyKey },
			isError: false,
			outcome: outcome as AuditOutcome,
			detail,
		});
	}
}
