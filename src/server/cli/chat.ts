/**
 * fiat chat —— pi-host 驱动的自研 CLI 入口（P9-49）。
 *
 * 「入口切换」的落点：原扩展加载器入口 → `fiat chat`（内嵌循环路径）。
 * （内嵌循环路径）。宿主 = `PiHostLoop`（Agent 直驱），装配链与 P9-48 闸门测试完全同源：
 *
 *   FIAT_MODEL=provider/model → ModelRegistry 注册 provider → 解析 Model
 *     → buildSession(subject)（闸门①裁剪 + L1a 钩子通道 + L1b 工具通道）
 *     → setupEmbeddedExtensions（官方 ExtensionRunner，闸门②）
 *     → bridgeAgentHooks → new PiHostLoop({...hooks, tools})
 *
 * 与 diagnose 的差异：diagnose 是一次性 fan-out（多子会话、inMemory）；chat 是
 * 一个可持久化的交互会话（HostSession 落盘 JSONL，`--session` 可继续）。
 *
 * 依赖 Pi 运行时的 import 全部动态加载 —— 与 diagnose 同一口径：CLI 离线命令
 * （audit / tickets / approve / tools / help）不需要着陆这些模块。
 */

import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuditClient } from "../audit/client.ts";
import { loadModelPolicies, piApiName } from "../models/router.ts";
import type { SessionSubject } from "../session/factory.ts";

export interface ChatTurnResult {
	ok: boolean;
	reply: string;
	/** ok=false 时的结构化错误（provider 失败 / 未配置模型等） */
	error?: string;
}

/** CLI 注入面：不直接 new PiHostLoop，便于测试用 faux 替换 */
export interface ChatSession {
	sessionId: string;
	/** 跑一轮；provider 失败不抛（runTurnSafe 兜底），返回结构化结果 */
	turn(input: string): Promise<ChatTurnResult>;
	dispose(): void;
}

export type ChatFactory = (subject: SessionSubject, sessionId: string) => Promise<ChatSession>;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CTX = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const DEFAULT_MODEL_POLICIES_PATH = fileURLToPath(new URL("../../../config/model_policies.yaml", import.meta.url));
const DEFAULT_POLICIES_PATH = fileURLToPath(new URL("../../../config/tool_policies.yaml", import.meta.url));

export interface MakeChatOptions {
	/** 模型标识 provider/model（如 gpt/gpt-5.6-terra）；缺省读 FIAT_MODEL */
	fiatModel?: string;
	/** 模型策略路径（测试可指临时 config） */
	modelPoliciesPath?: string;
	/** 工具策略路径（测试可指临时 config） */
	policiesPath?: string;
	/** 会话继续模式：传入既有会话文件则 open，缺省新建 */
	resumePath?: string;
	/** 会话落盘目录；缺省 Pi 默认（~/.pi/agent/sessions/...） */
	sessionDir?: string;
	/** 审计 client 注入（与 CLI 全局共享同一条审计链）；缺省进程内新建 */
	auditClient?: AuditClient;
	/**
	 * provider 注册覆盖（测试用 faux 时跳过 config 校验）。默认从 config/model_policies.yaml 读取。
	 */
	providerOverride?: {
		type: "openai" | "anthropic";
		base_url: string;
		api_key_env: string;
	};
	/**
	 * 模型解析覆盖（测试用 faux 时直接给 Model<Api>，跳过 ModelRegistry 解析路径）。
	 * 生产不传 —— Model 一律由 ModelRegistry 从 config 解析。
	 */
	modelOverride?: Model<Api>;
	/** 测试缝：跳过 HostSession 落盘（faux 全链路自测不需要临时目录） */
	inMemorySession?: boolean;
}

/** FIAT_MODEL 解析为 provider / modelId；格式错误抛出（CLI 层显式报错，不静默） */
export function parseFiatModel(fiatModel: string): { provider: string; modelId: string } {
	const slash = fiatModel.indexOf("/");
	if (slash <= 0 || slash === fiatModel.length - 1) {
		throw new Error(`FIAT_MODEL 格式应为 provider/model，收到：${fiatModel}`);
	}
	return { provider: fiatModel.slice(0, slash), modelId: fiatModel.slice(slash + 1) };
}

