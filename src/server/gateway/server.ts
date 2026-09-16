/**
 * 告警网关 HTTP 服务（阶段 13 / P13-74/75）—— node:http 零新依赖，仅 loopback。
 *
 * 端点：
 *   GET  /healthz        健康检查（无鉴权，只回 200 + uptime）
 *   POST /hooks/alert    告警推送入口（Bearer token 恒定时间比对）
 *
 * 安全口径（DEV_SPEC 阶段 13 + openclaw hooks 对齐）：
 *   - 仅 loopback bind（硬约束 2）；暴露给告警平台须经 reverse proxy，不做内建 TLS；
 *   - token 缺失/错误 → 401；**query string 传 token 一律拒绝**（对齐 openclaw）；
 *   - payload 非法 → 400；体超 maxBodyBytes → 413；method 不对 → 405；
 *   - 单请求异常不影响主监听（请求级 try/catch 兜底 500）。
 *
 * HTTP 层零业务逻辑：鉴权 + 读体 + 适配 → 交给 AlertGateway.handleAlert。
 * 测试经 handleRequest(requestLike) 注入，不必起真实端口。
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getAdapter } from "./adapters.ts";
import { AlertGateway } from "./runner.ts";
import type { AlertEnvelope, GatewayDeps } from "./types.ts";

const MAX_AGE_BODY_MS = 10_000;

/** 恒定时间比对（长度不齐直接 false —— 长度本身不是秘密） */
export function tokenMatches(expected: string | undefined, provided: string | undefined): boolean {
	if (!expected || !provided) return false;
	const a = Buffer.from(expected, "utf-8");
	const b = Buffer.from(provided, "utf-8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** 从 Authorization 头提取 Bearer token */
export function bearerOf(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m?.[1];
}

/** 鉴权 + 体读取之后的业务结果 */
export interface HandleOutcome {
	status: number;
	body: Record<string, unknown>;
}

export class GatewayServer {
	readonly #gateway: AlertGateway;
	readonly #config: GatewayDeps["config"];

	constructor(deps: GatewayDeps, inflight: import("./policy.ts").InflightGate) {
		if (!deps.config.token) {
			throw new Error(
				"gateway token 未配置：拒绝启动裸奔的鉴权服务（config/gateway.yaml 的 gateway.token 或 FIAT_GATEWAY_TOKEN）",
			);
		}
		this.#config = deps.config;
		this.#gateway = new AlertGateway(deps);
		// inflight 闸由 runner 层消费；server 持有引用是为了 #onRawRequest 的 429 上报与将来 status 端点
		void inflight;
	}

	/**
	 * 请求处理核心（可注入测试）：鉴权 → 读体（限长）→ 适配 → 网关。
	 * status 语义：200 处理完成（含 deduped/resolved）；202 已受理诊断（异步）；
	 * 400 payload 非法；401/403 鉴权；405 method；413 体超限；500 内部错误。
	 */
	async handleRequest(req: {
		method?: string;
		url?: string;
		headers: Record<string, string | string[] | undefined>;
		body: string;
	}): Promise<HandleOutcome> {
		const method = (req.method ?? "GET").toUpperCase();
		const url = new URL(req.url ?? "/", "http://loopback.invalid");

		// 健康检查：无鉴权
		if (method === "GET" && url.pathname === "/healthz") {
			return { status: 200, body: { ok: true, uptimeSec: Math.floor(process.uptime()) } };
		}

		if (url.pathname !== "/hooks/alert") {
			return { status: 404, body: { error: "not_found" } };
		}

		// query string 传 token 一律拒绝（对齐 openclaw：token 只走 Authorization 头）
		if (url.searchParams.has("token")) {
			return { status: 400, body: { error: "token_in_query_rejected" } };
		}

		if (method !== "POST") {
			return { status: 405, body: { error: "method_not_allowed" } };
		}

		const header = req.headers.authorization;
		const provided = Array.isArray(header) ? header[0] : header;
		if (!tokenMatches(this.#config.token, bearerOf(provided))) {
			return { status: 401, body: { error: "unauthorized" } };
		}

		const bodyBytes = Buffer.byteLength(req.body, "utf-8");
		if (bodyBytes > this.#config.maxBodyBytes) {
			return { status: 413, body: { error: "payload_too_large", limit: this.#config.maxBodyBytes } };
		}

		let payload: unknown;
		try {
			payload = JSON.parse(req.body);
		} catch {
			return { status: 400, body: { error: "invalid_json" } };
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return { status: 400, body: { error: "payload_must_be_object" } };
		}

		let envelope: AlertEnvelope;
		try {
			envelope = getAdapter(this.#config.adapter)({
				source: url.searchParams.get("source") ?? "webhook",
				payload: payload as Record<string, unknown>,
			});
		} catch (e) {
			return { status: 400, body: { error: "adapter_failed", detail: e instanceof Error ? e.message : String(e) } };
		}

		try {
			const { record, outcome, diagnosisDispatched } = await this.#gateway.handleAlert(envelope);
			// 202 = 新事件且诊断已异步受理；200 = deduped / resolved / 摘要卡等同步终态
			return {
				status: outcome === "accepted" && diagnosisDispatched ? 202 : 200,
				body: {
					ok: true,
					eventId: record.id,
					fingerprint: record.fingerprint,
					status: record.status,
					severity: record.severity,
				},
			};
		} catch (e) {
			return { status: 500, body: { error: "gateway_error", detail: e instanceof Error ? e.message : String(e) } };
		}
	}

	/** 起真实 HTTP 服务（生产 / smoke）。返回 server 便于 close。 */
	listen(): Server {
		const server = createServer((req, res) => {
			void this.#onRawRequest(req, res);
		});
		server.listen(this.#config.port, "127.0.0.1");
		return server;
	}

	async #onRawRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		const timer = setTimeout(() => {
			aborted = true;
			res.writeHead(408).end();
			req.destroy();
		}, MAX_AGE_BODY_MS);

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			// 边读边拦：超限立即断，不等读完全量（防恶意大包撑内存）
			if (size > this.#config.maxBodyBytes) {
				aborted = true;
				clearTimeout(timer);
				res.writeHead(413).end();
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (aborted) return;
			clearTimeout(timer);
			void (async () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				const headers: Record<string, string | string[] | undefined> = req.headers;
				const outcome = await this.handleRequest({ method: req.method, url: req.url, headers, body });
				res.writeHead(outcome.status, { "content-type": "application/json" });
				res.end(JSON.stringify(outcome.body));
			})().catch(() => {
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "gateway_error" }));
			});
		});

		req.on("error", () => {
			clearTimeout(timer);
		});
	}
}
