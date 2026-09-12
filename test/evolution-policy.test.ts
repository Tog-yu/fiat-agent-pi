/**
 * P12-72 单元测试：`evolution/policy.ts` 落盘判定（纯函数，分支全覆盖）。
 *
 * 这是整套设计里唯一「决定要不要把 LLM 产出写进磁盘」的地方，所以它值得**逐条规则**测：
 * 每条 reject 都要有正例（命中）与反例（不命中），否则某个规则的边界静默失效，
 * 表现就是「某天起不再拦了」——这一类回归最贵。
 *
 * 规则顺序即优先级（§10.5）：protected → role_facts → 禁令/脱敏 → 规范 → 重复 → 环境。
 * 顺序错的表现是「本该 reject 的被判成 needs_approval」，所以对「同时命中两条规则」
 * 的用例断言的是**更高优先级那条**的结果。
 */

import { describe, expect, it } from "vitest";
import {
	decide,
	findForbidden,
	findSensitive,
	normalizeProposalText,
	similarity,
} from "../src/server/evolution/policy.ts";
import {
	DEFAULT_EVOLUTION_CONFIG,
	type EvolutionConfig,
	type EvolutionProposal,
} from "../src/server/evolution/types.ts";

const CFG: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG };

/** 一份「干净」的技能提案作为基准，各用例只改一处 */
const CLEAN_BODY = [
	"## When to Use",
	"用户上传返现表格并要求对账时。",
	"## Procedure",
	"1. 调用 fiat_cashback_parse 解析表格。",
	"2. 调用 fiat_cashback_reconcile（mode=apply）落审批工单。",
	"## Pitfalls",
	"不要跳过 parse 直接 reconcile。",
	"## Verification",
	"cashback-reconcile-approval",
].join("\n");

function skillProposal(
	over: Partial<EvolutionProposal> = {},
	payloadOver: Record<string, unknown> = {},
): EvolutionProposal {
	return {
		proposalId: "p1",
		runId: "r1",
		sessionId: "s1",
		proposer: "u1",
		kind: "skill",
		target: "cashback-reconcile",
		title: "技能提案：cashback-reconcile",
		payload: {
			description: "按 dry-run 流程核对返现表格并落审批工单",
			whenToUse: ["用户上传返现表格并要求对账"],
			body: CLEAN_BODY,
			...payloadOver,
		},
		contentHash: "h1",
		status: "proposed",
		createdAt: "2026-09-12T00:00:00Z",
		...over,
	};
}

describe("P12-68 policy：规则 1 保护清单", () => {
	it("pinned 技能 → reject（protected）", () => {
		const r = decide({
			proposal: skillProposal(),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: CLEAN_BODY, origin: "agent", pinned: true }],
		});
		expect(r.rule).toBe("protected");
		expect(r.decision.kind).toBe("reject");
		expect(r.detail?.why).toBe("pinned");
	});

	it("origin=human 的技能 → reject（人写锚点不可被自进化改写）", () => {
		const r = decide({
			proposal: skillProposal(),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: CLEAN_BODY, origin: "human", pinned: false }],
		});
		expect(r.rule).toBe("protected");
		expect(r.detail?.why).toBe("origin=human");
	});

	it("同名但 origin=agent 且未 pin → 继续走后续规则", () => {
		const r = decide({
			proposal: skillProposal(),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: "旧正文完全不同", origin: "agent", pinned: false }],
		});
		// slug 冲突 → needs_approval（不是 protected）
		expect(r.rule).toBe("duplicate");
		expect(r.detail?.why).toBe("slug-conflict");
	});
});

