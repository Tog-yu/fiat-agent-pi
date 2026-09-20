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
import { LANGFUSE_KEYS, OBS_TYPE } from "../tracing/otlp.ts";
import { type AttributeValue, resolveTracing, type SpanHandle, type TracingSource } from "../tracing/types.ts";

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
	/** 列出全部工单（按创建时间倒序）；CLI / 后台列表用 */
	list(): Promise<ApprovalTicketRecord[]>;
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

	async list(): Promise<ApprovalTicketRecord[]> {
		return this.entries();
	}

	/** 仅本地实现提供的列举能力（CLI / 后台列表用）；TicketStore 接口不强制，PG 侧走 SQL 查询 */
	entries(): ApprovalTicketRecord[] {
		return [...this.#m.values()].sort((a, b) => b.createdAt - a.createdAt);
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

	async list(): Promise<ApprovalTicketRecord[]> {
		const rows = (await this.query("SELECT * FROM fiat_approval_tickets ORDER BY created_at DESC", [])) as Record<
			string,
			unknown
		>[];
		return rows.map((r) => PgTicketStore.fromRow(r));
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
	/**
	 * 阶段 14（P14-88）：全链路追踪。**缺省 undefined = 完全不开**（零开销）。
	 *
	 * 审批链是「LLM 之外」的确定性流程，追踪对它尤其重要：工单从建单到执行中间隔着**人**的
	 * 一段时间，这段在审计表里只有一个 `ticket_created` 和一个 `applied`。有了 span 之后
	 * 「审批卡推出去多久才被点通过、apply 时是 policy 拒的还是 token 失效」才第一次可见。
	 */
	tracing?: TracingSource;
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
	private readonly tracing?: TracingSource;

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
		this.tracing = d.tracing;
	}

	/**
	 * 审批链子 span 的统一入口；未开追踪 / 未采样 / 尚未开始任何一轮 → undefined，调用点用 `?.`。
	 *
	 * 收**取值器**：工单的三个动作（create / approve / apply）分别发生在不同时刻——
	 * `create` 在某一轮工具调用里，`approve` / `apply` 往往在**人点完卡片之后**（那时可能已经
	 * 换了一轮、甚至换了进程）。只有等到调用那一刻才知道该挂到哪条 trace 上。
	 */
	#span(name: string, attrs: Record<string, AttributeValue>): SpanHandle | undefined {
		const w = resolveTracing(this.tracing);
		if (!w?.trace.sampled) return undefined;
		return w.tracer.startSpan(w.trace, name, {
			kind: "internal",
			// 挂进**当前轮**（`fiat.turn`）而不是 trace 根：`approve` / `apply` 常常发生在
			// 人点完卡片之后，若那时没有"当前轮"，`turnSpanId` 已清空 → 退回会话默认父 / 根。
			// 指明父的收益在蜂群场景最明显：子会话的 trace 根是**告警** span，
			// 不指明父的话 `fiat.ticket.*` 会直接挂到告警上、跳出视角树枝。
			parentSpanId: w.turnSpanId ?? w.parentSpanId ?? w.trace.rootSpanId,
			attributes: { [LANGFUSE_KEYS.obsType]: OBS_TYPE.span, "fiat.ticket.stage": name, ...attrs },
		});
	}

	/** dry-run 之后调用：建单(pending) + 一次性 token + 推 Lark 卡。 */
	async requestApply(input: RequestApplyInput): Promise<RequestApplyResult> {
		const span = this.#span("fiat.ticket.create", {
			"fiat.tool.name": input.tool,
			"fiat.ticket.idempotency_key": input.idempotencyKey,
			"fiat.ticket.environment": input.subject.environment,
		});
		// 有多条 early-return 分支，统一经 finish 收口，避免漏关 span（span 漏关 = 树上一个洞）
		const finish = (r: RequestApplyResult, replayed: boolean): RequestApplyResult => {
			span?.setAttribute("fiat.ticket.id", r.ticketId);
			span?.setAttribute("fiat.ticket.status", r.status);
			span?.setAttribute("fiat.ticket.replayed", replayed);
			span?.setStatus("ok");
			span?.end();
			return r;
		};

		// 幂等：相同键已存在则重放（pending 重签 token，避免重复 Lark 推送）
		const existing = await this.store.findByKey(input.idempotencyKey);
		if (existing) {
			if (existing.status === "applied" || existing.status === "rejected") {
				return finish({ ticketId: existing.ticketId, token: "", status: existing.status }, true);
			}
			if (existing.status === "expired") {
				// 过期单不重放，重新建单
			} else {
				const token = this.genToken();
				existing.tokenHash = this.sha256(token);
				existing.expiresAt = this.now() + this.tokenTtlMs;
				await this.store.update(existing);
				return finish({ ticketId: existing.ticketId, token, status: existing.status }, true);
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
		return finish({ ticketId: ticket.ticketId, token, status: "pending" }, false);
	}

	/** Lark 卡片「通过」回调（L2 内部调用，非模型）：pending → approved。 */
	async approve(ticketId: string): Promise<ApprovalTicketRecord> {
		const span = this.#span("fiat.ticket.approve", { "fiat.ticket.id": ticketId });
		try {
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
			span?.setAttribute("fiat.ticket.status", "approved");
			span?.setStatus("ok");
			return t;
		} catch (error) {
			span?.setStatus("error", error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			span?.end();
		}
	}

	async reject(ticketId: string, reason = "rejected by approver"): Promise<ApprovalTicketRecord> {
		const span = this.#span("fiat.ticket.reject", { "fiat.ticket.id": ticketId });
		try {
			const t = await this.store.get(ticketId);
			if (!t) throw new Error(`ticket ${ticketId} not found`);
			if (t.status !== "pending") throw new Error(`ticket ${ticketId} not pending (${t.status})`);
			t.status = "rejected";
			await this.store.update(t);
			await this.#audit("ticket_rejected", t, reason);
			span?.setAttribute("fiat.ticket.status", "rejected");
			// 人拒了不是故障，是流程正常走完 —— WARNING 而非 ERROR
			span?.setLevel("WARNING");
			return t;
		} catch (error) {
			span?.setStatus("error", error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			span?.end();
		}
	}

	/** 列出全部工单（CLI `fiat tickets` / 后台用）；按创建时间倒序 */
	async list(): Promise<ApprovalTicketRecord[]> {
		return this.store.list();
	}

	/**
	 * fiat_job_apply 调用：复核 + 执行。返回结构化结果，业务失败也 ok:false（不抛），
	 * 工具侧以 isError:false 回灌模型，避免重试绕行。
	 */
	async apply(ticketId: string, token: string): Promise<ApplyResult> {
		const span = this.#span("fiat.ticket.apply", { "fiat.ticket.id": ticketId });
		const done = (r: ApplyResult): ApplyResult => {
			span?.setAttribute("fiat.ticket.result", r.ok ? "applied" : r.code);
			if (r.ok) {
				span?.setAttribute("fiat.ticket.status", "applied");
				span?.setAttribute("fiat.tool.name", r.tool);
				span?.setStatus("ok");
			} else {
				// 「未审批 / token 不对 / policy 拒」都是**预期内的业务结论**，不是故障：
				// 用 WARNING 让它在 trace 列表里显眼，但不污染错误率
				span?.setLevel("WARNING");
				span?.setAttribute("fiat.ticket.message", r.message);
			}
			span?.end();
			return r;
		};

		const t = await this.store.get(ticketId);
		if (!t) return done({ ok: false, code: "not_found", message: `ticket ${ticketId} not found` });
		if (this.now() > t.expiresAt) {
			t.status = "expired";
			await this.store.update(t);
			return done({ ok: false, code: "expired", message: `ticket ${ticketId} expired` });
		}
		if (t.status !== "approved") {
			return done({ ok: false, code: "pending_approval", message: `ticket ${ticketId} pending approval` });
		}
		if (this.sha256(token) !== t.tokenHash) {
			return done({ ok: false, code: "invalid_token", message: "invalid one-time token" });
		}
		// L2 再查一次：不信任 L1 放行结论
		const verdict = await this.policy.canExecute({
			user: { id: t.subject.userId, role: t.subject.role },
			tool: t.tool,
			environment: t.subject.environment,
			input: t.payload,
		});
		if (!verdict.allowed) {
			return done({ ok: false, code: "denied", message: verdict.reason ?? "denied by policy" });
		}
		const result = await this.fiat.applyTool(t.tool, t.payload);
		t.status = "applied";
		t.appliedAt = this.now();
		await this.store.update(t);
		await this.#audit("applied", t);
		return done({ ok: true, appliedAt: t.appliedAt, tool: t.tool, result });
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
