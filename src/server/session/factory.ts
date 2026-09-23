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
import { type AuditClient, InMemoryAuditClient } from "../audit/client.ts";
import type { RunOne, TaskOutcome } from "../diagnosis/fanout.ts";
import type { DiagnosisAngle } from "../diagnosis/plan.ts";
import type { EvalSink } from "../eval/sink.ts";
import type { EvalCase } from "../eval/types.ts";
import { composeSystemPrompt } from "../evolution/index-prompt.ts";
import type { MemoryStore } from "../evolution/memoryStore.ts";
import type { SkillStore } from "../evolution/skillStore.ts";
import { defineHostTools, type HostTool } from "../host/contracts.ts";
import { createAuditHook } from "../host/l1a/audit-hook.ts";
import { createEvalRecorder } from "../host/l1a/eval-recorder.ts";
import type { EvolutionTrigger } from "../host/l1a/evolution-trigger.ts";
import { createMemorySignal, type MemorySignal } from "../host/l1a/memory-signal.ts";
import { createModelRouter, type ModelResolver, type RouteApplied } from "../host/l1a/model-router.ts";
import { createPermissionGate } from "../host/l1a/permission-gate.ts";
import { createTraceHook } from "../host/l1a/trace-hook.ts";
import { createAlertFanout } from "../host/l1b/alert-fanout.ts";
import { createFiatTools } from "../host/l1b/fiat-tools.ts";
import { createJobApply } from "../host/l1b/job-apply.ts";
import { createMcpRagTools, type McpClientLike, type RagMcpConfig, type RagStatus } from "../host/l1b/mcp-rag.ts";
import { createMemoryTools } from "../host/l1b/memory-tools.ts";
import { createSkillTools } from "../host/l1b/skill-tools.ts";
import { DEFAULT_MEMORY_CONFIG_PATH, loadMemoryConfig } from "../memory/config.ts";
import { MemoryDrain } from "../memory/drain.ts";
import { composeHotSegment } from "../memory/hot.ts";
import { type MemoryIdentity, resolveMemoryIdentity } from "../memory/identity.ts";
import { type MemoryClientRole, type MemoryLog, type MemoryReadChannel, MemoryStoreBridge } from "../memory/store.ts";
import type { MemoryConfig } from "../memory/types.ts";
import { loadModelPolicies, type ModelPolicies } from "../models/router.ts";
import { LocalPolicyClient, type PolicyClient } from "../policy/client.ts";
import { loadPolicies, type ToolPolicy } from "../policy/engine.ts";
import { tracedPolicyClient } from "../tracing/decorators.ts";
import { resolveTracing, type TracingSource, type TracingWiring } from "../tracing/types.ts";

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
	/** 阶段 11：评测 sink。**缺省不注册 eval-recorder（fail-safe，现有测试零改动）** */
	evalSink?: EvalSink;
	/** 阶段 11：CI 场景的评测 case（提供则 recorder 算分；在线采集为空） */
	evalCase?: EvalCase;
	/** 阶段 11：P6-25 子会话挂父 run（多体轨迹关联） */
	parentRunId?: string;
	/**
	 * 阶段 12（P12-65/63）：自进化接线。**三件东西全部可选、缺省什么都不注册**：
	 *   - `skillStore`：注册 `fiat_skill_view`（按需读技能正文）+ 把技能索引拼进 systemPrompt 末尾
	 *   - `memoryStore`：把「近期事实」摘要段拼进 systemPrompt 末尾（提示层）
	 *   - `trigger`：L1a 工具迭代计数器（**尾部追加，不插队**，位置契约
	 *     `[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?]`）
	 *
	 * ⚠️ 传递进来的 trigger 只会被「主会话」使用；**评审 fork 绝不传**（§10.7 第 5 条
	 * 递归防护）——fork 是在别处单独装配的，走不到这条路径。
	 */
	evolution?: {
		skillStore: SkillStore;
		memoryStore?: MemoryStore;
		trigger?: EvolutionTrigger;
		/** 是否注入 role 运行约定（默认关，§10.2 第 2 条） */
		includeRoleFacts?: boolean;
		/** 注入的「近期事实」条数 / 字数上限（缺省用 memoryStore 的默认双截断） */
		memoryDays?: number;
	};
	/**
	 * 阶段 14（P14-87）：全链路追踪。**缺省 undefined = 完全不开**（走 Noop，零开销）。
	 *
	 * 收**取值器**（`TracingWiring` 或 `() => TracingWiring | undefined`），不是固定 wiring：
	 * chat 的语义是「一轮 = 一条 trace」，而本组合根跑在**首轮之前**，此后闸门③ / 工单 / MCP
	 * 都发生在某一轮之内——它们必须以「调用那一刻」的接线为准（见 tracing/types.ts）。
	 *
	 * 传入后本组合根会做三件事：
	 *   ① 用 `tracedPolicyClient` 包住 policyClient → 闸门③ `canExecute` 出 `fiat.gate.can_execute` span
	 *   ② 尾部追加 L1a `trace-hook`（generation / tool 子 span + 首轮补登 `fiat.gate.build`）
	 *   ③ 把构建事实（角色 / 环境 / 注册工具数）交给 trace-hook 延迟落 span
	 */
	tracing?: TracingSource;
	/**
	 * 阶段 15（P15-97）：跨会话长期记忆接线。**缺省 undefined / 配置里 `enabled=false`
	 * 时什么都不做** —— 零网络、零定时器、现有测试零改动（硬约束 7）。
	 *
	 * 与 `evolution` 的差别：那里 store 由调用方建好传进来（测试可以直接喂内存 store），
	 * 这里**配置由本组合根加载** —— 因为「要不要注册」这件事必须以 `config/memory.yaml`
	 * 的 `enabled` 为准，而让每个入口各自读一遍配置文件必然会有一处读法不同。
	 */
	memory?: MemoryFactoryOptions;
}

