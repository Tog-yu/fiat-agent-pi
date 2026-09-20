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

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuditClient } from "../audit/client.ts";
import type { EvalCase } from "../eval/types.ts";
import { type ApplyDeps, rejectProposal } from "../evolution/apply.ts";
import { EvolutionApprovalBridge } from "../evolution/approval.ts";
import { createCaseRunner } from "../evolution/caseRunner.ts";
import type { MemoryStore } from "../evolution/memoryStore.ts";
import type { EvolutionRunStore, ProposalStore } from "../evolution/proposalStore.ts";
import { EvolutionReviewer } from "../evolution/reviewer.ts";
import { type AfterTurnResult, type EvolutionApplyPort, EvolutionService } from "../evolution/service.ts";
import type { SkillStore } from "../evolution/skillStore.ts";
import type { EvolutionConfig, EvolutionProposal } from "../evolution/types.ts";
import { applyThenVerify } from "../evolution/verify.ts";
import { createEvolutionTrigger } from "../host/l1a/evolution-trigger.ts";
import { createTraceHook } from "../host/l1a/trace-hook.ts";
import { createProposeTools } from "../host/l1b/propose-tools.ts";
import { createSkillTools } from "../host/l1b/skill-tools.ts";
import { loadModelPolicies, piApiName } from "../models/router.ts";
import type { SessionSubject } from "../session/factory.ts";
import type { Tracer, TracingSource, TracingWiring } from "../tracing/types.ts";

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
	/** 阶段 12：自进化接线。**缺省 undefined = 完全不开**，现有行为零变化。 */
	evolution?: EvolutionWiring;
	/**
	 * 阶段 14（P14-89）：全链路追踪。**缺省 undefined = 完全不开**（走 Noop，零开销）。
	 *
	 * 收的是 `Tracer` 而不是 `TracingWiring`，因为 chat 的链路边界是**一轮用户输入**，
	 * 不是整个进程：每轮现开一条 trace，多轮靠 `langfuse.session.id`（= 会话 id）聚合。
	 * 若在这里就钉死一个 `TraceContext`，多轮会复用同一个预留根 spanId
	 * （同一条 trace 里出现多个同 id 根 span，OTLP 侧直接算脏数据）。
	 *
	 * 内部把「当前轮接线」做成**取值器**喂给 `buildSession`：闸门③ / 工单 / MCP 一跳都发生在
	 * 某一轮之内，必须在调用那一刻取（见 tracing/types.ts 的 `TracingSource`）。
	 */
	tracing?: Tracer;
}

/**
 * 阶段 12（P12-63/65/66/67/69/70）自进化接线。
 *
 * 刻意做成「一包依赖」而不是散在 MakeChatOptions 上：开自进化是一个**整体决定**
 * （要有技能库、提案表、run 表、配置，才谈得上触发与落盘），缺任何一块都会得到
 * 一个半死状态。打包之后「开 / 不开」是二元的，也方便测试整包注入。
 */
export interface EvolutionWiring {
	config: EvolutionConfig;
	skillStore: SkillStore;
	memoryStore: MemoryStore;
	proposals: ProposalStore;
	runs: EvolutionRunStore;
	/** 评测 case 集（人写锚点，只读）。缺省则落盘技能只能停在 unverified。 */
	evalCases?: readonly EvalCase[];
	/** 观察点（测试 / 日志）：一次触发的完整结果 */
	onEvolution?: (result: AfterTurnResult) => void;
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
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
		const { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } = await import("../host/extensions.ts");
		const { PiHostLoop, lastAssistantText } = await import("../host/loop.ts");
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

		// 阶段 12（P12-63）：自进化触发器（L1a，尾部追加）。
		// 不开自进化时 undefined → 不注册 → 与阶段 11 之前的行为字节级一致。
		const evo = opts.evolution;
		const trigger = evo ? createEvolutionTrigger() : undefined;

