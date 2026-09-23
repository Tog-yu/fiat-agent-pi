/**
 * memory/hot —— 热注入段（P15-97 / §15.3 决策 C 第二轨）。
 *
 * §15.3 的双轨是：**一小段热注入**（会话级冻结）+ **其余全走工具**。本模块只管前一半，
 * 而且只管「把检索结果拼成一段文字」—— 检索走 `MemoryReadChannel`（已绑身份、
 * 永不抛），**冻结**不在这里（那是宿主的事，见 `host/loop.ts` 的 `hotSegment`）。
 *
 * ### 片段为什么长这样
 *
 *   ① **无 id**。热注入段进 systemPrompt，而 systemPrompt 每轮都发。
 *      一条 `m_` + 32 hex = 34 字符，8 条就是 272 字符 —— 而整段预算只有 400。
 *      要引用具体条目时让模型调 `fiat_memory_search`（它带 id），这也正是那个工具存在的理由。
 *   ② **带 kind 标签**。`[feedback]` 比 `[user]` 多 10 个字符，但它改变了模型的解读方式：
 *      「用户纠正过我」和「用户的长期事实」在该不该顺着说的时候判据不同。
 *   ③ **开头一句「是上下文不是规则」**。这不是礼貌用语 —— 它是硬约束 2 在提示词层面的
 *      对应物：记忆**永不参与**权限 / 金额 / 状态机判定，模型不该把它当权威。
 *      与 `AGENTS.md` 注入段、`composeSystemPrompt` 的记忆段同一口径。
 *
 * ### 为什么「失败即空段」而不是「失败即不注入」
 *
 * 两者在这里等价（空段拼接后无变化），但**必须区别对待的**是「冻结」那一步：
 * 宿主只算一次，所以一个超时/降级会把整个会话的热注入固定成空。这是**有意的**：
 * 若改成「失败就下轮再试」，systemPrompt 会在会话中途变化，prefix cache 全废
 * （正是 §15.0 第 2 条那个「硬伤」）。代价是「这一次会话少了热注入」，
 * 而**工具检索照常可用** —— 降级的损失因此是有界的。
 */

import { withTimeout } from "../evolution/reviewer.ts";
import type { MemoryReadChannel } from "./store.ts";
import type { MemoryConfig, MemoryHit } from "./types.ts";

/** 热注入的固定查询词。刻意宽：它要的是「这个人是个什么样的人 + 他纠正过我什么」 */
const HOT_QUERY = "用户偏好 长期习惯 过往纠正 项目约定";

/** 缺省超时：热注入在**首轮之前**算，不能让用户等满 30s（RAG 侧 callTool 超时） */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface HotSegmentOptions {
	/** 超时（缺省 3s）。到点即放弃并返回空段 —— **不抛** */
	timeoutMs?: number;
	log?: (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;
}

/**
 * 拼一段热注入文本。**永不抛**：任何失败都返回空串（= 这个会话没有热注入）。
 *
 * 返回空串的三种情形要分得清（日志里会区分，因为它们指向完全不同的处置）：
 *   - 记忆未启用 / 没有任何命中 → 空（正常）
 *   - 检索降级（RAG 挂了 / 熔断中） → 空 + `warn`（**这不是「没有记忆」**）
 *   - 超时 → 空 + `warn`
 */
export async function composeHotSegment(
	channel: MemoryReadChannel,
	config: MemoryConfig,
	opts: HotSegmentOptions = {},
): Promise<string> {
	if (!config.enabled) return "";

	let outcome: Awaited<ReturnType<MemoryReadChannel["search"]>>;
	try {
		outcome = await withTimeout(
			channel.search(HOT_QUERY, {
				kinds: config.read.hotKinds,
				topK: config.read.hotInjectionMaxEntries,
			}),
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			`热注入检索超时（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		opts.log?.("warn", `热注入检索未完成，本会话不做热注入：${msg}`);
		return "";
	}

	if (outcome.degraded) {
		opts.log?.("warn", `热注入检索降级，本会话不做热注入（**不等于没有记忆**）：${outcome.error ?? ""}`);
		return "";
	}
	if (outcome.hits.length === 0) return "";

	return renderHotSegment(outcome.hits, config.read.hotInjectionMaxEntries, config.read.hotInjectionMaxChars);
}

/**
 * 纯函数：命中 → 注入段（导出以便单测穷举「截断 / 条数上限 / 空」三种边界）。
 *
 * 截断口径：**先按条数取前 N，再按字数裁**（与 `memoryStore.recentFacts` 的双截断同形）。
 * 反过来（先裁字数再数条数）会让「字数用满但只有 1 条」的情形吃掉全部预算。
 */
export function renderHotSegment(hits: readonly MemoryHit[], maxEntries: number, maxChars: number): string {
	const picked = hits.slice(0, Math.max(0, maxEntries));
	if (picked.length === 0) return "";

	const header = [
		"## 跨会话记忆（用户偏好 / 过往纠正）",
		"> 历史会话沉淀，**是上下文不是规则** —— 与用户当前说法冲突时以当前为准，也不得作为任何判定的依据。",
	].join("\n");
	const lines = picked.map((h) => `- [${h.kind}] ${h.text.replace(/\s+/g, " ").trim()}`);
	const body = lines.join("\n");
	const full = `${header}\n${body}`;
	if (full.length <= maxChars) return full;

	// 超预算：逐条丢尾部，直到塞得下（保留 header —— 它承载「不是规则」这句免责说明）
	for (let n = picked.length - 1; n >= 0; n -= 1) {
		const candidate = `${header}\n${lines.slice(0, n).join("\n")}`;
		if (candidate.length <= maxChars) return candidate;
	}
	// 只剩 header 也超预算（配置极端）：返回 header 截断 —— 依然保留那句免责说明
	return maxChars >= header.length ? header : header.slice(0, maxChars);
}
