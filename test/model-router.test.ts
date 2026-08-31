/**
 * P6-24 model-router 测试。
 *
 * 分两层：
 *   1. 纯逻辑（src/server/models/router.ts）—— 分类 / tier / fallback，零 Pi 依赖
 *   2. 扩展层（workspace/pi-extensions/model-router）—— 注册 provider、applyRoute、faux 端到端
 *
 * 端到端用**真实 config/model_policies.yaml**：local 默认 disabled，
 * 所以 rag_qa（simple）会真实走一次 fallback 链降级到 deepseek（medium）。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyTask,
	loadModelPolicies,
	type ModelPolicies,
	type ProviderConfig,
	piApiName,
	resolveProvider,
	resolveTier,
	routeModel,
} from "../src/server/models/router.ts";
import { buildSession } from "../src/server/session/factory.ts";
import {
	applyRoute,
	createModelRouter,
	type ModelRouterDeps,
	type RouteApplied,
	registerProviders,
	registryResolver,
} from "../workspace/pi-extensions/model-router/index.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));
const MODEL_POLICY_PATH = fileURLToPath(new URL("../config/model_policies.yaml", import.meta.url));

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
	type: "openai",
	base_url: "http://127.0.0.1:1/v1",
	model: "m",
	api_key_env: "FIAT_TEST_KEY",
	enabled: true,
	...over,
});

const mkPolicies = (over: Partial<ModelPolicies> = {}): ModelPolicies => ({
	providers: { p1: provider({ model: "m1" }), p2: provider({ model: "m2" }) },
	tiers: { complex: "p1", medium: "p2", simple: "p2" },
	task_tiers: { alert_diagnosis: "complex" },
	default_tier: "medium",
	fallback: { simple: ["medium", "complex"], medium: ["complex"], complex: [] },
	...over,
});

// ---------------------------------------------------------------- 1. 纯逻辑

describe("P6-24 纯逻辑：任务分类", () => {
	it("告警 / 报错 / error → alert_diagnosis", () => {
		expect(classifyTask("支付服务告警，帮忙排查一下")).toBe("alert_diagnosis");
		expect(classifyTask("接口一直报错")).toBe("alert_diagnosis");
		expect(classifyTask("there is an error in the log")).toBe("alert_diagnosis");
	});

	it("对账 / 返现 / 表格 → table_parse", () => {
		expect(classifyTask("把这批返现订单对账")).toBe("table_parse");
		expect(classifyTask("解析这个 csv 清单")).toBe("table_parse");
	});

	it("怎么 / 规则 / 政策 → rag_qa", () => {
		expect(classifyTask("退款政策是怎么规定的")).toBe("rag_qa");
		expect(classifyTask("充值流程是什么")).toBe("rag_qa");
	});

	it("都不命中 → general", () => {
		expect(classifyTask("帮我看看这个")).toBe("general");
	});

	it("多类关键词共存时按规则顺序取最靠前的（告警优先于对账）", () => {
		expect(classifyTask("对账任务告警了")).toBe("alert_diagnosis");
	});
});

describe("P6-24 纯逻辑：tier 解析", () => {
	it("命中 task_tiers", () => {
		expect(resolveTier("alert_diagnosis", mkPolicies())).toBe("complex");
	});

	it("未命中走 default_tier", () => {
		expect(resolveTier("rag_qa", mkPolicies())).toBe("medium");
	});
});

describe("P6-24 纯逻辑：provider 选择与降级链", () => {
	it("正常命中 tier 对应 provider", () => {
		const c = resolveProvider("complex", mkPolicies());
		expect(c?.provider).toBe("p1");
		expect(c?.fallbackUsed).toBe(false);
	});

	it("provider disabled 且该 tier 无 fallback 目标 → undefined", () => {
		const p = mkPolicies({ providers: { p1: provider({ enabled: false }), p2: provider({ model: "m2" }) } });
		// complex 的 fallback 是空链，p1 又 disabled → 无可用
		expect(resolveProvider("complex", p)).toBeUndefined();
	});

	it("simple 的 provider 不可用 → 降级到 medium", () => {
		const p = mkPolicies({
			providers: { p1: provider({ model: "m1" }), p2: provider({ model: "m2", enabled: false }) },
			tiers: { complex: "p1", medium: "p1", simple: "p2" },
		});
		const c = resolveProvider("simple", p);
		expect(c?.provider).toBe("p1");
		expect(c?.tier).toBe("medium");
		expect(c?.fallbackUsed).toBe(true);
	});

	it("运行时不可用（isAvailable=false）同样触发降级", () => {
		const p = mkPolicies({ fallback: { simple: ["medium"], medium: [], complex: ["medium"] } });
		const c = resolveProvider("complex", p, (name) => name !== "p1");
		expect(c?.provider).toBe("p2");
		expect(c?.tier).toBe("medium");
		expect(c?.fallbackUsed).toBe(true);
	});

	it("整条链都不可用 → undefined（调用方保持当前模型）", () => {
		const c = resolveProvider("complex", mkPolicies(), () => false);
		expect(c).toBeUndefined();
	});
});

describe("P6-24 纯逻辑：routeModel 端到端 + 真实配置", () => {
	it("routeModel 串起 分类 → tier → provider，并给出 modelRef", () => {
		const d = routeModel("支付告警排查", mkPolicies());
		expect(d?.taskType).toBe("alert_diagnosis");
		expect(d?.requestedTier).toBe("complex");
		expect(d?.choice.provider).toBe("p1");
		expect(d?.modelRef).toBe("p1/m1");
	});

	it("无可用 provider 时 routeModel 返回 undefined", () => {
		expect(routeModel("支付告警排查", mkPolicies(), () => false)).toBeUndefined();
	});

	it("真实配置：rag_qa → simple，但 local disabled → 降级到 deepseek(medium)", () => {
		const policies = loadModelPolicies(MODEL_POLICY_PATH);
		expect(policies.providers.local?.enabled).toBe(false);

		const d = routeModel("退款政策是怎么规定的", policies);
		expect(d?.taskType).toBe("rag_qa");
		expect(d?.requestedTier).toBe("simple");
		expect(d?.choice.provider).toBe("deepseek");
		expect(d?.choice.tier).toBe("medium");
		expect(d?.choice.fallbackUsed).toBe(true);
	});

	it("真实配置：alert_diagnosis → complex → gpt，不降级", () => {
		const policies = loadModelPolicies(MODEL_POLICY_PATH);
		const d = routeModel("支付服务告警，请排查", policies);
		expect(d?.choice.provider).toBe("gpt");
		expect(d?.choice.fallbackUsed).toBe(false);
		expect(d?.modelRef).toBe("gpt/gpt-5.6-terra");
	});

	it("piApiName 映射 openai/anthropic → Pi Api 名", () => {
		expect(piApiName("openai")).toBe("openai-completions");
		expect(piApiName("anthropic")).toBe("anthropic-messages");
	});
});

// ------------------------------------------------------------ 2. 扩展层

/** 收集 registerProvider / setModel 调用的假 ExtensionAPI */
function fakePi(setModelResult = true) {
	const registered: Array<{ name: string; config: Record<string, unknown> }> = [];
	const applied: Model<Api>[] = [];
	const onHandlers: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
	const pi = {
		registerProvider: (name: string, config: Record<string, unknown>) => {
			registered.push({ name, config });
		},
		setModel: async (m: Model<Api>) => {
			applied.push(m);
			return setModelResult;
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			onHandlers.push({ event, handler });
		},
	} as unknown as ExtensionAPI;
	return { pi, registered, applied };
}

