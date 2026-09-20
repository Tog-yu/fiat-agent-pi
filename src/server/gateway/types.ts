/**
 * 告警 webhook 网关契约（阶段 13 / P13-73）—— 纯类型与默认值，零 Pi 依赖。
 *
 * 设计依据：DEV_SPEC.md §8 阶段 13（参考 OpenClaw gateway hooks —— docs/gateway/index.md
 * 「Runtime model」+ docs/automation/cron-jobs.md「Webhooks」）。
 *
 * 核心口径：
 *   - **AlertInput 4 字段契约不动**（diagnosis/plan.ts:17）。它是给模型看的压缩视图；
 *     结构化字段（alert_id / severity / fingerprint / fired_at…）只存在于本文件的
 *     AlertEnvelope 信封与 store 持久化层，绝不污染纯函数诊断链。
 *   - severity 由**告警平台**判定并随 payload 传入，网关只做映射归一（adapters.ts），
 *     本层只认归一化后的 "P0"|"P1"|"P2"|"P3"。
 *   - 配置面 snake_case（给人编辑，对齐 evolution.yaml 口径），类型面 camelCase，
 *     转换只发生在 config.ts 的 normalize。
 */

import type { AlertInput } from "../diagnosis/plan.ts";
import type { Tracer, TracingWiring } from "../tracing/types.ts";

/** 归一化后的告警级别（P0 最高） */
export type AlertSeverity = "P0" | "P1" | "P2" | "P3";

/** 告警生命周期：firing 活跃 / resolved 平台恢复 / stale 超时兜底（P13-77） */
export type AlertStatus = "firing" | "resolved" | "stale";

/** 被限流闸处理后的派发结果（P13-78） */
export type ThrottleVerdict = "admit" | "queued" | "throttled";

/**
 * 告警信封：webhook 侧的结构化视图。
 * `alert` 字段就是既有 AlertInput —— 诊断链消费的只有它。
 */
export interface AlertEnvelope {
	/** 平台侧告警 ID（透传，仅落库与展示用） */
	alertId: string;
	/**
	 * 幂等键（P13-76 生成规则）：平台自带则透传；否则
	 * sha256(source|alertName|service|sorted(labels))，刻意不含时间戳/实例/计数值。
	 */
	fingerprint: string;
	severity: AlertSeverity;
	/** 平台侧触发时间（ISO 8601） */
	firedAt: string;
	status: AlertStatus;
	/** 告警来源标识（如 "alertmanager" / "lighthouse"），参与 fingerprint */
	source: string;
	/** 告警名（如 "HighErrorRate"），参与 fingerprint */
	alertName: string;
	/** 标签集（排序后参与 fingerprint；展示用） */
	labels: Record<string, string>;
	/** 给模型看的压缩视图（title 必填；service/window/detail 可选） */
	alert: AlertInput;
}

/** severity → 是否自动诊断 的派发动作（P13-78 classify 输出） */
export type DispatchAction = "auto_diagnose" | "manual_only";

/** 单条落库记录（对应 fiat_alert_event 表 / P13-77） */
export interface AlertEventRecord {
	id: string;
	fingerprint: string;
	status: AlertStatus;
	severity: AlertSeverity;
	/** 完整信封 JSON（含 AlertInput），重诊与审计用 */
	envelopeJson: string;
	/** 首次触发该诊断的会话 ID；未诊断为 undefined */
	diagnosisSessionId?: string;
	createdAt: string;
	lastSeenAt: string;
	lastDiagnosisAt?: string;
	/** 限流溢出标记：队列满被节流的次数（>0 即被节流过，绝不静默丢弃） */
	throttledCount: number;
}

// ---------- 配置（config/gateway.yaml ↔ config.ts normalize） ----------

export interface GatewayConfig {
	port: number;
	/** 目前只支持 loopback（硬约束 2：暴露给告警平台须走 reverse proxy，不做内建 TLS） */
	bind: "loopback";
	/** 独立 hook token；为空 = 网关拒绝启动（fail-fast，不复用任何既有凭据） */
	token?: string;
	/** 自动触发并行诊断的级别；缺省 P0/P1 */
	autoDiagnoseSeverities: AlertSeverity[];
	/** firing 无后续推送超过该分钟数 → stale（P13-77 兜底，平台丢 resolved 场景） */
	dedupeTtlMinutes: number;
	/** per-service 并发诊断上限（P13-78 inflight 计数器）；超了进有界队列 */
	maxInflightPerService: number;
	/** per-service 等待队列长度；队列满 → throttled 留痕 */
	maxQueuePerService: number;
	/** 单请求体上限（字节） */
	maxBodyBytes: number;
	/** webhook payload → AlertEnvelope 的适配器名（adapters.ts 注册表键） */
	adapter: string;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
	port: 18800,
	bind: "loopback",
	token: undefined,
	autoDiagnoseSeverities: ["P0", "P1"],
	dedupeTtlMinutes: 120,
	maxInflightPerService: 2,
	maxQueuePerService: 16,
	maxBodyBytes: 64 * 1024,
	adapter: "generic-json",
};

