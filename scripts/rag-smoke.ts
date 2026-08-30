/**
 * 真实 RAG server 的 stdio 握手冒烟（不在 CI 里跑，手工验证 transport 真实路径）。
 * 用后即删。
 */
import { createMcpRag } from "../workspace/pi-extensions/mcp-rag/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registered: string[] = [];
const pi = {
	registerTool: (t: { name: string }) => registered.push(t.name),
	on: () => {},
} as unknown as ExtensionAPI;

const done = new Promise<void>((resolve, reject) => {
	setTimeout(() => reject(new Error("smoke timeout 60s")), 60_000);
});

createMcpRag({
	config: {
		transport: "stdio",
		command: "/Users/tog/Desktop/project/MODULAR-RAG-MCP-SERVER/.venv/bin/python",
		args: ["-m", "src.mcp_server.server"],
		cwd: "/Users/tog/Desktop/project/MODULAR-RAG-MCP-SERVER",
		timeoutMs: 30_000,
	},
	onStatus: (status, detail) => {
		console.log(`[${status}] ${detail}`);
		if (status === "ready") {
			console.log("registered:", registered.join(", "));
			resolve();
		}
		if (status === "unavailable") reject(new Error(detail));
	},
})(pi);

await done;
console.log("SMOKE OK");
process.exit(0);
