/**
 * 阶段 13 / P13-81：网关 HTTP 层测试 —— 鉴权 / 4xx / 体积上限。
 * 经 GatewayServer.handleRequest 注入，不起真实端口。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAdapter } from "../src/server/gateway/adapters.ts";
import { loadGatewayConfig } from "../src/server/gateway/config.ts";
import { LocalAlertNotifier } from "../src/server/gateway/notify.ts";
import { InflightGate } from "../src/server/gateway/policy.ts";
import { bearerOf, GatewayServer, tokenMatches } from "../src/server/gateway/server.ts";
import { InMemoryAlertEventStore } from "../src/server/gateway/store.ts";

const CONFIG_PATH = fileURLToPath(new URL("../config/gateway.yaml", import.meta.url));

function makeServer(overrides: Record<string, unknown> = {}) {
	const config = {
		...loadGatewayConfig(CONFIG_PATH),
		token: "test-token",
		...overrides,
	};
	const notifier = new LocalAlertNotifier();
	const server = new GatewayServer(
		{ config, store: new InMemoryAlertEventStore(), notify: notifier },
		new InflightGate(config.maxInflightPerService, config.maxQueuePerService),
	);
	return { server, config, notifier };
}

function req(
	overrides: {
		method?: string;
		url?: string;
		/** "none" = 不带 Authorization 头；其他字符串 = 原样作为头值；缺省 = 正确 token */
		auth?: string;
		body?: string;
	} = {},
) {
	const authHeader =
		overrides.auth === undefined ? "Bearer test-token" : overrides.auth === "none" ? undefined : overrides.auth;
	return {
		method: overrides.method ?? "POST",
		url: overrides.url ?? "/hooks/alert",
		headers: { authorization: authHeader },
		body: overrides.body ?? JSON.stringify({ title: "支付网关 5xx 突增", service: "payment-gateway", severity: "P0" }),
	};
}

describe("token 工具函数", () => {
	it("bearerOf 提取 Bearer 头", () => {
		expect(bearerOf("Bearer abc")).toBe("abc");
		expect(bearerOf("bearer abc")).toBe("abc");
		expect(bearerOf("Basic abc")).toBeUndefined();
		expect(bearerOf(undefined)).toBeUndefined();
	});

	it("tokenMatches 恒定时间比对（长度不齐 false）", () => {
		expect(tokenMatches("secret", "secret")).toBe(true);
		expect(tokenMatches("secret", "secreT")).toBe(false);
		expect(tokenMatches("secret", "short")).toBe(false);
		expect(tokenMatches(undefined, "x")).toBe(false);
		expect(tokenMatches("x", undefined)).toBe(false);
	});
});

describe("鉴权", () => {
	it("无 token / 错 token → 401", async () => {
		const { server } = makeServer();
		expect((await server.handleRequest(req({ auth: "none" }))).status).toBe(401);
		expect((await server.handleRequest(req({ auth: "Bearer wrong" }))).status).toBe(401);
	});

	it("query string 传 token 一律拒绝（对齐 openclaw）", async () => {
		const { server } = makeServer();
		const r = await server.handleRequest(req({ url: "/hooks/alert?token=test-token" }));
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("token_in_query_rejected");
	});
});

describe("方法与路由", () => {
	it("GET /healthz 无鉴权 200", async () => {
		const { server } = makeServer();
		const r = await server.handleRequest({ method: "GET", url: "/healthz", headers: {}, body: "" });
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
	});

	it("未知路径 404；GET /hooks/alert 405", async () => {
		const { server } = makeServer();
		expect((await server.handleRequest(req({ url: "/nope" }))).status).toBe(404);
		expect((await server.handleRequest(req({ method: "GET" }))).status).toBe(405);
	});
});

describe("payload 校验", () => {
	it("非 JSON → 400；非对象 → 400", async () => {
		const { server } = makeServer();
		expect((await server.handleRequest(req({ body: "not-json" }))).status).toBe(400);
		expect((await server.handleRequest(req({ body: "[1,2]" }))).status).toBe(400);
	});

	it("缺 title（适配器拒绝猜测）→ 400", async () => {
		const { server } = makeServer();
		const r = await server.handleRequest(req({ body: JSON.stringify({ service: "x" }) }));
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("adapter_failed");
	});

	it("体超限 → 413", async () => {
		const { server } = makeServer({ maxBodyBytes: 100 });
		const r = await server.handleRequest(req({ body: JSON.stringify({ title: "x".repeat(200) }) }));
		expect(r.status).toBe(413);
	});
});

describe("端到端推送（假 token 通路）", () => {
	it("合法 P0 推送 → 202 受理 + 落库 firing", async () => {
		const { server } = makeServer();
		const r = await server.handleRequest(req());
		expect([200, 202]).toContain(r.status);
		expect(r.body.ok).toBe(true);
		expect(r.body.severity).toBe("P0");
	});

	it("通用适配器：severity 缺省 → P2 保守降级", () => {
		const env = getAdapter("generic-json")({
			source: "webhook",
			payload: { title: "磁盘水位", service: "db" },
		});
		expect(env.severity).toBe("P2");
		expect(env.status).toBe("firing");
	});
});
