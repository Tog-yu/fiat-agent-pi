/**
 * case 配置加载与校验（阶段 11 / P11-56）—— 纯逻辑，零 Pi 依赖。
 *
 * 设计口径（设计方案 §9.5）：
 *   - 每个 case 必须能明确回答「什么算成功」——回答不了就拒绝加载（EDD：先有判定标准再谈采集）。
 *   - 缺 terminal / threshold 的 case 直接抛错，fail-fast。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type {
	EvalCase,
	EvalCaseExpect,
	FirstStepExpectation,
	OutcomeExpectation,
	TrajectoryExpectation,
} from "./types.ts";

interface CasesFile {
	cases: unknown[];
}

/**
 * YAML（snake_case，配置面习惯）→ TS（camelCase，类型面）的字段映射。
 * 配置文件是给人编辑的活文档，用 snake_case（first_step / any_of / requires_approval /
 * max_steps）；TS 类型用 camelCase。加载时在此处统一转换。
 */
function normalizeExpect(raw: Record<string, unknown>): EvalCaseExpect {
	const outcome = (raw.outcome ?? {}) as Record<string, unknown>;
	const outcomeExp: OutcomeExpectation = {
		terminal: String(outcome.terminal ?? "") as OutcomeExpectation["terminal"],
		...(outcome.requires_approval !== undefined ? { requiresApproval: Boolean(outcome.requires_approval) } : {}),
	};

	let trajectory: TrajectoryExpectation | undefined;
	if (raw.trajectory) {
		const t = raw.trajectory as Record<string, unknown>;
		const milestones = Array.isArray(t.milestones)
			? t.milestones.map((m) => {
					const mm = m as Record<string, unknown>;
					return {
						tool: String(mm.tool ?? ""),
						...(mm.after !== undefined ? { after: String(mm.after) } : {}),
					};
				})
			: undefined;
		trajectory = {
			...(Array.isArray(t.toolPrefix) ? { toolPrefix: t.toolPrefix as string[] } : {}),
			...(milestones ? { milestones } : {}),
			...(Array.isArray(t.forbid) ? { forbid: t.forbid as string[] } : {}),
			...(t.max_steps !== undefined ? { maxSteps: Number(t.max_steps) } : {}),
		};
	}

	let firstStep: FirstStepExpectation | undefined;
	if (raw.first_step) {
		const f = raw.first_step as Record<string, unknown>;
		firstStep = { any_of: Array.isArray(f.any_of) ? f.any_of.map(String) : [] };
	}

	return { outcome: outcomeExp, ...(trajectory ? { trajectory } : {}), ...(firstStep ? { firstStep } : {}) };
}

function normalizeCase(raw: unknown): EvalCase {
	const r = raw as Record<string, unknown>;
	const subject = (r.subject ?? {}) as Record<string, unknown>;
	return {
		id: String(r.id ?? ""),
		prompt: String(r.prompt ?? ""),
		subject: { role: String(subject.role ?? ""), environment: String(subject.environment ?? "") },
		expect: normalizeExpect((r.expect ?? {}) as Record<string, unknown>),
		threshold: Number(r.threshold ?? NaN),
	};
}

/** 校验单个 case 的必要字段；不合法抛 Error（含 case id 定位） */
export function validateCase(c: EvalCase): string[] {
	const errors: string[] = [];
	const where = c.id ? `case[${c.id}]` : "case[?]";

	if (!c.id) errors.push(`${where}: 缺 id`);
	if (!c.prompt) errors.push(`${where}: 缺 prompt`);
	if (!c.subject?.role || !c.subject?.environment) errors.push(`${where}: 缺 subject.role / subject.environment`);
	if (!c.expect?.outcome?.terminal) {
		errors.push(`${where}: 缺 expect.outcome.terminal（什么算成功必须可回答）`);
	} else if (!["answered", "ticket_created", "applied"].includes(c.expect.outcome.terminal)) {
		errors.push(`${where}: expect.outcome.terminal 非法值 ${c.expect.outcome.terminal}`);
	}
	if (typeof c.threshold !== "number" || c.threshold < 0 || c.threshold > 1) {
		errors.push(`${where}: threshold 必须在 0..1（缺失或非法）`);
	}
	if (c.expect?.firstStep && !Array.isArray(c.expect.firstStep.any_of)) {
		errors.push(`${where}: expect.firstStep.any_of 必须是数组`);
	}
	return errors;
}

/** 从文件加载并校验全部 case；任一 case 非法即整体抛错（fail-fast） */
export function loadEvalCases(path: string): EvalCase[] {
	const file = parse(readFileSync(path, "utf-8")) as CasesFile;
	const cases = (file.cases ?? []).map(normalizeCase);
	const errors = cases.flatMap(validateCase);
	if (errors.length > 0) throw new Error(`eval_cases.yaml 校验失败:\n${errors.join("\n")}`);
	const ids = new Set<string>();
	for (const c of cases) {
		if (ids.has(c.id)) throw new Error(`eval_cases.yaml: case id 重复 ${c.id}`);
		ids.add(c.id);
	}
	return cases;
}