const fakeModel = (p: string, id: string) => ({ provider: p, id }) as unknown as Model<Api>;

describe("P6-24 扩展：registerProviders", () => {
	it("只注册 enabled 的 provider，密钥走 $ENV_VAR 不内联", () => {
		const { pi, registered } = fakePi();
		const deps: ModelRouterDeps = {
			policies: mkPolicies({ providers: { p1: provider({ enabled: true }), p2: provider({ enabled: false }) } }),
			resolveModel: () => undefined,
		};
		const names = registerProviders(pi, deps);

		expect(names).toEqual(["p1"]);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("p1");
		expect(registered[0]?.config.apiKey).toBe("$FIAT_TEST_KEY");
		expect(registered[0]?.config.api).toBe("openai-completions");
	});

	it("shouldRegister 可覆盖默认（enabled）判断", () => {
		const { pi, registered } = fakePi();
		registerProviders(pi, {
			policies: mkPolicies({ providers: { p1: provider({ enabled: false }) } }),
			resolveModel: () => undefined,
			shouldRegister: () => true,
		});
		expect(registered).toHaveLength(1);
	});
});

describe("P6-24 扩展：registryResolver / applyRoute", () => {
	it("registryResolver 把 provider/model 拆给 registry.find", () => {
		const calls: Array<[string, string]> = [];
		const r = registryResolver({
			find: (p, id) => {
				calls.push([p, id]);
				return fakeModel(p, id);
			},
		});
		expect(r("gpt/gpt-5.6-terra")?.id).toBe("gpt-5.6-terra");
		expect(calls).toEqual([["gpt", "gpt-5.6-terra"]]);
		expect(r("bad-ref")).toBeUndefined();
	});

	it("命中：解析到 Model 并 setModel 成功 → applied true", async () => {
		const { pi, applied } = fakePi(true);
		const info = await applyRoute(
			pi,
			{
				policies: mkPolicies(),
				resolveModel: () => fakeModel("p1", "m1"),
			},
			"支付告警排查",
		);

		expect(info.applied).toBe(true);
		expect(info.reason).toBeUndefined();
		expect(info.decision?.choice.provider).toBe("p1");
		expect(applied).toHaveLength(1);
	});

	it("解析不到 Model → model-unresolved，且不会调用 setModel", async () => {
		const { pi, applied } = fakePi(true);
		// isAvailable 恒真（走 enabled 判断），但 resolveModel 在应用阶段返回 undefined
		let first = true;
		const info = await applyRoute(
			pi,
			{
				policies: mkPolicies(),
				resolveModel: () => {
					if (first) {
						first = false;
						return fakeModel("p1", "m1"); // 可用性探测阶段
					}
					return undefined; // 应用阶段
				},
			},
			"支付告警排查",
		);

		expect(info.applied).toBe(false);
		expect(info.reason).toBe("model-unresolved");
		expect(applied).toHaveLength(0);
	});

	it("无可用 provider → no-route，无 decision", async () => {
		const { pi, applied } = fakePi(true);
		const info = await applyRoute(
			pi,
			{
				policies: mkPolicies(),
				resolveModel: () => undefined,
			},
			"支付告警排查",
		);

		expect(info.decision).toBeUndefined();
		expect(info.applied).toBe(false);
		expect(info.reason).toBe("no-route");
		expect(applied).toHaveLength(0);
	});

	it("setModel 被拒（无密钥）→ set-model-rejected", async () => {
		const { pi } = fakePi(false);
		const info = await applyRoute(
			pi,
			{
				policies: mkPolicies(),
				resolveModel: () => fakeModel("p1", "m1"),
			},
			"支付告警排查",
		);

		expect(info.applied).toBe(false);
		expect(info.reason).toBe("set-model-rejected");
	});
});

