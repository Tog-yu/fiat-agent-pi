/**
 * P8-37 钩子通道（L1a）离线自测（faux provider，无网络）。
 *
 * 覆盖：
 * 1. `buildEmbeddedExtensionFactories` 白名单入口防呆。
 * 2. 通道打通：`ExtensionFactory`（`pi.on("tool_call")` 钩子）编译期注入 →
 *    `setupEmbeddedExtensions`（DefaultResourceLoader + 官方 ExtensionRunner）→
 *    `bridgeAgentHooks` → Agent 循环。
 * 3. 闸门② 全链路：钩子 block 指定工具 → `execute` 不被执行 → 错误 tool result 回灌 →
 *    模型看到 reason 并给最终回复；非 block 工具正常执行（对照组）。
 * 4. tool_result 钩子（audit-hook 桥接点）收到工具结果。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildEmbeddedExtensionFactories } from "../src/server/host/embedded-factories.ts";
import { bridgeAgentHooks, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { defineHostTool } from "../src/server/host/tools.ts";

const tmpDirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-host-ext-"));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTool(name: string, runs: string[]) {
	return defineHostTool({
		name,
		label: name,
		description: `${name} 测试工具`,
		parameters: Type.Object({ message: Type.String() }),
		execute: async (_id, params) => {
			runs.push(`${name}:${params.message}`);
			return { content: [{ type: "text", text: `${name} done` }], details: undefined };
		},
	});
}

describe("P8-37 buildEmbeddedExtensionFactories 白名单入口", () => {
	it("透传工厂列表；非函数即抛", () => {
		const f = () => {};
		expect(buildEmbeddedExtensionFactories([f])).toEqual([f]);
		expect(buildEmbeddedExtensionFactories([])).toEqual([]);
		expect(() => buildEmbeddedExtensionFactories([null as unknown as () => void])).toThrow(/function/);
	});
});

describe("P8-37 extensionFactories 注入通道 + 闸门② 全链路", () => {
	it("tool_call 钩子 block 危险工具，放行安全工具", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		mkdtempSync(agentDir);

		const runs: string[] = [];
		const hookCalls: string[] = [];
		const resultEvents: string[] = [];

		// 内建 extension（闸门②雏形）：block fiat_danger，放行 fiat_echo
		const gateExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				hookCalls.push(event.toolName);
				if (event.toolName === "fiat_danger") return { block: true, reason: "闸门②拦截：高风险工具" };
				return undefined;
			});
			pi.on("tool_result", () => {
				resultEvents.push("tool_result");
			});
		};

		const { runner } = await setupEmbeddedExtensions({ cwd, agentDir, factories: [gateExtension] });
		const hooks = bridgeAgentHooks(runner);

		const faux = registerFauxProvider();
		try {
			// 第 1 轮调危险工具（被 block），第 2 轮调安全工具（放行），第 3 轮收尾
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("fiat_danger", { message: "rm -rf /" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("fiat_echo", { message: "hello" })], { stopReason: "toolUse" }),
				(context) => {
					// 第 3 轮：断言两条 tool result 都在（一条 error=block、一条正常）
					const toolResults = context.messages.filter((m) => (m as { role?: string }).role === "toolResult");
					if (toolResults.length !== 2) {
						return fauxAssistantMessage(`工具结果数量异常: ${toolResults.length}`);
					}
					return fauxAssistantMessage("闸门验证完成。");
				},
			]);

			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				tools: [makeTool("fiat_echo", runs), makeTool("fiat_danger", runs)],
				...hooks,
			});

			const reply = await host.runTurn("先删库再打招呼");
			expect(reply).toBe("闸门验证完成。");

			// 钩子两次都触发；危险工具 execute 未被调用，安全工具正常执行
			expect(hookCalls).toEqual(["fiat_danger", "fiat_echo"]);
			expect(runs).toEqual(["fiat_echo:hello"]);
			// tool_result 钩子（audit-hook 桥接点）只在真实执行后触发；
			// 被 block 的工具不发 tool_result 事件（错误结果由 Agent 循环直接生成，实测确认）
			expect(resultEvents.length).toBe(1);
		} finally {
			faux.unregister();
		}
	});
});
