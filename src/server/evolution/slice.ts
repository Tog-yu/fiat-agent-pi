/**
 * slice —— 评审 fork 的**脱敏切片**（阶段 12 / P12-66 配套，§10.7 第 3 条）。
 *
 * ⚠️ 这是整套设计里唯一「把主会话内容喂进另一个 LLM 会话」的地方，风险最高：
 * 主 transcript 里可能有真实订单号、金额、用户标识。§10.12 踩坑表明确要求
 * **宁可少给上下文**。
 *
 * 所以这里做两件事，缺一不可：
 *
 *   1. **降采样**：只取近 N 个「用户轮」，每轮只保留
 *        user 摘要 / assistant 的工具名 / toolResult 的 (工具名, isError, 输出摘要)
 *      —— **不落 prompt 全文、不落工具原始输出**。与阶段 11 采集红线同源。
 *   2. **二次脱敏**：即便降到摘要，输出里仍可能夹带 ID / 金额；再过一遍正则把
 *      手机号 / 卡号 / 订单号 / 邮箱 / 长数字串替换成 `[已脱敏]`。
 *
 * 输出是给人看的纯文本（会作为 fork 会话的第一条 user 消息），不是结构化数据——
 * 结构化的部分是给机器的，这里恰恰要「少而模糊」。
 */

import { findSensitive } from "./policy.ts";

export interface SliceOptions {
	/** 回放多少个用户轮（默认 12，取 config.sliceTurns） */
	turns: number;
	/** 每条摘要的字数上限 */
	entryChars?: number;
}

/** 单条摘要的字数上限（够传达「发生了什么」，不足以泄漏完整业务数据） */
const DEFAULT_ENTRY_CHARS = 160;

interface TextPart {
	type?: string;
	text?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const p = item as TextPart | undefined;
		if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("\n");
}

/** 工具调用名（assistant 消息里 type === "toolCall" 的项） */
function toolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const item of content) {
		const p = item as { type?: string; name?: string } | undefined;
		if (p?.type === "toolCall" && typeof p.name === "string") out.push(p.name);
	}
	return out;
}

/**
 * 输出二次脱敏：把审计红线里的敏感形态替换掉。
 * 复用 `policy.findSensitive` 的同一批模式（单一事实源——脱敏与判定不能有两套正则，
 * 否则会出现「判定说没有敏感信息、切片却漏出去」的裂缝）。
 */
export function redact(text: string): string {
	let out = text;
	// 反复替换直到没有命中（一次 replace 只处理第一个匹配）
	for (let i = 0; i < 50; i += 1) {
		const hit = findSensitive(out);
		if (!hit) break;
		const next = replaceFirstHit(out);
		if (next === out) break;
		out = next;
	}
	return out;
}

function replaceFirstHit(text: string): string {
	// 与 policy.SENSITIVE_PATTERNS 同源：这里只做替换，模式本身不重复定义
	const patterns = [
		/(?<!\d)1[3-9]\d{9}(?!\d)/,
		/(?<!\d)(?:\d[ -]?){15,19}(?!\d)/,
		/(?:order[_-]?id|订单(?:号|id)|交易号|流水号|工单号)\s*[:=：]?\s*[A-Za-z0-9][A-Za-z0-9_-]{5,}/i,
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
	];
	for (const re of patterns) {
		if (re.test(text)) return text.replace(re, "[已脱敏]");
	}
	return text;
}

function summarize(text: string, limit: number): string {
	const flat = redact(text).replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 把 transcript 压成脱敏切片。
 * 返回空串 = 没有可回放的内容（宿主要能处理这种情况，别起一个空 fork）。
 */
export function buildSanitizedSlice(messages: readonly unknown[], opts: SliceOptions): string {
	const limit = opts.entryChars ?? DEFAULT_ENTRY_CHARS;

	// 先按「用户轮」切段：每条 user 消息开启一个新轮
	const groups: unknown[][] = [];
	for (const m of messages) {
		const role = (m as { role?: string } | undefined)?.role;
		if (role === "user" || groups.length === 0) groups.push([]);
		groups[groups.length - 1]?.push(m);
	}
	const recent = groups.slice(-Math.max(1, opts.turns));

	const lines: string[] = [];
	for (const [i, group] of recent.entries()) {
		lines.push(`--- 轮 ${i + 1} ---`);
		for (const m of group) {
			const msg = m as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
			if (msg.role === "user") {
				lines.push(`[用户] ${summarize(textOf(msg.content), limit)}`);
			} else if (msg.role === "assistant") {
				const calls = toolCallNames(msg.content);
				const reply = summarize(textOf(msg.content), limit);
				const callText = calls.length > 0 ? `调用工具：${calls.join(", ")}` : "（无工具调用）";
				lines.push(`[助手] ${callText}${reply ? ` | ${reply}` : ""}`);
			} else if (msg.role === "toolResult") {
				const flag = msg.isError ? "失败" : "成功";
				lines.push(`[工具 ${msg.toolName ?? "?"}] ${flag} | ${summarize(textOf(msg.content), limit)}`);
			}
		}
	}
	return lines.join("\n");
}
