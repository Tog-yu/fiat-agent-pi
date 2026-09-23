/**
 * 业务 CLI 的纯计算 / 渲染逻辑（无 IO、无进程依赖，可离线测）。
 *
 * CLI 只做「把 L2 能力暴露成命令」，不含业务逻辑：
 * 权限判定走 policies、审计走 AuditReader、审批走 ApprovalService —— 与 Web/TUI 同源。
 */

import type { ApprovalTicketRecord } from "../approval/ticket.ts";
import type { AuditRecord } from "../audit/client.ts";
import type { SkillMeta } from "../evolution/skillStore.ts";
import type { CircuitSnapshot } from "../memory/circuit.ts";
import type { MemoryChannelState, MemorySearchOutcome } from "../memory/store.ts";
import type { MemoryConfig, MemoryForgetResult, MemoryScope } from "../memory/types.ts";
import type { ToolPolicy } from "../policy/engine.ts";

export interface ToolRow {
	tool: string;
	risk_level: ToolPolicy["risk_level"];
	approval_required: boolean;
}

/** 角色 + 环境可用的工具（闸门①的只读预览，帮助排「为什么模型看不到这个工具」） */
export function allowedTools(policies: Map<string, ToolPolicy>, role: string, environment: string): ToolRow[] {
	const rows: ToolRow[] = [];
	for (const p of policies.values()) {
		if (p.allowed_roles.includes(role) && p.allowed_environments.includes(environment)) {
			rows.push({ tool: p.tool, risk_level: p.risk_level, approval_required: p.approval_required });
		}
	}
	return rows.sort((a, b) => a.tool.localeCompare(b.tool));
}

export function renderTools(rows: readonly ToolRow[]): string {
	if (rows.length === 0) return "（该角色在此环境下无任何可用工具）";
	return rows.map((r) => `${r.tool}\t[${r.risk_level}]${r.approval_required ? "\t需审批" : ""}`).join("\n");
}

export function renderAudit(rows: readonly AuditRecord[]): string {
	if (rows.length === 0) return "（无匹配的审计记录）";
	return rows
		.map((r) => {
			const who = `${r.user.id}(${r.user.role})@${r.environment}`;
			const detail = r.detail ? `\t${r.detail}` : "";
			return `${r.ts}\t${who}\t${r.tool}\t${r.outcome}${detail}`;
		})
		.join("\n");
}

export function renderTickets(rows: readonly ApprovalTicketRecord[]): string {
	if (rows.length === 0) return "（无工单）";
	return rows
		.map((t) => {
			const who = `${t.subject.userId}(${t.subject.role})@${t.subject.environment}`;
			return `${t.ticketId}\t${t.status}\t${t.tool}\t${who}\t过期 ${new Date(t.expiresAt).toISOString()}`;
		})
		.join("\n");
}

/**
 * 技能库列表（`fiat skills list`，P12-71）。
 * 列的是「维护侧最关心的四件事」：来源（能不能被自进化改）、评测分（verified / unverified）、
 * 使用次数（Curator 的时间衰减依据）、状态标记（pinned / stale）。
 */
export function renderSkills(rows: readonly SkillMeta[]): string {
	if (rows.length === 0) return "（技能库为空）";
	return rows
		.map((s) => {
			// 只有评测回过分数才显示分数；只有锚点（刚落盘、未跑闸门）仍显示 unverified
			const mark = s.verifiedBy?.score !== undefined ? s.verifiedBy.score.toFixed(2) : "unverified";
			const flags = [s.pinned ? "pinned" : "", s.state !== "active" ? s.state : ""].filter(Boolean).join(",");
			const used = s.lastUsedAt ? new Date(s.lastUsedAt).toISOString().slice(0, 10) : "never";
			return `${s.name}\t${s.origin}\t${mark}\t用 ${s.useCount} 次\t最后 ${used}${flags ? `\t[${flags}]` : ""}`;
		})
		.join("\n");
}

