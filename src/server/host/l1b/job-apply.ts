/**
 * job-apply —— L1b「执行已审批工单」工具模块（P9-46，原 workspace/pi-extensions/job-apply）。
 *
 * **P9-40 新契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`。
 *
 * 模型在 dry-run 之后拿到 ticket_id + token（来自 fiat_cashback_reconcile mode=apply 的
 * 返回），等 Lark 审批通过后调用本工具。本模块只做薄封装：把参数转交 ApprovalService.apply，
 * 把结构化结果回给模型。业务失败（pending_approval / invalid_token / denied / expired）也用
 * isError:false 回灌，避免模型重试绕行审批。
 *
 * 权限：本工具本身受三道闸门约束（policy key = job_apply），且 ApprovalService.apply 内部
 * 还会再调一次 canExecute（L2 再查一次）—— 双保险。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ApprovalService } from "../../approval/ticket.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

export interface JobApplyDeps {
	approval: ApprovalService;
	/** 闸门①谓词；缺省不过滤（job_apply 由 permission-gate 控） */
	allowedTools?: (registeredToolName: string) => boolean;
}

export const JOB_APPLY_TOOL = "fiat_job_apply";

export function createJobApply(deps: JobApplyDeps): HostTool[] {
	if (deps.allowedTools && !deps.allowedTools(JOB_APPLY_TOOL)) return [];
	return [
		hostToolFromDefinition(
			defineTool({
				name: JOB_APPLY_TOOL,
				label: "Fiat Job Apply",
				description:
					"执行一个已审批通过的工单（来自 fiat_cashback_reconcile mode=apply 的 ticket）。需 ticket_id + token。审批通过前调用会返回 pending_approval。",
				promptSnippet: "执行已审批工单：fiat_job_apply(ticket_id, token)。审批通过前不要调用。",
				parameters: {
					type: "object",
					properties: {
						ticket_id: { type: "string", description: "审批工单 ID" },
						token: { type: "string", description: "一次性 token（建单时返回）" },
						note: { type: "string", description: "可选备注" },
					},
					required: ["ticket_id", "token"],
				},
				async execute(_toolCallId, params) {
					const { ticket_id, token } = params as { ticket_id: string; token: string };
					const r = await deps.approval.apply(ticket_id, token);
					return {
						content: [{ type: "text", text: JSON.stringify(r) }],
						details: { jobApply: ticket_id, ok: r.ok },
					};
				},
			}),
		),
	];
}
