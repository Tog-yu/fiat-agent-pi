/**
 * L2 权限策略引擎 —— 纯函数、声明式、无 LLM（v1 已验证的领域模型直接沿用）。
 *
 * 数据源：config/tool_policies.yaml（工具 / 风险等级 L1-L5 / 角色 / 环境 / 审批 / collection scope）。
 * canExecute 是三道闸门里的第三道、唯一权威；permission-gate（L1）只是提前拦截。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ToolPolicy {
	tool: string;
	risk_level: "L1" | "L2" | "L3" | "L4" | "L5";
	allowed_roles: string[];
	allowed_environments: string[];
	approval_required: boolean;
	allowed_scopes: string[];
	/** 角色到允许 collection 的映射；存在时 canExecute 会覆写 input.collection */
	collection_scopes?: Record<string, string[]>;
	denied_actions?: string[];
}

export interface PoliciesFile {
	policies: ToolPolicy[];
}

export interface FiatUser {
	id: string;
	role: string;
}

export interface CanExecuteReq {
	user: FiatUser;
	/** Pi 侧注册的工具名（如 fiat_cashback_submit / mcp_rag_query_knowledge_hub） */
	tool: string;
	environment: string;
	input: Record<string, unknown>;
}

export interface Verdict {
	allowed: boolean;
	reason?: string;
	/** 命中时调用方必须 Object.assign 进 event.input（types.ts:871：覆写后不再重新校验） */
	rewrite?: Record<string, unknown>;
	/** 提示业务层：该工具需要审批（由 L2 业务 API 返回工单，而不是在这里 block） */
	approvalRequired?: boolean;
}

export function loadPolicies(path: string): Map<string, ToolPolicy> {
	const file = parse(readFileSync(path, "utf-8")) as PoliciesFile;
	return new Map(file.policies.map((p) => [p.tool, p]));
}

/** Pi 工具名 → 策略名：剥掉 fiat_ 前缀；mcp_rag_* 归入 rag_query */
export function policyToolName(tool: string): string {
	if (tool.startsWith("mcp_rag_")) return "rag_query";
	if (tool.startsWith("fiat_")) return tool.slice(5);
	return tool;
}

/** 覆写数据范围：角色有 collection_scopes 时强制改写 input.collection */
function collectionVerdict(policy: ToolPolicy, role: string, input: Record<string, unknown>): Verdict {
	const scopes = policy.collection_scopes?.[role];
	if (!scopes || scopes.length === 0) return { allowed: true, approvalRequired: policy.approval_required };

	const requested = input.collection;
	if (typeof requested === "string" && !scopes.includes(requested)) {
		return {
			allowed: false,
			reason: `collection 越权：${requested} 不在角色 ${role} 的允许范围 [${scopes.join(", ")}]`,
		};
	}
	const target = typeof requested === "string" ? requested : scopes[0];
	return target === requested
		? { allowed: true, approvalRequired: policy.approval_required }
		: { allowed: true, rewrite: { collection: target }, approvalRequired: policy.approval_required };
}

/** 唯一权威判定。顺序：未知工具 → 角色 → 环境 → 数据范围（覆写/拒绝） */
export function canExecute(policies: Map<string, ToolPolicy>, req: CanExecuteReq): Verdict {
	const policy = policies.get(policyToolName(req.tool));
	if (!policy) {
		return { allowed: false, reason: `未知工具 ${req.tool}：默认拒绝（fail-closed）` };
	}
	if (!policy.allowed_roles.includes(req.user.role)) {
		return { allowed: false, reason: `角色 ${req.user.role} 无权使用 ${policy.tool}` };
	}
	if (!policy.allowed_environments.includes(req.environment)) {
		return {
			allowed: false,
			reason: `环境 ${req.environment} 不允许使用 ${policy.tool}（允许: ${policy.allowed_environments.join(", ")}）`,
		};
	}
	return collectionVerdict(policy, req.user.role, req.input);
}
