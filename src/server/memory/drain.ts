/**
 * memory/drain —— 记忆写入的**有界 drain**（P15-106 / 设计文档 §2.7a）。
 *
 * 问题：记忆写入是**轮末异步**的（§15.8 的提取 fork），因此天然存在一个窗口 ——
 * 「最后一次写入还没落库，进程就退出了」。本仓**刚踩过同类问题**：
 * `ChatSession.flush()` 就是为 tracer 的 `unref` 定时器补的
 * （不然一次性脚本退出时批次发不出去）。记忆通道复用同一形态，不新开钩子。
 *
 * 形状对齐 hermes `memory_manager.py` 的关闭路径：
 *
 *   _SYNC_DRAIN_TIMEOUT_S = 5.0
 *   def _drain_sync_executor(self):
 *       executor.shutdown(wait=False, cancel_futures=False)   # 关提交口，不动 FIFO
 *       _, pending = wait(tuple(tracked), timeout=_SYNC_DRAIN_TIMEOUT_S)
 *       # 超时 → 放弃，但把 abandoned_writes 记进快照
 *
 * 它最值得抄的一点是**不假装成功**：超时后 `logger.warning("abandoning %d queued
 * memory write(s)")`，把结果落进快照供查询，然后放进程走。「有界 + 可观测 + 不阻塞」
 * 三件事同时做到 —— 任何一件缺失都会让这个 drain 变成「看起来在等，其实在卡」。
 *
 * ### 为什么必须「有界」而不是「尽力而为」
 *
 * 没有超时的 drain 比没有 drain 更糟：它会把一个「丢失最后一次写入」的小问题
 * 升级成「进程永远不退出」。而记忆写入的承载体是 RAG server（进程外的服务），
 * 它挂掉时的表现正是**永远不返回**。所以 `run()` **绝不** reject、**绝不**超时后继续等。
 *
 * ### 为什么不强行取消
 *
 * 与 `reviewer.ts` 对 fork 超时的处置同一口径（那里有段诚实记录）：Node 单线程下
 * 强行中断一个正在写 RAG 的异步链会留下半写状态。与 fork 不同的是，这里的写入
 * 已经发到 RAG 侧了 —— 我们能做的只有「不再等」，而不是「撤销」。
 * 所以超时的语义是**放弃等待 + 记账**，不是回滚。
 *
 * 本模块零 Pi 依赖、零 IO：只持有一个 promise 集合与一个时钟。
 */

export interface MemoryDrainOptions {
	/** drain 超时（ms）。缺省 5000（对齐 hermes `_SYNC_DRAIN_TIMEOUT_S`） */
	timeoutMs?: number;
	/** 超时放弃时记日志（缺省静默） */
	log?: (level: "warn" | "info", message: string, detail?: Record<string, unknown>) => void;
}

/** 一次 drain 的结果（进日志 / 快照 / 测试断言） */
export interface DrainResult {
	/** 在超时前结算完毕的写入数 */
	drained: number;
	/** 超时仍未结算、被放弃的写入数 */
	abandoned: number;
	/** 本次 drain 时在飞的写入总数（= drained + abandoned） */
	inFlight: number;
}

export interface DrainSnapshot {
	/** 当前在飞的写入数 */
	inFlight: number;
	/** 累计被放弃的写入数（跨多次 drain） */
	abandonedTotal: number;
	/** 提交口是否已关闭 */
	closed: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class MemoryDrain {
	private readonly timeoutMs: number;
	private readonly log: MemoryDrainOptions["log"];
	private readonly inFlight = new Set<Promise<void>>();
	private abandonedTotal = 0;
	private closed = false;

	constructor(opts: MemoryDrainOptions = {}) {
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.log = opts.log;
	}

	/**
	 * 登记一个在飞的写入，使 drain 能等到它。
	 *
	 * 返回的 promise 与入参**同一个语义**（成功仍是成功、失败仍是失败）——
	 * 本方法只加观测，不改行为。调用方无需 await 返回值才能让 drain 生效。
	 *
	 * 提交口关闭后仍然登记（写入照跑），但**不进集合** —— 因为它已经晚于
	 * 「我们要 flush 的那一刻」，把它算进来只会让 flush 永远追不上新写入。
	 */
	track<T>(promise: Promise<T>): Promise<T> {
		if (this.closed) return promise;
		const wrapped: Promise<void> = promise.then(
			() => {
				this.inFlight.delete(wrapped);
			},
			() => {
				// 失败也是「结算完毕」：写入失败不该让 drain 超时（错误本身由写入侧上报）
				this.inFlight.delete(wrapped);
			},
		);
		this.inFlight.add(wrapped);
		return promise;
	}

	/**
	 * 关提交口（对齐 `executor.shutdown(wait=False, cancel_futures=False)`）：
	 * 已在飞的照跑，之后登记的**不再等待**。
	 */
	close(): void {
		this.closed = true;
	}

	/** 重新开放（长驻进程周期性 flush 后再继续写入时用；一次性 CLI 用不到） */
	reopen(): void {
		this.closed = false;
	}

	/**
	 * 等所有在飞写入结算，**有超时上限**。永不抛、永不超时后继续等。
	 *
	 * 超时即放弃并记账：这是本模块的核心承诺 —— 「有界 + 可观测 + 不阻塞」。
	 * 放弃不是失败：进程退出时写不完是**预期内**的（对齐 hermes 的 daemon worker
	 * 「卡住也不会阻塞进程退出」），前提是它被记下来了。
	 */
	async run(): Promise<DrainResult> {
		const pending = [...this.inFlight];
		if (pending.length === 0) return { drained: 0, abandoned: 0, inFlight: 0 };

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
		});
		// allSettled：写入失败不影响 drain（我们等的是「结算」，不是「成功」）
		const settled = Promise.allSettled(pending).then(() => "settled" as const);

		const outcome = await Promise.race([settled, timeout]);
		if (timer) clearTimeout(timer);

		// 此刻仍挂在集合里的就是被放弃的 —— 集合的删除发生在 track 注册的 then 里，
		// 早于 allSettled 的观察者结算，因此 settled 分支下这里读到的数量是准的。
		const abandoned = this.inFlight.size;
		const result: DrainResult = { drained: pending.length - abandoned, abandoned, inFlight: pending.length };

		if (outcome === "timeout") {
			this.abandonedTotal += abandoned;
			this.log?.("warn", `记忆写入 drain 超时（${this.timeoutMs}ms），放弃 ${abandoned} 条未完成的写入`, {
				timeoutMs: this.timeoutMs,
				drained: result.drained,
				abandoned,
			});
		}
		return result;
	}

	/** 快照（可观测 / 测试） */
	snapshot(): DrainSnapshot {
		return { inFlight: this.inFlight.size, abandonedTotal: this.abandonedTotal, closed: this.closed };
	}
}
