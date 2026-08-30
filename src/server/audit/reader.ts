/**
 * 审计读能力（阶段 5 / P5-22 审计后台）。
 *
 * 写侧是 AuditClient（audit-hook / approval 生命周期落库）；读侧是 AuditReader，供
 * L2 后台按条件检索审计记录。L2 真实服务会把两者挂到同一个 PG 库上；本仓库无 Fastify，
 * 故只交付「读逻辑」，挂载 HTTP 端点留作后续（需要 Fastify）。
 *
 * 两个实现共用同一接口（工厂注入）：
 *   - InMemoryAuditReader：测试 / 本地，从 AuditClient.entries() 读取
 *   - PgAuditReader：注入 query 函数，不硬依赖 pg
 */

import type { AuditRecord } from "./client.ts";

export interface AuditQuery {
	tool?: string;
	userId?: string;
	environment?: string;
	outcome?: string;
	sessionId?: string;
	limit?: number;
}

export interface AuditReader {
	query(q: AuditQuery): Promise<AuditRecord[]>;
}

export class InMemoryAuditReader implements AuditReader {
	private readonly source: () => readonly AuditRecord[];

	constructor(source: () => readonly AuditRecord[]) {
		this.source = source;
	}

	async query(q: AuditQuery): Promise<AuditRecord[]> {
		let rows = [...this.source()];
		if (q.tool) rows = rows.filter((r) => r.tool === q.tool);
		if (q.userId) rows = rows.filter((r) => r.user.id === q.userId);
		if (q.environment) rows = rows.filter((r) => r.environment === q.environment);
		if (q.outcome) rows = rows.filter((r) => r.outcome === q.outcome);
		if (q.sessionId) rows = rows.filter((r) => r.sessionId === q.sessionId);
		rows.sort((a, b) => b.ts.localeCompare(a.ts));
		return q.limit ? rows.slice(0, q.limit) : rows;
	}
}

/** 真实 L2 PG 实现：注入 query 函数（pg.Pool.query 适配），不硬依赖 pg。 */
export class PgAuditReader implements AuditReader {
	private readonly dbQuery: (sql: string, params: unknown[]) => Promise<unknown>;

	constructor(dbQuery: (sql: string, params: unknown[]) => Promise<unknown>) {
		this.dbQuery = dbQuery;
	}

	private static fromRow(r: Record<string, unknown>): AuditRecord {
		return {
			ts: r.ts as string,
			sessionId: r.session_id as string,
			user: { id: r.user_id as string, role: r.role as string },
			environment: r.environment as string,
			tool: r.tool as string,
			input: JSON.parse((r.input as string) ?? "{}"),
			isError: Boolean(r.is_error),
			outcome: r.outcome as AuditRecord["outcome"],
			detail: (r.detail as string) ?? undefined,
		};
	}

	async query(q: AuditQuery): Promise<AuditRecord[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		let i = 1;
		for (const [k, col] of [
			["tool", "tool"],
			["userId", "user_id"],
			["environment", "environment"],
			["outcome", "outcome"],
			["sessionId", "session_id"],
		] as const) {
			const v = q[k];
			if (v != null) {
				where.push(`${col}=$${i++}`);
				params.push(v);
			}
		}
		const sql = `SELECT * FROM fiat_audit_log${
			where.length ? ` WHERE ${where.join(" AND ")}` : ""
		} ORDER BY ts DESC LIMIT $${i}`;
		params.push(q.limit ?? 100);
		const rows = (await this.dbQuery(sql, params)) as Record<string, unknown>[];
		return rows.map(PgAuditReader.fromRow);
	}
}