/** 追踪状态报告的载荷（`fiat trace status`，阶段 14 / P14-89） */
export interface TraceStatus {
	enabled: boolean;
	endpoint: string;
	serviceName: string;
	captureContent: string;
	/** 凭据是否解析到（env 变量存在）；enabled=true 时必然为 true（配置加载 fail-fast） */
	credentials: boolean;
	/** 端点连通性不做网络探测（离线命令不许打网络）；只报队列与丢弃计数 */
	stats: { queued: number; sent: number; batches: number; dropped: number; failed: number };
}

/**
 * 追踪状态渲染（`fiat trace status`）。**零网络**：只看本地配置与进程内计数——
 * 一个"诊断不工作"的命令如果自己要先发网络请求，那它自己就是不可靠的。
 */
export function renderTrace(s: TraceStatus): string {
	const lines = [
		`追踪：${s.enabled ? "已开启" : "已关闭（缺省；设 FIAT_TRACING_ENABLED=true 开启）"}`,
		`服务名：${s.serviceName}`,
	];
	if (s.enabled) {
		lines.push(
			`端点：${s.endpoint}`,
			`凭据：${s.credentials ? "已从环境变量解析" : "缺失（不应发生：开启追踪时配置加载已 fail-fast）"}`,
			`内容采集：${s.captureContent}（off / redacted / full）`,
			`队列：待发 ${s.stats.queued}　已发 ${s.stats.sent} span / ${s.stats.batches} 批　丢弃 ${s.stats.dropped}　失败批次 ${s.stats.failed}`,
		);
	} else {
		lines.push("提示：关闭状态下零网络、零定时器，span 全部丢弃。");
	}
	return lines.join("\n");
}

// =====================================================================================
// 阶段 15（P15-99）：记忆维护（`fiat memory ...`）
// =====================================================================================

/**
 * `fiat memory stats` 的载荷。
 *
 * 与 `TraceStatus` 同一形状的取舍：**全部字段都来自零网络的读取**（配置 + 已发生的
 * 连接结果 + 进程内熔断计数），不为了「测一下通不通」而现发一次请求。
 *
 * `identity` / `channels` / `circuit` 都是**可选**的，这不是随手加的：
 *   - 记忆没开 → 没有分区，也不该有通道；
 *   - 身份解析失败（多租户下没配可信身份）→ **stats 仍必须能跑**，因为「为什么没数据」
 *     的答案有可能就是「身份没解析出来」。把这两件事塞进必填字段等于
 *     让诊断命令在它最该工作的时候先自己挂掉。
 */
export interface MemoryStats {
	enabled: boolean;
	/** 分区（`user` / `repo` / `global` 视角下的实际落点） */
	identity?: { scope: MemoryScope; key: string; collection: string; userId: string };
	/** 分区不可用的原因（人话）。**与 `enabled` 正交**：可以是「没开」，也可以是「身份解析失败」 */
	identityError?: string;
	/** 配置面全量。渲染端自己挑要显示的 —— 中间再插一层「视图类型」只会多一处要同步的字段表 */
	config: MemoryConfig;
	/** 读的是哪份配置（排查「改了配置没生效」的第一句话） */
	configPath: string;
	/** RAG 端点（展示用；**token 永不出现**） */
	endpoint: string;
	/** 惰性连接状态。`idle` = 还没用过，**不等于不可用** */
	channels?: { read: MemoryChannelState; write: MemoryChannelState };
	circuit?: CircuitSnapshot;
}

/** 通道状态的人话（`idle` 必须与 `unavailable` 分开说 —— 见 `MemoryChannelState`） */
function channelText(state: MemoryChannelState): string {
	if (state === "ready") return "已连接";
	if (state === "unavailable") return "不可用（connect 失败）";
	return "未使用（惰性连接）";
}

const CIRCUIT_STATE_TEXT: Readonly<Record<string, string>> = {
	closed: "正常",
	open: "已熔断",
};

/**
 * 记忆状态渲染（`fiat memory stats`）。**零网络**，与 `renderTrace` 同一条纪律：
 * 一个「诊断不工作」的命令如果自己要先发网络请求，那它自己就是不可靠的。
 */
