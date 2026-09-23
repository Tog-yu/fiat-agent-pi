/**
 * memory/policy —— 长期记忆的**确定性策略层**（阶段 15 / P15-93 + P15-105）。
 * **纯函数，零 Pi 依赖，零 IO。**
 *
 * 为什么这批判定必须是纯函数：本模块是「决定要不要把 LLM 产出写进**跨会话**记忆」的地方。
 * 与阶段 12 的 `evolution/policy.ts` 同一口径 —— 它必须能离线穷举测试（每个分支都能构造），
 * 且判定只读输入，不受模型输出影响。
 *
 * 两者最大的不同在于**风险面**（§15.9）：自进化的错误产物是「一条坏技能」，
 * 修正成本是改文件；记忆的错误产物是「此后所有会话都在注入的一条假事实」，
 * 而且它会被热注入段直接塞进 systemPrompt。所以这里多了一道自进化没有的关卡：
 * **写入资格**（本节，P15-105）。
 *
 * 本文件包含（P15-93 + P15-105）：
 *
 *   §1 写入资格（P15-105）—— 非主上下文不写记忆
 *   §2 触发判定（§15.8）+ 纠正信号检测（P15-93①）+ trivial 预筛（§2.3）
 *   §3 候选校验（P15-93②）+ 禁写三形态正则兜底（P15-93③）
 *   §4 幂等键与条目 id（P15-93④）
 *   §5 supersede 判定（P15-93⑤）
 *   §6 `feedback` → `user` 晋升判定（P15-93⑥）
 *   §7 归类漂移检测（P15-93⑦）
 *
 * ### 两条与 `evolution/policy.ts` 共用的事实源（**不要复制粘贴**）
 *
 * `findForbidden` / `findSensitive` / `similarity` / `normalizeText` 全部 import 自
 * `evolution/policy.ts`，本文件**不新写一套正则**。理由有三条，每条都对应一个真失效模式：
 *
 *   - 敏感模式（手机 / 卡号 / 订单号 / 邮箱）有两套 → 「一处判定说没有敏感信息、
 *     另一处却漏出去」的裂缝（`slice.ts:redact` 早就为此共用同一张表）；
 *   - §15.9 的「规则形态」禁令与阶段 12 的 `forbidden_approval_bypass` **本来就是同一批措辞**
 *     （「以后一律…」「无需审批」「跳过校验」）—— 两套正则必然一处紧一处松；
 *   - `DEV_SPEC.md` §15.6 约束 3 明确规定记忆幂等键与阶段 12 `applyProposal`
 *     **同口径**，归一化函数分叉会让「同一事实换个标点就重复入库」。
 *
 * 唯一的例外是**指令性内容**（§15.9 第三形态）：技能正文本来就该是指令式的，
 * 阶段 12 自然没有这组模式，因此那是本文件独有的 §3.3。
 *
 * 依赖方向说明：`memory/` → `evolution/policy.ts` 是**单向**的。`evolution/policy.ts`
 * 只 import `skillStore` / `types`，两者都不认识 `memory/`（`evolution/apply.ts` 认识
 * `memory/identity.ts`，但与本方向无关），因此不长环。
 */

import { createHash } from "node:crypto";
// 单一事实源（见文件头「两条共用的事实源」）：禁令 / 敏感 / 相似度 / 归一化都不在本文件重写
import { findForbidden, findSensitive, normalizeText, similarity } from "../evolution/policy.ts";
import { MEMORY_KINDS, type MemoryCandidate, type MemoryConfig, type MemoryEntry, type MemoryKind } from "./types.ts";

// =====================================================================================
// §1 写入资格：非主上下文不写记忆（P15-105 / 设计文档 §2.6）
// =====================================================================================

/**
 * 运行上下文（判据直接借自 hermes `memory_provider.py` 的 `agent_context` 契约）。
 *
 * hermes 原文：
 *
 *   - agent_context (str): "primary", "subagent", "cron", or "flush".
 *     Providers should skip writes for non-primary contexts (cron system
 *     prompts would corrupt user representations).
 *
 * 两个 provider 的落地都很干脆（`supermemory` 用集合成员判定，`honcho` 直接 return）。
 *
 * fiat 在 hermes 四值之外补两个**本仓特有的程序化路径**：
 *   - `eval`：阶段 11 的评测批量跑（`eval/caseRunner.ts` 起的会话）
 *   - `job-apply`：阶段 5 的工单 apply 路径（`host/l1b/job-apply.ts`）
 *
 * 为什么这两条也要进跳过集合：它们的共同特征是「**为了完成任务而跑，不是为了与用户对话**」。
 * 一个 eval 会话里模型说的每一句话都是被 case 设定驱动的，把它当成「用户偏好」记下来
 * 是纯粹的污染 —— 而且测量本身会改变被测量的东西（下一轮评测就带着上一轮的残留）。
 */
