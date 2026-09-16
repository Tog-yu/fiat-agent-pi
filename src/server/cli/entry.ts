/**
 * 业务 CLI 真实入口（P6-26，纯 Node、零新依赖）。
 *
 * 设计：CLI 只是把「L2 能力」暴露成命令，不含业务逻辑 —— 权限看 policies、审计走
 * AuditReader、审批走 ApprovalService、并行诊断走 P6-25 的 fan-out。与 Web / TUI 同源，
 * 不出现第二套权限实现。
 *
 * 运行：`tsx src/server/cli/entry.ts <command> ...`（package.json 的 `npm run cli`）。
 *
 * 命令：
 *   diagnose <标题>     并行告警诊断（需 FIAT_MODEL=provider/model + 对应密钥；未配置则明确提示）
 *   audit / tickets / approve / reject / tools / help   全部离线可用
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LocalLarkClient } from "../../../src/server/approval/lark.ts";
import { ApprovalService, InMemoryTicketStore, type TicketStore } from "../../../src/server/approval/ticket.ts";
import { type AuditClient, InMemoryAuditClient } from "../../../src/server/audit/client.ts";
import { InMemoryAuditReader } from "../../../src/server/audit/reader.ts";
import { runFanout } from "../../../src/server/diagnosis/fanout.ts";
import { diagnosisPlan, renderReport } from "../../../src/server/diagnosis/plan.ts";
import { loadEvalCases } from "../../../src/server/eval/cases.ts";
import { loadEvolutionConfig } from "../../../src/server/evolution/config.ts";
import { MemoryStore } from "../../../src/server/evolution/memoryStore.ts";
import {
	InMemoryProposalStore,
	InMemoryRunStore,
	type ProposalStore,
} from "../../../src/server/evolution/proposalStore.ts";
import { SkillStore } from "../../../src/server/evolution/skillStore.ts";
import { type FiatToolClient, LocalFiatClient } from "../../../src/server/fiat-tools/client.ts";
import { loadModelPolicies, piApiName } from "../../../src/server/models/router.ts";
import { LocalPolicyClient, type PolicyClient } from "../../../src/server/policy/client.ts";
import { loadPolicies, policyToolName } from "../../../src/server/policy/engine.ts";
import type { SessionSubject } from "../../../src/server/session/factory.ts";
import { allowedToolPredicate } from "../../../src/server/session/predicate.ts";
import { type EvolutionWiring, makeChat } from "./chat.ts";
import { type CliDeps, type DiagnosisInput, type GatewayLauncher, runCli } from "./index.ts";
import { createSkillOps } from "./skills.ts";

const DEFAULT_GATEWAY_PATH = fileURLToPath(new URL("../../../config/gateway.yaml", import.meta.url));

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CTX = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 默认策略路径：仓库根 config/，按本文件位置推算，不依赖 cwd */
const DEFAULT_POLICIES_PATH = fileURLToPath(new URL("../../../config/tool_policies.yaml", import.meta.url));
const DEFAULT_MODEL_POLICIES_PATH = fileURLToPath(new URL("../../../config/model_policies.yaml", import.meta.url));
const DEFAULT_EVOLUTION_PATH = fileURLToPath(new URL("../../../config/evolution.yaml", import.meta.url));
const DEFAULT_EVAL_CASES_PATH = fileURLToPath(new URL("../../../config/eval_cases.yaml", import.meta.url));
/** 技能库 / 记忆目录的宿主根（与 chat 的 cwd 同一处） */
const WORKSPACE_DIR = fileURLToPath(new URL("../../../workspace", import.meta.url));

function cliSubject(): SessionSubject {
	const role = process.env.FIAT_ROLE ?? "ops";
	const env = process.env.FIAT_ENV ?? "dev";
	return { user: { id: "cli", role }, environment: env };
}

