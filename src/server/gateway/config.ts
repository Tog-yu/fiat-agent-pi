/**
 * 网关配置加载（阶段 13 / P13-73）—— 纯逻辑，零 Pi 依赖。
 *
 * 口径对齐 `evolution/config.ts`：配置面 snake_case，类型面 camelCase，转换只在本文件。
 * **失败不炸**：文件缺失 / 字段非法回落 DEFAULT_GATEWAY_CONFIG 对应项 ——
 * 但 `token` 例外：它不是「缺省可容忍」项，加载结果里 token 为空时由 server.ts
 * **拒绝启动**（fail-fast），因为带鉴权的服务静默裸奔比起不来更危险。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type AlertSeverity, DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./types.ts";

interface GatewayFile {
	gateway?: Record<string, unknown>;
}

const SEVERITIES: readonly AlertSeverity[] = ["P0", "P1", "P2", "P3"];

function positiveInt(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function severityList(raw: unknown, fallback: AlertSeverity[]): AlertSeverity[] {
	if (!Array.isArray(raw)) return fallback;
	const out = raw.filter(
		(s): s is AlertSeverity => typeof s === "string" && (SEVERITIES as readonly string[]).includes(s),
	);
	return out.length > 0 ? out : fallback;
}

function string(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** 从已解析对象归一化（测试可直接喂对象） */
export function normalizeGatewayConfig(raw: unknown): GatewayConfig {
	const d = DEFAULT_GATEWAY_CONFIG;
	if (!raw || typeof raw !== "object") return { ...d, token: undefined };
	const r = raw as Record<string, unknown>;
	return {
		port: positiveInt(r.port, d.port),
		bind: "loopback",
		token: string(r.token),
		autoDiagnoseSeverities: severityList(r.auto_diagnose_severities, d.autoDiagnoseSeverities),
		dedupeTtlMinutes: positiveInt(r.dedupe_ttl_minutes, d.dedupeTtlMinutes),
		maxInflightPerService: positiveInt(r.max_inflight_per_service, d.maxInflightPerService),
		maxQueuePerService: positiveInt(r.max_queue_per_service, d.maxQueuePerService),
		maxBodyBytes: positiveInt(r.max_body_bytes, d.maxBodyBytes),
		adapter: string(r.adapter) ?? d.adapter,
	};
}

/** 从 YAML 加载。文件不存在 / 解析失败 → 全默认（token 仍为空 → server 拒绝启动） */
export function loadGatewayConfig(path: string): GatewayConfig {
	try {
		const file = parse(readFileSync(path, "utf-8")) as GatewayFile | null;
		return normalizeGatewayConfig(file?.gateway);
	} catch {
		return { ...DEFAULT_GATEWAY_CONFIG, token: undefined };
	}
}
