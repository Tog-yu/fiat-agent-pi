/**
 * 业务 CLI 的纯计算 / 渲染逻辑（无 IO、无进程依赖，可离线测）。
 *
 * CLI 只做「把 L2 能力暴露成命令」，不含业务逻辑：
 * 权限判定走 policies、审计走 AuditReader、审批走 ApprovalService —— 与 Web/TUI 同源。
 */

import type { ApprovalTicketRecord } from "../approval/ticket.ts";
import type { AuditRecord } from "../audit/client.ts";
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
  help                     显示本帮助

说明:
  chat / diagnose 需要模型（环境变量 FIAT_MODEL=provider/model + 对应密钥）；
  未配置时该命令会明确提示，其余命令完全离线可用。`;
