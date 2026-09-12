/**
 * 自进化循环（阶段 12 / P12-62）—— 纯逻辑类型定义，零 Pi 依赖。
 *
 * 设计依据：Obsidian `法币 agent/法币定制 Agent DEV_SPEC（Pi 版）.md` §10
 * （流程图 `fiat-agent-pi-自进化闭环.svg`）。
 *
 * 一句话口径：**Hermes 是「想到就写」，fiat 是「先提案、再审批、后验证」**。
 * 因此本模块的核心不是「技能长什么样」，而是**状态机与判定输入的形状**：
 *   proposed ──decide()──┬─ auto_apply ────────────► applied ──评测──┬─ pass → verified
 *                        ├─ needs_approval ──Lark─► applied          └─ fail → rolled_back(+stale)
 *                        └─ reject（终态）
 *
 * 字段与两张表（`fiat_evolution_run` / `fiat_evolution_proposal`）一一对应（§10.9）。
 */

/**
 * 触发来源（§10.4）。
 * - `tool_iters`：L1a evolution-trigger 的工具迭代计数达标（循环内可见，只有 L1a 知道）
 * - `turn`：用户轮次计数达标（只有宿主 PiHostLoop 知道）
 * - `manual`：显式触发（CLI `/refine`）
 * - `pre_compaction`：压缩前（预留；当前未接线）
 */
export type TriggerKind = "tool_iters" | "turn" | "manual" | "pre_compaction";

/** 三路沉淀（§10.3）：① 程序性流程 / ② 事实性知识 / ③ 运行约定（默认关） */
export type ProposalKind = "skill" | "memory" | "role_facts";

/**
 * 提案状态机（§10.5）。
 * `proposed` → `applied`（自动或审批后）/ `rejected`（终态）；
 * `applied` → `rolled_back`（评测不达标回滚）。
 * 注：`approved` 是审批通过但**尚未落盘**的中间态——落盘失败要能停在它上面重试。
 */
export type ProposalStatus = "proposed" | "approved" | "rejected" | "applied" | "rolled_back";

/** 一次评审 run 的终态（§10.9 的 `status` 字段） */
export type RunStatus = "ok" | "timeout" | "error" | "budget_exhausted";

/** 技能在 `.usage.json` 里的生命周期状态（§10.6 + P12-71 Curator） */
export type SkillState = "active" | "stale" | "archived";

/** 技能来源：只有 `agent` 的可被自进化改写（保护清单第 1 条） */
export type SkillOrigin = "agent" | "human";

// ---------- 落盘判定（§10.5，纯函数 policy.ts 的输出） ----------

export type Decision =
	| { kind: "auto_apply" }
	| { kind: "needs_approval"; reason: string }
	| { kind: "reject"; reason: string };

/** 判定命中的具体规则（便于测试与审计定位；不进状态机，只进 detail） */
export type DecisionRule =
	| "protected"
	| "role_facts_disabled"
	| "sensitive"
	| "forbidden_approval_bypass"
	| "forbidden_amount_rule"
	| "forbidden_prod_data"
	| "spec_violation"
	| "duplicate"
	| "dev_auto_apply"
	| "env_approval";

// ---------- 提案载荷 ----------

/** 技能提案载荷（对应 SKILL.md 的 frontmatter + 正文） */
export interface SkillProposalPayload {
	description: string;
	/** §10.6：索引注入的「何时使用」短句（每条 ≤30 字） */
	whenToUse: string[];
	/** 正文（不含 frontmatter；固定章节顺序 When to Use / Procedure / Pitfalls / Verification） */
	body: string;
	/** §10.10：指向可跑的 eval case id —— 评测闸门的锚点，缺失 = unverified */
	caseId?: string;
}

/** 事实性记忆提案载荷（追加进 `workspace/memory/YYYY-MM-DD.md` 的条目） */
export interface MemoryProposalPayload {
	/** 单条事实（一行一条，不含日期前缀） */
	entries: string[];
}

/** 运行约定提案载荷（`workspace/facts/roles/<role>.md`，默认关） */
export interface RoleFactsProposalPayload {
	role: string;
	entries: string[];
}

export type ProposalPayload = SkillProposalPayload | MemoryProposalPayload | RoleFactsProposalPayload;

