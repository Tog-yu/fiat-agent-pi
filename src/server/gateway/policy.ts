/**
 * severity 分级派发 + 告警风暴限流（阶段 13 / P13-78）—— 零 Pi 依赖。
 *
 * classify：纯函数。P0/P1 → auto_diagnose；P2/P3 → manual_only（落库 + Lark 摘要卡，
 * 人回一句即可唤起）。autoDiagnoseSeverities 由配置注入，不硬编码。
 *
 * InflightGate：防告警风暴（硬约束 6）。选 **inflight 计数**而非固定速率窗口——
 * 单次诊断是 fan-out 多视角子会话，耗时长且波动大（几十秒到 2 分钟），
 * 速率窗口挡不住「前 10 秒放进来的长耗时任务堆积」；按「同时有几个在跑」限
 * 才能守住 token 预算。
 *
 *   新告警到闸：inflight < max → admit（立即诊断）
 *              inflight ≥ max 且队列未满 → queued（入有界等待队列）
 *              队列满 → throttled（调用方落库 + 节流通知，绝不静默丢弃）
 *
 *   回收：release(service) 在诊断结束时（成功/失败/超时）调用，计数 -1 并
 *   消费队头（FIFO，P0 优先通过 drainHighPriority）。等待期内同 fingerprint
 *   的重复推送由 runner 层幂等挡掉，队列里天然不重复。
 */

import type { AlertSeverity, DispatchAction, GatewayConfig, ThrottleVerdict } from "./types.ts";

/** 分级派发（纯函数；配置注入，测试不用改代码） */
export function classify(severity: AlertSeverity, autoDiagnoseSeverities: readonly AlertSeverity[]): DispatchAction {
	return autoDiagnoseSeverities.includes(severity) ? "auto_diagnose" : "manual_only";
}

interface QueueEntry {
	fingerprint: string;
	/** P0 插队标记：队列消费时优先 */
	priority: boolean;
}

export class InflightGate {
	readonly #max: number;
	readonly #maxQueue: number;
	readonly #inflight = new Map<string, number>();
	readonly #queues = new Map<string, QueueEntry[]>();

	constructor(maxInflight: number, maxQueue: number) {
		this.#max = Math.max(1, maxInflight);
		this.#maxQueue = Math.max(0, maxQueue);
	}

	/** 当前某服务在跑的诊断数（测试 / status 命令用） */
	inflight(service: string): number {
		return this.#inflight.get(service) ?? 0;
	}

	queued(service: string): number {
		return this.#queues.get(service)?.length ?? 0;
	}

	/**
	 * 尝试占一个诊断槽位。
	 * admit = 立即开始（调用方负责 finally 里 release）；
	 * queued = 已入队（调用方等 drain 回调）；
	 * throttled = 队列满（调用方落库留痕 + 通知）。
	 */
	tryAcquire(service: string, fingerprint: string, severity: AlertSeverity): ThrottleVerdict {
		const current = this.inflight(service);
		if (current < this.#max) {
			this.#inflight.set(service, current + 1);
			return "admit";
		}
		const queue = this.#queues.get(service) ?? [];
		if (queue.length >= this.#maxQueue) return "throttled";
		// 同指纹已在队列 → 合并（幂等第二道，防风暴时重复排队）
		if (queue.some((e) => e.fingerprint === fingerprint)) return "queued";
		queue.push({ fingerprint, priority: severity === "P0" });
		this.#queues.set(service, queue);
		return "queued";
	}

	/** 诊断结束回收槽位；返回下一个应执行的 fingerprint（有则出队，无则 undefined） */
	release(service: string): string | undefined {
		const current = this.inflight(service);
		const next = current > 0 ? current - 1 : 0;
		if (next > 0) this.#inflight.set(service, next);
		else this.#inflight.delete(service);

		const queue = this.#queues.get(service);
		if (!queue || queue.length === 0) return undefined;
		// P0 优先：出队头前先找优先项（稳定性：同为 P0 保持 FIFO）
		const idx = queue.findIndex((e) => e.priority);
		const entry = queue.splice(idx >= 0 ? idx : 0, 1)[0];
		if (queue.length === 0) this.#queues.delete(service);
		else this.#queues.set(service, queue);
		return entry.fingerprint;
	}

	/** 进程退出 / 测试清理：丢弃全部队列并返回被丢数量（调用方负责留痕） */
	drainAll(): number {
		let dropped = 0;
		for (const q of this.#queues.values()) dropped += q.length;
		this.#queues.clear();
		return dropped;
	}
}

/** 从 GatewayConfig 造闸（便利工厂，避免调用方记两个数字的顺序） */
export function inflightGateFromConfig(
	config: Pick<GatewayConfig, "maxInflightPerService" | "maxQueuePerService">,
): InflightGate {
	return new InflightGate(config.maxInflightPerService, config.maxQueuePerService);
}