		// 阶段 14（P14-89）：逐轮追踪。`tracer` 关着时整体不装配（零开销、零分配）。
		const tracer = opts.tracing?.enabled ? opts.tracing : undefined;
		/** 「当前轮」的接线；每开一条新 trace 就换一次（见 MakeChatOptions.tracing 的说明） */
		let currentTurn: TracingWiring | undefined;
		const tracingSource: TracingSource | undefined = tracer ? () => currentTurn : undefined;
		/**
		 * 开这一轮的 trace。**必须是「每轮现取」而不是构建时钉死**：
		 * 根 span 名 = trace 名 = `fiat.turn`，一轮一条；sessionId 用会话 id 把多轮聚成一组。
		 */
		const perTurnTracing = tracer
			? (): TracingWiring => {
					const ctx = tracer.startTrace({
						name: "fiat.turn",
						kind: "chat",
						sessionId: session.id,
						userId: subject.user.id,
						role: subject.user.role,
						environment: subject.environment,
					});
					currentTurn = { tracer, trace: ctx };
					return currentTurn;
				}
			: undefined;

		const built = await buildSession(subject, {
			policiesPath,
			...(opts.auditClient ? { auditClient: opts.auditClient } : {}),
			sessionId,
			modelResolver: registryResolver(registry),
			...(tracingSource ? { tracing: tracingSource } : {}),
			...(evo && trigger
				? {
						evolution: {
							skillStore: evo.skillStore,
							memoryStore: evo.memoryStore,
							trigger,
							includeRoleFacts: evo.config.roleFactsEnabled,
						},
					}
				: {}),
		});

		const { runner } = await setupEmbeddedExtensions({
			cwd,
			agentDir,
			factories: built.extensionFactories,
		});

		// API key：按 model_policies.yaml 的 api_key_env 解析（gpt → FIAT_MODEL_GPT_KEY 等）；
		// 环境变量缺失时交给 Pi 报 "No API key"（runTurnSafe 兜底为结构化错误，不炸进程）。
		// 抽成变量是因为评审 fork 要用**同一个** resolver（§10.7 第 1 条：继承 runtime，
		// 同 provider / model / apiKey 才会命中同一条 prefix cache）。
		const resolveKey = (p: string): string | undefined => {
			const pcfg = p === provider ? cfg : modelPolicies.providers?.[p];
			const envName = pcfg?.api_key_env ?? `${p.toUpperCase()}_API_KEY`;
			return process.env[envName];
		};

		// 服务引用：`onUserTurn` 只在 runTurn 里被调用，所以这里留一个可变引用就能
		// 打破「host 需要 service → service 需要 host 的 transcript」这个构造顺序环。
		let service: EvolutionService | undefined;

		const host = new PiHostLoop({
			model,
			sessionId,
			tools: built.hostTools,
			session,
			// 阶段 12（P12-65）：技能索引 / 近期事实**追加在末尾**（按 name 稳定排序）。
			// 空串 → undefined，保持「没开自进化」时的提示词字节级不变。
			systemPrompt: built.evolutionPrompt || undefined,
			onUserTurn: () => service?.noteUserTurn(),
			getApiKey: resolveKey,
			// 阶段 14：一轮一条 trace —— 宿主在 runTurn 开头调它现开根 span（`fiat.turn`）
			...(perTurnTracing ? { perTurnTracing } : {}),
			...bridgeAgentHooks(runner),
		});

		// 阶段 14（P14-89）：`turn_start` / `turn_end` **只经 `Agent.subscribe()` 扇出**
		// （见 host/extensions.ts 的 bridgeLifecycleEvents），不在 bridgeAgentHooks 里。
		// 不订的话 trace-hook 收不到轮次事件 → 没有 `fiat.llm.turn` generation、
		// 也没有「被闸门②拦下的调用」对账，trace 上只剩一堆光杆 tool span。
		// 关追踪时不订阅：保持「关追踪 = 零行为变化」。
		const unsubLifecycle = tracer ? bridgeLifecycleEvents(host.agent, runner) : undefined;