describe("P6-24 端到端（faux + buildSession）", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `model-router-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * 用真实 config/model_policies.yaml。resolveModel 固定返回 faux model ——
	 * 它的 provider 已注入 runtime key，所以 pi.setModel 会真实成功（applied: true）。
	 */
	async function setup(prompt: string) {
		const routes: RouteApplied[] = [];
		const sess = buildSession(
			{ user: { id: "u1", role: "ops" }, environment: "dev" },
			{
				policiesPath: POLICY_PATH,
				modelPoliciesPath: MODEL_POLICY_PATH,
				modelResolver: () => faux.getModel(),
				onModelRoute: (info) => routes.push(info),
			},
		);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: sess.extensionFactories,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage("ok")]);

		await runtimeHost.session.prompt(prompt);
		return { runtimeHost, sess, routes };
	}

	it("真实会话里 before_agent_start 触发路由：rag_qa 降级到 deepseek 并成功切模型", async () => {
		const { runtimeHost, routes } = await setup("退款政策是怎么规定的");

		expect(routes).toHaveLength(1);
		const r = routes[0];
		expect(r?.applied).toBe(true);
		expect(r?.decision?.taskType).toBe("rag_qa");
		expect(r?.decision?.requestedTier).toBe("simple");
		expect(r?.decision?.choice.provider).toBe("deepseek");
		expect(r?.decision?.choice.fallbackUsed).toBe(true);

		runtimeHost.dispose();
	});

	it("告警类 prompt 路由到 gpt，不降级", async () => {
		const { runtimeHost, routes } = await setup("支付服务告警，请排查");

		expect(routes[0]?.applied).toBe(true);
		expect(routes[0]?.decision?.choice.provider).toBe("gpt");
		expect(routes[0]?.decision?.choice.fallbackUsed).toBe(false);

		runtimeHost.dispose();
	});

	it("未注入 resolver 时 fail-safe：不切模型，会话照常跑完", async () => {
		const routes: RouteApplied[] = [];
		const sess = buildSession(
			{ user: { id: "u1", role: "ops" }, environment: "dev" },
			{
				policiesPath: POLICY_PATH,
				modelPoliciesPath: MODEL_POLICY_PATH,
				onModelRoute: (info) => routes.push(info),
			},
		);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: sess.extensionFactories,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage("ok")]);
		await runtimeHost.session.prompt("支付服务告警，请排查");

		expect(routes).toHaveLength(1);
		expect(routes[0]?.applied).toBe(false);
		expect(routes[0]?.reason).toBe("no-route");

		runtimeHost.dispose();
	});

	it("createModelRouter 产出的扩展工厂可注册到 ExtensionAPI", () => {
		const { pi, registered } = fakePi();
		createModelRouter({
			policies: mkPolicies({ providers: { p1: provider({ enabled: true }), p2: provider({ enabled: false }) } }),
			resolveModel: () => undefined,
		})(pi);
		expect(registered.map((r) => r.name)).toEqual(["p1"]);
	});
});
