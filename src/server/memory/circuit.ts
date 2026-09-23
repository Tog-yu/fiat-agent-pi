/**
 * memory/circuit —— 记忆**检索侧**的断路器（P15-106 / 设计文档 §2.7b）。
 *
 * 为什么这是一个**必需品而不是优化**（设计文档原话）：
 *
 *   现有的 `mcp-rag.ts` 桥在 connect 失败时只 `onStatus("unavailable")` 并返回空数组，
 *   但**每次检索仍会去撞一次超时**（`config/rag.mcp.yaml` 的 `timeoutMs`，缺省 30s）。
 *   RAG server 挂掉时，`30s × 每轮` 会让会话直接卡死，而 §15.14 硬约束 8 承诺的是
 *   「检索失败降级为空结果」——**降级必须是快速的**。
 *
 * 也就是说：没有熔断器的「降级」是名存实亡的 —— 它确实返回了空结果，
 * 但用户先等了 30 秒。熔断器把「不可用」这个事实**在冷却期内记住**，
 * 于是降级从「30s 后返回空」变成「立刻返回空」。
 *
 * 形状对齐 hermes `memory_manager.py`：
 *
 *   _BREAKER_THRESHOLD = 5          # 连续失败 5 次
 *   _BREAKER_COOLDOWN_SECS = 120    # 冷却 120s
 *   # "after this many consecutive failures, pause API calls ... to avoid hammering a down server"
 *
 * 三个刻意的设计选择：
 *
 * 1. **只统计「连续」失败**。任何一次成功立刻归零 —— 网络抖动不该累积成熔断，
 *    而「服务真的挂了」的特征恰恰是连续失败。这是 hermes 的做法，也是
 *    最简单的「不误判」判据。
 *
 * 2. **冷却期满不预置成 closed，而是允许一次探测**。冷却期到点后第一次调用被放行，
 *    结果决定回到 `closed` 还是再次 `open`（并把冷却期重新起算）。否则会出现
 *    「冷却期满 → 状态变 closed → 下一轮 5 次失败才重新熔断」的漏斗，
 *    每次冷却都漏 5 个 30s 超时出去。
 *
 * 3. **时钟注入**（`now`）。熔断器全是时间判定，用 `Date.now()` 直接调会写出
 *    「测试要 sleep 120 秒」的用例，那种测试没人会跑，于是这条逻辑就再也不会被测到。
 *
 * 本模块**零 Pi 依赖、零 IO**：不 import 任何 transport，只回答「现在该不该尝试」。
 * 真正的降级（返回空数组）由调用方做 —— 与 `policy.ts` 的「纯函数只判定不执行」同旨。
 */

/** 断路器状态（与 `RagStatus` 的 `circuit_open` 是同一件事的两种表述：这里看机器，那里给人看） */
export type CircuitState = "closed" | "open";

export interface CircuitBreakerOptions {
	/** 连续失败多少次后打开。缺省 5（对齐 hermes `_BREAKER_THRESHOLD`） */
	threshold?: number;
	/** 冷却期 ms。缺省 120_000（对齐 hermes `_BREAKER_COOLDOWN_SECS`） */
	cooldownMs?: number;
	/** 时钟注入（测试用）；缺省 `Date.now` */
	now?: () => number;
	/**
	 * 状态变化回调（只在**真的变化**时触发，含冷却期到点后重新打开）。
	 * 调用方据此把 `circuit_open` 报给上层，与 `RagStatus` 合并展示。
	 */
	onStatus?: (status: "circuit_open" | "ready", detail: string) => void;
	/** 失败只记日志（缺省静默） */
	log?: (level: "warn" | "info", message: string, detail?: Record<string, unknown>) => void;
}

