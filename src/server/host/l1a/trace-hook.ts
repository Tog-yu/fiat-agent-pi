/**
 * trace-hook —— L1a 内建 extension（阶段 14 / P14-86），全链路追踪的采集层。
 *
 * 与另外四个 L1a 钩子的分工：
 *   permission-gate 负责**挡**、audit-hook 负责**记**、eval-recorder 负责**量**、
 *   evolution-trigger 负责**触发反思**，trace-hook 负责**看见**——把一次执行摊平成
 *   Langfuse 里的一棵树（generation / tool / 耗时 / token）。
 *
 * ── ⚠️ 采集口径：被 block 的调用收不到钩子（同一个坑，但处置与 eval-recorder 不同）──────
 * `ExtensionRunner.emitToolCall` 对 block 请求**短路返回**（runner.js:639-657），
 * 排在 factories 尾部的扩展收不到被拦调用的 `tool_call`；且被拦不产生 `tool_result`
 * （阶段 11 已实测）。eval-recorder 的处置是**彻底绕开** tool_call/tool_result，只认 `turn_end`；
 * trace-hook **两者都要**：
 *
 *   1. `tool_call`     → 开 tool span（此刻已知 args；**能进到这里本身就等价于闸门②放行**）
 *   2. `tool_result`   → 关 tool span（补结果 / isError / 耗时）
 *   3. `turn_end`      → **对账**：`toolResults` 里没有对应已开 span 的调用，就是被闸门②拦下的
 *                        （或闸门①裁掉后模型猜名调用命中 "Tool x not found"），补一条瞬时
 *                        span 并标 `fiat.gate.tool_call="block"`、level=WARNING
 *
 * 为什么是"对账"而不是"兜底"：**被拦的尝试和成功的调用一样值得被看见**。
 * 「这个模型一晚上猜了 40 次 fiat_job_apply」只在对账口径下才可见——它是安全信号，
 * 不是噪声。反过来只靠第 3 步也不行：那样会丢掉 args 与真实耗时。
 *
 * ── 硬约束（阶段 14 第 1 条）────────────────────────────────────
 * **只读不拦**：只订阅、绝不返回 `block`、绝不改写 `event.input` / `event.content`。
 * 唯一的副作用是 span 入队，且发生在 `end()` 之后。
 *
 * fail-safe：没传 wiring 就不注册（`factory.ts` 组合根控制）——符合本项目
 * 「注入式 + 缺依赖不注册」的通用模式，现有测试零改动。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LANGFUSE_KEYS, OBS_TYPE } from "../../tracing/otlp.ts";
import { resolveTracing, type SpanHandle, type TracingSource, type TracingWiring } from "../../tracing/types.ts";

/**
 * 会话构建事实（`fiat.gate.build` 的载荷）。
 *
 * 为什么由本钩子代发、而不是组合根构建时直接发：chat 是 **per-turn trace**，
 * 而 `buildSession` 跑在**首轮之前**——那一刻还没有 trace 可挂。若在构建时硬发一条，
 * 它只能是条孤儿 trace（`fiat.gate.build` 自成一棵树）。本钩子天然知道"这是第一轮"，
 * 于是在**第一条 trace 的首次 `turn_start`** 把它补登进去，`startMs` 仍用真实构建时刻，
 * 耗时如实反映「构建 → 首轮」的间隔。固定 wiring 的入口（诊断子会话）走的也是同一条路径。
 */
export interface TraceBuildInfo {
	/** 会话构建开始时刻（`fiat.gate.build` 的 startMs） */
	startedMs: number;
	role: string;
	environment: string;
	/** 闸门① 实际注册的工具名（角色 × 环境 × toolFilter 之后） */
	registeredTools: readonly string[];
	/** 加载到的策略条数 */
	policiesLoaded: number;
}

export interface TraceHookDeps {
	/** 追踪接线**取值器**：每轮现取（chat 的 per-turn trace 依赖它），见 types.ts */
	source: TracingSource;
	/** 会话构建事实：在第一条 trace 的首次 `turn_start` 落成 `fiat.gate.build` span */
	buildInfo?: TraceBuildInfo;
	/** 时钟注入（测试确定性用）；缺省 `Date.now` */
	now?: () => number;
}