export function renderMemoryStats(s: MemoryStats): string {
	const lines = [
		s.enabled ? "记忆：已开启" : "记忆：已关闭（缺省；设 FIAT_MEMORY=true 开启）",
		`配置：${s.configPath}`,
		`端点：${s.endpoint}`,
	];

	// 三条互斥的分支，**不要合并**：它们的正确处置完全不同
	// （不适用 / 正常 / 需要人去查身份配置）。
	if (!s.enabled) {
		lines.push("分区：不适用（记忆未启用）", "提示：关闭状态下不注入、不检索、不写入，零网络；以下配置仅供对照。");
	} else if (s.identity) {
		lines.push(
			`分区：${s.identity.scope} / ${s.identity.key}（属主 ${s.identity.userId}　collection ${s.identity.collection}）`,
		);
	} else {
		lines.push(`分区：不可用 —— ${s.identityError ?? "未知原因"}`);
	}

	if (s.identity && s.channels && s.circuit) {
		lines.push(
			`通道：读 ${channelText(s.channels.read)}　写 ${channelText(s.channels.write)}`,
			`断路器：${CIRCUIT_STATE_TEXT[s.circuit.state] ?? s.circuit.state}` +
				`（连续失败 ${s.circuit.consecutiveFailures}　短路 ${s.circuit.shortCircuited} 次　打开 ${s.circuit.openedCount} 次）` +
				(s.circuit.remainingCooldownMs > 0 ? `　冷却剩余 ${Math.ceil(s.circuit.remainingCooldownMs / 1000)}s` : ""),
		);
	}

	const w = s.config.write;
	const r = s.config.read;
	const t = s.config.trigger;
	lines.push(
		`写入：最小置信度 ${w.minConfidence}　单条上限 ${w.maxTextChars} 字　单轮最多 ${w.maxPerRun} 条`,
		`读取：默认 top_k ${r.defaultTopK}　热注入 ${r.hotKinds.join("/")}（≤${r.hotInjectionMaxEntries} 条 / ≤${r.hotInjectionMaxChars} 字）`,
		`触发：纠正信号 ${t.onCorrectionSignal ? "开" : "关"}　累计 ${t.minTurns} 轮　会话结束 ${t.atSessionEnd ? "跑" : "不跑"}　单会话最多 ${t.maxRunsPerSession} 次`,
		`晋升：同族 ≥${s.config.promote.promotionThreshold} 条且相似度 ≥${s.config.promote.similarityFloor}`,
		`保留：reference ${s.config.retention.referenceTtlDays} 天　project ${s.config.retention.projectTtlDays} 天（二期生效）`,
	);
	return lines.join("\n");
}

/**
 * 三种「什么都没有」的形态 —— 与 `host/l1b/memory-tools.ts` 的 `renderOutcome` 是
 * **同一套判据、不同的读者**，所以措辞不同、判据不共享：
 *
 *   - 工具版写给**模型**（「不要据此否定用户的说法」）；
 *   - 这里写给**运维的人**（「跟模型检索受同一套降级与熔断影响」）。
 *
 * 判据（命中 / 真空 / 降级）必须一致，否则会出现「模型看到降级、人看到空」这种
 * 自相矛盾的状态面 —— 所以下面两个 render 的第一句都是这一支。
 */
function renderMemoryUnavailable(outcome: MemorySearchOutcome, head: string): string {
	const why = outcome.error ? `\n原因：${outcome.error}` : "";
	return (
		`${head}**不可用**${why}\n` +
		`这**不代表该分区没有记忆** —— 只是这次没查出来。命令行检索与模型检索受同一套降级与熔断影响。`
	);
}

/** 记忆不足一条时统一补一句人话，避免运维把「检索挂了」读成「库里空的」 */
function memoryTail(outcome: MemorySearchOutcome): string {
	const parts: string[] = [];
	if (outcome.isolationViolations.length > 0) {
		// 这条**必须显式说**：它不是「没有数据」，是「有数据但不该给你看」。
		// 越界条目的明细已由 `store.ts` 以 error 级别留痕，这里只报条数（正文永不出现）。
		parts.push(`⚠️ 另有 ${outcome.isolationViolations.length} 条结果因分区不匹配被丢弃（隔离防线生效，详见日志）。`);
	}
	return parts.join("\n");
}