		if (evo && trigger) {
			service = buildEvolutionService({
				evo,
				trigger,
				subject,
				sessionId,
				fiatModel,
				cwd,
				agentDir,
				model,
				resolveKey,
				host,
				approval: built.approval,
				auditClient: built.auditClient,
				buildSession,
				setupEmbeddedExtensions,
				bridgeAgentHooks,
				bridgeLifecycleEvents,
				PiHostLoop,
				HostSession,
				lastAssistantText,
				policiesPath,
				registryResolver,
				registry,
				auditClientOverride: opts.auditClient,
				...(tracer ? { tracer } : {}),
			});
		}

		return {
			sessionId: session.id,
			async turn(input: string) {
				// provider 失败不抛：runTurnSafe 双查（catch + stopReason:"error"）
				const r = await host.runTurnSafe(input);
				// 阶段 12（P12-64/66）：**轮末**汇合判定 + 评审 fork（§10.4）。
				// 诚实记录一个取舍：这里 `await` 会推迟「把回复交给调用方」的时刻（最多 timeoutMs）。
				// 之所以仍然 await：Node 单线程下 fire-and-forget 的 fork 在 CLI 单轮模式下会随进程
				// 退出而丢提案（§10.12 踩坑表），而丢提案 = 整个自进化白跑。
				// 代价被三件事压住：fork 只在阈值命中时触发（默认 10 轮工具迭代）、
				// 单会话最多 3 次、且失败只记日志绝不上抛。
				if (service) {
					const outcome = await service.afterTurn();
					if (outcome) evo?.onEvolution?.(outcome);
				}
				return r.ok ? { ok: true, reply: r.reply } : { ok: false, reply: r.reply, error: r.error };
			},
			dispose() {
				// HostSession 由 SessionManager 持有，transcript 已逐轮落盘；宿主仅持引用。
				// 生命周期订阅要松开，否则 afterEach/长驻进程里会留着悬挂的 agent 订阅。
				unsubLifecycle?.();
			},
		};
	};
}

/**
 * 组装 EvolutionService —— 自进化的**组合根**（阶段 12）。
 *
 * 参数多到需要传 20 项，是因为它站在两条链的交汇处：上游要 L1a 触发器，下游要
 * 落盘 + 审批 + 评测，中间要 Pi 运行时去起 fork 会话。把 Pi 运行时依赖以参数形式
 * 传进来（而不是在这里 import），是为了让本文件保持「只有一个地方动态 import Pi」
 * 的既有纪律（离线 CLI 命令永不着陆 Pi）。
 */
