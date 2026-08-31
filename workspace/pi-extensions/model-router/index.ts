/**
 * model-router —— L1 扩展：按任务类型选模型（P6-24）。
 *
 * **Pi 的两个限制决定了这里的写法**：
 *   1. Pi 不提供按任务模型路由（README 明确无此能力）。
 *   2. `before_agent_start` 的返回值只有 `message` / `systemPrompt`（types.ts:1062-1066），
 *      **改不了模型**。所以只能靠副作用：ExtensionAPI.setModel（types.ts:1296）。
 *   好在 runner.ts:1023 是 `await handler(event, ctx)` —— 切模型在 agent loop 启动前完成。
 *
 * 分工（与权限闸门同构）：
 *   - L2 `src/server/models/router.ts` 算决策（纯函数、可离线测）
 *   - L1 本扩展只做两件事：注册 provider、把决策应用到 `pi.setModel`
 *
 * 密钥只以 `$ENV_VAR` 形式交给 Pi 去插值，绝不内联明文。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ModelPolicies,
	type ProviderConfig,
	piApiName,
	type RouteDecision,
	routeModel,
} from "../../../src/server/models/router.ts";

/** `provider/model` → Model 对象。生产注入 ModelRegistry.find，测试注入 fake。 */
export type ModelResolver = (modelRef: string) => Model<Api> | undefined;

/** 任何带 find(provider, id) 的对象都能用（真实 ModelRegistry 满足，测试可塞假实现） */
export interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/** `provider/model` 拆成两参喂给 registry.find */
export function registryResolver(registry: ModelRegistryLike): ModelResolver {
	return (modelRef) => {
		const idx = modelRef.indexOf("/");
		if (idx <= 0 || idx === modelRef.length - 1) return undefined;
		return registry.find(modelRef.slice(0, idx), modelRef.slice(idx + 1));
	};
}

export interface RouteApplied {
	/** 有可用 provider 时才有决策；无可用（含降级链走完）时为 undefined */
	decision?: RouteDecision;
	/** 是否真的切换了模型 */
	applied: boolean;
	/** 未切换的原因（无可用 provider / 模型解析不到 / setModel 拒绝） */
	reason?: "no-route" | "model-unresolved" | "set-model-rejected";
}

export interface ModelRouterDeps {
	policies: ModelPolicies;
	resolveModel: ModelResolver;
	/** 路由结果回调（审计 / 日志 / 测试断言） */
	onRoute?: (info: RouteApplied) => void;
	/** 是否注册该 provider；缺省只注册 enabled 的 */
	shouldRegister?: (provider: string, config: ProviderConfig) => boolean;
}

/** registerProvider 要求 models[] 必填这些字段，配置里没有的给保守默认值 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 注册配置里的 provider；返回实际注册的名字（顺序即配置顺序） */
export function registerProviders(pi: ExtensionAPI, deps: ModelRouterDeps): string[] {
	const registered: string[] = [];
	for (const [name, cfg] of Object.entries(deps.policies.providers ?? {})) {
		const should = deps.shouldRegister?.(name, cfg) ?? cfg.enabled;
		if (!should) continue;

		pi.registerProvider(name, {
			baseUrl: cfg.base_url,
			apiKey: `$${cfg.api_key_env}`,
			api: piApiName(cfg.type),
			models: [
				{
					id: cfg.model,
					name: `${name}/${cfg.model}`,
					reasoning: false,
					input: ["text"],
					cost: { ...ZERO_COST },
					contextWindow: DEFAULT_CONTEXT_WINDOW,
					maxTokens: DEFAULT_MAX_TOKENS,
				},
			],
		});
		registered.push(name);
	}
	return registered;
}

/** 算决策 → 解析 Model → pi.setModel。任一步失败都保持当前模型（fail-safe，不硬切）。 */
export async function applyRoute(pi: ExtensionAPI, deps: ModelRouterDeps, prompt: string): Promise<RouteApplied> {
	const decision = routeModel(
		prompt,
		deps.policies,
		(p) => deps.resolveModel(modelIdOf(deps.policies, p)) !== undefined,
	);

	if (!decision) {
		const info: RouteApplied = { applied: false, reason: "no-route" };
		deps.onRoute?.(info);
		return info;
	}

	const model = deps.resolveModel(decision.modelRef);
	if (!model) {
		const info: RouteApplied = { decision, applied: false, reason: "model-unresolved" };
		deps.onRoute?.(info);
		return info;
	}

	const ok = await pi.setModel(model);
	const info: RouteApplied = {
		decision,
		applied: ok,
		reason: ok ? undefined : "set-model-rejected",
	};
	deps.onRoute?.(info);
	return info;
}

/** provider 名 → 该 provider 的 model id，用于可用性探测（resolveModel 需要完整 ref） */
function modelIdOf(policies: ModelPolicies, provider: string): string {
	return `${provider}/${policies.providers[provider]?.model ?? ""}`;
}

export function createModelRouter(deps: ModelRouterDeps) {
	return (pi: ExtensionAPI) => {
		registerProviders(pi, deps);

		pi.on("before_agent_start", async (event) => {
			await applyRoute(pi, deps, event.prompt);
			// 返回值不改 systemPrompt，避免与其他扩展抢覆写；路由结果走 deps.onRoute
			return undefined;
		});
	};
}
