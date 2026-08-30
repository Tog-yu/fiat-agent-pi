/**
 * P2-9 纯函数策略引擎单测。
 * 覆盖：loadPolicies / policyToolName / canExecute（fail-closed → 角色 → 环境 → 数据范围覆写/拒绝 / 审批标记）。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type CanExecuteReq,
	canExecute,
	loadPolicies,
	policyToolName,
	type ToolPolicy,
} from "../src/server/policy/engine.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

/** 最小策略，用于隔离单测 */
function policy(
	p: Partial<ToolPolicy> & Pick<ToolPolicy, "tool" | "allowed_roles" | "allowed_environments">,
): ToolPolicy {
	return {
		risk_level: "L1",
		approval_required: false,
		allowed_scopes: [],
		...p,
	} as ToolPolicy;
}

function mapOf(...ps: ToolPolicy[]): Map<string, ToolPolicy> {
	return new Map(ps.map((p) => [p.tool, p]));
}

function req(over: Partial<CanExecuteReq> = {}): CanExecuteReq {
	return {
		user: { id: "u1", role: "ops" },
		tool: "cashback_reconcile",
		environment: "dev",
		input: {},
		...over,
	};
}

describe("policyToolName", () => {
	it("mcp_rag_* 归一为 rag_query", () => {
		expect(policyToolName("mcp_rag_query_knowledge_hub")).toBe("rag_query");
	});
	it("fiat_ 前缀剥掉", () => {
		expect(policyToolName("fiat_cashback_submit")).toBe("cashback_submit");
	});
	it("普通工具名原样返回", () => {
		expect(policyToolName("cashback_reconcile")).toBe("cashback_reconcile");
	});
});

describe("loadPolicies", () => {
	it("解析真实 tool_policies.yaml 并按 tool 建索引", () => {
		const policies = loadPolicies(POLICY_PATH);
		expect(policies.get("rag_query")?.allowed_roles).toEqual(["oncall", "ops", "viewer"]);
		expect(policies.get("cashback_submit")?.allowed_roles).toEqual([]); // MVP 无人可自动提交
		expect(policies.get("cashback_reconcile")?.approval_required).toBe(true);
	});
});

describe("canExecute —— 三道闸门的第三道（唯一权威）", () => {
	it("① fail-closed：未知工具默认拒绝", () => {
		const policies = mapOf(
			policy({ tool: "cashback_reconcile", allowed_roles: ["ops"], allowed_environments: ["dev"] }),
		);
		const v = canExecute(policies, req({ tool: "nonexistent_tool" }));
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("未知工具");
	});

	it("② 角色不在白名单 → 拒绝", () => {
		const policies = mapOf(
			policy({
				tool: "rag_query",
				allowed_roles: ["oncall", "ops", "viewer"],
				allowed_environments: ["dev"],
				approval_required: false,
			}),
		);
		const v = canExecute(policies, req({ tool: "rag_query", user: { id: "u2", role: "admin" } }));
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("角色 admin 无权");
	});

	it("③ 环境不在白名单 → 拒绝", () => {
		const policies = mapOf(
			policy({
				tool: "cashback_reconcile",
				allowed_roles: ["ops"],
				allowed_environments: ["dev", "staging"],
				approval_required: true,
			}),
		);
		const v = canExecute(policies, req({ environment: "prod" }));
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("环境 prod 不允许");
	});

	it("④ 放行：角色 + 环境均满足，无 collection 限制", () => {
		const policies = mapOf(
			policy({ tool: "rag_query", allowed_roles: ["viewer"], allowed_environments: ["dev"], approval_required: false }),
		);
		const v = canExecute(policies, req({ tool: "rag_query", user: { id: "u3", role: "viewer" } }));
		expect(v.allowed).toBe(true);
		expect(v.approvalRequired).toBe(false);
	});

	it("⑤ 放行 + 审批标记：cashback_reconcile 需审批", () => {
		const policies = mapOf(
			policy({
				tool: "cashback_reconcile",
				allowed_roles: ["ops"],
				allowed_environments: ["dev"],
				approval_required: true,
			}),
		);
		const v = canExecute(policies, req({ user: { id: "u1", role: "ops" } }));
		expect(v.allowed).toBe(true);
		expect(v.approvalRequired).toBe(true);
	});

	it("⑥ 数据范围覆写：ops 调 cashback_reconcile 缺 collection → 强制补 cashback_all", () => {
		const policies = mapOf(
			policy({
				tool: "cashback_reconcile",
				allowed_roles: ["ops"],
				allowed_environments: ["dev"],
				collection_scopes: { ops: ["cashback_all"], oncall: ["cashback_readonly"] },
			}),
		);
		const v = canExecute(policies, req({ input: {} }));
		expect(v.allowed).toBe(true);
		expect(v.rewrite).toEqual({ collection: "cashback_all" });
	});

	it("⑦ collection 越权：ops 请求不在白名单的 collection → 拒绝", () => {
		const policies = mapOf(
			policy({
				tool: "cashback_reconcile",
				allowed_roles: ["ops"],
				allowed_environments: ["dev"],
				collection_scopes: { ops: ["cashback_all"] },
			}),
		);
		const v = canExecute(policies, req({ input: { collection: "prod_finance" } }));
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("collection 越权");
	});

	it("⑧ mcp_rag_* 走 rag_query 策略：viewer 放行", () => {
		const policies = mapOf(
			policy({ tool: "rag_query", allowed_roles: ["viewer"], allowed_environments: ["dev"], approval_required: false }),
		);
		const v = canExecute(policies, req({ tool: "mcp_rag_query_knowledge_hub", user: { id: "u4", role: "viewer" } }));
		expect(v.allowed).toBe(true);
	});
});