/**
 * 组装 chat 会话工厂。与 makeDiagnose 同构：模型注册（ModelRegistry）+ subject 闸门装配。
 * 返回 undefined = FIAT_MODEL 未配置 —— runCli 据此明确提示，而不是静默失败。
 */
export function makeChat(opts: MakeChatOptions = {}): ChatFactory | undefined {
	const fiatModel = opts.fiatModel ?? process.env.FIAT_MODEL;
	if (!fiatModel) return undefined;

	const { provider, modelId } = parseFiatModel(fiatModel);
	const modelPoliciesPath = opts.modelPoliciesPath ?? DEFAULT_MODEL_POLICIES_PATH;
	const policiesPath = opts.policiesPath ?? DEFAULT_POLICIES_PATH;

	// 同步校验 provider 是否在配置中（不依赖 Pi 运行时）；测试可注入覆盖
	const modelPolicies = loadModelPolicies(modelPoliciesPath);
	const cfg = opts.providerOverride ?? modelPolicies.providers?.[provider];
	if (!cfg) throw new Error(`FIAT_MODEL 指定的 provider "${provider}" 不在 config/model_policies.yaml`);

	return async (subject, sessionId) => {
		// —— Pi 运行时依赖：仅 chat 路径动态加载，离线命令不触发 ——
		const { AuthStorage, getAgentDir, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
		const { registryResolver } = await import("../host/l1a/model-router.ts");
		const { bridgeAgentHooks, setupEmbeddedExtensions } = await import("../host/extensions.ts");
		const { PiHostLoop } = await import("../host/loop.ts");
		const { HostSession } = await import("../host/session.ts");
		const { buildSession } = await import("../session/factory.ts");

		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider(provider, {
			baseUrl: cfg.base_url,
			apiKey: `$${cfg.api_key_env}`,
			api: piApiName(cfg.type),
			models: [
				{
					id: modelId,
					name: fiatModel,
					reasoning: false,
					input: ["text"],
					cost: { ...ZERO_COST },
					contextWindow: DEFAULT_CTX,
					maxTokens: DEFAULT_MAX_TOKENS,
				},
			],
		});

		const model = opts.modelOverride ?? registryResolver(registry)(fiatModel);
		if (!model) throw new Error(`无法解析模型 ${fiatModel}（provider 已注册但 find 失败）`);

		// 会话句柄：open（--session 续）/ create（新建）/ inMemory（测试缝）。cwd = workspace。
		const cwd = fileURLToPath(new URL("../../../workspace", import.meta.url));
		const agentDir = getAgentDir();
		const session = opts.inMemorySession
			? HostSession.inMemory(cwd)
			: opts.resumePath
				? HostSession.open(opts.resumePath, opts.sessionDir)
				: HostSession.create(cwd, opts.sessionDir);

		const built = await buildSession(subject, {
			policiesPath,
			...(opts.auditClient ? { auditClient: opts.auditClient } : {}),
			sessionId,
			modelResolver: registryResolver(registry),
		});

		const { runner } = await setupEmbeddedExtensions({
			cwd,
			agentDir,
			factories: built.extensionFactories,
		});

		const host = new PiHostLoop({
			model,
			sessionId,
			tools: built.hostTools,
			session,
			// API key：按 model_policies.yaml 的 api_key_env 解析（gpt → FIAT_MODEL_GPT_KEY 等）；
			// 环境变量缺失时交给 Pi 报 "No API key"（runTurnSafe 兜底为结构化错误，不炸进程）
			getApiKey: (p) => {
				const pcfg = p === provider ? cfg : modelPolicies.providers?.[p];
				const envName = pcfg?.api_key_env ?? `${p.toUpperCase()}_API_KEY`;
				return process.env[envName];
			},
			...bridgeAgentHooks(runner),
		});

		return {
			sessionId: session.id,
			async turn(input: string) {
				// provider 失败不抛：runTurnSafe 双查（catch + stopReason:"error"）
				const r = await host.runTurnSafe(input);
				return r.ok ? { ok: true, reply: r.reply } : { ok: false, reply: r.reply, error: r.error };
			},
			dispose() {
				// HostSession 由 SessionManager 持有，transcript 已逐轮落盘；宿主仅持引用。
			},
		};
	};
}
