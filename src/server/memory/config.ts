/**
 * memory/config —— 长期记忆配置加载（P15-92）—— 纯逻辑，零 Pi 依赖。
 *
 * 口径对齐 `evolution/config.ts` + `tracing/config.ts`（配置面 snake_case、类型面 camelCase、
 * 转换只在本文件里做），但**失败策略是刻意选的第四种**：
 *
 *   - `evolution/config.ts`：文件缺失 / 字段非法 → **全默认**（自进化是旁路）
 *   - `tracing/config.ts`   ：**开**追踪时任何一项配错都抛；**关**时宽容到底
 *   - `gateway/config.ts`   ：字段非法回落默认；**token 为空则由 server 拒绝启动**
 *   - 本文件                ：**关**记忆时宽容到底；**开**记忆时字段非法即抛
 *
 * 为什么与 tracing 同款而不是与 evolution 同款：两者的风险面形状一致 ——
 * 「开了却不工作」比「起不来」更难查。而记忆比追踪还多一层：追踪的错误面是
 * 「观测数据缺失」（不影响用户），记忆的错误面是**此后所有会话都在注入的一条假事实**
 * （§15.9）。一个 `min_confidence` 被写成 `"0.6"` 之外的东西却静默回落成默认值，
 * 表现就是「策略以为自己在拦，其实没拦」。
 *
 * 而**关记忆时**（缺省）必须宽容：`config/memory.yaml` 缺失 / 写坏不该让
 * `fiat chat` 起不来 —— 硬约束 7 要求的「现有测试零改动」正落在这条路径上。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// 复用 tracing 的 `${VAR:-default}` 插值：它已经是本仓该语法的单一事实源
// （`config/settings.yaml` / `config/tracing.yaml` 都靠它）。重写一份必然在
// 「变量为空串算不算有值」这类细节上漂移，而那正是 `enabled` 开关的判定点。
import { interpolate } from "../tracing/config.ts";
import { DEFAULT_MEMORY_CONFIG, MEMORY_KINDS, type MemoryConfig, type MemoryKind } from "./types.ts";

interface MemoryFile {
	memory?: Record<string, unknown>;
}

export class MemoryConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryConfigError";
	}
}

/** 缺省配置文件位置（按模块位置解析，不依赖 cwd） */
export const DEFAULT_MEMORY_CONFIG_PATH = fileURLToPath(new URL("../../../config/memory.yaml", import.meta.url));

type Env = Record<string, string | undefined>;

/** 认不出来的布尔值抛错而不是回落 —— 与 tracing 同口径（开关写错最不该静默） */
function boolValue(raw: unknown, env: Env, fallback: boolean, key: string): boolean {
	if (typeof raw === "boolean") return raw;
	const s = interpolate(raw, env);
	if (s === undefined) return fallback;
	const v = s.toLowerCase();
	if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
	if (v === "false" || v === "0" || v === "no" || v === "off") return false;
	throw new MemoryConfigError(`${key} 需要布尔值，收到：${s}`);
}

