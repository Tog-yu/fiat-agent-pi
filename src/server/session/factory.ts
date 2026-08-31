/**
 * session-factory —— 三道闸门之①：会话创建时按角色 + 环境裁剪工具集。
 *
 * 与 permission-gate（②）和 L2 canExecute（③）的关系：
 *   - ① 在「工具注册阶段」就过滤：角色无权 → 工具根本不注册，模型看不到（最省 token、最稳）
 *   - ② tool_call 拦截：模型即使绕过（prompt 注入 / 工具名猜测）也会被拦，回灌 isError 文本
 *   - ③ L2 canExecute：唯一权威，执行前最后一查（审批 / 数据范围覆写）
 *
 * 本模块是组合根：把 L1 扩展（permission-gate / mcp-rag / fiat-tools / job-apply）按 subject
 * 组装成 extensionFactories，并构造阶段 5 的 ApprovalService（审批工单唯一权威）。
 */

import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LocalLarkClient } from "../../../src/server/approval/lark.ts";
import {
	ApprovalService,
	InMemoryTicketStore,
	type LarkClientLike,
	type TicketStore,
} from "../../../src/server/approval/ticket.ts";
import { type FiatToolClient, LocalFiatClient } from "../../../src/server/fiat-tools/client.ts";
import { createAlertFanout } from "../../../workspace/pi-extensions/alert-fanout/index.ts";
import { createAuditHook } from "../../../workspace/pi-extensions/audit-hook/index.ts";
import { createFiatTools } from "../../../workspace/pi-extensions/fiat-tools/index.ts";
import { createJobApply } from "../../../workspace/pi-extensions/job-apply/index.ts";
import {
	createMcpRag,
	type McpClientLike,
	type RagMcpConfig,
	type RagStatus,
} from "../../../workspace/pi-extensions/mcp-rag/index.ts";
import {
	createModelRouter,
	type ModelResolver,
	type RouteApplied,
} from "../../../workspace/pi-extensions/model-router/index.ts";
import { createPermissionGate } from "../../../workspace/pi-extensions/permission-gate/index.ts";
import { type AuditClient, InMemoryAuditClient } from "../audit/client.ts";
import type { RunOne, TaskOutcome } from "../diagnosis/fanout.ts";
import type { DiagnosisAngle } from "../diagnosis/plan.ts";
import { loadModelPolicies, type ModelPolicies } from "../models/router.ts";
import { LocalPolicyClient, type PolicyClient } from "../policy/client.ts";
import { loadPolicies, policyToolName, type ToolPolicy } from "../policy/engine.ts";

export interface SessionSubject {
	user: { id: string; role: string };
	environment: string;
}

export interface SessionFactoryOptions {
	policiesPath: string;
	/** 进程内 / HTTP policy client；缺省 LocalPolicyClient（零网络） */
	policyClient?: PolicyClient;
	/** 审计 client；缺省 InMemoryAuditClient（测试 / 本地） */
	auditClient?: AuditClient;
	/** mcp-rag 配置；缺省 stdio */
	ragConfig?: RagMcpConfig;
	/** mcp-rag 客户端工厂（测试 mock / 真实 SDK）；缺省用真实 SDK */
	ragClientFactory?: (cfg: RagMcpConfig) => McpClientLike;
	/** mcp-rag 状态回调透传（ready / unavailable） */
	ragOnStatus?: (status: RagStatus, detail: string) => void;
	/** fiat 业务工具执行 client；缺省 LocalFiatClient（stub） */
	fiatToolClient?: FiatToolClient;
	/** 阶段 5：审批工单存储；缺省 InMemoryTicketStore（测试 / 本地） */
	ticketStore?: TicketStore;
	/** 阶段 5：Lark 卡片 client；缺省 LocalLarkClient（stub） */
	larkClient?: LarkClientLike;
	/** 阶段 5：一次性 token 有效期（ms）；缺省 30 分钟 */
	tokenTtlMs?: number;
	/** 会话 ID（审计用）；缺省自动生成 */
	sessionId?: string;
	/** P6-24：模型路由策略路径；缺省 config/model_policies.yaml */
	modelPoliciesPath?: string;
	/**
	 * P6-24：`provider/model` → Model。缺省不切模型（fail-safe，路由结果 reason: "no-route"）。
	 * 生产用 registryResolver(ModelRegistry.create(authStorage))。
	 */
	modelResolver?: ModelResolver;
	/** P6-24：路由结果回调（审计 / 可观测 / 测试断言） */
	onModelRoute?: (info: RouteApplied) => void;
	/** P6-25：进一步收敛工具（与角色谓词 AND）。子会话用它把工具压到单个视角的只读子集 */
	toolFilter?: (registeredToolName: string) => boolean;
	/**
	 * P6-25：并行告警诊断的子会话 runner。**只有提供了它才注册 `fiat_alert_diagnosis`** ——
	 * 诊断的本质是起 N 个子会话，没有 runner 就没有这个能力，硬注册只会给模型一个必然失败的工具。
	 * 生产用 createDiagnosisRunner(...)（src/server/diagnosis/sessionRunner.ts）。
	 */
	diagnosisRunner?: RunOne;
	diagnosisAngles?: DiagnosisAngle[];
	diagnosisConcurrency?: number;
	diagnosisTimeoutMs?: number;
	onDiagnosisTask?: (outcome: TaskOutcome) => void;
}