/** 组装 CLI 依赖（全部真实服务，零网络；PG 实现留作 L2 挂载时替换） */
function bootstrapCliDeps(): CliDeps {
	const policiesPath = DEFAULT_POLICIES_PATH;
	const policies = loadPolicies(policiesPath);
	const auditClient: AuditClient = new InMemoryAuditClient();
	const audit = new InMemoryAuditReader(() => auditClient.entries?.() ?? []);
	const ticketStore: TicketStore = new InMemoryTicketStore();
	const policyClient: PolicyClient = new LocalPolicyClient(policiesPath);
	const fiatClient: FiatToolClient = new LocalFiatClient();
	const approval = new ApprovalService({
		store: ticketStore,
		policy: policyClient,
		lark: new LocalLarkClient(),
		fiat: fiatClient,
		audit: auditClient,
		now: Date.now,
		genId: () => crypto.randomUUID(),
		genToken: () => crypto.randomUUID(),
		sha256,
		tokenTtlMs: 30 * 60 * 1000,
		sessionId: "cli",
	});

	// 阶段 12（P12-64/71）：技能库 / 记忆目录 / 提案表。全部落在 workspace 下，
	// 与 chat 会话的 cwd 一致（技能库是「这个 agent 的东西」，不是进程级全局）。
	const skillStore = new SkillStore(join(WORKSPACE_DIR, "pi-skills"));
	const memoryStore = new MemoryStore({ workspace: WORKSPACE_DIR });
	const proposals: ProposalStore = new InMemoryProposalStore();
	const evolutionConfig = loadEvolutionConfig(DEFAULT_EVOLUTION_PATH);

	return {
		policies,
		audit,
		listTickets: () => approval.list(),
		approveTicket: (id) => approval.approve(id),
		rejectTicket: (id, reason) => approval.reject(id, reason),
		diagnose: makeDiagnose(policiesPath, auditClient),
		chat: makeChat({
			policiesPath,
			auditClient,
			evolution: evolutionWiring({ skillStore, memoryStore, proposals, evolutionConfig, auditClient }),
		}),
		skills: createSkillOps({ skills: skillStore, proposals, config: evolutionConfig }),
		gateway: makeGateway(policiesPath, auditClient),
	};
}

/**
 * 阶段 13 / P13-81：`fiat gateway` 装配。
 *
 * 复用 makeDiagnose 的注入式诊断（FIAT_MODEL 未配置 → 只落库 + 通知，不自动诊断，
 * 告警仍可用 —— 分级策略天然容忍 diagnose 缺失，见 gateway/runner.ts #dispatch）。
 * Pi 运行时依赖仅网关命令动态 import，离线命令不受影响。
 */
