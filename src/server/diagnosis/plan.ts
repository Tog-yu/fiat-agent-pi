/**
 * P6-25 告警诊断：任务拆分与报告聚合（纯逻辑层）。
 *
 * **为什么不用 Pi 官方 subagent 扩展**（packages/coding-agent/examples/extensions/subagent）：
 *   它走「子进程」路线 —— 每个 agent 是一个独立 `pi` 进程（index.ts:294
 *   `pi --mode json -p --no-session`，只透传 --model / --tools）。子进程从磁盘加载
 *   `.pi/extensions`，而本仓库所有 fiat 扩展都是**依赖注入工厂**（createXxx(deps)），
 *   没有 default 自配置入口，子进程里等于什么都注册不上 —— 权限闸门与审计整条丢失。
 *   对法币这种权限敏感场景不可接受。
 *
 * **本模块的路线**：L2 进程内 fan-out。把一条告警拆成 N 个**固定诊断视角**，
 *   每个视角由调用方起一个独立 AgentSession（同 subject、同三道闸门、同审计链）。
 *
 * 铁律 4：怎么拆是**声明式**的（固定视角 + 只读工具白名单），不用 LLM 决定拆分方式。
 */

export interface AlertInput {
	title: string;
	service?: string;
	/** 时间窗，如 "最近 30 分钟" */
	window?: string;
	detail?: string;
}

/** 一个诊断视角（声明式配置，不含运行时状态） */
export interface DiagnosisAngle {
	name: string;
	description: string;
	/** 该视角可使用的逻辑工具名；会被只读白名单与角色谓词双重收敛 */
	tools: string[];
	/** 支持 {alert} / {context} 占位符 */
	promptTemplate: string;
}

export interface DiagnosisTask {
	name: string;
	description: string;
	/** 收敛后的工具（已过只读白名单 + 角色谓词） */
	tools: string[];
	prompt: string;
}

/**
 * 只读白名单：诊断子 agent 能用的工具上限。
 * 对照 config/tool_policies.yaml —— 只取 L1/L2 只读项，
 * 排除 cashback_submit(L5) / cashback_reconcile(L4) / test_env(L3) / job_apply(L4) / lark_send。
 * 诊断只收集证据，不允许改任何东西。
 */
export const READONLY_DIAGNOSIS_TOOLS = [
	"es_search_logs",
	"db_query",
	"rag_query",
	"logistics_parse",
	"logistics_validate",
	"cashback_parse",
];

export const DEFAULT_ANGLES: DiagnosisAngle[] = [
	{
		name: "logs",
		description: "错误日志与异常堆栈",
		tools: ["es_search_logs", "db_query"],
		promptTemplate: [
			"你负责告警诊断中的「日志与异常」视角，只做**只读**证据收集，不要修改任何系统。",
			"",
			"告警：{alert}",
			"{context}",
			"",
			"请检索相关错误日志与异常堆栈，给出：1) 错误类型与出现频次 2) 首个/末次出现时间 3) 关键堆栈或错误码原文。",
			"证据不足就明确说「未找到」，不要臆测。",
		].join("\n"),
	},
	{
		name: "config_change",
		description: "配置、发布与近期变更",
		tools: ["db_query", "rag_query"],
		promptTemplate: [
			"你负责告警诊断中的「配置与变更」视角，只做**只读**证据收集，不要修改任何系统。",
			"",
			"告警：{alert}",
			"{context}",
			"",
			"请排查近期是否有配置变更、发布、开关调整或数据订正与该告警相关，给出：1) 变更项 2) 变更时间 3) 与告警的时间先后关系。",
			"证据不足就明确说「未找到」，不要臆测。",
		].join("\n"),
	},
	{
		name: "dependency",
		description: "依赖服务与下游影响",
		tools: ["es_search_logs", "db_query"],
		promptTemplate: [
			"你负责告警诊断中的「依赖与下游」视角，只做**只读**证据收集，不要修改任何系统。",
			"",
			"告警：{alert}",
			"{context}",
			"",
			"请排查上下游依赖是否异常（超时、限流、不可用），给出：1) 异常依赖方 2) 异常表现 3) 受影响的范围。",
			"证据不足就明确说「未找到」，不要臆测。",
		].join("\n"),
	},
	{
		name: "history",
		description: "历史相似故障与处置经验",
		tools: ["rag_query"],
		promptTemplate: [
			"你负责告警诊断中的「历史经验」视角，只做**只读**证据收集，不要修改任何系统。",
			"",
			"告警：{alert}",
			"{context}",
			"",
			"请检索知识库中是否出现过相同或相似故障，给出：1) 相似案例 2) 当时的根因 3) 当时的处置方式与结论。",
			"证据不足就明确说「未找到」，不要臆测。",
		].join("\n"),
	},
];

