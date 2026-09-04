/**
 * fiat-tools —— L1b 业务工具模块（P9-43，原 workspace/pi-extensions/fiat-tools）：
 * 阶段 3/4/5 的只读、dry-run 与 apply 工具。
 *
 * **P9-40 新契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`：
 *
 *   const tools = createFiatTools(deps); // 同步：工具定义静态已知
 *
 * 把 src/server/fiat-tools/schema.ts 声明的工具暴露给内嵌循环，执行委托给 FiatToolClient
 * （LocalFiatClient 测试 / HttpFiatClient 真实 L2）。这些 `fiat_*` 工具天然经过三道闸门：
 *   ① session-factory 按角色裁剪（allowedTools 谓词拒绝则不注册）
 *   ② permission-gate 在 tool_call 拦截（L2 canExecute 唯一权威）
 *   ③ audit-hook 在 tool_result 落审计
 * 所以本模块不写任何权限/审计逻辑，只管「声明 + 转发执行结果」。
 *
 * 阶段 5 apply 模式：`fiat_cashback_reconcile` 传 mode=apply 时，不直接写，而是
 * 转交 ApprovalService.requestApply 建单（pending + 一次性 token + Lark 卡），把 ticket_id
 * 与 token 回给模型（isError:false，不重试）。实际写要等 fiat_job_apply（审批通过后）。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ApprovalService } from "../../approval/ticket.ts";
import type { FiatToolClient } from "../../fiat-tools/client.ts";
import { FIAT_TOOLS, type FiatToolDef } from "../../fiat-tools/schema.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

export type { FiatToolClient } from "../../fiat-tools/client.ts";
export { FIAT_TOOLS } from "../../fiat-tools/schema.ts";

export interface FiatToolsDeps {
	client: FiatToolClient;
	/** 闸门①谓词：registered tool name → 是否允许注册；缺省不过滤 */
	allowedTools?: (registeredToolName: string) => boolean;
	/** 阶段 5：注入后支持 mode=apply 走审批工单；缺省则 apply 等同于 dry-run 转发 */
	approval?: ApprovalService;
	/** 当前会话主体（建单时记录到 ticket.subject） */
	user?: { id: string; role: string };
	environment?: string;
	/** 哪些工具允许 apply 触发工单（默认仅返现对账） */
	applyTools?: string[];
}

/** 支持 apply 走审批的 L4 工具白名单（避免任意工具都能触发写工单） */
const DEFAULT_APPLY_TOOLS = ["fiat_cashback_reconcile"];

export function createFiatTools(deps: FiatToolsDeps): HostTool[] {
	const applyTools = new Set(deps.applyTools ?? DEFAULT_APPLY_TOOLS);
	const tools: HostTool[] = [];
	for (const def of FIAT_TOOLS) {
		// 闸门①：角色白名单拒绝 → 不注册，模型根本看不到
		if (deps.allowedTools && !deps.allowedTools(def.name)) continue;
		tools.push(defineFiatTool(def, deps, applyTools));
	}
	return tools;
}

function defineFiatTool(def: FiatToolDef, deps: FiatToolsDeps, applyTools: Set<string>): HostTool {
	const canApply = !!deps.approval && applyTools.has(def.name);
	return hostToolFromDefinition(
		defineTool({
			name: def.name,
			label: def.name.replace(/^fiat_/, "Fiat "),
			description: def.description,
			promptSnippet: def.description,
			parameters: def.parameters,
			async execute(_toolCallId, params) {
				const p = params as Record<string, unknown>;
				// 阶段 5：apply 触发审批工单（不重试，返回 ticket + token）
				if (canApply && p.mode === "apply" && deps.approval && deps.user && deps.environment) {
					const r = await deps.approval.requestApply({
						tool: def.name,
						subject: {
							userId: deps.user.id,
							role: deps.user.role,
							environment: deps.environment,
						},
						payload: p,
						idempotencyKey: `${def.name}:${deps.user.id}:${JSON.stringify(p.csv ?? p.csv)}:${JSON.stringify(
							p.systemOfRecord ?? p.csv,
						)}`,
						title: `返现对账写操作：${def.name}`,
						summary: `将对账差异写入系统记录（环境 ${deps.environment}）`,
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									ticket_id: r.ticketId,
									token: r.token,
									status: r.status,
									next: "等待 Lark 审批通过后调用 fiat_job_apply(ticket_id, token)",
								}),
							},
						],
						details: { fiatTool: def.name, ticketId: r.ticketId },
					};
				}
				const result = await deps.client.execute(def.name, p);
				return { content: result.content, details: { fiatTool: def.name, ticketId: "" } };
			},
		}),
	);
}