/** 记忆接线的**入口层**可调项（`SessionFactoryOptions.memory` 的形状，单独命名便于 chat.ts 复用） */
export interface MemoryFactoryOptions {
	/** 覆盖配置路径；缺省 `config/memory.yaml` */
	configPath?: string;
	/** 直接给配置（测试用；给了就跳过文件加载）。**要给完整的** `MemoryConfig` */
	config?: MemoryConfig;
	/** 注入 MCP client 工厂（测试 mock；生产用真实 SDK） */
	clientFactory?: (cfg: RagMcpConfig, role: MemoryClientRole) => McpClientLike;
	/** 熔断 / 连接状态回调（入口层通常与 `ragOnStatus` 接同一个 handler，合并展示） */
	onStatus?: (status: RagStatus, detail: string) => void;
	log?: MemoryLog;
}

/**
 * 阶段 15（P15-97）：记忆接线包。**只在 `memory.enabled=true` 时存在**。
 *
 * 四个成员分给三类消费者，边界就是「谁能拿到什么」：
 *
 * | 成员 | 给谁 | 为什么 |
 * |---|---|---|
 * | `read` | `fiat_memory_search`（模型可见） | 只读通道：类型上**没有** write / forget |
 * | `store` | 提取器（`MemoryExtractor.port`）+ CLI 维护命令 | 写通道。**绝不进工具表**（硬约束 1） |
 * | `drain` | `ChatSession.flush()`（P15-97） | 退出前有界等待在飞写入（P15-106） |
 * | `hotSegment` / `signal` | 宿主（`PiHostLoop` / REPL） | 热注入段 + 循环内工具步 |
 *
 * `identity` 一并带出**只为审计与日志**（collection 名是人肉核对时最直接的线索）。
 */