/**
 * `fiat memory list` 的渲染（**维护视角**：看这个分区里都有什么）。
 *
 * 与 `search` 的差别不在数据来源，在**排序与列**：这里按 kind/status 一眼看全貌
 * （含退役条目），不显示分数 —— 分数在这个视角里是噪音。
 */
export function renderMemoryList(outcome: MemorySearchOutcome, probe: string): string {
	if (outcome.degraded) return renderMemoryUnavailable(outcome, "记忆列举");
	if (outcome.hits.length === 0) {
		return `本分区没有匹配「${clip(probe)}」的记忆（分区：${outcome.collection}）。`;
	}
	const rows = [...outcome.hits].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status) || a.id.localeCompare(b.id),
	);
	const lines = rows.map((h) => `${h.id}\t${h.kind}\t${h.status}\t${dateOnly(h.createdAt)}\t${clip(h.text, 60)}`);
	return [`分区 ${outcome.collection} · ${rows.length} 条：`, ...lines, memoryTail(outcome)].filter(Boolean).join("\n");
}

/**
 * `fiat memory search` 的渲染（**排序视角**：看为什么是这几条排前面）。
 *
 * `score_type` 与分数一起显示，且**必须带上那句注脚**：缺省不加 reranker 时
 * `score` 是 RRF 融合分，值域与相似度无关，人（和模型）都容易把它读成置信度（§15.7）。
 */
export function renderMemorySearch(outcome: MemorySearchOutcome, query: string): string {
	if (outcome.degraded) return renderMemoryUnavailable(outcome, "记忆检索");
	if (outcome.hits.length === 0) {
		return `没有找到匹配「${clip(query)}」的记忆（分区：${outcome.collection}）。`;
	}
	const lines = outcome.hits.map(
		(h) =>
			`${h.id}\t${h.kind}\t${h.status}\t${h.score.toFixed(4)}\t${h.scoreType}\t${dateOnly(h.createdAt)}\t${clip(h.text, 60)}`,
	);
	return [
		`分区 ${outcome.collection} · ${outcome.hits.length} 条（按相关度排序）：`,
		...lines,
		memoryTail(outcome),
		"（分数为检索融合分，仅供排序参考，不代表记忆的可靠程度。）",
	]
		.filter(Boolean)
		.join("\n");
}

/** `fiat memory forget` 的渲染。措辞按模式分叉 —— 「真删」与「打标」不能说得一样 */
export function renderMemoryForget(r: MemoryForgetResult): string {
	const verb = r.mode === "mark_forgotten" ? "已标记遗忘" : "已删除";
	const lines =
		r.forgotten > 0
			? [`${verb} ${r.forgotten} 条（分区 ${r.collection}${r.mode ? `，模式 ${r.mode}` : ""}）`]
			: [`没有条目被撤销（分区 ${r.collection}）`];
	if (r.notFound.length > 0) {
		// 「找不到」的语义是**本分区内不存在** —— 属主校验靠分区天然提供（契约 7）
		lines.push(`未在本分区找到 ${r.notFound.length} 条：${r.notFound.join(", ")}`);
	}
	return lines.join("\n");
}

/** 取日期部分（记忆只精确到天够用；ISO 串在表格里太长） */
function dateOnly(iso: string): string {
	return iso.length >= 10 ? iso.slice(0, 10) : iso || "-";
}

/**
 * 表格单元格用的截断。
 *
 * ⚠️ 单条记忆正文上限是 `maxTextChars`（缺省 300 字），**不是**几十字 ——
 * 整段打进终端会让「一次 list 20 条」变成刷屏，于是真正要看的那一行被冲到屏幕外。
 * 想要全文就按 id 去库里查；CLI 是索引视图。
 *
 * （`memory-tools.ts` 另有一份给**模型**用的 `clip`，两者不共享：那边的上限
 * 与措辞是跟提示词一起调的，同步两份反而会把两处约束绑死。）
 */