/** 渲染告警上下文（服务 / 时间窗 / 补充信息），缺省字段不占位 */
export function renderContext(alert: AlertInput): string {
	const parts: string[] = [];
	if (alert.service) parts.push(`服务：${alert.service}`);
	if (alert.window) parts.push(`时间窗：${alert.window}`);
	if (alert.detail) parts.push(`补充信息：${alert.detail}`);
	return parts.join("\n");
}

export function renderPrompt(template: string, alert: AlertInput): string {
	return template.replaceAll("{alert}", alert.title).replaceAll("{context}", renderContext(alert));
}

export interface DiagnosisPlanOptions {
	angles?: DiagnosisAngle[];
	/** 闸门①谓词：逻辑工具名 → 该角色/环境是否可用；缺省不过滤 */
	allowedTools?: (logicalToolName: string) => boolean;
	/** 只读白名单；缺省 READONLY_DIAGNOSIS_TOOLS（测试可注入） */
	readonlyTools?: string[];
}

/**
 * 告警 → N 个诊断任务。
 * 工具双重收敛：先过只读白名单（硬上限），再过角色谓词（闸门①）。
 * 收敛后一个工具都不剩的视角会被丢弃 —— 没有工具就收集不到证据，派出去只会浪费 token。
 */
export function diagnosisPlan(alert: AlertInput, opts: DiagnosisPlanOptions = {}): DiagnosisTask[] {
	const angles = opts.angles ?? DEFAULT_ANGLES;
	const readonly = new Set(opts.readonlyTools ?? READONLY_DIAGNOSIS_TOOLS);
	const tasks: DiagnosisTask[] = [];

	for (const angle of angles) {
		const tools = angle.tools.filter((t) => readonly.has(t) && (opts.allowedTools?.(t) ?? true));
		if (tools.length === 0) continue;
		tasks.push({
			name: angle.name,
			description: angle.description,
			tools,
			prompt: renderPrompt(angle.promptTemplate, alert),
		});
	}
	return tasks;
}

/** 报告聚合用的最小结构；fanout 的 TaskOutcome 天然满足（避免 plan ↔ fanout 循环引用） */
export interface ReportOutcome {
	name: string;
	description: string;
	status: string;
	output?: string;
	error?: string;
}

export interface ReportSummary {
	total: number;
	ok: number;
	failed: number;
	timeout: number;
}

/**
 * 把各视角结果聚合成一份报告。
 * 部分失败不掩盖 —— 明确列出失败/超时的视角，避免上层把「没查到」当成「没问题」。
 */
export function renderReport(alert: AlertInput, outcomes: ReportOutcome[], summary: ReportSummary): string {
	const lines: string[] = [];
	lines.push(`# 告警并行诊断报告`);
	lines.push("");
	lines.push(`告警：${alert.title}`);
	const ctx = renderContext(alert);
	if (ctx) lines.push(ctx);
	lines.push("");
	lines.push(`汇总：共 ${summary.total} 个视角，成功 ${summary.ok}，失败 ${summary.failed}，超时 ${summary.timeout}。`);

	for (const o of outcomes) {
		lines.push("");
		lines.push(`## ${o.name} — ${o.description} [${o.status}]`);
		if (o.status === "ok") {
			lines.push(o.output?.trim() || "（该视角无输出）");
		} else {
			lines.push(`未产出结论：${o.error ?? "unknown error"}`);
		}
	}

	if (summary.failed + summary.timeout > 0) {
		lines.push("");
		lines.push("注意：存在失败或超时的视角，上述结论不完整，请勿据此判定根因。");
	}
	return lines.join("\n");
}