export interface MemoryWiring {
	config: MemoryConfig;
	identity: MemoryIdentity;
	/** 只读检索通道（模型的唯一入口） */
	read: MemoryReadChannel;
	/** 读写桥（提取器 / 维护命令）。**不要**传给任何工具模块 */
	store: MemoryStoreBridge;
	/** 有界 drain（`flush()` 等它） */
	drain: MemoryDrain;
	/** 热注入段提供者（会话首轮算一次后**冻结**） */
	hotSegment: () => Promise<string>;
	/** L1a 工具步收集器（宿主席在轮末 `takeSteps()`） */
	signal: MemorySignal;
	/** 关桥（进程退出 / 测试收尾）；**永不抛** */
	close: () => Promise<void>;
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
	/** L1a 钩子通道：编译期注入的内建 extension（permission-gate / audit-hook / model-router） */
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
	/** L1b 工具通道：直接注册进内嵌循环的工具模块产物（mcp-rag / fiat-tools / job-apply / alert-fanout） */
	hostTools: HostTool[];
	/**
	 * 阶段 12（P12-65）：要**追加在 systemPrompt 末尾**的自进化段落
	 * （技能索引 + 近期事实 + 角色运行约定，按此顺序，段间空行）。
	 * 没开自进化时为空串 —— 调用方 `systemPrompt: built.evolutionPrompt || undefined`
	 * 即可保持与以前字节级一致（也为 prefix cache 保留了稳定性）。
	 */
	evolutionPrompt: string;
	/**
	 * 阶段 14（P14-87）：本次会话的追踪句柄（= 构建时刻取值器的求值结果）。
	 * 入口层据此把**同一个 `TraceContext`** 交给 `PiHostLoop` 当根 span——两处必须同一个 ctx，
	 * 否则子 span 会挂到根 id 之外，树裂开。
	 *
	 * 取值器是函数且此刻还没开始任何一轮时（chat 的 per-turn trace）→ undefined：
	 * 那条路径由入口层用 `perTurnTracing` 直接给宿主，不经过这里。
	 */
	tracing?: TracingWiring;
	/**
	 * 阶段 15（P15-97）：记忆接线包。**缺省 undefined = 记忆未开**（零行为变化）。
	 * 开记忆时本组合根已经：注册 `fiat_memory_search`（过闸门①）、装好 `memorySignal`
	 * （L1a 尾部）、备好热注入提供者。提取器由入口层装配（它需要 Pi 运行时去起 fork）。
	 */
	memory?: MemoryWiring;
}

/**
 * 闸门①纯函数：根据 policies 计算「角色 + 环境」允许的工具名谓词。
 * 定义已抽到 predicate.ts（切断与 factory 组合根的 Pi 依赖链）；此处 import 后 re-export 保持兼容。
 */
import { allowedToolPredicate } from "./predicate.ts";
export { allowedToolPredicate };

const sha256Default = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 默认模型路由策略：仓库根 config/model_policies.yaml（按模块位置解析，不依赖 cwd） */
const DEFAULT_MODEL_POLICIES_PATH = fileURLToPath(new URL("../../../config/model_policies.yaml", import.meta.url));

