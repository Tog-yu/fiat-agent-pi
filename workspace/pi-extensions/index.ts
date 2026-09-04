/**
 * pi-extensions 入口 —— 【已归档】（P9-49，2026-09-04）
 *
 * ⚠️ 本目录自阶段 9 起为**归档**状态：入口已切换为自研 CLI（`npm run cli` → `fiat chat`，
 * 由 pi-host 内嵌循环 `PiHostLoop` 驱动，装配链见 src/server/cli/chat.ts）。
 * 原扩展加载器入口已弃用，该加载链路不再是受支持的运行方式。
 *
 * 业务扩展本体已迁至 src/server/host/{l1a,l1b}/（P9-40~47）：
 *   - L1a 内建 extension（extensionFactories 编译期注入）：permission-gate / audit-hook / model-router
 *   - L1b 工具模块（直接注册进内嵌循环）：mcp-rag / fiat-tools / job-apply / alert-fanout
 *
 * 本目录仅保留历史实现快照与 hello 加载链路演示，供对照与回溯；不再跟随 L1 演进。
 * 扩展加载器残留已随 P10-50 清理：无扩展加载器软链、无目录扫描，运行入口为 `npm run cli`。
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
