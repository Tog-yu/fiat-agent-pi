/**
 * pi-extensions 入口
 *
 * `pi -e ./pi-extensions/index.ts` 加载本文件（阶段 9 起为遗留入口，P9-49 归档）。
 * 业务扩展本体已迁至 src/server/host/{l1a,l1b}/；此处仅保留 hello + mcp-rag 演示加载链路。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpRagTools, ragConfigFromEnv } from "../../src/server/host/l1b/mcp-rag.ts";
import { createHelloExtension } from "./hello.ts";

export default async function (pi: ExtensionAPI) {
	// hello 扩展：演示用，验证加载链路；真实部署可移除
	createHelloExtension({ greeting: "Fiat" })(pi);

	// mcp-rag：stdio（MVP）/ http（改 RAG_MCP_URL 即切），失败自动降级不注册
	// P9-42：mcp-rag 已改工具模块契约；遗留入口经过渡适配器注册（P9-49 归档）
	for (const tool of await createMcpRagTools({ config: ragConfigFromEnv() })) pi.registerTool(tool);

	// 其余扩展按相同模式挂载（deps 由入口注入）：
	// createPermissionGate({ platform: localPlatformClient })(pi);
}