/** 网关运行时需要外部注入的能力（CLI 装配时接线；测试注入 stub） */
export interface GatewayDeps {
	config: GatewayConfig;
	/** 幂等与持久化（P13-77 store.ts） */
	store: AlertEventStore;
	/** 自动诊断执行器（P13-79 runner 接线；缺省 = 仅落库 + 通知，便于离线测试） */
	diagnose?: (input: AlertEnvelope, tracing?: TracingWiring) => Promise<{ sessionId: string; report: string }>;
	/** 回推通道（P13-80 notify.ts；测试注入 stub 收集调用） */
	notify: AlertNotifier;
	/**
	 * 阶段 14（P14-89）：追踪器。**缺省 undefined = 不开**。
	 *
	 * 传 `Tracer` 而不是 `TracingWiring`：网关是**长驻进程**，「一条告警」才是链路边界，
	 * 所以 trace 必须在 `handleAlert` 里**每条现开**——这与 chat（一个进程一个会话、wiring 固定）
	 * 是不同的生命周期，用同一种入参会把两种语义搅在一起。
	 */
	tracer?: Tracer;
	/** 时钟注入 */
	now?: () => number;
	/** 诊断结束回调（回收 inflight 计数在 runner 内部做，这里供测试断言） */
	onEvent?: (event: GatewayEvent) => void;
}

/** 网关内部事件（onEvent 回调载荷 / 测试断言用） */
export type GatewayEvent =
	| { kind: "accepted"; fingerprint: string; severity: AlertSeverity; action: DispatchAction }
	| { kind: "deduped"; fingerprint: string }
	| { kind: "severity_escalated"; fingerprint: string; from: AlertSeverity; to: AlertSeverity }
	| { kind: "staled"; fingerprint: string }
	| { kind: "resolved"; fingerprint: string }
	| { kind: "queued"; fingerprint: string; service: string }
	| { kind: "throttled"; fingerprint: string; service: string }
	| { kind: "diagnosis_done"; fingerprint: string; sessionId: string }
	| { kind: "diagnosis_failed"; fingerprint: string; error: string };

// ---------- 存储契约（P13-77 实现；对齐 approval/ticket.ts 的接口 + InMemory 模式） ----------

export interface AlertEventStore {
	/** 幂等查询：同 fingerprint 且 status=firing 的活跃事件（最多一条） */
	findActive(fingerprint: string): Promise<AlertEventRecord | null>;
	insert(record: AlertEventRecord): Promise<void>;
	update(record: AlertEventRecord): Promise<void>;
	/** 按 ID 取（诊断回写 diagnosis_session_id 用） */
	get(id: string): Promise<AlertEventRecord | null>;
	/** 全量列出（CLI / 测试断言；创建时间倒序） */
	list(): Promise<AlertEventRecord[]>;
}

// ---------- 通知契约（P13-80 实现） ----------

export interface AlertNotice {
	/** summary 卡（P2/P3 或诊断报告头）：一句话让人决定要不要介入 */
	kind: "summary" | "report" | "throttled";
	fingerprint: string;
	severity: AlertSeverity;
	/** 卡片正文（Markdown 明文） */
	text: string;
	/** report 卡附带完整诊断报告 */
	report?: string;
}

export interface AlertNotifier {
	send(notice: AlertNotice): Promise<{ messageId: string }>;
}

/** handleAlert 结果：记录 + 派发去向（HTTP 层据此回 200/202，不做启发式猜测） */
export interface HandleAlertResult {
	record: AlertEventRecord;
	/** deduped = 同指纹重复推送只更 last_seen_at；resolved = 恢复闭环；accepted = 新事件已按级别派发 */
	outcome: "deduped" | "resolved" | "accepted";
	/** accepted 且 auto_diagnose = 诊断已异步受理（HTTP 回 202），其余回 200 */
	diagnosisDispatched: boolean;
}
