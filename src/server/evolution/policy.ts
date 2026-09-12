/**
 * policy —— 自进化的落盘判定（阶段 12 / P12-68）。**纯函数，零 Pi 依赖，零 IO。**
 *
 * 为什么必须是纯函数：这是整套设计里唯一「决定要不要把 LLM 产出写进磁盘」的地方。
 * 它必须能离线穷举测试（每个分支都能构造出来），且**不受模型输出影响**——
 * 判定只读提案、环境、配置、已有技能这四个输入。
 *
 * 规则顺序即优先级（§10.5；第 3 条是 §10.8 三条禁令的**正则兜底**插入点）：
 *
 *   1 保护清单（bundled / pinned / origin=human）      → reject
 *   2 role_facts 类但 roleFactsEnabled === false       → reject
 *   3 禁令兜底（审批泛化 / 金额规则）+ 脱敏扫描          → reject
 *   4 不合技能规范（缺 when_to_use / description 超长）  → reject
 *   5 与已有技能重复（slug 冲突 + 正文相似度 > 阈值）    → needs_approval
 *   6 env === "dev" && config.autoApplyDev             → auto_apply
 *   7 其余（staging / prod / dev 关了自动落盘）         → needs_approval
 *
 * 为什么「禁令」是正则兜底而不是只靠提示词（§10.8）：
 *   提示词是**劝**，prompt 注入可以绕过；正则与判定是**拦**。这与
 *   「tool_call block 只是第一道、服务端 canExecute 才是权威」是同一个思维。
 */

import { isValidSkillSlug } from "./skillStore.ts";
import type {
	Decision,
	DecisionRule,
	EvolutionConfig,
	EvolutionProposal,
	ProposalPayload,
	RoleFactsProposalPayload,
	SkillProposalPayload,
} from "./types.ts";

/** 已有技能的判定投影（只要判定用得到的部分，避免把整个 SkillMeta 拖进来） */
export interface ExistingSkill {
	name: string;
	body: string;
	origin: "agent" | "human";
	pinned: boolean;
	/** 兜底：判定为 human 的来源说明（`manifest` / `frontmatter` / `default`），只进 detail */
}

export interface DecideInput {
	proposal: Pick<EvolutionProposal, "kind" | "target" | "payload">;
	environment: string;
	config: EvolutionConfig;
	existing: readonly ExistingSkill[];
}

export interface DecideResult {
	decision: Decision;
	rule: DecisionRule;
	/** 命中细节（审计 / 测试断言用）：相似技能名、命中片段、字数等 */
	detail?: Record<string, unknown>;
}

/** 禁令命中的形状 */
export interface ForbiddenHit {
	rule: Extract<DecisionRule, "forbidden_approval_bypass" | "forbidden_amount_rule">;
	excerpt: string;
}

/** 敏感信息命中的形状（生产数据 / PII，沿用审计红线） */
export interface SensitiveHit {
	rule: string;
	/** 只留片段，绝不把命中原文落日志——否则判定过程本身就成了泄漏点 */
	excerpt: string;
}

// ---------- §10.8 三条禁令的正则兜底 ----------

/**
 * 禁令 1：**禁止把「某次审批通过」泛化成「以后不用审批」**。
 * 这是本项目最危险的技能形态——它会把三道闸门掏空。
 * 只匹配「肯定式」的泛化表述；否定语境（不得跳过审批 / 禁止绕过审批）先被摘掉再扫。
 */
const APPROVAL_BYPASS_PATTERNS: RegExp[] = [
	/(?:以后|今后|之后|后续|从此|下次|后续所有|未来的?)\s*(?:都|一律|全部|无需|不用|不必|免|跳过|绕过|取消|忽略)/,
	/(?:无需|不用|不必|跳过|绕过|免除|豁免|取消)\s*(?:再)?\s*(?:人工)?\s*(?:审批|审核|复核|approval|approve)/i,
	/(?:审批|审核|approval)\s*(?:已|被)?\s*(?:泛化|省略|可省|可跳过|免除了?|不再需要)/i,
	/(?:已经?|已)\s*(?:审批|授权)\s*(?:过|了)?\s*(?:一次)?\s*[,，。]?\s*(?:所以|因此|故)\s*(?:都|一律|无需|不用)/,
	/(?:不必|不需要|无需)\s*(?:每次都?|再)\s*(?:走|经|提交)?\s*(?:审批|审核)/,
];

/**
 * 禁令 2：**禁止在技能正文写金额 / 状态机 / 字段校验规则**。
 * 那是 L2 的活——技能只描述「怎么调工具」。匹配形式是「把某个数值写成判断/赋值」，
 * 而不是「提到金额这个词」（后者在业务 SOP 里太常见，做窄才有用）。
 */
