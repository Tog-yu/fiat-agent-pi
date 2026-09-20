/**
 * 告警网关执行链（阶段 13 / P13-79）—— 幂等 → 分级 → 限流 → 诊断 → 回写。
 *
 * 一句话口径：**网关只做「收、验、存、派」四件确定性的事，诊断逻辑一行不写**——
 * payload 转 AlertEnvelope 后复用既有 diagnosisPlan / runFanout / renderReport
 * 纯函数链（由 deps.diagnose 注入，通常是 CLI 的 makeDiagnose 或其变体），
 * 闸门与审计天然同链。写操作零例外走工单，本层绝不直接执行 L3+ 工具。
 *
 * 处理管线（对齐 P13-77/78 定稿口径）：
 *   1. store.findActive(fingerprint) 命中且非升级 → 只更 last_seen_at（deduped）
 *      —— severity 升级（P2→P0）视为新事件重新诊断，降级只记不改；
 *   2. resolved 推送 → 关闭活跃告警（resolved）；
 *   3. 新事件 → classify() 分级：manual_only 落库 + 摘要卡；auto_diagnose 进闸；
 *   4. InflightGate.tryAcquire：admit → 立即诊断（后台跑，finally release）；
 *      queued → 等待；throttled → 落库 throttledCount + 节流通知；
 *   5. dedupeTtlMinutes 兜底：本条推送到达时顺带清扫同 service 的过期 firing
 *      → stale（平台丢 resolved 的场景），此后同指纹再来按新事件处理。
 */

import { LANGFUSE_KEYS, OBS_TYPE } from "../tracing/otlp.ts";
import type { SpanHandle, TraceContext, Tracer, TracingWiring } from "../tracing/types.ts";
import { classify } from "./policy.ts";
import type {
	AlertEnvelope,
	AlertEventRecord,
	AlertSeverity,
	GatewayConfig,
	GatewayDeps,
	GatewayEvent,
	HandleAlertResult,
} from "./types.ts";

function nowIso(now: () => number): string {
	return new Date(now()).toISOString();
}

/** severity 升级判定：P0 < P1 < P2 < P3（数字越小级别越高） */
function severityRank(s: AlertSeverity): number {
	return Number(s.slice(1));
}

/** 摘要卡正文（P2/P3 / 人工介入入口） */
function renderSummary(env: AlertEnvelope): string {
	const lines = [`[${env.severity}] ${env.alert.title}`];
	if (env.alert.service) lines.push(`服务：${env.alert.service}`);
	lines.push(`状态：${env.status === "resolved" ? "已恢复" : "触发中"}　来源：${env.source}`);
	lines.push(`回复「诊断 ${env.fingerprint.slice(0, 12)}」让 Agent 立即并行诊断（只读取证）。`);
	return lines.join("\n");
}

export class AlertGateway {
	readonly #config: GatewayConfig;
	readonly #store: GatewayDeps["store"];
	readonly #diagnose?: NonNullable<GatewayDeps["diagnose"]>;
	readonly #notify: GatewayDeps["notify"];
	readonly #now: () => number;
	readonly #onEvent?: (event: GatewayEvent) => void;
	readonly #tracer?: Tracer;
	#sweepCounter = 0;

	constructor(deps: GatewayDeps) {
		this.#config = deps.config;
		this.#store = deps.store;
		this.#diagnose = deps.diagnose;
		this.#notify = deps.notify;
		this.#now = deps.now ?? Date.now;
		this.#onEvent = deps.onEvent;
		this.#tracer = deps.tracer;
	}

