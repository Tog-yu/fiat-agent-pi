/**
 * webhook payload → AlertEnvelope 适配层（阶段 13 / P13-76）—— 纯函数，零 Pi 依赖。
 *
 * fingerprint 生成规则（DEV_SPEC 阶段 13）：
 *   - 平台自带 dedup 键（fingerprint / dedup_key / alert_key）→ **透传**；
 *   - 否则 sha256(source|alertName|service|sorted(labels_json))。
 *     刻意**不含** timestamp / 实例 ip / 计数值：同一条告警的重试与重复通知哈希一致
 *     （命中幂等），换了实例或标签集变化 = 不同指纹（各自独立诊断）。
 *     labels 排序后序列化，避免字段顺序抖动造成指纹漂移。
 *
 * severity 归一化：severity 由**告警平台**判定随 payload 传入，网关只映射不判断：
 *   critical/fatal → P0，error/high → P1，warn → P2，info → P3；
 *   **缺省 / 未知 → P2 保守降级**（宁可少自动诊断，不可误触发烧 token）。
 *
 * 转换失败（缺 title 等必填项）明确报错，**不猜字段**。
 */

import { createHash } from "node:crypto";
import type { AlertEnvelope, AlertSeverity } from "./types.ts";

// ---------- severity 归一化 ----------

/** 平台词表 → 归一化级别；映射表可配（覆盖 SEMANTIC_MAP 的键即可） */
const SEMANTIC_MAP: Record<string, AlertSeverity> = {
	critical: "P0",
	fatal: "P0",
	emergency: "P0",
	error: "P1",
	high: "P1",
	major: "P1",
	warning: "P2",
	warn: "P2",
	minor: "P2",
	info: "P3",
	notice: "P3",
	low: "P3",
};

/** 已是 P0-P3 的直接通过（平台直接传级别的常见形态）；i 标志：先 toLowerCase 了 */
const LEVEL_RE = /^p[0-3]$/;

/** 缺省 / 未命中一律 P2 —— 保守降级，不猜 */
export function normalizeSeverity(raw: unknown): AlertSeverity {
	if (typeof raw === "string") {
		const s = raw.trim().toLowerCase();
		if (LEVEL_RE.test(s)) return s.toUpperCase() as AlertSeverity;
		const mapped = SEMANTIC_MAP[s];
		if (mapped) return mapped;
	}
	// 数字形态：0/1/2/3 → P0-P3（部分平台用数值级别）；其余一律 P2
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
		return `P${raw}` as AlertSeverity;
	}
	return "P2";
}

// ---------- fingerprint ----------

function stableLabels(labels: Record<string, string>): string {
	const keys = Object.keys(labels).sort();
	return JSON.stringify(keys.map((k) => [k, labels[k]]));
}

/** 本地指纹：source|alertName|service|sorted(labels)，竖线分隔防字段拼接歧义 */
export function localFingerprint(args: {
	source: string;
	alertName: string;
	service?: string;
	labels: Record<string, string>;
}): string {
	const parts = [args.source, args.alertName, args.service ?? "", stableLabels(args.labels)];
	return createHash("sha256").update(parts.join("|")).digest("hex");
}

// ---------- 适配器 ----------

export interface AdapterInput {
	/** 告警来源标识（网关配置 / 请求 query 带 source 时传入） */
	source: string;
	/** 平台原始 payload（JSON 已解析） */
	payload: Record<string, unknown>;
}

export type AlertAdapter = (input: AdapterInput) => AlertEnvelope;

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function labelsOf(payload: Record<string, unknown>): Record<string, string> {
	const raw = payload.labels;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			out[k] = String(v);
		}
	}
	return out;
}

/** alertName 参与指纹；平台没给就从 title 推（title 必填，见 validate） */
function alertNameOf(payload: Record<string, unknown>, title: string): string {
	return str(payload.alert_name) ?? str(payload.alertName) ?? str(payload.name) ?? title;
}

/**
 * 通用 JSON 适配器（首版，字段映射表驱动）。
 * 必填：title（或 message/summary/text 之一）；缺 → 抛错不猜。
 * 其余全部可选，缺省走保守路径（severity→P2 / fingerprint→本地算 / status→firing）。
 */
export const genericJsonAdapter: AlertAdapter = ({ source, payload }) => {
	const title =
		str(payload.title) ?? str(payload.message) ?? str(payload.summary) ?? str(payload.text) ?? str(payload.alert_name);
	if (!title) {
		throw new Error("payload 缺少告警标题（title/message/summary/text 之一），拒绝猜测字段");
	}

	const service =
		str(payload.service) ??
		(typeof payload.labels === "object" && payload.labels !== null
			? str((payload.labels as Record<string, unknown>).service)
			: undefined);
	const labels = labelsOf(payload);
	const alertName = alertNameOf(payload, title);
	const status = str(payload.status) === "resolved" ? "resolved" : "firing";

	// 平台自带 dedup 键 → 透传；否则本地算
	const platformFp =
		str(payload.fingerprint) ?? str(payload.dedup_key) ?? str(payload.dedupKey) ?? str(payload.alert_key);
	const fingerprint = platformFp ?? localFingerprint({ source, alertName, service, labels });

	const alert: AlertEnvelope["alert"] = { title };
	if (service) alert.service = service;
	const window = str(payload.window) ?? str(payload.time_window);
	if (window) alert.window = window;
	const detail = str(payload.detail) ?? str(payload.description);
	if (detail) alert.detail = detail;

	return {
		alertId: str(payload.alert_id) ?? str(payload.alertId) ?? `evt-${fingerprint.slice(0, 12)}`,
		fingerprint,
		severity: normalizeSeverity(payload.severity),
		firedAt: str(payload.fired_at) ?? str(payload.startsAt) ?? str(payload.starts_at) ?? new Date().toISOString(),
		status,
		source,
		alertName,
		labels,
		alert,
	};
};

/** 适配器注册表：接入新平台 = 加一个条目 + config/gateway.yaml 改 adapter 键 */
export const ADAPTERS: Record<string, AlertAdapter> = {
	"generic-json": genericJsonAdapter,
};

export function getAdapter(name: string): AlertAdapter {
	const adapter = ADAPTERS[name];
	if (!adapter) throw new Error(`未知适配器 "${name}"，可用：${Object.keys(ADAPTERS).join(", ")}`);
	return adapter;
}
