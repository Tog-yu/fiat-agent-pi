/**
 * fiat 业务工具声明式 schema（阶段 3/4/5 的 L1 侧工具清单）。
 *
 * 这些工具的执行全部委托给 L2（Fiat Platform）的 FiatToolClient；本文件只描述
 * 「注册成什么、参数长什么样」。注册名用 `fiat_` 前缀，policyToolName 剥前缀后
 * 命中 tool_policies.yaml 的对应 key（es_search_logs / db_query / lark_send / test_env）。
 *
 * 与 mcp-rag 的区别：mcp-rag 的工具来自外部 MCP server（动态 listTools），fiat 工具
 * 是本项目自有、静态声明。两者都走同一套三道闸门（① session-factory 裁剪 ②
 * permission-gate ③ audit-hook），因为都是 `fiat_*` / `mcp_rag_*` 命名空间下的工具。
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";

export interface FiatToolDef {
	/** Pi 侧注册名（fiat_ 前缀） */
	name: string;
	description: string;
	parameters: TSchema;
}

/** 阶段 3：告警与测试环境 */
export const FIAT_TOOLS: FiatToolDef[] = [
	{
		name: "fiat_es_search_logs",
		description: "在 ES 只读检索告警/业务日志（L2）。仅 oncall/ops，dev/staging/prod 均可用。",
		parameters: Type.Object({
			index: Type.String({ description: "ES 索引，如 logs-* 或 alerts-*" }),
			query: Type.String({ description: "Lucene/KQL 查询串" }),
			size: Type.Optional(Type.Number({ description: "返回条数，默认 20" })),
		}),
	},
	{
		name: "fiat_db_query",
		description: "只读查询业务库（L2）。按 role 限表。DEV_SPEC 的 fiat_db_query_* 通配由 table 参数承载。",
		parameters: Type.Object({
			table: Type.String({ description: "表名，如 users / orders" }),
			where: Type.Optional(Type.String({ description: "WHERE 片段（只读，禁止写）" })),
			limit: Type.Optional(Type.Number({ description: "上限，默认 50" })),
		}),
	},
	{
		name: "fiat_lark_send",
		description: "向 Lark 发送告警/通知（非破坏性）。仅 oncall/ops。",
		parameters: Type.Object({
			target: Type.String({ description: "群/人 open_id" }),
			text: Type.String({ description: "消息内容" }),
		}),
	},
	{
		name: "fiat_test_env",
		description: "测试环境自动化（仅 DEV）：建测试账号 / 重置数据。仅 oncall/ops。",
		parameters: Type.Object({
			action: Type.String({ description: "create_account | reset_data" }),
			payload: Type.Optional(Type.String({ description: "动作参数（JSON 字符串）" })),
		}),
	},

	/* 阶段 4：返现与物流 dry-run（只读解析 + 对账，不改数据） */
	{
		name: "fiat_cashback_parse",
		description: "解析返现表格（CSV/TSV）为结构化记录，只读、不写。",
		parameters: Type.Object({
			content: Type.String({ description: "表格文本（CSV/TSV）" }),
			format: Type.Optional(Type.String({ description: "csv | tsv，默认 csv" })),
		}),
	},
	{
		name: "fiat_cashback_reconcile",
		description:
			"返现对账：对比表格与系统记录，生成差异清单与变更计划。mode=dry_run 只读不改；mode=apply 触发 L4 写操作（建审批工单，不重试）。仅 dev/staging，ops/oncall，需审批。",
		parameters: Type.Object({
			csv: Type.String({ description: "已解析的返现表格文本" }),
			systemOfRecord: Type.String({ description: "系统记录文本（CSV/TSV），与 csv 同构" }),
			mode: Type.Optional(Type.String({ description: "dry_run（默认，只读）| apply（触发审批工单）" })),
		}),
	},
	{
		name: "fiat_logistics_parse",
		description: "解析物流表格（CSV/TSV）为结构化记录，只读、不写。",
		parameters: Type.Object({
			content: Type.String({ description: "表格文本（CSV/TSV）" }),
			format: Type.Optional(Type.String({ description: "csv | tsv，默认 csv" })),
		}),
	},
	{
		name: "fiat_logistics_validate",
		description: "物流表格校验（只读）：检查必填字段/状态合法性，输出问题清单，不改数据。",
		parameters: Type.Object({
			csv: Type.String({ description: "物流表格文本（CSV/TSV）" }),
		}),
	},
];
