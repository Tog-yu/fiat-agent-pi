/**
 * 技能索引注入（阶段 12 / P12-65）—— 纯字符串拼装，零 Pi 依赖。
 *
 * §10.3：**systemPrompt 只注入索引**（name + ≤60 字 description + when_to_use），
 * 正文按需用 `fiat_skill_view` 读取。理由是 token 经济学：
 *   - 索引段随技能数线性增长，一个技能一行（~30 token）
 *   - 正文可能几百上千 token，只有真的要用时才值得进上下文
 *
 * 三条注入纪律（§10.6 + §10.12 踩坑表）：
 *
 * 1. **追加在末尾**。索引段放最前面或中间都会让「系统提示词前缀」随技能库变化而整体位移，
 *    prefix cache 每轮全废。放末尾 = 前面的人写锚点（业务上下文 / 角色 / 合规约束）
 *    保持字节级稳定。
 * 2. **按 name 稳定排序**（已验证的排在前，组内仍按 name）。§10.10 要求「unverified
 *    排在 verified 之后」，§10.6 要求「顺序稳定」——两者用「先分组、组内按 name」
 *    同时满足：分数只影响括号里的数字，不影响顺序，所以分数刷新不会打掉 cache。
 * 3. **只在落盘后变化**。索引的输入是 `SkillStore.index()`，它只在 apply / verify /
 *    archive 时变——一轮评审最多变一次，而不是每轮都变。
 *
 * 记忆段（②③ 路）同样追加在末尾，但排在技能索引**之后**（技能比事实更常被用到）。
 */

import type { SkillIndexEntry } from "./skillStore.ts";

export interface PromptSections {
	skills?: SkillIndexEntry[];
	/** ② 近期事实摘要（已由 memoryStore 截断） */
	memory?: string;
	/** ③ 当前 role 的运行约定（已由 memoryStore 截断） */
	roleFacts?: string;
}

const SKILL_HEADER = "## 可用技能（按需用 fiat_skill_view 读取正文）";
const MEMORY_HEADER = "## 近期事实（提示层：不得作为金额 / 状态机 / 字段校验的依据）";
const ROLE_HEADER = "## 运行约定（提示层，同上）";

/** 单行索引：`- name (0.92|unverified): description → when_to_use` */
export function renderSkillLine(e: SkillIndexEntry): string {
	const mark = e.score === undefined ? "unverified" : e.score.toFixed(2);
	const when = e.whenToUse.length > 0 ? ` → ${e.whenToUse.join(" / ")}` : "";
	const pin = e.pinned ? " [pinned]" : "";
	return `- ${e.name} (${mark})${pin}: ${e.description}${when}`;
}

/**
 * 渲染索引段。空技能库返回空串（**不输出空标题**）——否则一份空标题也会进 systemPrompt，
 * 白白多出一段恒定文本。
 */
export function renderSkillIndex(entries: readonly SkillIndexEntry[]): string {
	if (entries.length === 0) return "";
	const verified = entries.filter((e) => e.score !== undefined).sort(byName);
	const unverified = entries.filter((e) => e.score === undefined).sort(byName);
	const lines = [...verified, ...unverified].map(renderSkillLine);
	return `${SKILL_HEADER}\n${lines.join("\n")}`;
}

function byName(a: SkillIndexEntry, b: SkillIndexEntry): number {
	return a.name.localeCompare(b.name);
}

/**
 * 组装最终 systemPrompt：`base` 原样在前，各段按固定顺序追加在末尾。
 * 段与段之间空一行；所有段都为空时**原样返回 base**（不引入任何多余空白，
 * 保证「没开自进化」与「以前的行为」字节级一致）。
 */
export function composeSystemPrompt(base: string, sections: PromptSections): string {
	const blocks: string[] = [];
	const skills = renderSkillIndex(sections.skills ?? []);
	if (skills) blocks.push(skills);
	if (sections.memory?.trim()) blocks.push(`${MEMORY_HEADER}\n${sections.memory.trim()}`);
	if (sections.roleFacts?.trim()) blocks.push(`${ROLE_HEADER}\n${sections.roleFacts.trim()}`);
	if (blocks.length === 0) return base;

	const suffix = blocks.join("\n\n");
	if (!base.trim()) return suffix;
	return `${base.replace(/\s+$/, "")}\n\n${suffix}`;
}
