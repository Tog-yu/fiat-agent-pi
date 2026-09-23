/**
 * memory/submit —— 提取 fork 的**唯一工具**与候选收集口（P15-94）。
 *
 * 阶段 12 的对应物是 `host/l1b/propose-tools.ts`：fork 能做的只有「把结构化候选交出去」，
 * 真正的落盘由确定性代码决定（§15.2「LLM 只产候选，代码决定落盘」）。
 * 记忆这边**更严一层**：这里的工具只往一个**内存收集口**写，连提案表都不碰 ——
 * 落库要再穿过 `policy.ts` 的六道校验与 `store.ts` 的写入通道。
 *
 * ### 为什么 sink 与 tool 分成两半
 *
 * `MemoryCandidateSink` 是**纯内存对象、零 Pi 依赖**，因此可以被 `extractor.ts` 持有、
 * 被单测直接驱动（faux 的 `runFork` 往 sink 里塞候选即可，不需要起真的 fork）。
 * `createMemorySubmitTool` 才需要 `HostTool` 形态，供组合根装配到 fork 会话里。
 * 拆开之后「提取编排」与「fork 装配」可以各自测试，也正是 `reviewer.ts` 的既有分层方式。
 *
 * ### 形态归一化在这里做，策略判定不在这里做
 *
 * 本文件只回答「这条东西能不能被当作一条候选读出来」（缺字段 / 类型不对就进 `malformed`），
 * **不回答「该不该记」** —— 那是 `policy.validateCandidate` 的职责。
 * 混在一起会让「形态错」与「策略拒」在日志里无法区分，而这两类要采取的行动完全不同
 * （前者是提示词/schema 问题，后者是模型判断问题）。
 */

import { defineHostTool, type HostTool } from "../host/tools.ts";
import { MEMORY_SUBMIT_TOOL } from "./prompts.ts";
import type { MemoryCandidate, MemoryKind } from "./types.ts";

/** 形态不合的原始输入（诊断用；**不落日志正文**，只留原因） */
export interface MalformedCandidate {
	raw: unknown;
	reason: string;
}

/** 候选收集口：extractor 持有，submit 工具往里写 */
export interface MemoryCandidateSink {
	readonly candidates: readonly MemoryCandidate[];
	readonly malformed: readonly MalformedCandidate[];
	/** 达上限后被丢弃的条数（提示词要求 ≤ maxPerRun，超了说明模型没照做） */
	readonly overflow: number;
	/** 尝试接收一条；返回是否被接收（false = 形态不合或超上限） */
	add(raw: unknown): boolean;
}

/**
 * 创建收集口。
 *
 * `maxCandidates` = `config.write.maxPerRun`（缺省 5）。上限放在**收集口**而不是事后截断：
 * 事后截断会让「模型一次提交了 50 条」这件事完全不可见，而它恰恰是提示词该被修的信号。
 * 这里的处置与 §15.14 硬约束 9（单次条数上限）一致 —— 记忆不是文档库。
 */
export function createCandidateSink(maxCandidates: number): MemoryCandidateSink {
	const candidates: MemoryCandidate[] = [];
	const malformed: MalformedCandidate[] = [];
	let overflow = 0;

	return {
		get candidates() {
			return candidates;
		},
		get malformed() {
			return malformed;
		},
		get overflow() {
			return overflow;
		},
		add(raw: unknown): boolean {
			const parsed = normalizeCandidate(raw);
			if (typeof parsed === "string") {
				// 形态不合：只记原因与原始形态，不把正文带进日志（硬约束 6 的延伸）
				malformed.push({ raw, reason: parsed });
				return false;
			}
			if (candidates.length >= maxCandidates) {
				overflow += 1;
				return false;
			}
			candidates.push(parsed);
			return true;
		},
	};
}

/** 归一化单条候选；返回字符串 = 失败原因 */
function normalizeCandidate(raw: unknown): MemoryCandidate | string {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "not_an_object";
	const r = raw as Record<string, unknown>;
	// kind 只检查「是不是字符串」——**合法值判定留给 policy**，这样「未知 kind」会以
	// `invalid_kind` 出现在拒收原因里，而不是被这里悄悄吞掉
	if (typeof r.kind !== "string") return "kind_not_string";
	if (typeof r.text !== "string") return "text_not_string";
	const confidence = typeof r.confidence === "number" ? r.confidence : Number(r.confidence);
	if (!Number.isFinite(confidence)) return "confidence_not_number";
	return {
		kind: r.kind as MemoryKind,
		text: r.text,
		confidence,
		reason: typeof r.reason === "string" ? r.reason : "",
	};
}

/**
 * `fiat_memory_submit` —— fork 白名单里**唯一**的工具。
 *
 * 注意它的 `parameters` 里**没有** `scope` / `key`（硬约束 3：隔离标识不出现在任何对模型的
 * schema 里）。模型看不到、也改不了隔离边界 —— 这是结构性保证，不是提示词要求。
 *
 * `execute` 刻意**不标注自定义的 params 类型**：`defineHostTool` 会从 schema 推断出一个
 * 全 `unknown` 的宽松形状，硬标一个收窄的接口只会多出一次 cast。而形态判定本来就全部
 * 由 `sink.add()` 里的 `normalizeCandidate` 负责 —— 那一层对「模型真的传了什么」更诚实
 * （类型标注在运行时不存在，见 `policy.ts` 里 kind 白名单的同一条理由）。
 */
export function createMemorySubmitTool(sink: MemoryCandidateSink): HostTool {
	return defineHostTool({
		name: MEMORY_SUBMIT_TOOL,
		label: "Fiat Memory Submit",
		description:
			"提交本次提取到的跨会话记忆候选（只进内存收集口，不落库、不产生任何写入）。" +
			"落库与否则由确定性代码判定。若没有值得记住的事实，提交空列表。",
		parameters: {
			type: "object",
			properties: {
				candidates: {
					type: "array",
					description: "候选列表；没有值得记住的就传空数组",
					items: {
						type: "object",
						properties: {
							kind: {
								type: "string",
								description:
									"user（关于人的稳态事实）/ feedback（对助手的纠正或确认）/ project（目标·决策·期限）/ reference（什么在哪儿）",
							},
							text: { type: "string", description: "一句完整的话，不含事件锚点（不要写「上次」「这次」）" },
							confidence: { type: "number", description: "自评置信度 0~1；拿不准就调低" },
							reason: { type: "string", description: "为什么值得记（仅供审计，不进记忆库）" },
						},
						required: ["kind", "text", "confidence"],
					},
				},
			},
			required: ["candidates"],
		},
		async execute(_toolCallId, params) {
			const list = Array.isArray(params?.candidates) ? params.candidates : [];
			let accepted = 0;
			for (const item of list) {
				if (sink.add(item)) accepted += 1;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							accepted,
							overflow: sink.overflow,
							malformed: sink.malformed.length,
							note: "候选已交给确定性代码判定，此处不代表已落库",
						}),
					},
				],
				details: { memorySubmit: true, accepted },
			};
		},
	});
}
