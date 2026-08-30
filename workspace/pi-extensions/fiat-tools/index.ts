/**
 * fiat-tools —— L1 业务工具扩展（阶段 3/4/5 的只读与 dry-run 工具）。
 *
 * 把 src/server/fiat-tools/schema.ts 声明的工具注册到 Pi，执行委托给 FiatToolClient
 * （LocalFiatClient 测试 / HttpFiatClient 真实 L2）。这些 `fiat_*` 工具天然经过三道闸门：
 *   ① session-factory 按角色裁剪（allowedTools 谓词拒绝则不注册）
 *   ② permission-gate 在 tool_call 拦截（L2 canExecute 唯一权威）
 *   ③ audit-hook 在 tool_result 落审计
 * 所以本扩展不写任何权限/审计逻辑，只管「注册 + 转发执行结果」。
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FiatToolClient } from "../../../src/server/fiat-tools/client.ts";
import { FIAT_TOOLS, type FiatToolDef } from "../../../src/server/fiat-tools/schema.ts";

export type { FiatToolClient } from "../../../src/server/fiat-tools/client.ts";
export { FIAT_TOOLS } from "../../../src/server/fiat-tools/schema.ts";

export interface FiatToolsDeps {
	client: FiatToolClient;
	/** 闸门①谓词：registered tool name → 是否允许注册；缺省不过滤 */
	allowedTools?: (registeredToolName: string) => boolean;
}

export function createFiatTools(deps: FiatToolsDeps) {
	return (pi: ExtensionAPI) => {
		for (const def of FIAT_TOOLS) {
			// 闸门①：角色白名单拒绝 → 不注册，模型根本看不到
			if (deps.allowedTools && !deps.allowedTools(def.name)) continue;
			pi.registerTool(defineFiatTool(def, deps.client));
		}
	};
}

function defineFiatTool(def: FiatToolDef, client: FiatToolClient) {
	return defineTool({
		name: def.name,
		label: def.name.replace(/^fiat_/, "Fiat "),
		description: def.description,
		promptSnippet: def.description,
		parameters: def.parameters,
		async execute(_toolCallId, params) {
			const result = await client.execute(def.name, params as Record<string, unknown>);
			return { content: result.content, details: { fiatTool: def.name } };
		},
	});
}