/**
 * blocked 判定的文本特征（同 eval-recorder 的两类越权信号）：
 *   1. 闸门② block 的拒绝 reason（permission-gate："权限拒绝" / "无权" 等）
 *   2. 工具被闸门①裁剪后模型仍猜名调用 → agent-loop 的 "Tool x not found"
 */
const BLOCKED_PATTERN = /blocked|denied|权限|无权|拒绝|not found/i;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const part = item as { type?: string; text?: string } | undefined;
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

export function createTraceHook(deps: TraceHookDeps) {
	return (pi: ExtensionAPI) => {
		const now = deps.now ?? (() => Date.now());

		/** 已开未关的 tool span（key = toolCallId） */
		const open = new Map<string, SpanHandle>();
		/** 本 turn 内已由 tool_result 正常收口的调用（对账时跳过） */
		const closed = new Set<string>();
		/** 整个 trace 内单调递增的工具序号——Tree 视图里用来还原调用顺序 */
		let toolSeq = 0;
		/**
		 * 本轮接线：`turn_start` 时现取并钉住，`tool_call` / `tool_result` / `turn_end`
		 * 全部沿用它。**钉住而不是每次重取**是必须的——否则一旦调用方在轮中换了 trace
		 * （chat 的 per-turn trace 若被误用），同一个 turn 的 span 会劈到两条 trace 上。
		 */
		let turnWiring: TracingWiring | undefined;
		let turnSpan: SpanHandle | undefined;
		/** 构建事实只补登一次（首轮），见 TraceBuildInfo 的说明 */
		let buildEmitted = false;

		pi.on("turn_start", (event) => {
			closed.clear();
			// ⚠️ 现取：chat 的语义是「一轮 = 一条 trace」，上一轮的接线已经过期
			turnWiring = resolveTracing(deps.source);
			if (!turnWiring) {
				turnSpan = undefined;
				return;
			}
			const w = turnWiring;
			// 本轮的父 = **宿主**开的 `fiat.turn`（`wiring.turnSpanId`，见 TracingWiring.turnSpanId）。
			// 退化顺序只在宿主没来得及登记时兜底（根入口两者同值，故 chat 路径行为不变）。
			const parent = w.turnSpanId ?? w.parentSpanId ?? w.trace.rootSpanId;

			// 首轮顺带补登「会话构建」span（见 TraceBuildInfo）。必须排在 fiat.llm.turn
			// 之前——树里的阅读顺序就是执行顺序。未采样时不算"已补登"，留给后续轮次再试。
			if (!buildEmitted && w.trace.sampled) {
				buildEmitted = true;
				const b = deps.buildInfo;
				if (b) {
					const gate = w.tracer.startSpan(w.trace, "fiat.gate.build", {
						kind: "internal",
						parentSpanId: parent,
						startMs: b.startedMs,
						attributes: {
							[LANGFUSE_KEYS.obsType]: OBS_TYPE.span,
							"fiat.gate.name": "session_tools",
							"fiat.policy.role": b.role,
							"fiat.policy.environment": b.environment,
							"fiat.tools.registered": b.registeredTools.length,
							"fiat.policies.loaded": b.policiesLoaded,
						},
					});
					gate.setOutput({ registeredTools: [...b.registeredTools] });
					gate.setStatus("ok");
					gate.end();
				}
			}

			turnSpan = w.tracer.startSpan(w.trace, "fiat.llm.turn", {
				kind: "internal",
				parentSpanId: parent,
				attributes: {
					[LANGFUSE_KEYS.obsType]: OBS_TYPE.generation,
					"gen_ai.operation.name": "chat",
					"fiat.turn.index": event.turnIndex,
				},
			});
		});

		pi.on("tool_call", (event) => {
			const w = turnWiring;
			if (!w) return;
			toolSeq += 1;
			const span = w.tracer.startSpan(w.trace, `fiat.tool ${event.toolName}`, {
				kind: "client",
				parentSpanId: turnSpan?.spanId ?? w.turnSpanId ?? w.parentSpanId ?? w.trace.rootSpanId,
				attributes: {
					[LANGFUSE_KEYS.obsType]: OBS_TYPE.tool,
					"fiat.tool.name": event.toolName,
					// 能走到这里 = 闸门② 放行（被 block 的调用短路，钩子不触发，见文件头）
					"fiat.gate.tool_call": "allow",
					"fiat.tool.seq": toolSeq,
				},
			});
			span.setInput(event.input);
			open.set(event.toolCallId, span);
			// L1b 工具在 execute 里据此把自己发起的下游调用（MCP）挂成子 span
			w.trace.toolSpans?.set(event.toolCallId, span.spanId);
		});

		pi.on("tool_result", (event) => {
			const w = turnWiring;
			const span = open.get(event.toolCallId);
			if (!w || !span) return;
			const text = textOf(event.content);
			span.setOutput(text);
			// 显式标 ok / error（OTLP 缺省是 unset）：这样「闸门放行的调用成功率」能直接从
			// span status 统计出来，而不是要靠有没有 level 属性去猜。
			if (event.isError) span.setStatus("error", text.slice(0, 200));
			else span.setStatus("ok");
			span.end(now());
			open.delete(event.toolCallId);
			w.trace.toolSpans?.delete(event.toolCallId);
			closed.add(event.toolCallId);
		});

		pi.on("turn_end", (event) => {
			const w = turnWiring;

			// ── 对账：补齐被闸门拦下的调用（第 3 步，见文件头）──
			for (const tr of event.toolResults) {
				if (closed.has(tr.toolCallId)) continue;
				const pending = open.get(tr.toolCallId);
				if (pending) {
					// 开了但没等到 tool_result（异常/中断）：就地收口，别把 span 漏在树外
					pending.setOutput(textOf(tr.content));
					if (tr.isError) pending.setStatus("error");
					pending.end(now());
					open.delete(tr.toolCallId);
					w?.trace.toolSpans?.delete(tr.toolCallId);
					closed.add(tr.toolCallId);
					continue;
				}
				if (!w) {
					closed.add(tr.toolCallId);
					continue;
				}
				// 从未开到过 span → 被闸门拦下的调用
				const text = textOf(tr.content);
				const blocked = tr.isError && BLOCKED_PATTERN.test(text);
				toolSeq += 1;
				const span = w.tracer.startSpan(w.trace, `fiat.tool ${tr.toolName}`, {
					kind: "client",
					parentSpanId: turnSpan?.spanId ?? w.turnSpanId ?? w.parentSpanId ?? w.trace.rootSpanId,
					attributes: {
						[LANGFUSE_KEYS.obsType]: OBS_TYPE.tool,
						"fiat.tool.name": tr.toolName,
						"fiat.gate.tool_call": blocked ? "block" : "unreported",
						"fiat.tool.seq": toolSeq,
						"fiat.tool.reconciled": true,
					},
				});
				span.setOutput(text);
				span.setStatus("error", text.slice(0, 200));
				// 被拦是**安全信号**：WARNING 而不是 ERROR——它不是故障，是闸门正常工作
				if (blocked) span.setLevel("WARNING");
				span.end(now());
				closed.add(tr.toolCallId);
			}

			// ── 收口本轮 generation：model / token / 输出 / stopReason ──
			const message = event.message as
				| {
						role?: string;
						model?: string;
						provider?: string;
						stopReason?: string;
						errorMessage?: string;
						content?: unknown;
						usage?: {
							input: number;
							output: number;
							totalTokens?: number;
							cacheRead?: number;
							cacheWrite?: number;
							reasoning?: number;
						};
				  }
				| undefined;
			if (turnSpan && message?.role === "assistant") {
				if (message.model) turnSpan.setModel(message.model, message.provider);
				if (message.usage) {
					turnSpan.setUsage({
						input: message.usage.input,
						output: message.usage.output,
						...(message.usage.totalTokens !== undefined ? { total: message.usage.totalTokens } : {}),
						...(message.usage.cacheRead !== undefined ? { cacheRead: message.usage.cacheRead } : {}),
						...(message.usage.cacheWrite !== undefined ? { cacheWrite: message.usage.cacheWrite } : {}),
						...(message.usage.reasoning !== undefined ? { reasoning: message.usage.reasoning } : {}),
					});
				}
				turnSpan.setOutput(textOf(message.content));
				if (message.stopReason) turnSpan.setAttribute("gen_ai.response.finish_reasons", message.stopReason);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					turnSpan.setStatus("error", message.errorMessage ?? message.stopReason);
				}
			} else {
				turnSpan?.setStatus("ok");
			}
			turnSpan?.end(now());
			turnSpan = undefined;
			turnWiring = undefined;
		});
	};
}