function positiveInt(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 0..1 的比值（阈值类） */
function ratio(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function record(raw: unknown): Record<string, unknown> | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/**
 * 从已解析对象归一化（测试可直接喂对象）。
 *
 * `strict` = 是否在非法值上抛错。**由 `enabled` 自己决定**：
 * 关记忆时走宽容路径（回落默认），开记忆时走严格路径（抛）。
 * 这个「先算 enabled、再决定其余字段怎么处理」的顺序不是巧合 ——
 * 否则关记忆状态下也会因为一个无关字段写坏而起不来，违反硬约束 7。
 */
export function normalizeMemoryConfig(raw: unknown, env: Env = process.env): MemoryConfig {
	const d = DEFAULT_MEMORY_CONFIG;
	const r = record(raw);
	if (!r) return { ...d };

	// 开关必须先算：它决定后面所有字段是「宽容回落」还是「非法即抛」
	const enabled = boolValue(r.enabled, env, d.enabled, "memory.enabled");
	const strict = enabled;
	const bad = (message: string): never => {
		throw new MemoryConfigError(message);
	};

	const triggerRaw = record(r.trigger) ?? {};
	const extractRaw = record(r.extract) ?? {};
	const writeRaw = record(r.write) ?? {};
	const promoteRaw = record(r.promote) ?? {};
	const readRaw = record(r.read) ?? {};
	const retentionRaw = record(r.retention) ?? {};

	const minConfidence = ratio(writeRaw.min_confidence, d.write.minConfidence);

	// 只有「开记忆 + 值非法」才抛。判据是「原值存在但不是合法数值」——
	// 字段缺失走默认（那是正常的「不配就用缺省」），字段写错才是配置错误。
	if (strict && writeRaw.min_confidence !== undefined && minConfidence !== writeRaw.min_confidence) {
		bad(`memory.write.min_confidence 必须在 [0, 1] 内，收到：${String(writeRaw.min_confidence)}`);
	}
	const maxTextChars = positiveInt(writeRaw.max_text_chars, d.write.maxTextChars);
	if (strict && writeRaw.max_text_chars !== undefined && maxTextChars !== writeRaw.max_text_chars) {
		bad(`memory.write.max_text_chars 必须是正整数，收到：${String(writeRaw.max_text_chars)}`);
	}

	const hotKindsRaw = readRaw.hot_kinds;
	let hotKinds: MemoryKind[] = [...d.read.hotKinds];
	if (Array.isArray(hotKindsRaw)) {
		const parsed = hotKindsRaw.filter((k): k is MemoryKind => MEMORY_KINDS.includes(k as MemoryKind));
		if (strict && parsed.length !== hotKindsRaw.length) {
			bad(`memory.read.hot_kinds 含未知 kind：${JSON.stringify(hotKindsRaw)}（合法值：${MEMORY_KINDS.join(" | ")}）`);
		}
		hotKinds = parsed.length > 0 ? parsed : [...d.read.hotKinds];
	}

	return {
		enabled,
		trigger: {
			onCorrectionSignal: boolValue(
				triggerRaw.on_correction_signal,
				env,
				d.trigger.onCorrectionSignal,
				"memory.trigger.on_correction_signal",
			),
			minTurns: positiveInt(triggerRaw.min_turns, d.trigger.minTurns),
			atSessionEnd: boolValue(triggerRaw.at_session_end, env, d.trigger.atSessionEnd, "memory.trigger.at_session_end"),
			maxRunsPerSession: positiveInt(triggerRaw.max_runs_per_session, d.trigger.maxRunsPerSession),
		},
		extract: {
			timeoutMs: positiveInt(extractRaw.timeout_ms, d.extract.timeoutMs),
			sliceTurns: positiveInt(extractRaw.slice_turns, d.extract.sliceTurns),
		},
		write: {
			minConfidence,
			maxTextChars,
			maxPerRun: positiveInt(writeRaw.max_per_run, d.write.maxPerRun),
		},
		promote: {
			promotionThreshold: positiveInt(promoteRaw.promotion_threshold, d.promote.promotionThreshold),
			similarityFloor: ratio(promoteRaw.similarity_floor, d.promote.similarityFloor),
		},
		read: {
			hotInjectionMaxEntries: positiveInt(readRaw.hot_injection_max_entries, d.read.hotInjectionMaxEntries),
			hotInjectionMaxChars: positiveInt(readRaw.hot_injection_max_chars, d.read.hotInjectionMaxChars),
			defaultTopK: positiveInt(readRaw.default_top_k, d.read.defaultTopK),
			hotKinds,
		},
		retention: {
			referenceTtlDays: positiveInt(retentionRaw.reference_ttl_days, d.retention.referenceTtlDays),
			projectTtlDays: positiveInt(retentionRaw.project_ttl_days, d.retention.projectTtlDays),
		},
	};
}

/**
 * 从 YAML 加载。
 *
 * 文件**读不到** → 全默认（含 `enabled=false`），不抛：配置缺失 = 这个旁路不开，
 * 与 `loadEvolutionConfig` 同一处置。而文件**能读到但内容非法**时，
 * 由 `normalizeMemoryConfig` 按 `enabled` 决定宽容还是抛 —— 两者是不同的失效原因，
 * 不该共用一套处置。
 */
export function loadMemoryConfig(path: string, env: Env = process.env): MemoryConfig {
	let raw: unknown;
	try {
		const file = parse(readFileSync(path, "utf-8")) as MemoryFile | null;
		raw = file?.memory;
	} catch {
		return { ...DEFAULT_MEMORY_CONFIG };
	}
	return normalizeMemoryConfig(raw, env);
}
