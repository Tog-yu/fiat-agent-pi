/**
 * 自进化配置加载（阶段 12 / P12-62）—— 纯逻辑，零 Pi 依赖。
 *
 * 口径对齐 `eval/cases.ts` 的加载器：
 *   - 配置面用 snake_case（给人编辑），类型面用 camelCase；转换只在这一个文件里做。
 *   - **失败不炸**：文件缺失 / 字段缺失 / 值非法一律回落到 `DEFAULT_EVOLUTION_CONFIG` 的对应项。
 *     理由：自进化是**旁路**能力。配置写错不该让主链路的 chat 起不来
 *     （与 eval-recorder「缺 sink 就不注册」的 fail-safe 同源）。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig } from "./types.ts";

interface EvolutionFile {
	evolution?: Record<string, unknown>;
}

/** 取正整数（<=0 / 非数 / 缺失 → 用默认）；自进化里所有「计数 / 毫秒 / 天数」都走它 */
function positiveInt(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 取 0..1 的比值（阈值类） */
function ratio(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

/** 取布尔（只认显式 true/false，字符串不猜） */
function bool(raw: unknown, fallback: boolean): boolean {
	return typeof raw === "boolean" ? raw : fallback;
}

/** 从已解析的对象归一化（便于测试直接喂对象） */
export function normalizeEvolutionConfig(raw: unknown): EvolutionConfig {
	const d = DEFAULT_EVOLUTION_CONFIG;
	if (!raw || typeof raw !== "object") return { ...d };
	const r = raw as Record<string, unknown>;
	return {
		intervalIters: positiveInt(r.interval_iters, d.intervalIters),
		intervalTurns: positiveInt(r.interval_turns, d.intervalTurns),
		maxRunsPerSession: positiveInt(r.max_runs_per_session, d.maxRunsPerSession),
		timeoutMs: positiveInt(r.timeout_ms, d.timeoutMs),
		autoApplyDev: bool(r.auto_apply_dev, d.autoApplyDev),
		roleFactsEnabled: bool(r.role_facts_enabled, d.roleFactsEnabled),
		sliceTurns: positiveInt(r.slice_turns, d.sliceTurns),
		staleAfterDays: positiveInt(r.stale_after_days, d.staleAfterDays),
		archiveAfterDays: positiveInt(r.archive_after_days, d.archiveAfterDays),
		duplicateThreshold: ratio(r.duplicate_threshold, d.duplicateThreshold),
		descriptionMaxChars: positiveInt(r.description_max_chars, d.descriptionMaxChars),
	};
}

/**
 * 从 YAML 加载。**文件不存在 / 解析失败 → 全默认**（不抛）。
 * 这与 `loadEvalCases` 的 fail-fast 是**故意相反**的：case 缺失会让评测给出假结论，
 * 必须炸；自进化配置缺失只是「这个旁路不开」，不该影响主链路。
 */
export function loadEvolutionConfig(path: string): EvolutionConfig {
	try {
		const file = parse(readFileSync(path, "utf-8")) as EvolutionFile | null;
		return normalizeEvolutionConfig(file?.evolution);
	} catch {
		return { ...DEFAULT_EVOLUTION_CONFIG };
	}
}