function buildEvolutionService(ctx: {
	evo: EvolutionWiring;
	trigger: ReturnType<typeof createEvolutionTrigger>;
	subject: SessionSubject;
	sessionId: string;
	fiatModel: string;
	cwd: string;
	agentDir: string;
	model: Model<Api>;
	resolveKey: (p: string) => string | undefined;
	host: import("../host/loop.ts").PiHostLoop;
	approval: import("../approval/ticket.ts").ApprovalService;
	auditClient: AuditClient;
	buildSession: typeof import("../session/factory.ts").buildSession;
	setupEmbeddedExtensions: typeof import("../host/extensions.ts").setupEmbeddedExtensions;
	bridgeAgentHooks: typeof import("../host/extensions.ts").bridgeAgentHooks;
	bridgeLifecycleEvents: typeof import("../host/extensions.ts").bridgeLifecycleEvents;
	PiHostLoop: typeof import("../host/loop.ts").PiHostLoop;
	HostSession: typeof import("../host/session.ts").HostSession;
	lastAssistantText: typeof import("../host/loop.ts").lastAssistantText;
	policiesPath: string;
	registryResolver: (
		r: import("../host/l1a/model-router.ts").ModelRegistryLike,
	) => import("../host/l1a/model-router.ts").ModelResolver;
	registry: import("../host/l1a/model-router.ts").ModelRegistryLike;
	auditClientOverride?: AuditClient;
	/**
	 * 阶段 14（P14-89）：评审 fork 要开一条**独立 trace**（`fiat.evolution.review`）。
	 * 缺省 undefined = 不开（fork 行为与阶段 12 字节级一致）。
	 */
	tracer?: Tracer;
}): EvolutionService {
	const { evo, trigger } = ctx;
	const log = evo.log;

	// —— 落盘依赖（apply / reject / rollback 共用一份）——
	const applyDeps: Omit<ApplyDeps, "proposals"> & { proposals: ProposalStore } = {
		skills: evo.skillStore,
		memory: evo.memoryStore,
		proposals: evo.proposals,
		audit: ctx.auditClient,
		config: evo.config,
		sessionId: ctx.sessionId,
		environment: ctx.subject.environment,
		...(log ? { log } : {}),
	};

	// —— 评测闸门的跑分器（跑真实 case；拿不到分则返回 undefined，verify 据此不回滚）——
	const runCase = evo.evalCases
		? createCaseRunner({
				cases: evo.evalCases,
				makeRunner: async (evalCase, sink) => {
					// 与 CI（P11-61）同一条装配链：真实 policy 不放宽 + eval-recorder 采集 + 三维判分
					const caseBuilt = await ctx.buildSession(
						{
							user: { id: ctx.subject.user.id, role: evalCase.subject.role },
							environment: evalCase.subject.environment,
						},
						{
							policiesPath: ctx.policiesPath,
							...(ctx.auditClientOverride ? { auditClient: ctx.auditClientOverride } : {}),
							sessionId: `evo-eval-${evalCase.id}`,
							modelResolver: ctx.registryResolver(ctx.registry),
							evalSink: sink,
							evalCase,
						},
					);
					const { runner } = await ctx.setupEmbeddedExtensions({
						cwd: ctx.cwd,
						agentDir: ctx.agentDir,
						factories: caseBuilt.extensionFactories,
					});
					// 评测会话刻意**不落盘 transcript**（inMemory）：它是「跑一次实验」，不是用户会话
					const caseHost = new ctx.PiHostLoop({
						model: ctx.model,
						sessionId: caseBuilt.sessionId,
						tools: caseBuilt.hostTools,
						getApiKey: ctx.resolveKey,
						...ctx.bridgeAgentHooks(runner, { cwd: ctx.cwd }),
					});
					const unsub = ctx.bridgeLifecycleEvents(caseHost.agent, runner);
					return {
						sink,
						run: async () => {
							try {
								await caseHost.runTurnSafe(evalCase.prompt);
							} finally {
								unsub();
							}
						},
					};
				},
				...(log ? { log } : {}),
			})
		: async () => undefined;

	const verifyDeps = {
		skills: evo.skillStore,
		proposals: evo.proposals,
		audit: ctx.auditClient,
		cases: evo.evalCases ?? [],
		runCase,
		sessionId: ctx.sessionId,
		environment: ctx.subject.environment,
		...(log ? { log } : {}),
	};

	// —— 审批桥（needs_approval 的落点；复用阶段 5 的票据生命周期 + Lark 卡）——
	const approvalBridge = new EvolutionApprovalBridge({
		approval: ctx.approval,
		proposals: evo.proposals,
		apply: applyDeps,
		sha256: (s) => createHash("sha256").update(s).digest("hex"),
	});

	// —— 落盘端口：三种归宿 ——
	const applyPort: EvolutionApplyPort = {
		async autoApply(proposalId, decidedBy) {
			const r = await applyThenVerify(proposalId, decidedBy, applyDeps, verifyDeps);
			return r.apply;
		},
		async reject(proposalId, decidedBy, reason) {
			return rejectProposal(proposalId, decidedBy, reason, applyDeps);
		},
		async requestApproval(proposal: EvolutionProposal, reason: string) {
			const r = await approvalBridge.requestApproval(proposal, reason);
			return { ticketId: r.ticketId, token: r.token, status: r.status };
		},
	};

	// —— 评审 fork 的装配（§10.7 八条硬约束的落点都在这一段）——
	const reviewer = new EvolutionReviewer({
		proposals: evo.proposals,
		runs: evo.runs,
		config: evo.config,
		sessionId: ctx.sessionId,
		proposer: ctx.subject.user.id,
		model: ctx.fiatModel,
		// #3 脱敏切片：只回放「user 摘要 + 工具名 + isError + 输出摘要」（见 evolution/slice.ts）
		transcript: () => ctx.host.agent.state.messages,
		runFork: async (input) => {
			// #2 HostSession.inMemory —— 绝不触碰主会话 transcript / JSONL
			const forkSession = ctx.HostSession.inMemory(ctx.cwd, { id: `evo-${input.context.runId}` });
			// #4 运行时白名单：只有 fiat_skill_view + 三个 *_propose。
			// **没有任何业务写工具**（fiat_job_apply / fiat_cashback_reconcile 一律不在）——
			// 模型即使猜名字调用，也只会拿到 Pi 的 "Tool ... not found"。
			const forkTools = [
				...createSkillTools({ store: evo.skillStore, recordUsage: false }),
				...createProposeTools({ proposals: evo.proposals, context: input.context }),
			];
			// 阶段 14（P14-89）：评审 fork **独立成一条 trace**。
			// 虽然它由主会话轮末触发，但它是一次完整的 LLM 会话（另一个 systemPrompt、另一套工具、
			// 另一份 token 账单）；塞进主会话的 trace 会让「这轮用户请求花了多少」被评审污染。
			// 归属关系靠 metadata.parentSessionId 保留——两个视角都不丢。
			const forkTracer = ctx.tracer;
			const forkTracing: TracingWiring | undefined = forkTracer?.enabled
				? {
						tracer: forkTracer,
						trace: forkTracer.startTrace({
							name: "fiat.evolution.review",
							kind: "evolution",
							sessionId: forkSession.id,
							userId: ctx.subject.user.id,
							role: ctx.subject.user.role,
							environment: ctx.subject.environment,
							metadata: { parentSessionId: ctx.sessionId, runId: input.context.runId },
						}),
					}
				: undefined;
			// 阶段 14：fork 也挂 trace-hook —— 没有它，`fiat.evolution.review` 只是一个光杆根 span，
			// 看不到评审跑了几轮、烧了多少 token（而「评审花多少钱」正是自进化的主要成本项）。
			// 只注册 trace-hook（只读不拦）：fork 的工具白名单与 #5 递归防护一字不动。
			const forkRunner = forkTracing
				? (
						await ctx.setupEmbeddedExtensions({
							cwd: ctx.cwd,
							agentDir: ctx.agentDir,
							factories: [createTraceHook({ source: forkTracing })],
						})
					).runner
				: undefined;
			// #1 继承 runtime：同一个 model + 同一个 resolveKey → 命中同一条 prefix cache
			// #5 递归防护：fork **不传 evolution**，所以它里面没有 evolution-trigger，评审不会触发评审
			const forkHost = new ctx.PiHostLoop({
				model: ctx.model,
				sessionId: forkSession.id,
				systemPrompt: input.systemPrompt,
				tools: forkTools,
				session: forkSession,
				getApiKey: ctx.resolveKey,
				...(forkTracing ? { tracing: forkTracing } : {}),
				...(forkRunner ? ctx.bridgeAgentHooks(forkRunner, { cwd: ctx.cwd }) : {}),
			});
			// 同上：轮次事件必须订阅，否则 fork 的 trace 里没有 generation（token 无从看起）
			const unsubFork = forkRunner ? ctx.bridgeLifecycleEvents(forkHost.agent, forkRunner) : undefined;
			try {
				await forkHost.runTurnSafe(input.prompt);
			} finally {
				unsubFork?.();
			}
			return ctx.lastAssistantText(forkHost.messages);
		},
		...(log ? { log } : {}),
	});

	return new EvolutionService({
		config: evo.config,
		trigger,
		reviewer,
		applyPort,
		proposals: evo.proposals,
		// 保护清单 / 重复检测的输入：技能库当前快照（每次判定现取，避免用陈旧视图）
		existingSkills: () =>
			evo.skillStore.list().map((s) => ({ name: s.name, body: s.body, origin: s.origin, pinned: s.pinned })),
		proposer: ctx.subject.user.id,
		sessionId: ctx.sessionId,
		environment: ctx.subject.environment,
		...(log ? { log } : {}),
	});
}