export type AgentContext = "primary" | "subagent" | "cron" | "flush" | "eval" | "job-apply";

/** 唯一允许写记忆的上下文 */
export const PRIMARY_AGENT_CONTEXT: AgentContext = "primary";

/**
 * 非主上下文集合（**写入资格判据的单一事实源**）。
 *
 * 之所以把 `"subagent"` 也放进来（这一条最反直觉）：fiat 的记忆提取**自己就跑在一个
 * fork 子会话里**（§15.11：`HostSession.inMemory` + 工具白名单只给 `submit`）。
 * §15 原本靠「fork 白名单只给 `submit`」**隐式**挡住了递归提取 —— 那是"顺带挡住"，
 * 不是"明确设计"。一个只读工具日后被加进 fork 白名单，递归就会静默复活：
 * fork 里的对话又产生 feedback → 又起 fork。
 *
 * 显式短路的第二个理由是**语义**的，比递归防护更重要：子会话产出的是
 * 「**关于子任务的**」，不是「**用户对助手的表述**」（设计文档 §2.6 的原话）。
 * 哪怕技术上不递归，把子任务的中间结论写进用户画像也是错的。
 */
export const NON_PRIMARY_CONTEXTS: readonly AgentContext[] = ["subagent", "cron", "flush", "eval", "job-apply"];

/** 纯判据：这个上下文有没有写记忆的资格 */
export function isPrimaryContext(context: AgentContext): boolean {
	return context === PRIMARY_AGENT_CONTEXT;
}

/** 写入被短路的原因（进日志 / 审计，便于回答「这条记忆为什么没记下来」） */
export type WriteSkipReason = "non_primary_context" | "memory_disabled";

export interface WriteQualificationInput {
	/** 发起写入的运行上下文 */
	context: AgentContext;
	/**
	 * 记忆总开关（`config/memory.yaml` 的 `memory.enabled`）。
	 * 缺省视为 `true` —— 调用方通常已经判过开关，这里是**重复保险**：
	 * 关掉记忆时即便某条路径漏了解注册，也不应该产生写入。
	 */
	enabled?: boolean;
}

export interface WriteQualification {
	/** true = 可以进入后续的候选校验与落库 */
	eligible: boolean;
	/** eligible=false 时的原因 */
	reason?: WriteSkipReason;
	/** 人话说明（日志里直接打，不要在别处再拼一遍文案） */
	detail?: string;
}

/**
 * **写入资格闸门**：任何记忆写入在进入候选校验之前必须先过这里（设计文档 §2.6 / §15.14 硬约束 14）。
 *
 * 判定顺序是**故意**的：先看上下文再看开关。理由是二者虽然都会拒，
 * 但诊断价值不同 —— 一个 cron 会话不写记忆，运维想看到的是「因为这是 cron」，
 * 而不是「因为记忆没开」（后者会让人误以为打开开关就行了）。
 *
 * 返回结构化结果而不是抛异常：本层是**旁路判定**，不是守卫。
 * 与 §15.14 硬约束 8「永不阻塞回复」一致 —— 资格不够的正确表现是"静默跳过 + 留痕"，
 * 不是"抛出去把会话打崩"。（对比：哨兵身份 `assertNotSentinelIdentity` 是**真守卫**，
 * 因为那属于「配置错了」，宁可起不来也不要带着假隔离跑。）
 */
export function checkWriteQualification(input: WriteQualificationInput): WriteQualification {
	if (!isPrimaryContext(input.context)) {
		return {
			eligible: false,
			reason: "non_primary_context",
			detail:
				`上下文 ${input.context} 不写记忆：子会话 / cron / flush / eval / job-apply 产出的是` +
				`「关于子任务的」，不是「用户对助手的表述」，写进用户画像属污染（且子会话本身可能就是提取 fork）。`,
		};
	}
	if (input.enabled === false) {
		return { eligible: false, reason: "memory_disabled", detail: "记忆未启用（memory.enabled=false）" };
	}
	return { eligible: true };
}

// =====================================================================================
// §2 触发判定 + 纠正信号检测（P15-93① / §15.8 触发表 / §2.3 trivial 预筛）
// =====================================================================================

/**
 * 一次命中（进审计 / 日志 / 提示词锚点）。
 * `excerpt` **只留片段**，与 `evolution/policy.ts` 的 `SensitiveHit` 同规矩 ——
 * 命中原文落日志会让判定过程本身变成泄漏点。
 */