const AMOUNT_RULE_PATTERNS: RegExp[] = [
	/(?:金额|额度|价格|费率|手续费率|汇率|阈值|限额|amount|price|fee[_ ]?rate|rate)\s*(?:=|＝|为|是|:|：|>|<|>=|<=)\s*[¥$]?\s*\d/i,
	/(?:如果|当|若|when)\s*[^\n]{0,16}(?:金额|amount|费率|rate)\s*[^\n]{0,10}(?:大于|小于|超过|低于|>=?|<=?)\s*\d/i,
	/(?:状态机|状态流转)\s*[:：]\s*\S+\s*(?:->|→|=>)\s*\S+/,
	/(?:字段校验|校验规则|正则)\s*[:：]\s*[`'"]?[\\^$*+?()[\]{}|]/,
];

/** 否定语境前缀：命中片段往前 8 字内出现这些词就跳过（避免「不得跳过审批」被误判） */
const NEGATION_PREFIX = /(?:不得|不能|不可|不要|不应|不许|严禁|禁止|切勿|避免|杜绝|防止|违反)\s*$/;

/**
 * 在整段文本里扫禁令模式。返回第一处命中。
 * 否定语境的处置是**启发式**：往前 8 个字符里出现否定词就跳过该次命中。
 * 之所以可用：这些模式匹配的都是「泛化 / 赋值」这类肯定式短语，正常写法里
 * 「不得跳过审批」的否定词必定紧邻其前。宁可漏判（还有提示词那一道）也不误杀好技能。
 */
export function findForbidden(text: string): ForbiddenHit | null {
	return (
		scanWithNegationGuard(text, APPROVAL_BYPASS_PATTERNS, "forbidden_approval_bypass") ??
		scanWithNegationGuard(text, AMOUNT_RULE_PATTERNS, "forbidden_amount_rule")
	);
}

function scanWithNegationGuard(
	text: string,
	patterns: readonly RegExp[],
	rule: ForbiddenHit["rule"],
): ForbiddenHit | null {
	for (const re of patterns) {
		const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
		for (const m of text.matchAll(global)) {
			const at = m.index ?? 0;
			const before = text.slice(Math.max(0, at - 8), at);
			if (NEGATION_PREFIX.test(before)) continue;
			return { rule, excerpt: truncate(m[0]) };
		}
	}
	return null;
}

// ---------- 脱敏扫描（禁令 3 + 通用 PII） ----------

const SENSITIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: "phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
	{ name: "bank_card", re: /(?<!\d)(?:\d[ -]?){15,19}(?!\d)/ },
	{
		name: "order_id",
		re: /(?:order[_-]?id|订单(?:号|id)|交易号|流水号|工单号)\s*[:=：]?\s*[A-Za-z0-9][A-Za-z0-9_-]{5,}/i,
	},
	{ name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

/** 生产数据 / PII 扫描；命中即拒（沿用审计红线：不进技能库、不进记忆） */
export function findSensitive(text: string): SensitiveHit | null {
	for (const { name, re } of SENSITIVE_PATTERNS) {
		const m = re.exec(text);
		if (m) return { rule: name, excerpt: truncate(m[0]) };
	}
	return null;
}

function truncate(s: string, n = 24): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------- 相似度（零依赖，确定性） ----------

/**
 * 正文相似度：**字符二元组 Dice 系数**。
 * 选它的理由：中文没有空格，词级 Jaccard 需要分词器（引入依赖且不确定）；
 * 字符 bigram 对中英混排都稳定、O(n) 可测、结果在 0..1。
 * 阈值 0.85 是设计值（§10.5）——实践中「同一套流程换了个名字」通常落在 0.7~0.95，
 * 而「同一流程新增一节」落在 0.5~0.7，所以 0.85 偏向「几乎原样重写」。
 */
export function similarity(a: string, b: string): number {
	const A = bigrams(normalizeText(a));
	const B = bigrams(normalizeText(b));
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const g of A) if (B.has(g)) inter += 1;
	return (2 * inter) / (A.size + B.size);
}

function normalizeText(s: string): string {
	return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
	return out;
}

// ---------- 正文归一化（幂等键与相似度共用） ----------

/**
 * 提案正文的归一化文本：技能取 body，记忆 / 运行约定取条目拼接。
 * 幂等键 = `hash(target + 归一化正文)`（§10.9）——所以归一化必须**稳定且与空白无关**，
 * 否则同一内容被模型换个换行就会重复落盘。
 */
export function normalizeProposalText(payload: ProposalPayload): string {
	if ("body" in payload) return normalizeText(payload.body);
	if ("entries" in payload) return normalizeText(payload.entries.join("\n"));
	return "";
}

/** 判定与落盘都要看的「正文全文」（正文 + description + when_to_use），用于禁令 / 脱敏扫描 */
export function fullTextOf(payload: ProposalPayload): string {
	if ("body" in payload) {
		const p = payload as SkillProposalPayload;
		return `${p.description}\n${p.whenToUse.join("\n")}\n${p.body}`;
	}
	if ("entries" in payload) return payload.entries.join("\n");
	return "";
}

// ---------- 主判定 ----------

export function decide(input: DecideInput): DecideResult {
	const { proposal, environment, config, existing } = input;
	const text = fullTextOf(proposal.payload);

	// —— 1 保护清单（§10.5 第 1 条）——
	// bundled / hub / external_dirs 这些 Hermes 概念在 fiat 不存在（技能库只有本目录一层），
	// 对应物是「人写的技能」与「pinned」。两者都 reject。
	if (proposal.kind === "skill") {
		const same = existing.find((s) => s.name === proposal.target);
		if (same?.pinned) {
			return {
				decision: { kind: "reject", reason: "技能已 pinned，受保护" },
				rule: "protected",
				detail: { skill: same.name, why: "pinned" },
			};
		}
		if (same?.origin === "human") {
			return {
				decision: { kind: "reject", reason: "技能来源为 human（人写锚点），自进化不可改写" },
				rule: "protected",
				detail: { skill: same.name, why: "origin=human" },
			};
		}
	}

	// —— 2 第三路默认关（§10.5 第 2 条 / §10.2 第 2 条）——
	if (proposal.kind === "role_facts" && !config.roleFactsEnabled) {
		return {
			decision: { kind: "reject", reason: "role_facts 默认关闭（不做个人画像）" },
			rule: "role_facts_disabled",
			detail: { role: (proposal.payload as RoleFactsProposalPayload).role },
		};
	}

	// —— 3 禁令兜底 + 脱敏扫描（§10.5 第 3 条，§10.8）——
	const forbidden = findForbidden(text);
	if (forbidden) {
		return {
			decision: { kind: "reject", reason: `命中禁令（${forbidden.rule}）` },
			rule: forbidden.rule,
			detail: { excerpt: forbidden.excerpt },
		};
	}
	const sensitive = findSensitive(text);
	if (sensitive) {
		return {
			decision: { kind: "reject", reason: `脱敏扫描命中（${sensitive.rule}）` },
			rule: "sensitive",
			detail: { kind: sensitive.rule, excerpt: sensitive.excerpt },
		};
	}

	// —— 4 技能规范（§10.5 第 4 条 / §10.6）——
	if (proposal.kind === "skill") {
		const p = proposal.payload as SkillProposalPayload;
		const problems: string[] = [];
		if (!isValidSkillSlug(proposal.target)) problems.push(`技能名不合规范（${proposal.target}）`);
		if (!p.description?.trim()) problems.push("缺 description");
		else if (p.description.trim().length > config.descriptionMaxChars) {
			problems.push(`description 超 ${config.descriptionMaxChars} 字（${p.description.trim().length}）`);
		}
		if (!p.whenToUse || p.whenToUse.length === 0) problems.push("缺 when_to_use");
		if (!p.body?.trim()) problems.push("正文为空");
		if (problems.length > 0) {
			return {
				decision: { kind: "reject", reason: `不合技能规范：${problems.join("；")}` },
				rule: "spec_violation",
				detail: { problems },
			};
		}
	}

	// —— 5 重复检测（§10.5 第 5 条）——
	// slug 冲突 + 正文相似度 > 阈值。交给人判「合并 or 新建」，因为自动合并会丢信息、
	// 自动新建会积累近义技能，两个方向都需要语义判断，而那正是 LLM 不可信的地方。
	if (proposal.kind === "skill") {
		const slugHit = existing.some((s) => s.name === proposal.target);
		const norm = normalizeProposalText(proposal.payload);
		let best: { name: string; score: number } | undefined;
		for (const s of existing) {
			if (s.name === proposal.target) continue;
			const score = similarity(s.body, norm);
			if (!best || score > best.score) best = { name: s.name, score };
		}
		if (slugHit) {
			return {
				decision: { kind: "needs_approval", reason: `技能名 ${proposal.target} 已存在（覆盖 or 改名，人判）` },
				rule: "duplicate",
				detail: { skill: proposal.target, why: "slug-conflict" },
			};
		}
		if (best && best.score > config.duplicateThreshold) {
			return {
				decision: { kind: "needs_approval", reason: `与已有技能 ${best.name} 高度相似（${best.score.toFixed(2)}）` },
				rule: "duplicate",
				detail: { skill: best.name, score: Number(best.score.toFixed(4)) },
			};
		}
	}

	// —— 6/7 环境分级（§10.5 第 6/7 条）——
	// 与 tool_policies.yaml 的 allowed_environments 语义对齐：环境本身就是风险分级的第一维度。
	if (environment === "dev" && config.autoApplyDev) {
		return { decision: { kind: "auto_apply" }, rule: "dev_auto_apply", detail: { environment } };
	}
	return {
		decision: { kind: "needs_approval", reason: `${environment} 环境变更需人工审批` },
		rule: "env_approval",
		detail: { environment, autoApplyDev: config.autoApplyDev },
	};
}