function clip(text: string, max = 60): string {
	const t = (text ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const HELP = `fiat —— 法币业务 CLI（pi-host 内嵌宿主驱动，不改 Pi 核心）
用法:
  fiat <command> [参数] [--flag value]

命令:
  chat [一句话]           内嵌会话问答（pi-host 驱动；P9-49 起替代原扩展加载器入口）
      无参数进入交互 REPL；带一句话则单轮执行后退出
      --session <path>    继续既有会话文件
  diagnose <告警标题>      并行告警诊断（多视角只读取证，输出聚合报告）
      --service <name>     服务名
      --window <text>      时间窗，如 "最近 30 分钟"
      --detail <text>      补充信息
  audit                    查询审计流水
      --tool --outcome --user --env --session --limit <n>
  tickets                  列出审批工单
      --status <pending|approved|rejected|applied>
  approve <ticket_id>      通过工单
  reject  <ticket_id>      驳回工单
      --reason <text>
  tools                    查看某角色在某环境下可用的工具（闸门①预览）
      --role <ops>         --env <dev>
  skills <子命令>           技能库维护（阶段 12 / P12-71；全部离线可用）
      list                 列出技能（来源 / 评测分 / 使用次数 / 状态）
      curate               跑一次确定性维护（active → stale → archived）
            --report <path>  同时把维护报告写到文件
      pin <name>           钉住技能（豁免 Curator，自进化也不可改写）
      unpin <name>         取消钉住
      archive <name>       手动归档（软删，可 restore）
      restore <name>       从归档恢复
      rollback <name>      回滚到最近一次落盘前拍的 tar.gz 快照
  gateway                  告警 webhook 网关（常驻进程，前台跑；P13-74）
      --verbose            打印每个请求的处理结果
      POST /hooks/alert 接告警平台推送：Bearer token 鉴权 → fingerprint 去重
      → severity 分级（P0/P1 自动并行诊断，P2+ 落库 + Lark 摘要卡）
  trace status             全链路追踪状态（阶段 14；离线可跑，零网络）
  memory <子命令>           跨会话长期记忆维护（阶段 15 / P15-99；零 Pi 依赖）
      stats                分区 / 通道 / 熔断 / 关键配置（**零网络**，可离线跑）
      list <探针>          按探针列举本分区记忆（**含退役条目**，维护视角）
            --kind <k>       限定类别（user / feedback / project / reference）
            --top <n>        返回条数上限
            --active-only    只列可检索条目（去掉 superseded / forgotten）
      search <查询>        按相关度检索（**只含可检索条目**，排序视角；参数同 list）
      forget <id...>       撤销记忆（人触发；属主校验靠分区天然提供）
            --mode <m>       delete（缺省，物理删）/ mark_forgotten（打标留痕）
      --scope <s>          以上子命令通用的粒度覆盖：user（缺省）/ repo / global
  help                     显示本帮助

说明:
  chat / diagnose 需要模型（环境变量 FIAT_MODEL=provider/model + 对应密钥）；
  未配置时该命令会明确提示，其余命令完全离线可用。

  全链路追踪（阶段 14）需要 FIAT_TRACING_ENABLED=true + LANGFUSE_PUBLIC_KEY /
  LANGFUSE_SECRET_KEY，端点与采样见 config/tracing.yaml；关时零开销。

  自进化循环（阶段 12）需要 FIAT_EVOLUTION=1 才在 chat 会话里启用；
  设计见 Obsidian「法币定制 Agent DEV_SPEC（Pi 版）」§10。

  跨会话长期记忆（阶段 15）需要 FIAT_MEMORY=true（缺省关），配置见
  config/memory.yaml。memory 子命令不依赖 Pi 运行时：stats 完全离线，
  list / search / forget 只多要一个可达的 RAG server（后三者仍会经与模型
  同一套降级与熔断）。`;