export interface SignalHit {
	kind: "correction" | "confirmation";
	/** 命中的规则名（可观测 / 测试断言用） */
	rule: string;
	excerpt: string;
}

/**
 * 纠正 / 确认措辞表（**与提示词成对**：`prompts.ts` 的硬约束必须提到同一批词）。
 *
 * 为什么拆成两组而不是一张表：§15.8 要求「纠正信号命中时优先出 `feedback`」，
 * 而**确认**信号（「就是这样」「以后都这么写」）同样该出 `feedback`（判定线里
 * 那半句是「用户要求 Y / **认可 Y**」）。分组让提示词能分别引用。
 *
 * 保守取向：**宁可漏判也不误判**。漏判还有 `minTurns` 那条次优路径兜底；
 * 误判则是每轮白起一次 fork（token 成本 + 延迟）。所以像「对」「可以」「注意」
 * 这种高频词一律不收 —— 它们在中文里太容易出现在普通陈述中。
 */
const CORRECTION_PATTERNS: Array<{ rule: string; re: RegExp }> = [
	{ rule: "negation_correction", re: /(?:不对|不准确|不正确|不是这样|不是这个|有误|错(?:了|误)|说错|搞错|弄错)/ },
	{
		rule: "should_be",
		re: /(?:应该(?:是|用|写|改成|按|走)?|应当|改成|换成|改为|重写|重新(?:写|来|做)|修正|纠正|更正)/,
	},
	{ rule: "prohibition", re: /(?:不要(?:再)?|别再?|禁止|避免|不准|不许|不能(?:再)?|以后别)/ },
	{ rule: "future_rule", re: /(?:以后(?:都|一律)?|今后|下次|后续(?:都)?|从现在起|一律|都(?:要|用|按))/ },
	{ rule: "remember", re: /(?:记住|记一下|记下来|记着|别忘了|要记得)/ },
	{ rule: "preference", re: /(?:我(?:更)?(?:喜欢|偏好|倾向|习惯)|照我(?:说|写|要)的|按我(?:的)?(?:习惯|风格|口径))/ },
];

const CONFIRMATION_PATTERNS: Array<{ rule: string; re: RegExp }> = [
	{ rule: "affirmation", re: /(?:没错|正是这样|就是这样|这样就对|答对了|完全正确|说得对)/ },
	{
		rule: "keep_it_up",
		re: /(?:以后(?:就)?(?:都)?(?:这么|这样)(?:写|做|来|答)|保持(?:这个|这样)|沿用|照这个来|就按这个)/,
	},
];

/**
 * 无信号输入（`memory_provider.py:61-78` 的 `is_trivial_prompt`）。
 *
 * 目的很实在：`hi` / `ok` / `/help` 这类输入**不可能**携带可提取的事实，
 * 判掉它能省一次网络往返 + 一次 LLM 调用。设计文档 §2.3 建议把它并进本文件，
 * 与纠正信号检测**共用同一批措辞认知**（「好的」既不该触发提取，也不该被当成确认）。
 */
const TRIVIAL_PATTERNS: RegExp[] = [
	/^(?:hi|hello|hey|yo|ok|okay|k|thanks|thank you|thx|bye|good\s*(?:morning|night))\b/i,
	/^(?:你好|您好|嗨|哈喽|在吗|在不在|谢谢|多谢|感谢|收到|明白|好的|好|嗯+|哦+|啊+|是|对|行|可以|没事)[!！。.、~～？?\s]*$/,
	/^\/[a-z][a-z0-9_-]*$/i, // 纯 slash 命令（/help、/refine …）：命令本身不是事实
	/^[\s\p{P}\p{S}]*$/u, // 纯标点 / 表情 / 空白
];