export interface SessionFactoryResult {
	policies: Map<string, ToolPolicy>;
	/** 闸门①谓词：registered tool name（如 mcp_rag_query_knowledge_hub）→ 是否允许注册 */
	allowedTools: (registeredToolName: string) => boolean;
	policyClient: PolicyClient;
	auditClient: AuditClient;
	/** 阶段 5：审批服务（供 job-apply 工具与 apply 模式复用） */
	approval: ApprovalService;
	sessionId: string;
	/** P6-24：实际加载的模型路由策略（便于调用方检查 tier / fallback 配置） */
	modelPolicies: ModelPolicies;
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
}

/**
 * 闸门①纯函数：根据 policies 计算「角色 + 环境」允许的工具名谓词。
 * registered tool name 经 policyToolName 归一（mcp_rag_* → rag_query，fiat_* → 去前缀）。
 */
export function allowedToolPredicate(
	policies: Map<string, ToolPolicy>,
	subject: SessionSubject,
): (registeredToolName: string) => boolean {
	return (registeredToolName: string) => {
		const policy = policies.get(policyToolName(registeredToolName));
		if (!policy) return false;
		return (
			policy.allowed_roles.includes(subject.user.role) && policy.allowed_environments.includes(subject.environment)
		);
	};
}

const sha256Default = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 默认模型路由策略：仓库根 config/model_policies.yaml（按模块位置解析，不依赖 cwd） */
const DEFAULT_MODEL_POLICIES_PATH = fileURLToPath(new URL("../../../config/model_policies.yaml", import.meta.url));

/** 组合根：按 subject 装配 ①~③ 闸门 + 阶段 5 审批工单 + fiat/job-apply 工具 */
export function buildSession(subject: SessionSubject, opts: SessionFactoryOptions): SessionFactoryResult {
	const policies = loadPolicies(opts.policiesPath);
	const roleAllowed = allowedToolPredicate(policies, subject);
	// P6-25：toolFilter 与角色谓词 AND —— 子会话据此把工具压到单个视角的只读子集
	const allowedTools = opts.toolFilter
		? (name: string) => roleAllowed(name) && (opts.toolFilter?.(name) ?? false)
		: roleAllowed;
	const policyClient = opts.policyClient ?? new LocalPolicyClient(opts.policiesPath);
	const auditClient = opts.auditClient ?? new InMemoryAuditClient();
	const ragConfig = opts.ragConfig ?? { transport: "stdio" };
	const sessionId = opts.sessionId ?? randomUUID();
	const fiatClient = opts.fiatToolClient ?? new LocalFiatClient();
	const ticketStore = opts.ticketStore ?? new InMemoryTicketStore();
	const larkClient = opts.larkClient ?? new LocalLarkClient();

	const mcpRag = createMcpRag({
		config: ragConfig,
		clientFactory: opts.ragClientFactory,
		allowedTools,
		onStatus: opts.ragOnStatus,
	});

	const gate = createPermissionGate({
		policy: policyClient,
		user: subject.user,
		environment: subject.environment,
		sessionId,
		audit: auditClient,
	});

	const audit = createAuditHook({
		audit: auditClient,
		user: subject.user,
		environment: subject.environment,
		sessionId,
	});

	// 阶段 5：审批工单唯一权威。与 fiatTools 共用同一个 fiatClient（apply 时执行底层变更）。
	const approval = new ApprovalService({
		store: ticketStore,
		policy: policyClient,
		lark: larkClient,
		fiat: fiatClient,
		audit: auditClient,
		now: Date.now,
		genId: randomUUID,
		genToken: randomUUID,
		sha256: sha256Default,
		tokenTtlMs: opts.tokenTtlMs ?? 30 * 60 * 1000,
		sessionId,
	});

	const fiatTools = createFiatTools({
		client: fiatClient,
		allowedTools,
		approval,
		user: subject.user,
		environment: subject.environment,
	});

	const jobApply = createJobApply({ approval, allowedTools });

	// P6-24：模型路由。默认不注入 resolver —— 没有 Model 可解析就不切模型（fail-safe）。
	const modelPolicies = loadModelPolicies(opts.modelPoliciesPath ?? DEFAULT_MODEL_POLICIES_PATH);
	const modelRouter = createModelRouter({
		policies: modelPolicies,
		resolveModel: opts.modelResolver ?? (() => undefined),
		onRoute: opts.onModelRoute,
	});

	// P6-25：并行告警诊断。需调用方注入子会话 runner 才注册 —— 没有 runner 就没有这个能力。
	const factories: Array<(pi: ExtensionAPI) => void> = [gate, mcpRag, fiatTools, jobApply, audit, modelRouter];
	if (opts.diagnosisRunner) {
		factories.push(
			createAlertFanout({
				runAgent: opts.diagnosisRunner,
				allowedTools,
				...(opts.diagnosisAngles ? { angles: opts.diagnosisAngles } : {}),
				...(opts.diagnosisConcurrency !== undefined ? { concurrency: opts.diagnosisConcurrency } : {}),
				...(opts.diagnosisTimeoutMs !== undefined ? { timeoutMs: opts.diagnosisTimeoutMs } : {}),
				...(opts.onDiagnosisTask ? { onTask: opts.onDiagnosisTask } : {}),
			}),
		);
	}

	return {
		policies,
		allowedTools,
		policyClient,
		auditClient,
		approval,
		sessionId,
		modelPolicies,
		extensionFactories: factories,
	};
}
