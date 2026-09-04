/**
 * fiat_hello — 最小验证扩展
 *
 * 目的：确认 Pi 的扩展加载链路通畅（文件被发现 → 被 import → 被调用 → 工具注册成功）。
 * 同时也是「工厂注入」模式的范本：扩展本身不依赖任何具体平台客户端，
 * 由入口（index.ts / 测试 / Web 宿主）注入 deps，从而实现单测 / TUI / 服务三处共用一份代码。
 *
 * 状态：本文件为【归档】快照（P9-49），不再经扩展加载器加载；
 * 现入口为 `npm run cli` → `fiat chat`（pi-host 内嵌循环）。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface HelloDeps {
	/** 问候前缀，演示 deps 注入；TUI 传 "Fiat"，测试可传任意值 */
	greeting: string;
}

/**
 * 工厂：返回可被 Pi 直接调用的扩展函数 `(pi: ExtensionAPI) => void`。
 * 同一份业务代码，TUI / 测试 / Web 入口只需提供不同的 deps。
 */
export function createHelloExtension(deps: HelloDeps) {
	return (pi: ExtensionAPI) => {
		const helloTool = defineTool({
			name: "fiat_hello",
			label: "Fiat Hello",
			description: "fiat-agent 最小验证工具：回显问候，确认扩展加载链路通畅。",
			promptSnippet: "Echo a greeting to confirm the extension load chain is wired.",
			parameters: Type.Object({
				name: Type.String({ description: "要问候的名字" }),
			}),
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${deps.greeting}, ${params.name}!` }],
					details: { greeted: params.name },
				};
			},
		});

		pi.registerTool(helloTool);
	};
}

// 默认导出：归档快照，原供扩展加载器直接加载（注入 TUI 默认 deps）；现入口为 `fiat chat`。
export default createHelloExtension({ greeting: "Fiat" });