// ---------- 两张表 ----------

/** `fiat_evolution_run` 行：每次评审的事实 */
export interface EvolutionRun {
	runId: string;
	sessionId: string;
	trigger: TriggerKind;
	/** 触发时的工具迭代计数（§10.9 `tool_steps`） */
	toolSteps: number;
	/** 触发时的用户轮次计数（§10.9 `turns`） */
	turns: number;
	/** 使用的模型 ref（`provider/model`）；fork 继承 runtime 所以与主会话一致 */
	model?: string;
	/** 提示词版本号（提示词改动后可回溯某批技能是谁生成的） */
	promptVersion: string;
	proposalsN: number;
	status: RunStatus;
	startedAt: string;
	finishedAt?: string;
	/** status !== "ok" 时的原因（超时 / 异常），只记不上抛 */
	error?: string;
}

/** `fiat_evolution_proposal` 行：提案与决策流水 */
export interface EvolutionProposal {
	proposalId: string;
	runId: string;
	/** 触发本提案的会话（审批人 != 提案人 的判定依据之一） */
	sessionId: string;
	/** 提案人（= 触发会话的 userId）；审批人必须不同于它 */
	proposer: string;
	kind: ProposalKind;
	/** skill: slug；memory: `YYYY-MM-DD`；role_facts: role 名 */
	target: string;
	title: string;
	payload: ProposalPayload;
	/** 幂等键 = hash(target + 归一化正文)（§10.9） */
	contentHash: string;
	status: ProposalStatus;
	/** decide() 的输出 + 命中的规则（审计用） */
	decision?: Decision;
	decisionRule?: DecisionRule;
	/** 审批人 / 决策人（自动落盘时为 `system:<env>`） */
	decidedBy?: string;
	decidedAt?: string;
	appliedAt?: string;
	/** 落盘前拍的 tar.gz 快照路径（rollback 靠它） */
	snapshotPath?: string;
	rolledBackAt?: string;
	createdAt: string;
}

// ---------- 配置（config/evolution.yaml 的反序列化目标） ----------

export interface EvolutionConfig {
	/** 工具迭代阈值（§10.4）：默认 10，对齐 Hermes `skills.creation_nudge_interval` */
	intervalIters: number;
	/** 用户轮次阈值：默认 10，对齐 Hermes `memory.nudge_interval` */
	intervalTurns: number;
	/** 单会话评审预算（§10.4）：默认 3 */
	maxRunsPerSession: number;
	/** 评审 fork 超时（§10.7 第 6 条）：默认 60000ms */
	timeoutMs: number;
	/** dev 环境自动落盘（§10.5 第 6 条）：默认 true */
	autoApplyDev: boolean;
	/** 第三路（运行约定）开关（§10.2 第 2 条）：默认 false */
	roleFactsEnabled: boolean;
	/** 脱敏切片回放轮数（§10.7 第 3 条）：默认 12 */
	sliceTurns: number;
	/** Curator：多久没用标 stale（天，默认 30） */
	staleAfterDays: number;
	/** Curator：多久没用归档（天，默认 90） */
	archiveAfterDays: number;
	/** 重复检测阈值（§10.5 第 5 条）：默认 0.85 */
	duplicateThreshold: number;
	/** description 字数上限（§10.6）：默认 60 */
	descriptionMaxChars: number;
}

/**
 * 缺省配置（对齐 §10.4 / §10.5 / §10.7 的设计值）。
 * `config/evolution.yaml` 缺失或字段缺省时用它 —— 与「注入式 + 缺依赖不注册」同源的 fail-safe。
 */
export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
	intervalIters: 10,
	intervalTurns: 10,
	maxRunsPerSession: 3,
	timeoutMs: 60_000,
	autoApplyDev: true,
	roleFactsEnabled: false,
	sliceTurns: 12,
	staleAfterDays: 30,
	archiveAfterDays: 90,
	duplicateThreshold: 0.85,
	descriptionMaxChars: 60,
};

/** 提示词版本（提示词骨架借 Hermes，fiat 增补三条禁令；改动时 bump） */
export const EVOLUTION_PROMPT_VERSION = "fiat-evo-v1";
