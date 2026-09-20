/**
 * 追踪配置加载（阶段 14 / P14-82）—— 纯逻辑，零 Pi 依赖。
 *
 * 口径对齐 `gateway/config.ts` + `evolution/config.ts`：配置面 snake_case、类型面 camelCase，
 * 转换只在本文件里做。但**失败策略与两者都不同**，是刻意选的第三种：
 *
 *   - `evolution/config.ts`：文件缺失 / 字段非法 → **全默认**（自进化是旁路，配错不该让 chat 起不来）
 *   - `gateway/config.ts`：字段非法 → 回落默认；**token 为空则由 server 拒绝启动**（fail-fast）
 *   - 本文件：**开追踪**时任何一项配错都直接抛（fail-fast）；**关追踪**时（缺省）宽容到底
 *
 * 理由：tracking 一旦「配置写错但悄悄不工作」，排查成本远高于起不来——你会以为链路没数据是
 * 业务没跑，实际是上报端点在静默失败。这与「带鉴权的服务静默裸奔比起不来更危险」是同一条逻辑。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type CaptureContent, DEFAULT_TRACING_CONFIG, type TraceKind, type TracingConfig } from "./types.ts";

interface TracingFile {
	tracing?: Record<string, unknown>;
}

export class TracingConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TracingConfigError";
	}
}

export const TRACE_KINDS: readonly TraceKind[] = ["chat", "gateway", "diagnose", "ci", "evolution"];
const CAPTURE_MODES: readonly CaptureContent[] = ["off", "redacted", "full"];

type Env = Record<string, string | undefined>;

/** `${VAR}` / `${VAR:-default}` 插值；无匹配 / 变量缺失且无默认 → 返回 undefined（让调用方回落默认） */
export function interpolate(raw: unknown, env: Env): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/.exec(trimmed);
	if (!exact) return trimmed;
	const [, name, fallback] = exact;
	const value = env[name as string];
	if (value !== undefined && value !== "") return value;
	return fallback !== undefined && fallback !== "" ? fallback : undefined;
}

/**
 * 布尔归一化。`enabled: ${FIAT_TRACING_ENABLED:-false}` 插值后是**字符串**，
 * 所以这里要同时吃 boolean 与 true/false/1/0/yes/no/on/off 文本；
 * 认不出来的值抛错而不是回落默认——开了追踪却把开关写错，是最不该静默的一类错。
 */
function boolValue(raw: unknown, env: Env, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	const s = interpolate(raw, env);
	if (s === undefined) return fallback;
	const v = s.toLowerCase();
	if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
	if (v === "false" || v === "0" || v === "no" || v === "off") return false;
	throw new TracingConfigError(`tracing.enabled 需要布尔值，收到：${s}`);
}

function positiveInt(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function record(raw: unknown): Record<string, unknown> | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/**
 * 从已解析对象归一化（测试可直接喂对象）。
 * `env` 用于 `${VAR:-default}` 插值（默认 `process.env`）。
 * 违反契约的值**抛 `TracingConfigError`**，不静默回落。
 */
export function normalizeTracingConfig(raw: unknown, env: Env = process.env): TracingConfig {
	const d = DEFAULT_TRACING_CONFIG;
	const r = record(raw);
	if (!r) return { ...d };

	const enabled = boolValue(r.enabled, env, d.enabled);
	const endpoint = interpolate(r.endpoint, env) ?? d.endpoint;
	const ingestionVersion = interpolate(r.ingestion_version, env) ?? d.ingestionVersion;
	const serviceName = interpolate(r.service_name, env) ?? d.serviceName;
	const publicKeyEnv = interpolate(r.public_key_env, env) ?? d.publicKeyEnv;
	const secretKeyEnv = interpolate(r.secret_key_env, env) ?? d.secretKeyEnv;

	if (!/^https?:\/\//.test(endpoint)) {
		throw new TracingConfigError(`tracing.endpoint 必须以 http(s):// 开头，收到：${endpoint}`);
	}

	const captureRaw = interpolate(r.capture_content, env) ?? d.captureContent;
	if (!(CAPTURE_MODES as readonly string[]).includes(captureRaw)) {
		throw new TracingConfigError(
			`tracing.capture_content 必须是 ${CAPTURE_MODES.join(" | ")} 之一，收到：${captureRaw}`,
		);
	}
	const captureContent = captureRaw as CaptureContent;

	const sampleRate: Record<TraceKind, number> = { ...d.sampleRate };
	const rateRaw = record(r.sample_rate);
	if (rateRaw) {
		for (const kind of TRACE_KINDS) {
			const v = rateRaw[kind];
			if (v === undefined) continue;
			const n = typeof v === "number" ? v : Number(v);
			if (!Number.isFinite(n) || n < 0 || n > 1) {
				throw new TracingConfigError(`tracing.sample_rate.${kind} 必须在 [0, 1] 内，收到：${String(v)}`);
			}
			sampleRate[kind] = n;
		}
	}

	const redactRaw = r.redact_keys;
	const redactKeys = Array.isArray(redactRaw)
		? redactRaw.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim())
		: [...d.redactKeys];

	const batchRaw = record(r.batch) ?? {};
	const batch = {
		maxQueue: positiveInt(batchRaw.max_queue, d.batch.maxQueue),
		maxBatch: positiveInt(batchRaw.max_batch, d.batch.maxBatch),
		flushIntervalMs: positiveInt(batchRaw.flush_interval_ms, d.batch.flushIntervalMs),
		maxRetries: positiveInt(batchRaw.max_retries, d.batch.maxRetries),
		timeoutMs: positiveInt(batchRaw.timeout_ms, d.batch.timeoutMs),
	};

	const cfg: TracingConfig = {
		enabled,
		provider: "langfuse",
		endpoint,
		publicKeyEnv,
		secretKeyEnv,
		ingestionVersion,
		serviceName,
		captureContent,
		redactKeys,
		sampleRate,
		batch,
	};

	// fail-fast（硬约束 4）：开了追踪就必须拿得到凭据，绝不静默降级成「追踪悄悄不工作」。
	if (cfg.enabled && !resolveTracingCredentials(cfg, env)) {
		throw new TracingConfigError(
			`tracing.enabled=true 但凭据缺失：需要环境变量 ${cfg.publicKeyEnv} 与 ${cfg.secretKeyEnv}`,
		);
	}
	return cfg;
}

/**
 * 解析 Basic auth 凭据。**只从环境变量读值**——配置文件里只有变量名（硬约束 4）。
 * 任一缺失 → undefined（由 normalize 决定是否 fail-fast；client 侧则视为不可上报）。
 */
export function resolveTracingCredentials(
	cfg: TracingConfig,
	env: Env = process.env,
): { publicKey: string; secretKey: string } | undefined {
	const publicKey = env[cfg.publicKeyEnv];
	const secretKey = env[cfg.secretKeyEnv];
	if (!publicKey || !secretKey) return undefined;
	return { publicKey, secretKey };
}

/** 从 YAML 加载。文件缺失 / 解析失败 → 全默认（`enabled=false`，不抛） */
export function loadTracingConfig(path: string, env: Env = process.env): TracingConfig {
	let raw: unknown;
	try {
		const file = parse(readFileSync(path, "utf-8")) as TracingFile | null;
		raw = file?.tracing;
	} catch {
		return { ...DEFAULT_TRACING_CONFIG };
	}
	return normalizeTracingConfig(raw, env);
}