/** 归一化到「比较用」的文本（与 evolution 共用；不参与幂等键，只用于 trivial 判定） */
function compact(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function excerpt(s: string, n = 24): string {
	const t = compact(s);
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 是不是无信号输入（纯招呼 / 纯确认词 / 纯命令 / 纯标点 / 过短） */
export function isTrivialInput(userText: string): boolean {
	const t = compact(userText);
	if (t.length < 2) return true;
	return TRIVIAL_PATTERNS.some((re) => re.test(t));
}

/**
 * 文本层的纠正 / 确认信号（**零 LLM 预筛**的第一步）。
 * 返回 null = 这一轮的用户文本里没有「需要沉淀的偏好 / 纠正」证据。
 */
export function detectTextSignal(userText: string): SignalHit | null {
	const t = compact(userText);
	if (t.length === 0 || isTrivialInput(t)) return null;
	// 纠正优先于确认：一句话里两者同时出现（「不对，应该这样」）时按纠正记 ——
	// 纠正信息量更大，且提示词硬约束要求这种情况必须出 feedback（两者都出 feedback，
	// 因此这里只影响 SignalHit.kind 的记账口径）
	for (const { rule, re } of CORRECTION_PATTERNS) {
		const m = re.exec(t);
		if (m) return { kind: "correction", rule, excerpt: excerpt(m[0]) };
	}
	for (const { rule, re } of CONFIRMATION_PATTERNS) {
		const m = re.exec(t);
		if (m) return { kind: "confirmation", rule, excerpt: excerpt(m[0]) };
	}
	return null;
}

/** 循环内可见的一步工具调用（L1a `memory-signal.ts` 从 `turn_end.toolResults` 抽出） */
export interface MemoryToolStep {
	tool: string;
	isError: boolean;
}

/**
 * 「工具失败 → 改参数后成功」信号（§15.8 第一行后半句）。
 *
 * 这是**只有循环内看得到**的证据，所以采集点在 L1a（`turn_end`）而不是宿主 ——
 * 与阶段 12 把 `itersSinceSkill` 放在 L1a 是同一个理由。
 *
 * 判据刻意简单（同一工具先失败后成功）：更复杂的「参数是否真的改了」需要读工具入参，
 * 而那会把 prompt 内容带进判定链。事实是**失败后重试成功**本身就说明原做法不对。
 */
export function detectRetrySignal(steps: readonly MemoryToolStep[]): SignalHit | null {
	const failed = new Set<string>();
	for (const s of steps) {
		if (s.isError) {
			failed.add(s.tool);
			continue;
		}
		if (failed.has(s.tool)) {
			return { kind: "correction", rule: "tool_retry_success", excerpt: excerpt(s.tool) };
		}
	}
	return null;
}

export type TriggerDecision =
	| {
			kind: "skip";
			reason:
				| "disabled"
				| "trivial"
				| "budget_exhausted"
				| "duplicate_signal"
				| "below_threshold"
				| "not_enabled_signal";
	  }
	| {
			kind: "run";
			reason: "correction_signal" | "min_turns" | "session_end";
			/** 触发证据（`correction_signal` 时必然有；另两条路径为 undefined） */
			signal?: SignalHit;
	  };

export interface TriggerInput {
	/** 本轮用户原文 */
	userText: string;
	/** 本会话累计用户轮次（宿主 `PiHostLoop.runTurn` 计数） */
	turns: number;
	/** 本会话已起过的提取 fork 次数 */
	runs: number;
	/** 本轮工具步（可选；没有就是纯对话轮） */
	toolSteps?: readonly MemoryToolStep[];
	/** 是否处于会话结束的兜底时刻（`agent_end` / REPL 退出前） */
	atSessionEnd?: boolean;
	/**
	 * 本会话已触发过的信号指纹（`signalFingerprint()` 的产物）。
	 * 用来避免「同一句纠正被连续几轮重复提取」—— 重复写入本身会被幂等键挡住，
	 * 但**白起一次 fork** 是纯浪费（每轮一次 LLM 调用）。
	 */
	recentSignalHashes?: readonly string[];
	config: MemoryConfig;
}

/**
 * §15.8 的触发表（**判定顺序即优先级**，含两条次优路径与一条兜底）：
 *
 *   0 总开关关            → skip（零行为变化）
 *   1 trivial 输入        → skip（连预筛都不必跑）
 *   2 提取预算用尽        → skip（硬顶，优先于一切信号）
 *   3 纠正信号（文本 or 失败→成功）→ run
 *   4 会话结束兜底        → run
 *   5 累计轮次达标        → run
 *   6 其余                → skip
 *
 * 为什么预算排在信号之前：信号是**事件驱动**的，一个用户连说十句「不对」就能把
 * `maxRunsPerSession` 撑爆 —— 预算必须先于信号生效，否则它形同虚设。
 */
export function shouldExtract(input: TriggerInput): TriggerDecision {
	const { config } = input;
	if (!config.enabled) return { kind: "skip", reason: "disabled" };
	if (isTrivialInput(input.userText)) return { kind: "skip", reason: "trivial" };
	if (input.runs >= config.trigger.maxRunsPerSession) return { kind: "skip", reason: "budget_exhausted" };

	const textSignal = config.trigger.onCorrectionSignal ? detectTextSignal(input.userText) : null;
	const retrySignal = config.trigger.onCorrectionSignal ? detectRetrySignal(input.toolSteps ?? []) : null;
	const signal = textSignal ?? retrySignal;

	if (signal) {
		const hash = signalFingerprint(signal, input.userText);
		if ((input.recentSignalHashes ?? []).includes(hash)) return { kind: "skip", reason: "duplicate_signal" };
		return { kind: "run", reason: "correction_signal", signal };
	}
	if (input.atSessionEnd && config.trigger.atSessionEnd) return { kind: "run", reason: "session_end" };
	if (input.turns >= config.trigger.minTurns) return { kind: "run", reason: "min_turns" };
	return { kind: "skip", reason: "below_threshold" };
}

/**
 * 信号指纹（去重用）。与幂等键同源：`rule + 归一化文本`。
 * 只取前 16 位 hex —— 它的用途是「本会话内去重」，不是全局唯一标识。
 */
export function signalFingerprint(signal: SignalHit, userText: string): string {
	return createHash("sha256")
		.update(`${signal.rule}|${normalizeText(userText)}`)
		.digest("hex")
		.slice(0, 16);
}

// =====================================================================================
// §3 候选校验 + 禁写三形态（P15-93②③ / §15.9）
// =====================================================================================

/** 拒收原因（可观测：哪一类被拒得最多，是提示词该改的信号） */
export type CandidateRejection =
	| "invalid_kind"
	| "empty_text"
	| "too_long"
	| "low_confidence"
	| "forbidden_rule"
	| "forbidden_prod_data"
	| "forbidden_instruction";

/**
 * kind 白名单（**运行时**判定，不是类型判定）。
 *
 * 为什么不能只靠 TS 类型：`MemoryCandidate` 来自 fork 回复的 JSON 解析，
 * 类型标注在运行时是**不存在**的 —— 模型完全可能产出已撤销的 `performance`
 * 或任意别的词。这里的 `String(...)` 就是为了让这层校验真的发生。
 */
const MEMORY_KINDS_SET: ReadonlySet<string> = new Set(MEMORY_KINDS.map(String));

export interface CandidateVerdict {
	accepted: boolean;
	reason?: CandidateRejection;
	/** 命中的片段（截断）/ 超限字数等细节，进审计与日志 */
	detail?: string;
}

/**
 * 候选校验（**顺序即优先级**）。任一步不过 → 整条丢弃，**不脱敏后入库**。
 *
 * 为什么生产数据是「整条丢弃」而不是「脱敏后保留」（§15.9 原话）：脱敏后的记忆
 * 往往已失去价值，留着一个残缺事实更危险 —— 模型会对「订单号是 [已脱敏]」
 * 这种半截事实编造上下文。
 */
export function validateCandidate(candidate: MemoryCandidate, config: MemoryConfig): CandidateVerdict {
	// ① kind 合法性：LLM 可能产出提示词之外的词（如已撤销的 `performance`）
	if (!MEMORY_KINDS_SET.has(String(candidate.kind))) {
		return { accepted: false, reason: "invalid_kind", detail: String(candidate.kind) };
	}
	const text = candidate.text?.trim() ?? "";
	if (text.length === 0) return { accepted: false, reason: "empty_text" };

	// ② 长度硬上限：**拒绝不截断**（截断会静默改语义）
	if (text.length > config.write.maxTextChars) {
		return {
			accepted: false,
			reason: "too_long",
			detail: `${text.length} > ${config.write.maxTextChars}`,
		};
	}

	// ③ 置信度下限：LLM 自评低于阈值直接丢弃（提示词里已说明这一点，这里是兜底）
	if (!Number.isFinite(candidate.confidence) || candidate.confidence < config.write.minConfidence) {
		return {
			accepted: false,
			reason: "low_confidence",
			detail: `${String(candidate.confidence)} < ${config.write.minConfidence}`,
		};
	}

	// ④ 禁写形态一：**规则形态**（「以后一律…」「无需审批」「跳过校验」「免复核」）
	//    与阶段 12 的 `forbidden_approval_bypass` 共用同一批模式。
	//    记忆绝不能成为第二规则源（铁律 5）—— 三处权威只有 RAG 知识库 / config/*.yaml / L2 规则引擎。
	const forbidden = findForbidden(text);
	if (forbidden) {
		return { accepted: false, reason: "forbidden_rule", detail: `${forbidden.rule}: ${forbidden.excerpt}` };
	}

	// ⑤ 禁写形态二：**生产数据**（订单号 / 金额 / 手机号 / 卡号 / 邮箱 / 用户标识）
	//    与审计红线共用同一张表（`evolution/policy.ts` 的 SENSITIVE_PATTERNS）
	const sensitive = findSensitive(text);
	if (sensitive) {
		return { accepted: false, reason: "forbidden_prod_data", detail: `${sensitive.rule}: ${sensitive.excerpt}` };
	}

	// ⑥ 禁写形态三：**指令性内容**（「你必须…」「忽略之前的…」）—— 这就是 prompt injection 的形态本身。
	//    记忆会被注入到**此后每次** systemPrompt，存下一条祈使句等于给自己装了一个后门。
	const instruction = findInstruction(text);
	if (instruction) {
		return { accepted: false, reason: "forbidden_instruction", detail: instruction };
	}

	return { accepted: true };
}

/**
 * 指令性内容的模式（**本文件独有**，阶段 12 没有对应物 —— 技能正文本来就该是指令式的）。
 *
 * 三组：
 *   - 对模型下命令（「你必须」「你应该」）
 *   - 覆盖既有指令（「忽略之前的指令」）—— 注入的经典形态
 *   - 伪 system 段（「system:」「# 指令」）
 *
 * 为什么不复用 `findForbidden`：那套是「业务规则泛化」的口径，与「对模型下命令」是两类东西。
 * 混在一起会让两边都变松（例如技能里合法的「你必须先校验」会被误杀）。
 */
const INSTRUCTION_PATTERNS: Array<{ rule: string; re: RegExp }> = [
	{
		rule: "imperative_to_model",
		re: /(?:你|助手|AI|模型|agent)\s*(?:必须|应当|需要|一律|不得|不能|绝不可|务必)\s*\S/,
	},
	{
		rule: "override_instructions",
		re: /(?:忽略|无视|忘记|抛弃|跳过)\s*(?:之前|上面|前面|以上|先前|原有)的?\s*(?:所有)?\s*(?:指令|提示|要求|设定|规则|约束)/,
	},
	{
		rule: "override_instructions_en",
		re: /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|constraints?)/i,
	},
	{ rule: "fake_system_block", re: /(?:^|\n)\s*(?:system|系统提示词?|系统指令)\s*[:：]/i },
	{ rule: "fake_rule_header", re: /(?:^|\n)\s*#*\s*(?:指令|规则|约束|要求)\s*[:：]\s*\S/ },
];

function findInstruction(text: string): string | null {
	for (const { rule, re } of INSTRUCTION_PATTERNS) {
		const m = re.exec(text);
		if (m) return `${rule}: ${excerpt(m[0])}`;
	}
	return null;
}

// =====================================================================================
// §4 幂等键与条目 id（P15-93④ / §15.6 约束 3 + 跨仓库契约 2·3）
// =====================================================================================

/**
 * 幂等键 = `sha256(scope + key + kind + 归一化 text)`（§15.6 约束 3）。
 *
 * 「同口径」是硬要求：阶段 12 `applyProposal` 的键是 `hash(target + 归一化正文)`，
 * 记忆是它的三元扩展（多了 scope/key —— 因为记忆按分区存，同一句话在不同分区
 * 是两条不同的记忆）。归一化函数**共用**（见文件头）。
 *
 * 拼接用 `\u0000` 分隔而不是 `|` 或空串：`scope+key+kind` 都是受控的小字符集，
 * 但 text 里可以出现任何字符 —— 用 `|` 会造出「key=a|b, kind=c」与
 * 「key=a, kind=b|c」的碰撞。NUL 不可能出现在这些字段里。
 */
export function memoryIdempotencyKey(input: { scope: string; key: string; kind: MemoryKind; text: string }): string {
	return createHash("sha256")
		.update([input.scope, input.key, input.kind, normalizeText(input.text)].join("\u0000"))
		.digest("hex");
}

/**
 * 条目 id（契约 2/3）：**定长 `m_` + 32 hex**。
 *
 * 为什么由 fiat 侧生成而不是 RAG 侧：归一化文本这件事跨语言做必然不一致
 * （`normalizeText` 依赖 Unicode 属性类），而 fiat 侧算出的键还要用于自己的幂等判断 ——
 * 两边各算一次就会出现「fiat 以为是同一条、RAG 以为是两条」。
 *
 * 为什么必须定长：RAG 的 `remove_document` 按**前缀**删（`bm25_indexer.py:394`），
 * 变长会出现「`m_abc` 是 `m_abcd` 的前缀」→ **误删他人条目**。
 * 取 32 位（128 bit）而不是更短：截断会引入碰撞，而碰撞的后果就是上面那条。
 */
export function memoryEntryId(input: { scope: string; key: string; kind: MemoryKind; text: string }): string {
	return `m_${memoryIdempotencyKey(input).slice(0, 32)}`;
}

// =====================================================================================
// §5 supersede 判定（P15-93⑤ / §15.6 约束 2）
// =====================================================================================

/**
 * 会互相顶替的 kind。
 *
 * ⚠️ **`feedback` 刻意不在其中** —— 这是一处非平凡的设计澄清，写下来免得后人「修」回去：
 *
 * §15.5 的晋升链要求「同向 `feedback` 累计 ≥ `promotionThreshold` 条才提炼成一条 `user`」。
 * 若 `feedback` 也走 supersede，那每写一条新的就会把上一条标 `superseded`，
 * **永远攒不到 3 条 active**，晋升链直接失效。
 *
 * 所以两个机制的职责是分开的且**互补**：
 *   - `user` / `project` / `reference`：**新替旧**（同一件事的最新说法），走 supersede
 *   - `feedback`：**累积**，由晋升链（§6）统一收口成一条 `user`，届时才标 `superseded`
 *
 * 这也解释了为什么两个机制都需要：只用 supersede 会丢「反复被纠正」这个信号，
 * 只用晋升则会让十条重复的 `feedback` 一直躺在检索结果里。
 */
export const SUPERSEDING_KINDS: readonly MemoryKind[] = ["user", "project", "reference"];

/** 一条候选要顶替哪些旧条目（返回旧条目 id 列表） */
export function pickSuperseded(
	candidate: { scope: string; key: string; kind: MemoryKind; text: string },
	existing: readonly MemoryEntry[],
	similarityFloor: number,
): string[] {
	if (!SUPERSEDING_KINDS.includes(candidate.kind)) return [];
	const out: string[] = [];
	for (const old of existing) {
		if (old.status !== "active") continue;
		if (old.scope !== candidate.scope || old.key !== candidate.key || old.kind !== candidate.kind) continue;
		// 同一条（幂等键相同）由写入侧 upsert 处理，不算 supersede —— 否则会把
		// 「重复提取同一条」记成「新条目替代了旧条目」，审计上读起来像发生了变更
		if (memoryIdempotencyKey({ ...candidate }) === memoryIdempotencyKey({ ...old })) continue;
		if (similarity(old.text, candidate.text) >= similarityFloor) out.push(old.id);
	}
	return out;
}

// =====================================================================================
// §6 feedback → user 晋升判定（P15-93⑥ / §15.5 晋升链）
// =====================================================================================

/** 一次晋升的产物（写入侧据此构造 `MemoryEntry` 并调 `memory_store`） */
export interface PromotionPlan {
	/** 提炼后的正文（已去事件锚点、去重、截断到 `maxTextChars`） */
	text: string;
	/** 被收口的 `feedback` 条目 id（**同时**作为 `supersedes` 与 `promotedFrom`，见下） */
	memberIds: string[];
	/** 该族的原始正文（诊断 / 审计用，不进记忆库） */
	memberTexts: string[];
}

/**
 * 事件锚点（「上次」「你刚才」…）。晋升要求「提炼式、**去事件锚点**」。
 *
 * 代码能做的「提炼」只有确定性变形，**不做语义归纳** —— §15.5 明确「不让 LLM 再判一次」
 * （与 §15.2「LLM 只产候选，代码决定落盘」同一口径）。所以这里的产物是
 * 「去掉时间锚点后的最短表述」，而不是一句真正被概括过的话。
 *
 * ⚠️ 诚实记录一个取舍：同族三条若措辞各异，拼接出来的正文会带冗余
 * （「改用 map；别用 forEach；用 map 不用 forEach」）。宁可冗余也不让 LLM 参与判定 ——
 * 冗余只影响可读性，而让 LLM 参与判定会让「谁决定写进热注入段」这件事失去确定性。
 */
const EVENT_ANCHOR_RE =
	/(?:上次|上一次|这次|这一次|刚才|刚刚|你刚才|之前那(?:次|回)|前几轮|本轮|这一轮|刚才那个|前面提到)/g;

/** 去掉事件锚点并清理残留标点 / 空白 */
export function stripEventAnchors(text: string): string {
	return text
		.replace(EVENT_ANCHOR_RE, "")
		.replace(/\s+/g, " ")
		.replace(/^[\s,，。.、;；:：]+|[\s,，。.、;；:：]+$/g, "")
		.trim();
}

/**
 * 同族聚类（**确定性**）：把 active 的 `feedback` 按「与族代表相似度 ≥ floor」归族。
 *
 * 用「族代表」而不是两两相似度图/并查集：后者在「A~B、B~C、A≁C」的链式情形下会把
 * 语义并不相同的一组并成一族（单链聚类漂移），而这是会把无关偏好合并的**静默错误**。
 * 代表法只回答「这条与**已经入族的代表**像不像」，行为可预测、可穷举测试。
 * 族代表取族内**第一条**（按传入顺序，调用方按 `createdAt` 升序传）。
 */
function clusterFeedback(
	entries: readonly MemoryEntry[],
	floor: number,
): Array<{ rep: MemoryEntry; members: MemoryEntry[] }> {
	const clusters: Array<{ rep: MemoryEntry; members: MemoryEntry[] }> = [];
	for (const e of entries) {
		const hit = clusters.find((c) => similarity(c.rep.text, e.text) >= floor);
		if (hit) hit.members.push(e);
		else clusters.push({ rep: e, members: [e] });
	}
	return clusters;
}

/**
 * 晋升判定（§15.5 的第二行）：达阈值的族各产出**一条** `user` 条目。
 *
 * `supersedes` 与 `promotedFrom` **同时**填同一批 id，这不是冗余：
 *   - `supersedes` 是**给 RAG 侧的指令** —— `memory_store` 的 J4.2 第 5 步据此
 *     把那些 id 标 `superseded`（契约 6：fiat 判定、RAG 执行）；
 *   - `promotedFrom` 是**给审计读的溯源链** —— 它回答「这条 `user` 是由哪几条
 *     `feedback` 提炼出来的」，与「被谁替代」是两个问题。
 * 只填 `supersedes` 会丢溯源，只填 `promotedFrom` 则 RAG 侧不会改状态，旧 `feedback`
 * 会继续留在检索结果里 —— 那正是晋升想解决的问题本身。
 */
export function pickPromotions(entries: readonly MemoryEntry[], config: MemoryConfig): PromotionPlan[] {
	const pool = entries
		.filter((e) => e.status === "active" && e.kind === "feedback")
		.sort((a, b) => a.evidence.createdAt.localeCompare(b.evidence.createdAt));

	const out: PromotionPlan[] = [];
	for (const cluster of clusterFeedback(pool, config.promote.similarityFloor)) {
		if (cluster.members.length < config.promote.promotionThreshold) continue;
		const memberTexts = cluster.members.map((m) => m.text);
		out.push({
			text: assemblePromotedText(memberTexts, config.write.maxTextChars),
			memberIds: cluster.members.map((m) => m.id),
			memberTexts,
		});
	}
	return out;
}

/**
 * 把族成员的正文拼成一条「提炼式」正文：逐个去锚点 → 去重 → 分号连接 → 截断。
 *
 * 顺序刻意是「先去重再截断」：先截断会把尾部成员整个丢掉，而那可能是最关键的一条。
 * 去重按**归一化**文本判等（与幂等键同源），这样「别用 forEach」与「别用 ForEach ！」
 * 会被认成同一条。
 */
export function assemblePromotedText(memberTexts: readonly string[], maxChars: number): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const raw of memberTexts) {
		const cleaned = stripEventAnchors(raw);
		if (cleaned.length === 0) continue;
		const key = normalizeText(cleaned);
		if (seen.has(key)) continue;
		seen.add(key);
		parts.push(cleaned);
	}
	const joined = parts.join("；");
	return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

// =====================================================================================
// §7 归类漂移检测（P15-93⑦ / §15.8）
// =====================================================================================

export interface KindDrift {
	/** 期望的 kind（纠正信号命中时是 `feedback`） */
	expected: MemoryKind;
	/** 实际产出的 kind */
	actual: MemoryKind;
	detail: string;
}

/**
 * 归类漂移：**纠正信号命中但 LLM 产出了别的 kind** → 记告警，**不拒**。
 *
 * 为什么不拒：一个纠正里可能同时含一条稳态偏好（「上次用 forEach 被要求改成 map」
 * 顺带说明「偏好函数式风格」），把它硬掰成 `feedback` 反而丢信息。
 * 但不拒 ≠ 不管 —— 漂移率是**提示词质量的度量**：如果 `correction_signal` 命中时
 * 大半产出都不是 `feedback`，说明 §15.5 的判定线在提示词里没写清楚。
 *
 * 只对 `correction` 报，不对 `confirmation` 报：§15.8 的硬约束原文是
 * 「纠正信号命中 → 优先 `feedback`」，没有对确认信号提同样要求。
 */
export function detectKindDrift(signal: SignalHit | null, candidate: MemoryCandidate): KindDrift | null {
	if (!signal || signal.kind !== "correction") return null;
	if (candidate.kind === "feedback") return null;
	return {
		expected: "feedback",
		actual: candidate.kind,
		detail: `纠正信号命中（${signal.rule}）但产出 kind=${candidate.kind}；按 §15.8 应优先 feedback`,
	};
}
