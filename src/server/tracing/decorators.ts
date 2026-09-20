/**
 * 追踪装饰器（阶段 14 / P14-87）—— 用**包装**而不是改内部实现的方式给 L2 纯函数/服务加 span。
 *
 * 为什么用装饰器而不是往 `LocalPolicyClient` / `engine.ts` 里塞 tracer：
 *   - `engine.ts` 是**纯函数**（`canExecute(policies, req)`），零依赖是它的价值所在。
 *     改造它会把这层纯度毁掉，而它被 20+ 个测试直接断言。
 *   - `LocalPolicyClient` 有「进程内直连」和「HTTP 到 L2」两个实现，将来还会加。
 *     装饰器一次覆盖全部实现，不需要每个实现都记一遍 span。
 *
 * 装饰器必须**完全透明**：不改返回值、不改异常、不改调用次数（严格 1:1 透传）。
 */

import type { PolicyClient } from "../policy/client.ts";
import type { CanExecuteReq, Verdict } from "../policy/engine.ts";
import { LANGFUSE_KEYS, OBS_TYPE } from "./otlp.ts";
import { resolveTracing, type TracingSource } from "./types.ts";

/**
 * 给 `canExecute`（闸门③，唯一权威）加 `fiat.gate.can_execute` span。
 *
 * 为什么闸门③值得单独一个 span：它是**唯一说了算**的一道（①②都只是提前拦），
 * 排障时最常见的问题是「为什么这次被判 deny」——把 verdict 的 reason 直接落在 span 上，
 * 就不用再去翻审计表猜是哪条策略命中。
 *
 * 第二参收**取值器**而不是固定 wiring：chat 是 per-turn trace，而装饰器在会话构建时就包好了，
 * 必须等真正 `canExecute` 的那一刻才问「现在挂在哪条 trace 上」。
 */
export function tracedPolicyClient(inner: PolicyClient, source: TracingSource): PolicyClient {
	return {
		async canExecute(req: CanExecuteReq): Promise<Verdict> {
			const w = resolveTracing(source);
			if (!w || !w.trace.sampled) return inner.canExecute(req);
			const { tracer, trace } = w;
			const span = tracer.startSpan(trace, "fiat.gate.can_execute", {
				kind: "internal",
				// 挂进**当前轮**（`fiat.turn`）而不是 trace 根：蜂群的 trace 根是**告警** span，
				// 不指明父的话，子会话里的闸门判定会跳出视角树枝、直接挂到告警上
				// （树仍闭合，但「哪个视角在反复被 deny」就看不出来了）。
				parentSpanId: w.turnSpanId ?? w.parentSpanId ?? trace.rootSpanId,
				attributes: {
					[LANGFUSE_KEYS.obsType]: OBS_TYPE.span,
					"fiat.gate.name": "can_execute",
					"fiat.tool.name": req.tool,
					"fiat.policy.environment": req.environment,
					"fiat.policy.role": req.user.role,
				},
			});
			span.setInput(req.input);
			try {
				const verdict = await inner.canExecute(req);
				span.setAttribute("fiat.gate.verdict", verdict.allowed ? "allow" : "deny");
				if (verdict.reason) span.setAttribute("fiat.gate.reason", verdict.reason);
				if (verdict.approvalRequired) span.setAttribute("fiat.gate.approval_required", true);
				// deny 不是错误：闸门按预期工作。用 WARNING 而非 ERROR，避免把安全信号染成故障
				if (!verdict.allowed) span.setLevel("WARNING");
				return verdict;
			} catch (error) {
				span.setStatus("error", error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				span.end();
			}
		},
	};
}
