/**
 * memory/audit —— 记忆写入 / 遗忘的**审计双写**（P15-98 / §15.9 第 3 条 + §10.9 双写口径）。
 *
 * ### 为什么必须显式双写，而不靠现有的 audit-hook
 *
 * `host/l1a/audit-hook.ts` 记的是**模型发起的工具调用**，而记忆写入**根本不是工具调用**
 * —— 它由 L2 确定性代码（`MemoryStoreBridge.write`）发起，那条路上没有任何钩子会经过。
 * 不显式补一条，本阶段最有合规意义的动作（「往此后所有会话的注入面写了一条东西」）
 * 就会是审计里唯一查不到的事。
 *
 * ### 正文不入（硬约束 6）
 *
 * 审计表是**合规证据，不是记忆副本**。载荷里只放「足以定位与核对」的字段：
 *
 *   | 字段 | 回答什么问题 |
 *   |---|---|
 *   | `id` | 撤销时用哪个 id（`fiat memory forget <id>`） |
 *   | `hash` | 这条记忆是不是我以为的那条（不存正文也能比对） |
 *   | `length` | 长度异常（突然 300 字）是想找的信号之一 |
 *   | `kind` / `scope` | 归类与隔离边界是否被改动 |
 *   | `collection` | 落到哪个分区（人肉核对最直接的线索） |
 *   | `evidenceSessionId` | 溯源链的第一跳（哪次会话产生的） |
 *
 * `hash` 取 sha256 **前 16 位**：它的用途是「比对是不是同一条」，不是防碰撞 ——
 * 越短越不会让人误以为它是可逆的密文。
 *
 * ### 永不抛
 *
 * 审计写失败**不该回滚已经发生的记忆写入**（写入是幂等的、可重试的；审计是旁路）。
 * 所以本模块的每个函数都吞掉异常并 `log`。这与 `audit-hook` 的处置相反（那里
 * audit 失败会让工具调用失败），理由是**风险归属不同**：工具调用失败可以重试，
 * 而记忆已经写进 RAG 了，「审计失败」不能把它拿回来。
 */

import type { AuditClient, AuditOutcome, AuditRecord } from "../audit/client.ts";
import type { FiatUser } from "../policy/engine.ts";
import type { MemoryEntry, MemoryForgetResult } from "./types.ts";

export interface MemoryAuditContext {
	audit: AuditClient;
	user: FiatUser;
	environment: string;
	/** **主**会话 id（不是提取 fork 的临时 id） */
	sessionId: string;
	now?: () => Date;
	log?: (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;
}

/** 写入 / 失败 / 遗忘三个结论（`AuditOutcome` 只增不改，与 `P12-69` 同口径） */
export const MEMORY_AUDIT_OUTCOMES = {
	written: "memory_written",
	writeFailed: "memory_write_failed",
	forgotten: "memory_forgotten",
} as const satisfies Record<string, AuditOutcome>;

/** 记忆审计载荷（**正文不入**）。纯函数，导出以便单测逐字段钉住「没有 text」。 */
export function memoryAuditPayload(entry: MemoryEntry, hash: string): Record<string, unknown> {
	return {
		id: entry.id,
		hash,
		length: entry.text.length,
		kind: entry.kind,
		scope: entry.scope,
		collection: `fiat_memory_${entry.scope}_${entry.key}`,
		evidenceSessionId: entry.evidence.sessionId,
		...(entry.supersedes.length > 0 ? { supersedes: entry.supersedes.length } : {}),
		...(entry.promotedFrom && entry.promotedFrom.length > 0 ? { promotedFrom: entry.promotedFrom.length } : {}),
	};
}

async function record(ctx: MemoryAuditContext, r: Omit<AuditRecord, "ts" | "user" | "environment" | "sessionId">) {
	try {
		await ctx.audit.record({
			ts: (ctx.now ?? (() => new Date()))().toISOString(),
			sessionId: ctx.sessionId,
			user: ctx.user,
			environment: ctx.environment,
			...r,
		});
	} catch (e) {
		ctx.log?.("warn", `记忆审计写入失败（不影响记忆本身）：${e instanceof Error ? e.message : String(e)}`, {
			tool: r.tool,
			outcome: r.outcome,
		});
	}
}

/**
 * 记一条「写入成功 / 失败」。
 *
 * `hash` 由调用方算好传进来（`store.ts` 有 `node:crypto`，而本模块刻意不 import 任何
 * 加密原语 —— 它只负责**形状**，不负责算法）。失败时 `detail` 只放原因，不放正文。
 */
export async function auditMemoryWrite(
	ctx: MemoryAuditContext,
	entry: MemoryEntry,
	hash: string,
	opts: { ok: boolean; reason?: string } = { ok: true },
): Promise<void> {
	await record(ctx, {
		tool: "memory_store",
		input: memoryAuditPayload(entry, hash),
		isError: !opts.ok,
		outcome: opts.ok ? MEMORY_AUDIT_OUTCOMES.written : MEMORY_AUDIT_OUTCOMES.writeFailed,
		...(opts.reason ? { detail: opts.reason } : {}),
	});
}

/** 记一次遗忘（`ids` 是请求撤销的，`result.notFound` 是对端没找到的） */
export async function auditMemoryForget(
	ctx: MemoryAuditContext,
	result: MemoryForgetResult,
	ids: readonly string[],
): Promise<void> {
	await record(ctx, {
		tool: "memory_forget",
		// 只记 id 与计数：遗忘的记录本身不该留下正文（它可能正是因为「不该被记住」才被忘的）
		input: {
			ids: [...ids],
			mode: result.mode ?? "delete",
			forgotten: result.forgotten,
			notFound: result.notFound.length,
		},
		isError: false,
		outcome: MEMORY_AUDIT_OUTCOMES.forgotten,
		...(result.notFound.length > 0 ? { detail: `not_found: ${result.notFound.join(", ")}` } : {}),
	});
}
