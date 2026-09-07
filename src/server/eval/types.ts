/**
 * 三层评测（阶段 11）—— 纯逻辑类型定义，零 Pi 依赖。
 *
 * 对应设计方案（Obsidian `agent问题笔记/fiat-agent-pi-三层评测设计方案.md`）§3/§9：
 *   - 一次 run（在线一次会话 / CI 一个 case）= RunTrace（采集产物，事实）
 *   - 评分 = Score（判定产物，可重算：换 evaluator 就换一批分）
 *   - case 期望 = EvalCase.expect（不写死完整调用顺序，用路标 + 多解 + 硬约束）
 *
 * 字段与三张 PG 表（fiat_eval_run / fiat_eval_step / fiat_eval_score）一一对应（P11-57 sink）。
 */

/** 业务终态： answered=纯问答 / ticket_created=落审批工单 / applied=工单已执行 */
export type TerminalState = "answered" | "ticket_created" | "applied";

/** 评测维度： 结果 / 轨迹 / 单步 / 硬约束 */
export type EvalDimension = "outcome" | "trajectory" | "first_step" | "constraint";

/** 评测对象来源 */
export type RunSource = "online" | "ci";

/** 一步的事实记录（fiat_eval_step 行） */
export interface StepRecord {
	/** 全 run 内单调递增（序列比对靠它） */
	stepIndex: number;
	/** 属于第几个 LLM 轮次 */
	turnIndex: number;
	tool: string;
	/** 脱敏后的参数（只存参数键与必要值，不落 prompt 全文 / 业务敏感字段） */
	input: Record<string, unknown>;
	isError: boolean;
	/** 被闸门②拦下（isError 回灌且文本命中拒绝语义） */
	blocked: boolean;
	durationMs?: number;
}

/** 一次 run 的完整事实（fiat_eval_run + 关联 fiat_eval_step） */
export interface RunTrace {
	runId: string;
	/** CI 用；在线为空 */
	caseId?: string;
	/** P6-25 并行诊断子会话挂父 run */
	parentRunId?: string;
	sessionId: string;
	userId: string;
	role: string;
	environment: string;
	model?: string;
	source: RunSource;
	status: "ok" | "error" | "aborted";
	/** 按 stepIndex 升序的工具调用事实 */
	steps: StepRecord[];
	/** agent_end 时的最终消息（outcome 判定输入；只取终态信号，不落全文） */
	finalStopReason?: string;
}

/** 单维评分（fiat_eval_score 行） */
export interface Score {
	dimension: EvalDimension;
	/** 0..1 */
	value: number;
	/** 加权汇总用权重 */
	weight: number;
	/** 'deterministic' | 'rubric-llm' | 自定义名 */
	evaluator: string;
	/** 失败定位 / 中间量（lcp / firstWrong / blocked / redundant 等） */
	detail?: Record<string, unknown>;
}

// ---------- case 期望（config/eval_cases.yaml 反序列化目标） ----------

/** 路标：关键必经点，只约束相对顺序，中间自由 */
export interface Milestone {
	tool: string;
	/** 可选：该路标必须出现在指定工具之后 */
	after?: string;
}

/** 轨迹期望：三种匹配模式（严格前缀 / 路标子序列 / 硬约束），按鲁棒性递增 */
export interface TrajectoryExpectation {
	/** 模式①：严格前缀（流程极固定场景），部分分来源 */
	toolPrefix?: string[];
	/** 模式②：路标（默认推荐，2~4 个必经点，相对顺序约束） */
	milestones?: Milestone[];
	/** 模式③：禁止项，出现即 0 */
	forbid?: string[];
	/** 步数上限（超出按 0.02/步 惩罚；硬上限见 case 级 constraint） */
	maxSteps?: number;
}

/** 结果期望 */
export interface OutcomeExpectation {
	terminal: TerminalState;
	/** 高风险场景：必须落到审批（出现 fiat_job_apply）而不是直接执行 */
	requiresApproval?: boolean;
}

/** 单步期望：any_of 多解，避免「唯一正确答案」陷阱 */
export interface FirstStepExpectation {
	any_of: string[];
}

export interface EvalCaseExpect {
	outcome: OutcomeExpectation;
	trajectory?: TrajectoryExpectation;
	firstStep?: FirstStepExpectation;
}

/** 一个评测 case（fiat 场景的「什么算成功」必须可回答，否则不进 CI） */
export interface EvalCase {
	id: string;
	prompt: string;
	subject: { role: string; environment: string };
	expect: EvalCaseExpect;
	/** pass 判定阈值（且 outcome 维度必须 = 1） */
	threshold: number;
}