	#emit(event: GatewayEvent): void {
		this.#onEvent?.(event);
	}

	/** 子 span 便利入口；未开追踪 / 未采样 → undefined（调用点用 `?.`） */
	#span(
		ctx: TraceContext | undefined,
		root: SpanHandle | undefined,
		name: string,
		attrs: Record<string, string | number | boolean>,
	): SpanHandle | undefined {
		if (!ctx || !this.#tracer || !ctx.sampled) return undefined;
		return this.#tracer.startSpan(ctx, name, {
			kind: "internal",
			...(root ? { parentSpanId: root.spanId } : {}),
			attributes: { [LANGFUSE_KEYS.obsType]: OBS_TYPE.span, ...attrs },
		});
	}

	/**
	 * webhook 主入口：server.ts 鉴权 + 适配成功后调用。
	 * 返回记录 + 派发去向（HTTP 层据此回 200/202）。
	 * 抛错 = 适配层之外的问题（store 异常等），由 server 兜 500。
	 *
	 * 阶段 14（P14-89）：**一条告警 = 一条 trace**。根 span `fiat.alert.handle` 覆盖整条
	 * 处理链（去重 → 分级 → 派发 → 诊断），诊断蜂群的每个视角都长在它下面。
	 */
	async handleAlert(env: AlertEnvelope): Promise<HandleAlertResult> {
		const ctx = this.#tracer?.startTrace({
			name: "fiat.alert.handle",
			kind: "gateway",
			// sessionId 用 fingerprint：同一条告警的重复推送/升级在 Langfuse 里聚成一组
			sessionId: env.fingerprint,
			userId: env.source,
			extraTags: [env.severity, env.status],
			metadata: {
				fingerprint: env.fingerprint,
				source: env.source,
				severity: env.severity,
				service: env.alert.service ?? "",
			},
		});
		const root = ctx && this.#tracer ? this.#tracer.startRootSpan(ctx) : undefined;
		root?.setInput(env);
		try {
			const result = await this.#handle(env, ctx, root);
			root?.setAttribute("fiat.gateway.outcome", result.outcome);
			root?.setAttribute("fiat.gateway.diagnosis_dispatched", result.diagnosisDispatched);
			root?.setStatus("ok");
			root?.setOutput({ outcome: result.outcome, diagnosisDispatched: result.diagnosisDispatched });
			return result;
		} catch (error) {
			root?.setStatus("error", error instanceof Error ? error.message : String(error));
			// 网关单请求异常不影响主监听（P13-74），但要留痕——否则 trace 列表里凭空少一条
			throw error;
		} finally {
			root?.end();
		}
	}

	async #handle(
		env: AlertEnvelope,
		ctx: TraceContext | undefined,
		root: SpanHandle | undefined,
	): Promise<HandleAlertResult> {
		await this.#sweepStaleIfNeeded();

		const ts = nowIso(this.#now);
		const dedupe = this.#span(ctx, root, "fiat.alert.dedupe", {
			"fiat.alert.fingerprint": env.fingerprint,
			"fiat.alert.status": env.status,
			"fiat.alert.severity": env.severity,
		});
		const active = await this.#store.findActive(env.fingerprint);
		dedupe?.setAttribute("fiat.alert.dedupe_hit", active !== null);
		dedupe?.setStatus("ok");
		dedupe?.end();

		// resolved：关闭活跃告警（无活跃记录也接受 —— 平台可能重复恢复）
		if (env.status === "resolved") {
			if (active) {
				const closed: AlertEventRecord = { ...active, status: "resolved", lastSeenAt: ts };
				await this.#store.update(closed);
				this.#emit({ kind: "resolved", fingerprint: env.fingerprint });
				return { record: closed, outcome: "resolved", diagnosisDispatched: false };
			}
			// 无活跃记录的 resolved：落一条已恢复记录，保证审计连续
			const record: AlertEventRecord = {
				id: crypto.randomUUID(),
				fingerprint: env.fingerprint,
				status: "resolved",
				severity: env.severity,
				envelopeJson: JSON.stringify(env),
				createdAt: ts,
				lastSeenAt: ts,
				throttledCount: 0,
			};
			await this.#store.insert(record);
			this.#emit({ kind: "resolved", fingerprint: env.fingerprint });
			return { record, outcome: "resolved", diagnosisDispatched: false };
		}

		// firing 命中活跃记录 → 幂等（升级特例除外）
		if (active) {
			if (severityRank(env.severity) < severityRank(active.severity)) {
				// 升级：P2 → P0 等，视为新事件重新诊断
				const escalated: AlertEventRecord = {
					...active,
					severity: env.severity,
					envelopeJson: JSON.stringify(env),
					lastSeenAt: ts,
				};
				await this.#store.update(escalated);
				this.#emit({
					kind: "severity_escalated",
					fingerprint: env.fingerprint,
					from: active.severity,
					to: env.severity,
				});
				return this.#dispatch(escalated, env, ctx, root);
			}
			// 同级 / 降级：只更 last_seen_at，不重复诊断
			const refreshed: AlertEventRecord = { ...active, lastSeenAt: ts };
			await this.#store.update(refreshed);
			this.#emit({ kind: "deduped", fingerprint: env.fingerprint });
			return { record: refreshed, outcome: "deduped", diagnosisDispatched: false };
		}

		// 全新事件：INSERT + 分级
		const record: AlertEventRecord = {
			id: crypto.randomUUID(),
			fingerprint: env.fingerprint,
			status: "firing",
			severity: env.severity,
			envelopeJson: JSON.stringify(env),
			createdAt: ts,
			lastSeenAt: ts,
			throttledCount: 0,
		};
		await this.#store.insert(record);
		return this.#dispatch(record, env, ctx, root);
	}

	/** 分级派发：manual_only → 摘要卡；auto_diagnose → 诊断（未注入 diagnose 则降级摘要卡） */
	#dispatch(
		record: AlertEventRecord,
		env: AlertEnvelope,
		ctx: TraceContext | undefined,
		root: SpanHandle | undefined,
	): HandleAlertResult {
		const action = classify(env.severity, this.#config.autoDiagnoseSeverities);
		// 分级是纯函数决策，单独出 span：排障时「为什么这条 P0 没自动诊断」第一个要看的
		// 就是 classify 的入参（severity）与配置（autoDiagnoseSeverities 命中与否）
		const cls = this.#span(ctx, root, "fiat.alert.classify", {
			"fiat.alert.severity": env.severity,
			"fiat.alert.action": action,
			"fiat.gateway.diagnose_injected": Boolean(this.#diagnose),
		});
		cls?.setStatus("ok");
		cls?.end();

		if (action !== "auto_diagnose" || !this.#diagnose) {
			this.#emit({ kind: "accepted", fingerprint: env.fingerprint, severity: env.severity, action: "manual_only" });
			void this.#notify.send({
				kind: "summary",
				fingerprint: env.fingerprint,
				severity: env.severity,
				text: renderSummary(env),
			});
			return { record, outcome: "accepted", diagnosisDispatched: false };
		}

		this.#emit({ kind: "accepted", fingerprint: env.fingerprint, severity: env.severity, action: "auto_diagnose" });
		// 诊断后台跑：webhook 立即返回（告警平台有超时重试，同步跑会放大风暴）。
		// 注意这里**不关根 span**——根 span 由 handleAlert 的 finally 收口，而诊断是
		// fire-and-forget 的后台任务，它的 span 挂在已关的根上仍是合法子节点（OTLP 允许后到的子 span）。
		void this.#runDiagnosis(record, env, ctx, root).catch(() => {});
		return { record, outcome: "accepted", diagnosisDispatched: true };
	}

	/** 执行一次诊断：P13-79 执行链 + 回写 + 通知。调用方保证异常被兜住。 */
	async #runDiagnosis(
		record: AlertEventRecord,
		env: AlertEnvelope,
		ctx: TraceContext | undefined,
		root: SpanHandle | undefined,
	): Promise<void> {
		if (!this.#diagnose) return; // 调用方 #dispatch 已保证 diagnose 存在；防御双保险
		const diagnose = this.#diagnose;
		const span = this.#span(ctx, root, "fiat.alert.diagnose", {
			"fiat.alert.fingerprint": env.fingerprint,
			"fiat.alert.severity": env.severity,
		});
		// 把**同一条 trace 的 ctx** 交给诊断执行链：蜂群的每个视角都挂在这条 trace 下
		const wiring: TracingWiring | undefined =
			ctx && this.#tracer
				? { tracer: this.#tracer, trace: ctx, ...(root ? { parentSpanId: root.spanId } : {}) }
				: undefined;
		try {
			const { sessionId, report } = await diagnose(env, wiring);
			const ts = nowIso(this.#now);
			await this.#store.update({ ...record, diagnosisSessionId: sessionId, lastDiagnosisAt: ts });
			this.#emit({ kind: "diagnosis_done", fingerprint: env.fingerprint, sessionId });
			span?.setAttribute("fiat.diagnosis.session_id", sessionId);
			span?.setOutput(report);
			span?.setStatus("ok");
			const header = `[${env.severity}] ${env.alert.title}\n诊断会话 ${sessionId}\n---\n`;
			void this.#notify.send({
				kind: "report",
				fingerprint: env.fingerprint,
				severity: env.severity,
				text: header,
				report,
			});
		} catch (e) {
			span?.setStatus("error", e instanceof Error ? e.message : String(e));
			this.#emit({
				kind: "diagnosis_failed",
				fingerprint: env.fingerprint,
				error: e instanceof Error ? e.message : String(e),
			});
			// 失败也通知：绝不把「诊断挂了」伪装成「没问题」
			void this.#notify.send({
				kind: "summary",
				fingerprint: env.fingerprint,
				severity: env.severity,
				text: `[${env.severity}] ${env.alert.title}\n自动诊断失败，请人工介入。`,
			});
			throw e; // 交给调用方 catch(() => {}) 兜底；事件已 emit
		} finally {
			span?.end();
		}
	}

	/**
	 * stale 清扫（P13-77 兜底）：每 20 条推送触发一次全表扫（量级 ≤ 千，扫表成本低），
	 * firing 且 last_seen_at 距今超过 dedupeTtlMinutes → stale。
	 */
	async #sweepStaleIfNeeded(): Promise<void> {
		this.#sweepCounter += 1;
		if (this.#sweepCounter % 20 !== 1) return;
		const cutoff = this.#now() - this.#config.dedupeTtlMinutes * 60_000;
		for (const r of await this.#store.list()) {
			if (r.status !== "firing") continue;
			if (new Date(r.lastSeenAt).getTime() >= cutoff) continue;
			await this.#store.update({ ...r, status: "stale" });
			this.#emit({ kind: "staled", fingerprint: r.fingerprint });
		}
	}
}

/** 限流闸接线：gate 由 server 层持有，诊断结束时 release 并弹出下一个排队项 */
export function nextQueuedAfterRelease(gate: import("./policy.ts").InflightGate, service: string): string | undefined {
	return gate.release(service);
}