function makeGateway(policiesPath: string, sharedAudit: AuditClient): GatewayLauncher {
	return async (): Promise<number> => {
		const { loadGatewayConfig } = await import("../gateway/config.ts");
		const { InMemoryAlertEventStore } = await import("../gateway/store.ts");
		const { inflightGateFromConfig } = await import("../gateway/policy.ts");
		const { GatewayServer } = await import("../gateway/server.ts");
		const { LocalAlertNotifier } = await import("../gateway/notify.ts");

		const config = loadGatewayConfig(DEFAULT_GATEWAY_PATH);
		// token 兜底：环境变量优先级高于配置文件（容器部署常见做法）
		const token = process.env.FIAT_GATEWAY_TOKEN ?? config.token;
		if (!token) {
			throw new Error("网关 token 未配置：请在 config/gateway.yaml 设 gateway.token 或设置 FIAT_GATEWAY_TOKEN");
		}
		const effectiveConfig = { ...config, token };

		// 诊断注入：FIAT_MODEL 已配置 → 复用 makeDiagnose（同一套三道闸门 + 审计）
		const diagnoseImpl = makeDiagnose(policiesPath, sharedAudit);
		const store = new InMemoryAlertEventStore();
		const gate = inflightGateFromConfig(effectiveConfig);
		const notify = new LocalAlertNotifier();

		const server = new GatewayServer(
			{
				config: effectiveConfig,
				store,
				...(diagnoseImpl
					? {
							diagnose: async (envelope) => {
								const sessionId = `gw-${envelope.fingerprint.slice(0, 8)}-${Date.now()}`;
								const report = await diagnoseImpl({
									title: envelope.alert.title,
									...(envelope.alert.service ? { service: envelope.alert.service } : {}),
									...(envelope.alert.window ? { window: envelope.alert.window } : {}),
									...(envelope.alert.detail ? { detail: envelope.alert.detail } : {}),
								});
								return { sessionId, report };
							},
						}
					: {}),
				notify,
				now: Date.now,
			},
			gate,
		);

		const httpServer = server.listen();
		await new Promise<void>((resolve, reject) => {
			httpServer.once("listening", resolve);
			httpServer.once("error", reject);
		});
		process.stderr.write(
			`[gateway] 已启动 http://127.0.0.1:${effectiveConfig.port}/hooks/alert（${effectiveConfig.adapter}）\n` +
				`[gateway] 自动诊断级别：${effectiveConfig.autoDiagnoseSeverities.join("/")}；` +
				`模型：${diagnoseImpl ? process.env.FIAT_MODEL : "未配置（只落库 + 通知）"}\n` +
				`[gateway] Ctrl+C 退出。\n`,
		);

		// 常驻：SIGINT/SIGTERM 优雅关闭
		const stopped = new Promise<number>((resolve) => {
			const shutdown = () => {
				process.stderr.write("\n[gateway] 收到退出信号，关闭监听…\n");
				httpServer.close(() => resolve(0));
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
		return stopped;
	};
}

/**
 * 阶段 12：自进化接线的开关。
 *
 * **默认关**（`FIAT_EVOLUTION=1` 才开），三个理由：
 *   1. 自进化会花钱（每次评审 fork 是一次完整 LLM 会话）——默认开会让一次 `fiat chat` 静默产生额外成本；
 *   2. 它会改磁盘（dev 环境自动落盘）——默认写用户的工作目录不合适；
 *   3. 关掉时整条链路（触发器 / 技能索引 / fork）都不装配，行为与阶段 11 完全一致，便于排查。
 *
 * eval case 加载失败时**只关闸门、不关整条循环**：没有 case 的技能落盘后停在 unverified
 * （`verify.ts` 的 `no_case` 分支），仍然可注入、可人工 rollback。
 */
function evolutionWiring(args: {
	skillStore: SkillStore;
	memoryStore: MemoryStore;
	proposals: ProposalStore;
	evolutionConfig: ReturnType<typeof loadEvolutionConfig>;
	auditClient: AuditClient;
}): EvolutionWiring | undefined {
	if (process.env.FIAT_EVOLUTION !== "1") return undefined;

	let evalCases: ReturnType<typeof loadEvalCases> | undefined;
	try {
		evalCases = loadEvalCases(DEFAULT_EVAL_CASES_PATH);
	} catch (e) {
		process.stderr.write(`[evolution] eval_cases.yaml 加载失败，评测闸门停用：${e instanceof Error ? e.message : e}\n`);
	}

	return {
		config: args.evolutionConfig,
		skillStore: args.skillStore,
		memoryStore: args.memoryStore,
		proposals: args.proposals,
		runs: new InMemoryRunStore(),
		...(evalCases ? { evalCases } : {}),
		onEvolution: (r) => {
			const detail = r.outcomes.map((o) => `${o.proposalId.slice(0, 8)}:${o.decision}`).join(", ");
			process.stderr.write(
				`[evolution] 触发 ${r.trigger}｜run ${r.run.runId.slice(0, 8)}｜${r.run.status}｜提案 ${r.run.proposalsN} 条${detail ? `（${detail}）` : ""}\n`,
			);
		},
		log: (level, message, detail) => {
			process.stderr.write(`[evolution:${level}] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
		},
	};
}

/**
 * 把并行诊断接线到 P6-25 的 fan-out：
 *   解析 FIAT_MODEL=provider/model → 在 ModelRegistry 注册 provider → 解析 Model
 *   → 每个视角用同一个 buildSession 起只读子会话（共享 subject + 三道闸门 + 审计）
 *
 * 未配置 FIAT_MODEL 时返回 undefined —— runCli 会明确提示，而不是静默失败。
 *
 * 注意：Pi 运行时依赖（AuthStorage / ModelRegistry / sessionRunner）仅在真正诊断时
 * 动态 import，离线命令（audit / tickets / approve / tools / help）永不着陆这些模块，
 * 因此可在零依赖 Node 下直接跑，无需先 build 本地 Pi 的 dist。
 */
function makeDiagnose(policiesPath: string, sharedAudit: AuditClient) {
	const fiatModel = process.env.FIAT_MODEL;
	if (!fiatModel) return undefined;

	const slash = fiatModel.indexOf("/");
	if (slash <= 0 || slash === fiatModel.length - 1) {
		throw new Error(`FIAT_MODEL 格式应为 provider/model，收到：${fiatModel}`);
	}
	const provider = fiatModel.slice(0, slash);
	const modelId = fiatModel.slice(slash + 1);

	// 同步校验 provider 是否在配置中（不依赖 Pi）
	const modelPolicies = loadModelPolicies(DEFAULT_MODEL_POLICIES_PATH);
	const cfg = modelPolicies.providers?.[provider];
	if (!cfg) throw new Error(`FIAT_MODEL 指定的 provider "${provider}" 不在 config/model_policies.yaml`);

	return async (input: DiagnosisInput): Promise<string> => {
		// —— Pi 运行时依赖：仅诊断路径动态加载，离线命令不触发 ——
		const { AuthStorage, getAgentDir, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
		const { registryResolver } = await import("../host/l1a/model-router.ts");
		const { createDiagnosisRunner } = await import("../../../src/server/diagnosis/sessionRunner.ts");
		const { buildSession } = await import("../../../src/server/session/factory.ts");

		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
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

		const resolve = registryResolver(registry);
		const model = resolve(fiatModel);
		if (!model) throw new Error(`无法解析模型 ${fiatModel}（provider 已注册但 find 失败）`);

		const subject = cliSubject();
		const policies = loadPolicies(policiesPath);
		const roleAllowed = allowedToolPredicate(policies, subject);

		const runOne = createDiagnosisRunner({
			buildChildSession: async (task) => {
				const r = await buildSession(subject, {
					policiesPath,
					auditClient: sharedAudit,
					modelResolver: resolve,
					// 子会话把工具收敛到单个视角的只读子集（registered name → logical 归一后比对）
					toolFilter: (registeredName) => task.tools.includes(policyToolName(registeredName)),
				});
				return { extensionFactories: r.extensionFactories, tools: r.hostTools, sessionId: r.sessionId };
			},
			model,
			getApiKey: (p) => {
				const pcfg = p === provider ? cfg : modelPolicies.providers?.[p];
				const envName = pcfg?.api_key_env ?? `${p.toUpperCase()}_API_KEY`;
				return process.env[envName];
			},
			cwd: process.cwd(),
			agentDir: getAgentDir(),
		});

		const tasks = diagnosisPlan(input, { allowedTools: (logicalName) => roleAllowed(logicalName) });
		const { results, summary } = await runFanout({ tasks, runOne });
		return renderReport(input, results, summary);
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const deps = bootstrapCliDeps();
	try {
		const code = await runCli(args, deps, {
			out: (s) => process.stdout.write(`${s}\n`),
			err: (s) => process.stderr.write(`${s}\n`),
		});
		process.exit(code);
	} catch (e) {
		process.stderr.write(`CLI 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
}

main().catch((e) => {
	process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
