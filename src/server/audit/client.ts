/**
 * Audit client —— 三道闸门之后，把每次工具调用的结果落审计。
 *
 * 三个实现共用同一扩展代码（工厂注入）：
 *   - InMemoryAuditClient：测试 / 本地验证，零依赖
 *   - PgAuditClient：L2 Fastify 服务端用，注入 query 函数（不硬依赖 pg，真实 L2 用 pg.Pool.query 适配）
 *
 * 审计在 tool_result 阶段采集（三道闸门都已裁决之后），记录的是「实际发生了什么」。
 */

import type { FiatUser } from "../policy/engine.ts";

/**
 * 审计结论。
 *
 * 阶段 12（P12-69）扩了四个自进化取值——**只增不改**，与「审计只追加」的语义一致：
 * 自进化本身必须可审计（§10.9 双写口径），而它既不是工具调用也不是业务工单，
 * 硬塞进 `applied` / `ticket_approved` 会让审计查询分不清「谁改了自己的行为」。
 *
 * 阶段 15（P15-98）同理加三个记忆取值：记忆写入由 L2 代码发起、**不是工具调用**，
 * 走不到 `audit-hook`；不显式补一条，本阶段最有合规意义的动作（「往此后所有会话的
 * 注入面写了一条东西」）就会是审计里唯一查不到的事。
 */
export type AuditOutcome =
	| "allowed"
	| "blocked"
	| "error"
	| "ticket_created"
	| "ticket_approved"
	| "ticket_rejected"
	| "applied"
	| "evolution_proposed"
	| "evolution_applied"
	| "evolution_rejected"
	| "evolution_rolled_back"
	| "memory_written"
	| "memory_write_failed"
	| "memory_forgotten";

export interface AuditRecord {
	ts: string;
	sessionId: string;
	user: FiatUser;
	environment: string;
	tool: string;
	input: Record<string, unknown>;
	isError: boolean;
	outcome: AuditOutcome;
	detail?: string;
}

export interface AuditClient {
	record(r: AuditRecord): Promise<void>;
	/** 测试 / 调试：返回已记录条目（可选） */
	entries?(): readonly AuditRecord[];
}

export class InMemoryAuditClient implements AuditClient {
	readonly #log: AuditRecord[] = [];

	async record(r: AuditRecord): Promise<void> {
		this.#log.push(r);
	}

	entries(): readonly AuditRecord[] {
		return this.#log;
	}
}

/** L2 PG 审计实现：注入 query 函数，避免硬依赖 pg（真实 L2 用 pg.Pool.query 适配即可）。 */
export class PgAuditClient implements AuditClient {
	private readonly query: (sql: string, params: unknown[]) => Promise<unknown>;

	constructor(query: (sql: string, params: unknown[]) => Promise<unknown>) {
		this.query = query;
	}

	async record(r: AuditRecord): Promise<void> {
		await this.query(
			`INSERT INTO fiat_audit_log
         (ts, session_id, user_id, role, environment, tool, input, is_error, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				r.ts,
				r.sessionId,
				r.user.id,
				r.user.role,
				r.environment,
				r.tool,
				JSON.stringify(r.input),
				r.isError,
				r.outcome,
				r.detail ?? null,
			],
		);
	}
}
