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
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LocalLarkClient } from "../../../src/server/approval/lark.ts";
import { ApprovalService, InMemoryTicketStore, type TicketStore } from "../../../src/server/approval/ticket.ts";
import { type AuditClient, InMemoryAuditClient } from "../../../src/server/audit/client.ts";
import { InMemoryAuditReader } from "../../../src/server/audit/reader.ts";
import { runFanout } from "../../../src/server/diagnosis/fanout.ts";
import { diagnosisPlan, renderReport } from "../../../src/server/diagnosis/plan.ts";
import { type FiatToolClient, LocalFiatClient } from "../../../src/server/fiat-tools/client.ts";
import { loadModelPolicies, piApiName } from "../../../src/server/models/router.ts";
import { LocalPolicyClient, type PolicyClient } from "../../../src/server/policy/client.ts";
import { loadPolicies, policyToolName } from "../../../src/server/policy/engine.ts";
import type { SessionSubject } from "../../../src/server/session/factory.ts";
import { allowedToolPredicate } from "../../../src/server/session/predicate.ts";
import { type CliDeps, type DiagnosisInput, runCli } from "./index.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CTX = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 默认策略路径：仓库根 config/，按本文件位置推算，不依赖 cwd */
const DEFAULT_POLICIES_PATH = fileURLToPath(new URL("../../../config/tool_policies.yaml", import.meta.url));
const DEFAULT_MODEL_POLICIES_PATH = fileURLToPath(new URL("../../../config/model_policies.yaml", import.meta.url));

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

	return {
		policies,
		audit,
		listTickets: () => approval.list(),
		approveTicket: (id) => approval.approve(id),
		rejectTicket: (id, reason) => approval.reject(id, reason),
		diagnose: makeDiagnose(policiesPath, auditClient),
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
				return { extensionFactories: r.extensionFactories, hostTools: r.hostTools, sessionId: r.sessionId };
			},
			model,
			authStorage,
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
