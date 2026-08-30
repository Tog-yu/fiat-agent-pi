/**
 * P6-23 RAG MCP transport 切换（stdio ⇄ streamable-http）。
 *
 * 验证「配置切 http」在客户端成立：createTransport 按 config 选对传输实现，
 * ragConfigFromEnv 按 RAG_MCP_URL 环境变量切换。业务代码（connect/listTools/callTool）
 * 与 transport 无关，故切换零改业务。
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createTransport, type RagMcpConfig, ragConfigFromEnv } from "../workspace/pi-extensions/mcp-rag/transport.ts";

describe("P6-23 RAG MCP transport 切换（stdio ⇄ http）", () => {
	it("createTransport: stdio 返回 StdioClientTransport", () => {
		const t = createTransport({ transport: "stdio" } as RagMcpConfig);
		expect(t).toBeInstanceOf(StdioClientTransport);
	});

	it("createTransport: http 返回 StreamableHTTPClientTransport", () => {
		const t = createTransport({ transport: "http", url: "http://h:8000/mcp" } as RagMcpConfig);
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	it("ragConfigFromEnv: 设 RAG_MCP_URL 时切 http", () => {
		const cfg = ragConfigFromEnv({
			RAG_MCP_URL: "http://rag.internal:8000/mcp",
		});
		expect(cfg.transport).toBe("http");
		expect(cfg.url).toBe("http://rag.internal:8000/mcp");
		expect(cfg.tokenEnv).toBe("RAG_MCP_TOKEN");
	});

	it("ragConfigFromEnv: 不设 URL 时走 stdio 默认", () => {
		const cfg = ragConfigFromEnv({});
		expect(cfg.transport).toBe("stdio");
		expect(cfg.url).toBeUndefined();
	});

	it("createTransport: http 缺 url 时抛错（fail-fast）", () => {
		expect(() => createTransport({ transport: "http" } as RagMcpConfig)).toThrow(/url/);
	});
});
