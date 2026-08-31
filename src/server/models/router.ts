/**
 * L2 模型路由 —— 纯函数、声明式、无 LLM（铁律 4：LLM 不参与判定）。
 *
 * 数据源：config/model_policies.yaml（providers / tiers / task_tiers / fallback）。
 * 职责：任务类型 → 复杂度 tier → provider；provider 不可用时按 fallback 链降级。
 *
 * **为什么不能在 Pi 里做**：Pi 明确不提供按任务模型路由（README 声明无此能力），
 * 且 `before_agent_start` 的返回值只有 `message` / `systemPrompt` 两个字段
 * （types.ts:1062-1066），**改不了模型**。所以路由决策在 L2 算好，由 L1 扩展
 * 通过 `pi.setModel(model)` 副作用应用（ExtensionAPI.setModel，types.ts:1296）。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** 配置里的 type 字段；映射到 Pi 的 Api 名见 piApiName */
export type ProviderType = "openai" | "anthropic";

/** Pi 的 Api 联合成员（packages/ai/src/types.ts:16-21） */
export type PiApiName = "openai-completions" | "anthropic-messages";

export interface ProviderConfig {
	type: ProviderType;
	base_url: string;
	model: string;
	api_key_env: string;
	enabled: boolean;
}

export type Tier = "complex" | "medium" | "simple";

export type TaskType = "alert_diagnosis" | "table_parse" | "rag_qa" | "general";

export interface ModelPolicies {
	providers: Record<string, ProviderConfig>;
	/** tier → provider 名 */
	tiers: Record<Tier, string>;
	/** 任务类型 → tier；未列出的走 default_tier */
	task_tiers: Record<string, Tier>;
	default_tier: Tier;
	/** tier → 降级时依次尝试的 tier 列表 */
	fallback: Record<Tier, Tier[]>;
}

export function loadModelPolicies(path: string): ModelPolicies {
	return parse(readFileSync(path, "utf-8")) as ModelPolicies;
}

/** 配置 type → Pi Api 名 */
export function piApiName(type: ProviderType): PiApiName {
	return type === "anthropic" ? "anthropic-messages" : "openai-completions";
}

/** 分类规则：按顺序匹配，命中即返回。越具体越靠前。 */
export interface TaskKeywordRule {
	task: TaskType;
	words: string[];
}

export const DEFAULT_TASK_KEYWORDS: TaskKeywordRule[] = [
	{
		task: "alert_diagnosis",
		words: [
			"告警",
			"报警",
			"alert",
			"故障",
			"异常",
			"报错",
			"错误",
			"排查",
			"诊断",
			"定位问题",
			"error",
			"exception",
			"超时",
			"抖动",
		],
	},
	{
		task: "table_parse",
		words: ["表格", "对账", "返现", "物流", "解析", "清单", "差异", "报表", "核算", "csv", "excel", "订单号"],
	},
	{
		task: "rag_qa",
		words: ["什么是", "怎么", "如何", "为什么", "规则", "政策", "文档", "知识", "咨询", "流程"],
	},
];

/** 任务分类：纯关键词，不调 LLM。rules 可注入以便测试或定制。 */
export function classifyTask(prompt: string, rules: TaskKeywordRule[] = DEFAULT_TASK_KEYWORDS): TaskType {
	const text = prompt.toLowerCase();
	for (const rule of rules) {
		if (rule.words.some((w) => text.includes(w.toLowerCase()))) return rule.task;
	}
	return "general";
}

/** 任务类型 → tier（未列出或未命中 → default_tier） */
export function resolveTier(taskType: TaskType, policies: ModelPolicies): Tier {
	return policies.task_tiers[taskType] ?? policies.default_tier;
}

export interface ProviderChoice {
	provider: string;
	/** 实际命中的 tier（降级后与原 tier 不同） */
	tier: Tier;
	/** 是否走了降级链 */
	fallbackUsed: boolean;
	config: ProviderConfig;
}

/** provider 可用 = 配置 enabled 且运行时可用（密钥 / 模型可解析） */
export function isProviderUsable(
	provider: string,
	policies: ModelPolicies,
	isAvailable: (provider: string) => boolean = () => true,
): boolean {
	const cfg = policies.providers[provider];
	return Boolean(cfg?.enabled) && isAvailable(provider);
}

/**
 * tier → provider，带 fallback 链。
 * 链 = [tier, ...fallback[tier]]，逐个跳过未配置 / disabled / 不可用的。
 * 全部不可用返回 undefined（调用方应保持当前模型，而不是硬切）。
 */
export function resolveProvider(
	tier: Tier,
	policies: ModelPolicies,
	isAvailable: (provider: string) => boolean = () => true,
): ProviderChoice | undefined {
	const chain: Tier[] = [tier, ...(policies.fallback[tier] ?? [])];
	for (const t of chain) {
		const provider = policies.tiers[t];
		if (!provider) continue;
		const config = policies.providers[provider];
		if (!config) continue;
		if (!isProviderUsable(provider, policies, isAvailable)) continue;
		return { provider, tier: t, fallbackUsed: t !== tier, config };
	}
	return undefined;
}

export interface RouteDecision {
	taskType: TaskType;
	/** 期望 tier（降级前的原始 tier） */
	requestedTier: Tier;
	choice: ProviderChoice;
	/** `provider/model`，给 ModelRegistry.find 用 */
	modelRef: string;
}

/** 完整决策：prompt → 任务类型 → tier → provider（含降级）。无可用 provider 返回 undefined。 */
export function routeModel(
	prompt: string,
	policies: ModelPolicies,
	isAvailable: (provider: string) => boolean = () => true,
): RouteDecision | undefined {
	const taskType = classifyTask(prompt);
	const requestedTier = resolveTier(taskType, policies);
	const choice = resolveProvider(requestedTier, policies, isAvailable);
	if (!choice) return undefined;
	return {
		taskType,
		requestedTier,
		choice,
		modelRef: `${choice.provider}/${choice.config.model}`,
	};
}
