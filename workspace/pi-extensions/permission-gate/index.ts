/**
 * permission-gate —— L1 三道闸门中的第二道（第一道是会话创建时按角色裁剪工具集，P2-10）。
 *
 * `tool_call` 拦截语义（来自 Pi 源码，务必记住）：
 *   1. 返回 { block: true, reason } → agent-loop 把 reason 转成 isError:true 的 tool result 回灌模型
 *      —— 模型看得到拒绝原因、可能换参数重试，所以 block 只是第一道，不是唯一一道
 *   2. 覆写参数必须 mutate event.input（Pi 不再重新校验），collection 白名单就靠这个
 *   3. 判定的唯一权威在 L2 canExecute（本扩展只转发 + 执行 verdict）
 *
 * 审计：被本闸门 block 的调用，由本扩展直接落一条 outcome="blocked" 审计（因为 block 会短路，
 * 不会走到 tool_result 事件，audit-hook 看不到）。放行的调用由 audit-hook 在 tool_result 阶段记录。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuditClient } from "../../../src/server/audit/client.ts";
import type { PolicyClient } from "../../../src/server/policy/client.ts";
import type { CanExecuteReq, FiatUser } from "../../../src/server/policy/engine.ts";

export interface PermissionGateDeps {
	policy: PolicyClient;
	/** 会话级用户上下文：session 是按用户建的，用户/角色在创建时注入 */
	user: FiatUser;
	/** 当前环境：dev / staging / prod */
	environment: string;
	/** 会话 ID（审计关联） */
	sessionId: string;
	/** 可选审计 client：被 block 时落一条 blocked 记录 */
	audit?: AuditClient;
	/** 可选的任务标识，进审计 */
	taskId?: string;
}

export function createPermissionGate(deps: PermissionGateDeps) {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event) => {
			const req: CanExecuteReq = {
				user: deps.user,
				tool: event.toolName,
				environment: deps.environment,
				input: (event.input ?? {}) as Record<string, unknown>,
			};

			const verdict = await deps.policy.canExecute(req);

			if (!verdict.allowed) {
				await deps.audit?.record({
					ts: new Date().toISOString(),
					sessionId: deps.sessionId,
					user: deps.user,
					environment: deps.environment,
					tool: event.toolName,
					input: (event.input ?? {}) as Record<string, unknown>,
					isError: true,
					outcome: "blocked",
					detail: verdict.reason ?? "权限拒绝",
				});
				return { block: true, reason: verdict.reason ?? "权限拒绝" };
			}

			// 数据范围覆写：mutate event.input，Pi 不再重新校验
			if (verdict.rewrite) Object.assign(event.input, verdict.rewrite);
			return undefined;
		});
	};
}
