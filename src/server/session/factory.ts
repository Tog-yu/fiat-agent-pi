/**
 * session-factory —— 三道闸门之①：会话创建时按角色 + 环境裁剪工具集。
 *
 * 与 permission-gate（②）和 L2 canExecute（③）的关系：
 *   - ① 在「工具注册阶段」就过滤：角色无权 → 工具根本不注册，模型看不到（最省 token、最稳）
 *   - ② tool_call 拦截：模型即使绕过（prompt 注入 / 工具名猜测）也会被拦，回灌 isError 文本
 *   - ③ L2 canExecute：唯一权威，执行前最后一查（审批 / 数据范围覆写）
 *
 * 本模块是组合根：把 L1 扩展（permission-gate / mcp-rag）按 subject 组装成 extensionFactories。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createMcpRag,
	type McpClientLike,
	type RagMcpConfig,
	type RagStatus,
} from "../../../workspace/pi-extensions/mcp-rag/index.ts";
import { createPermissionGate } from "../../../workspace/pi-extensions/permission-gate/index.ts";
import { LocalPolicyClient, type PolicyClient } from "../policy/client.ts";
import { loadPolicies, policyToolName, type ToolPolicy } from "../policy/engine.ts";

export interface SessionSubject {
	user: { id: string; role: string };
	environment: string;
}

export interface SessionFactoryOptions {
	policiesPath: string;
	/** 进程内 / HTTP policy client；缺省 LocalPolicyClient（零网络） */
	policyClient?: PolicyClient;
	/** mcp-rag 配置；缺省 stdio */
	ragConfig?: RagMcpConfig;
	/** mcp-rag 客户端工厂（测试 mock / 真实 SDK）；缺省用真实 SDK */
	ragClientFactory?: (cfg: RagMcpConfig) => McpClientLike;
	/** mcp-rag 状态回调透传（ready / unavailable） */
	ragOnStatus?: (status: RagStatus, detail: string) => void;
}

export interface SessionFactoryResult {
	policies: Map<string, ToolPolicy>;
	/** 闸门①谓词：registered tool name（如 mcp_rag_query_knowledge_hub）→ 是否允许注册 */
	allowedTools: (registeredToolName: string) => boolean;
	policyClient: PolicyClient;
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
}

/**
 * 闸门①纯函数：根据 policies 计算「角色 + 环境」允许的工具名谓词。
 * registered tool name 经 policyToolName 归一（mcp_rag_* → rag_query，fiat_* → 去前缀）。
 */
export function allowedToolPredicate(
	policies: Map<string, ToolPolicy>,
	subject: SessionSubject,
): (registeredToolName: string) => boolean {
	return (registeredToolName: string) => {
		const policy = policies.get(policyToolName(registeredToolName));
		if (!policy) return false;
		return (
			policy.allowed_roles.includes(subject.user.role) && policy.allowed_environments.includes(subject.environment)
		);
	};
}

/** 组合根：按 subject 装配 permission-gate（②）与 mcp-rag（受①约束） */
export function buildSession(subject: SessionSubject, opts: SessionFactoryOptions): SessionFactoryResult {
	const policies = loadPolicies(opts.policiesPath);
	const allowedTools = allowedToolPredicate(policies, subject);
	const policyClient = opts.policyClient ?? new LocalPolicyClient(opts.policiesPath);
	const ragConfig = opts.ragConfig ?? { transport: "stdio" };

	const mcpRag = createMcpRag({
		config: ragConfig,
		clientFactory: opts.ragClientFactory,
		allowedTools,
		onStatus: opts.ragOnStatus,
	});

	const gate = createPermissionGate({
		policy: policyClient,
		user: subject.user,
		environment: subject.environment,
	});

	return { policies, allowedTools, policyClient, extensionFactories: [gate, mcpRag] };
}
