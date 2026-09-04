/**
 * audit-hook —— L1 审计钩子（三道闸门之后）。
 *
 * 订阅 `tool_result` 事件：无论工具是「放行执行」还是「被 gate ② block（回灌 isError）」，
 * 都产生一条 tool_result，本钩子据此落审计。block 原因在 content 文本里，作为 detail 记录。
 *
 * 与 permission-gate 的分工：gate 负责「挡」，audit-hook 负责「记」。两者都从 session 注入
 * user / environment / sessionId（会话按用户建，身份在创建时已知）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuditClient, AuditOutcome } from "../../audit/client.ts";
import type { FiatUser } from "../../policy/engine.ts";

export interface AuditHookDeps {
	audit: AuditClient;
	user: FiatUser;
	environment: string;
	sessionId: string;
}

export function createAuditHook(deps: AuditHookDeps) {
	return (pi: ExtensionAPI) => {
		pi.on("tool_result", async (event) => {
			const detail =
				event.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || undefined;

			const outcome: AuditOutcome = event.isError ? "error" : "allowed";

			await deps.audit.record({
				ts: new Date().toISOString(),
				sessionId: deps.sessionId,
				user: deps.user,
				environment: deps.environment,
				tool: event.toolName,
				input: (event.input ?? {}) as Record<string, unknown>,
				isError: event.isError,
				outcome,
				detail,
			});
		});
	};
}
