/**
 * pi-extensions 入口
 *
 * `pi -e ./pi-extensions/index.ts` 加载本文件。
 * 后续的业务扩展（permission-gate / mcp-rag / fiat-tools / model-router / audit-hook）
 * 都在这里按相同的「工厂注入」模式装配后挂载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHelloExtension } from "./hello.ts";
import { createMcpRag, ragConfigFromEnv } from "./mcp-rag/index.ts";

export default function (pi: ExtensionAPI) {
	// hello 扩展：演示用，验证加载链路；真实部署可移除
	createHelloExtension({ greeting: "Fiat" })(pi);

	// mcp-rag：stdio（MVP）/ http（改 RAG_MCP_URL 即切），失败自动降级不注册
	createMcpRag({ config: ragConfigFromEnv() })(pi);

	// 其余扩展按相同模式挂载（deps 由入口注入）：
	// createPermissionGate({ platform: localPlatformClient })(pi);
}