/** 组合根：按 subject 装配 ①~③ 闸门 + 阶段 5 审批工单 + fiat/job-apply 工具 */
export async function buildSession(
	subject: SessionSubject,
	opts: SessionFactoryOptions,
): Promise<SessionFactoryResult> {
	const startedMs = Date.now();
	const policies = loadPolicies(opts.policiesPath);
	const roleAllowed = allowedToolPredicate(policies, subject);
	// P6-25：toolFilter 与角色谓词 AND —— 子会话据此把工具压到单个视角的只读子集
	const allowedTools = opts.toolFilter
		? (name: string) => roleAllowed(name) && (opts.toolFilter?.(name) ?? false)
		: roleAllowed;
	const rawPolicyClient = opts.policyClient ?? new LocalPolicyClient(opts.policiesPath);
	// 阶段 14（P14-87）：装饰而非改实现 —— `LocalPolicyClient` / `HttpPolicyClient` / 测试 mock
	// 三种实现一次覆盖，且 `engine.ts` 的纯函数属性不被污染。
	const policyClient = opts.tracing ? tracedPolicyClient(rawPolicyClient, opts.tracing) : rawPolicyClient;
	const auditClient = opts.auditClient ?? new InMemoryAuditClient();
	const ragConfig = opts.ragConfig ?? { transport: "stdio" };
	const sessionId = opts.sessionId ?? randomUUID();
	const fiatClient = opts.fiatToolClient ?? new LocalFiatClient();
	const ticketStore = opts.ticketStore ?? new InMemoryTicketStore();
	const larkClient = opts.larkClient ?? new LocalLarkClient();

	const mcpRagTools = await createMcpRagTools({
		config: ragConfig,
		clientFactory: opts.ragClientFactory,
		allowedTools,
		onStatus: opts.ragOnStatus,
		// 阶段 14（P14-88）：MCP 一跳挂 tool span 之下（父 span 经 toolSpans 注册表解析）
		...(opts.tracing ? { tracing: opts.tracing } : {}),
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
		// 阶段 14（P14-88）：工单生命周期 span（create / approve / reject / apply）
		...(opts.tracing ? { tracing: opts.tracing } : {}),
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

	// P9-40 分流装配：L1a 钩子通道（编译期注入）；L1b 工具通道（直接注册进循环）
	// 阶段 11：eval-recorder **尾部追加，不插队**（位置契约：[gate, audit, modelRouter, ...evalRecorder?]）。
	// 缺省 fail-safe：没传 evalSink 就不注册。
	const factories: Array<(pi: ExtensionAPI) => void> = [gate, audit, modelRouter];
	if (opts.evalSink) {
		factories.push(
			createEvalRecorder({
				sink: opts.evalSink,
				user: subject.user,
				environment: subject.environment,
				sessionId,
				...(opts.evalCase ? { evalCase: opts.evalCase } : {}),
				...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
			}),
		);
	}
	// 阶段 12（P12-63）：evolution-trigger **尾部追加，不插队**。
	// 位置契约：[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?, ...traceHook?]
	if (opts.evolution?.trigger) factories.push(opts.evolution.trigger.factory);

	const skillTools = opts.evolution ? createSkillTools({ store: opts.evolution.skillStore, allowedTools }) : [];
	const hostTools = defineHostTools([...mcpRagTools, ...fiatTools, ...jobApply, ...skillTools]);
	if (opts.diagnosisRunner) {
		hostTools.push(
			...createAlertFanout({
				runAgent: opts.diagnosisRunner,
				allowedTools,
				...(opts.diagnosisAngles ? { angles: opts.diagnosisAngles } : {}),
				...(opts.diagnosisConcurrency !== undefined ? { concurrency: opts.diagnosisConcurrency } : {}),
				...(opts.diagnosisTimeoutMs !== undefined ? { timeoutMs: opts.diagnosisTimeoutMs } : {}),
				...(opts.onDiagnosisTask ? { onTask: opts.onDiagnosisTask } : {}),
			}),
		);
	}

	// 阶段 14（P14-86/87）：trace-hook **尾部追加，不插队**（放在 hostTools 定稿之后，
	// 因为构建事实要带上最终注册的工具名）。
	// 放最后的另一个原因：它对 tool_call 的可见性依赖「闸门在前」——被闸门② block 的调用
	// 会短路，trace-hook 因此收不到；那部分由 turn_end 对账补齐（见 trace-hook 文件头）。
	if (opts.tracing) {
		factories.push(
			createTraceHook({
				source: opts.tracing,
				// 构建事实**延迟**到第一条 trace 的首轮才落 span：chat 是 per-turn trace，
				// 而本函数跑在首轮之前——此刻没有 trace 可挂（详见 trace-hook 的 TraceBuildInfo）。
				buildInfo: {
					startedMs,
					role: subject.user.role,
					environment: subject.environment,
					registeredTools: hostTools.map((t) => t.name),
					policiesLoaded: policies.size,
				},
			}),
		);
	}

	// 阶段 12（P12-65）：自进化段落 —— 技能索引 / 近期事实 / 角色运行约定，按此顺序追加在末尾。
	// 记忆段是**提示层**：只注入事实，绝不把规则带进判定链（§10.3 铁律）。
	//
	// P15-102（设计文档 §3-L1）：记忆层此前是**唯一没接身份的消费点** —— 闸门② / 审计 /
	// fiatTools / evalRecorder 都显式传了 `subject.user`，只有这里没有，于是 `user` scope
	// 会退化成「所有人都是 cli」，隔离在纸面上成立、运行时失效。现在按会话主体派生
	// `MemoryIdentity` 再读（P15-103 的 per-user 目录因此才有意义）。
	//
	// identity 由本组合根**内部**派生，不从 opts 传入：`resolveMemoryIdentity` 是唯一构造点，
	// 让它从外部进来就等于多开一个可能构造错的口子（设计文档 §9-1）。
	const memoryStore = opts.evolution?.memoryStore;
	const memoryIdentity = memoryStore ? resolveMemoryIdentity(subject) : undefined;

	const evolutionPrompt = opts.evolution
		? composeSystemPrompt("", {
				skills: opts.evolution.skillStore.index(),
				...(memoryStore && memoryIdentity
					? { memory: memoryStore.recentFacts(memoryIdentity, opts.evolution.memoryDays ?? 3) }
					: {}),
				...(opts.evolution.includeRoleFacts && memoryStore
					? { roleFacts: memoryStore.roleFacts(subject.user.role) }
					: {}),
			})
		: "";

	/**
	 * 记忆接线。**只有 `config/memory.yaml` 的 `enabled=true` 才返回东西**。
	 *
	 * 三条刻意的顺序：
	 *
	 *   ① `enabled` **先判**。关记忆时连 `resolveMemoryIdentity` 都不跑 —— 那一步有
	 *      哨兵守卫（P15-104），多租户下会**抛**。关记忆就不该有这条抛点：
	 *      「没开记忆的单租户本地部署」必须与以前字节级一致（硬约束 7）。
	 *   ② 桥（含两个 MCP client）**惰性连接**：构造不发网络请求，第一次 `search` /
	 *      `write` 才 connect。所以这里多构造一个对象对「没用到记忆的会话」零成本。
	 *   ③ `signal` 与 `drain` 与桥**同生命周期**（同一个 wiring 包）—— 让别处
	 *      「记得把 drain 挂上 flush」这种纪律性的东西变成「拿到 wiring 就都拿到了」。
	 */
	function buildMemoryWiring(): MemoryWiring | undefined {
		const cfg = opts.memory?.config ?? loadMemoryConfig(opts.memory?.configPath ?? DEFAULT_MEMORY_CONFIG_PATH);
		if (!cfg.enabled) return undefined;

		const identity = resolveMemoryIdentity(subject);
		const bridge = new MemoryStoreBridge({
			rag: ragConfig,
			memory: cfg,
			identity,
			...(opts.memory?.clientFactory ? { clientFactory: opts.memory.clientFactory } : {}),
			...(opts.memory?.onStatus ? { onStatus: opts.memory.onStatus } : {}),
			...(opts.memory?.log ? { log: opts.memory.log } : {}),
			// 阶段 14：检索 / 写入各出一个 `fiat.memory.*` span（父 span 由 traced 的 mcp 桥接）
			...(opts.tracing ? { tracing: opts.tracing } : {}),
			// 阶段 15（P15-98）：写入 / 遗忘**双写审计** —— 这两条路都不是模型工具调用，
			// 走不到 audit-hook，必须显式补（否则本阶段最有合规意义的动作在审计里查不到）
			audit: {
				audit: auditClient,
				user: subject.user,
				environment: subject.environment,
				sessionId,
				...(opts.memory?.log ? { log: opts.memory.log } : {}),
			},
		});
		return {
			config: cfg,
			identity,
			read: bridge.readChannel(),
			store: bridge,
			drain: new MemoryDrain({ ...(opts.memory?.log ? { log: opts.memory.log } : {}) }),
			hotSegment: () =>
				composeHotSegment(bridge.readChannel(), cfg, { ...(opts.memory?.log ? { log: opts.memory.log } : {}) }),
			signal: createMemorySignal(),
			close: () => bridge.close(),
		};
	}

	// ── 阶段 15（P15-97）：跨会话长期记忆 ────────────────────────────────────────────
	//
	// 装配顺序刻意放在**最后**：注册工具要过闸门①（`allowedTools` 依赖 policies 与
	// subject），挂 L1a 要排在 trace-hook 之后（位置契约），而热注入要等 `evolutionPrompt`
	// 定稿（热注入段追加在它之后）。
	const memory = buildMemoryWiring();
	if (memory) {
		hostTools.push(...createMemoryTools({ channel: memory.read, allowedTools }));
		factories.push(memory.signal.factory); // 位置契约尾部：...traceHook?, ...memorySignal?
	}

	// 阶段 14：把「构建时刻的接线」求值一次给调用方。函数形态的取值器此刻多半是 undefined
	// （chat 是 per-turn trace，首轮还没开始）——那条路径由入口层用 `perTurnTracing` 自己给宿主。
	const buildTimeTracing = resolveTracing(opts.tracing);

	return {
		policies,
		allowedTools,
		policyClient,
		auditClient,
		approval,
		sessionId,
		modelPolicies,
		extensionFactories: factories,
		hostTools,
		evolutionPrompt,
		...(buildTimeTracing ? { tracing: buildTimeTracing } : {}),
		...(memory ? { memory } : {}),
	};
}