/** 只读快照（可观测 / 测试断言） */
export interface CircuitSnapshot {
	state: CircuitState;
	/** 当前连续失败次数（成功一次即归零） */
	consecutiveFailures: number;
	/** 打开状态下，冷却期还剩多少 ms（未打开为 0） */
	remainingCooldownMs: number;
	/** 累计：被短路（没真的发出请求）的次数 */
	shortCircuited: number;
	/** 累计：状态打开的次数 */
	openedCount: number;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 120_000;

export class MemoryCircuitBreaker {
	private readonly threshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private readonly onStatus: CircuitBreakerOptions["onStatus"];
	private readonly log: CircuitBreakerOptions["log"];

	private state: CircuitState = "closed";
	private failures = 0;
	/** 打开时点（到点后可探测） */
	private openedAt = 0;
	/** 冷却期已满、本次放行的调用是一次**探测**（决定回 closed 还是重新起算冷却） */
	private probing = false;
	private shortCircuited = 0;
	private openedCount = 0;

	constructor(opts: CircuitBreakerOptions = {}) {
		this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
		this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = opts.now ?? Date.now;
		this.onStatus = opts.onStatus;
		this.log = opts.log;
	}

	/**
	 * 现在该不该真的发请求？`false` = 直接降级为空结果，**不要**去撞那个 30s 超时。
	 *
	 * 冷却期到点时**不做状态迁移**，只放行这一次 —— 调用方随后的
	 * `recordSuccess()` / `recordFailure()` 才会决定状态去哪。
	 * 这样「探测中」不会短暂地把状态暴露成 `closed`（那会让上层以为已经恢复）。
	 */
	allow(): boolean {
		if (this.state === "closed") return true;
		if (this.now() - this.openedAt >= this.cooldownMs) {
			this.probing = true; // 冷却期满：本次调用是探测，不是恢复
			return true;
		}
		this.shortCircuited += 1;
		return false;
	}

	/** 一次成功：连续失败归零，状态回到 closed（若原本是 open 说明探测成功） */
	recordSuccess(): void {
		this.failures = 0;
		if (this.state === "open") {
			this.state = "closed";
			this.probing = false;
			this.onStatus?.("ready", "记忆检索断路器恢复：探测成功，冷却期提前结束");
		}
	}

	/** 一次失败（超时 / 网络错误 / 返回 `degraded=true`） */
	recordFailure(detail = ""): void {
		this.failures += 1;
		if (this.failures < this.threshold) return;

		// 计数口径（两条线分开，别混）：
		//   `openedCount` —— **打开窗口**的次数。探测失败算一个新窗口（冷却重新起算），
		//                    而在冷却期内重复失败不算（窗口没换，只是窗口被延长）。
		//   `onStatus`    —— 只在状态**真的变化**时报。探测失败时状态本来就是 open，
		//                    再报一次会把状态面刷成噪音（上层要的是「现在能不能用」）。
		const wasClosed = this.state === "closed";
		const wasProbing = this.probing;
		this.probing = false;
		this.openedAt = this.now();
		this.state = "open";

		if (!wasClosed && !wasProbing) return; // 冷却期内的重复失败：不换窗口、不报状态
		this.openedCount += 1;
		if (!wasClosed) return; // 探测失败：状态未变（仍是 open），不重复报

		this.onStatus?.("circuit_open", this.describeOpen(detail));
		this.log?.("warn", `记忆检索断路器打开：连续失败 ${this.failures} 次，冷却 ${this.cooldownMs}ms`, {
			threshold: this.threshold,
			detail,
		});
	}

	snapshot(): CircuitSnapshot {
		const remaining = this.state === "open" ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0;
		return {
			state: this.state,
			consecutiveFailures: this.failures,
			remainingCooldownMs: remaining,
			shortCircuited: this.shortCircuited,
			openedCount: this.openedCount,
		};
	}

	/**
	 * 打开原因的人话（进日志 / 状态面）。
	 * detail 来自最后一次失败 —— 但**只用于人看**，不参与任何判定。
	 */
	private describeOpen(detail: string): string {
		const tail = detail ? `（最后一次失败：${detail}）` : "";
		return (
			`记忆检索连续失败 ${this.failures} 次，已熔断 ${this.cooldownMs}ms；` +
			`冷却期内检索直接返回空结果，不再撞击超时。${tail}`
		);
	}
}