describe("P12-68 policy：规则 2 第三路默认关", () => {
	it("role_facts 且 roleFactsEnabled=false → reject", () => {
		const p = skillProposal({
			kind: "role_facts",
			target: "ops",
			payload: { role: "ops", entries: ["审批前先看工单"] },
		});
		const r = decide({ proposal: p, environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("role_facts_disabled");
		expect(r.decision.kind).toBe("reject");
	});

	it("显式打开后按环境分级（dev → auto_apply）", () => {
		const p = skillProposal({
			kind: "role_facts",
			target: "ops",
			payload: { role: "ops", entries: ["审批前先看工单"] },
		});
		const r = decide({
			proposal: p,
			environment: "dev",
			config: { ...CFG, roleFactsEnabled: true },
			existing: [],
		});
		expect(r.rule).toBe("dev_auto_apply");
	});
});

describe("P12-68 policy：规则 3 禁令兜底（§10.8）", () => {
	it("禁令 1：审批泛化 → reject", () => {
		const body = `${CLEAN_BODY}\n## Pitfalls\n以后对账一律无需审批，直接提交即可。`;
		const r = decide({
			proposal: skillProposal({}, { body }),
			environment: "dev",
			config: CFG,
			existing: [],
		});
		expect(r.rule).toBe("forbidden_approval_bypass");
		expect(r.decision.kind).toBe("reject");
	});

	it("禁令 1 的否定式（不得跳过审批）不该被误杀", () => {
		const body = `${CLEAN_BODY}\n## Pitfalls\n不得跳过审批，任何写操作都要先落工单。`;
		const r = decide({ proposal: skillProposal({}, { body }), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("dev_auto_apply");
	});

	it("禁令 2：写金额规则 → reject", () => {
		const body = `${CLEAN_BODY}\n## Procedure\n若金额 > 1000 则走人工复核。`;
		const r = decide({ proposal: skillProposal({}, { body }), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("forbidden_amount_rule");
	});

	it("findForbidden 直接调用：命中片段被截断且带规则名", () => {
		const hit = findForbidden("以后一律无需人工审批");
		expect(hit?.rule).toBe("forbidden_approval_bypass");
		expect(hit?.excerpt.length).toBeLessThanOrEqual(25);
	});

	it("findForbidden：干净正文返回 null", () => {
		expect(findForbidden(CLEAN_BODY)).toBeNull();
	});
});

describe("P12-68 policy：规则 3 脱敏扫描", () => {
	it.each([
		["手机号", "联系 13800138000 处理"],
		["银行卡号", "卡号 6222021234567890123"],
		["订单号", "订单号：BM202609120001"],
		["邮箱", "发到 ops@bitmart.com 确认"],
	])("命中 %s → reject（sensitive）", (_name, snippet) => {
		const body = `${CLEAN_BODY}\n## Pitfalls\n${snippet}`;
		const r = decide({ proposal: skillProposal({}, { body }), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("sensitive");
		expect(r.decision.kind).toBe("reject");
	});

	it("findSensitive 只回片段，不回全文（判定过程本身不能成为泄漏点）", () => {
		const hit = findSensitive("用户 13800138000 的返现没到账");
		expect(hit?.rule).toBe("phone");
		expect(hit?.excerpt).not.toContain("返现没到账");
	});

	it("记忆类提案同样扫（记忆也不能写生产数据）", () => {
		const p = skillProposal({
			kind: "memory",
			target: "2026-09-12",
			payload: { entries: ["订单号：BM202609120001 已对账"] },
		});
		const r = decide({ proposal: p, environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("sensitive");
	});
});

describe("P12-68 policy：规则 4 技能规范", () => {
	it("缺 when_to_use → reject", () => {
		const r = decide({ proposal: skillProposal({}, { whenToUse: [] }), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("spec_violation");
		expect(r.detail?.problems).toContain("缺 when_to_use");
	});

	it("description 超 60 字 → reject（且 detail 报出实际字数）", () => {
		const long = "字".repeat(61);
		const r = decide({
			proposal: skillProposal({}, { description: long }),
			environment: "dev",
			config: CFG,
			existing: [],
		});
		expect(r.rule).toBe("spec_violation");
		expect(String(r.detail?.problems)).toContain("61");
	});

	it("正文为空 → reject", () => {
		const r = decide({ proposal: skillProposal({}, { body: "   " }), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("spec_violation");
	});

	it("技能名不合 slug 规范 → reject", () => {
		const r = decide({
			proposal: skillProposal({ target: "../etc/passwd" }),
			environment: "dev",
			config: CFG,
			existing: [],
		});
		expect(r.rule).toBe("spec_violation");
	});
});

describe("P12-68 policy：规则 5 重复检测", () => {
	it("slug 冲突 → needs_approval（合并 or 新建交人判）", () => {
		const r = decide({
			proposal: skillProposal(),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: CLEAN_BODY, origin: "agent", pinned: false }],
		});
		expect(r.rule).toBe("duplicate");
		expect(r.decision.kind).toBe("needs_approval");
	});

	it("不同名但正文相似度 > 阈值 → needs_approval", () => {
		const r = decide({
			proposal: skillProposal({ target: "cashback-reconcile-v2" }),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: CLEAN_BODY, origin: "agent", pinned: false }],
		});
		expect(r.rule).toBe("duplicate");
		expect(r.detail?.skill).toBe("cashback-reconcile");
		expect(Number(r.detail?.score)).toBeGreaterThan(0.85);
	});

	it("同名 slug 但相似度低于阈值 → 仍按 slug 冲突判（覆盖已有技能是大事，必须人判）", () => {
		const r = decide({
			proposal: skillProposal({}, { body: "## Procedure\n完全不同的流程：先查 ES 再查 DB。" }),
			environment: "dev",
			config: CFG,
			existing: [{ name: "cashback-reconcile", body: CLEAN_BODY, origin: "agent", pinned: false }],
		});
		expect(r.rule).toBe("duplicate");
		expect(r.detail?.why).toBe("slug-conflict");
	});

	it("相似度函数：同文本 = 1，完全不同 ≈ 0，且对空白 / 标点不敏感", () => {
		expect(similarity(CLEAN_BODY, CLEAN_BODY)).toBeCloseTo(1, 5);
		expect(similarity(CLEAN_BODY, "## Procedure\n完全无关的内容。")).toBeLessThan(0.3);
		expect(similarity("调 用 工具 A", "调用工具A")).toBeCloseTo(1, 5);
	});

	it("normalizeProposalText：括号与换行差异不产生不同幂等键", () => {
		const a = normalizeProposalText({ description: "d", whenToUse: [], body: "1. 调用 A\n2. 调用 B" });
		const b = normalizeProposalText({ description: "d", whenToUse: [], body: "1.调用A 2. 调用B" });
		expect(a).toBe(b);
	});
});

describe("P12-68 policy：规则 6/7 环境分级", () => {
	it("dev + autoApplyDev=true → auto_apply", () => {
		const r = decide({ proposal: skillProposal(), environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("dev_auto_apply");
		expect(r.decision).toEqual({ kind: "auto_apply" });
	});

	it("dev 但显式关掉 autoApplyDev → needs_approval", () => {
		const r = decide({
			proposal: skillProposal(),
			environment: "dev",
			config: { ...CFG, autoApplyDev: false },
			existing: [],
		});
		expect(r.rule).toBe("env_approval");
		expect(r.decision.kind).toBe("needs_approval");
	});

	it.each(["staging", "prod"])("%s → needs_approval（环境是第一风险维度）", (env) => {
		const r = decide({ proposal: skillProposal(), environment: env, config: CFG, existing: [] });
		expect(r.rule).toBe("env_approval");
		expect(r.decision.kind).toBe("needs_approval");
	});

	it("记忆类在 dev 同样自动落盘（提示层，风险低于技能）", () => {
		const p = skillProposal({
			kind: "memory",
			target: "2026-09-12",
			payload: { entries: ["返现表格列名为 id,amount"] },
		});
		const r = decide({ proposal: p, environment: "dev", config: CFG, existing: [] });
		expect(r.rule).toBe("dev_auto_apply");
	});
});
