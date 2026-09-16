/**
 * 告警事件存储（阶段 13 / P13-77）—— 幂等与持久化，零 Pi 依赖。
 *
 * 口径对齐 `approval/ticket.ts`：接口 + InMemory 实现同文件；
 * 未来接 SQLite / PG 时新增实现类，消费方（runner.ts / server.ts）只依赖接口。
 *
 * 幂等判定（DEV_SPEC 阶段 13）：
 *   `SELECT ... WHERE fingerprint = ? AND status = 'firing'` 命中 → 调用方只更
 *   last_seen_at，不重复诊断；未命中 → insert + 触发下游分级。
 *   并发安全：单进程内依赖调用方串行使用（webhook handler 逐条 await）；
 *   将来多实例部署换 SQLite/PG 实现时由数据库唯一索引兜底，本接口不变。
 *
 * InMemory 用 Map 实现，幂等查询 O(n) 扫描（告警量级 ≤ 千，不做索引）；
 * fingerprint 唯一性由 adapters 保证，重复 insert 同指纹 + firing 属调用方 bug，
 * 直接覆盖（append-only 语义由调用方先 findActive 保证）。
 */

import type { AlertEventRecord, AlertEventStore } from "./types.ts";

export class InMemoryAlertEventStore implements AlertEventStore {
	readonly #m = new Map<string, AlertEventRecord>();

	async findActive(fingerprint: string): Promise<AlertEventRecord | null> {
		for (const r of this.#m.values()) {
			if (r.fingerprint === fingerprint && r.status === "firing") return { ...r };
		}
		return null;
	}

	async insert(record: AlertEventRecord): Promise<void> {
		this.#m.set(record.id, { ...record });
	}

	async update(record: AlertEventRecord): Promise<void> {
		if (!this.#m.has(record.id)) throw new Error(`alert event 不存在：${record.id}`);
		this.#m.set(record.id, { ...record });
	}

	async get(id: string): Promise<AlertEventRecord | null> {
		const r = this.#m.get(id);
		return r ? { ...r } : null;
	}

	/** 创建时间倒序（同 approval list 口径） */
	async list(): Promise<AlertEventRecord[]> {
		return [...this.#m.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	}
}
