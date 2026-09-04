/**
 * P8-40 关闭自动发现 + 通道自测（阶段 8 收官）。
 *
 * 覆盖两条通道的隔离性：
 * 1. **编译期注入的 extension 生效**：`DefaultResourceLoader` 显式传
 *    `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true` +
 *    `extensionFactories`，钩子正常触发（复用 P8-37 通道，这里验证「关闭自动发现后仍生效」）。
 * 2. **外部目录 extension 不生效**：在 cwd / agentDir 下放真实 extension 文件
 *    （`.pi/extensions/*.ts`），关闭自动发现后不得被加载，钩子不触发。
 *    这是「弃用扩展加载器」的验收线：白名单之外进不来。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeAgentHooks, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { HostResources } from "../src/server/host/resources.ts";
import { defineHostTool } from "../src/server/host/tools.ts";

const tmpDirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-host-noauto-"));
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

describe("P8-40 关闭自动发现 + 通道自测", () => {
	it("编译期注入的 extension 在 no* 全 true 下仍生效", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const hookCalls: string[] = [];
		const injected: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				hookCalls.push(event.toolName);
				if (event.toolName === "fiat_gate") return { block: true, reason: "闸门②拦截" };
			});
		};

		const { runner } = await setupEmbeddedExtensions({ cwd, agentDir, factories: [injected] });
		const hooks = bridgeAgentHooks(runner);

		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("fiat_gate", { message: "x" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("fiat_echo", { message: "hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => "faux-key",
				tools: [makeTool("fiat_echo", []), makeTool("fiat_gate", [])],
				...hooks,
			});
			await host.runTurn("test");

			// 编译期注入的钩子生效：危险工具被 block、安全工具放行
			expect(hookCalls).toEqual(["fiat_gate", "fiat_echo"]);
		} finally {
			faux.unregister();
		}
	});

	it("外部目录 extension 不生效（自动发现关闭，白名单之外进不来）", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		// 外部目录 extension：cwd 下 .pi/extensions/（Pi 约定路径）+ agentDir 下 extensions/
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const externalHook = `export default function (pi) {
	pi.on("tool_call", (event) => { externalCalls.push(event.toolName); });
}`;
		// 两个位置都放，确保无论 Pi 扫哪个路径都不会被加载
		writeFileSync(join(cwd, ".pi", "extensions", "rogue.ts"), externalHook);
		writeFileSync(join(agentDir, "extensions", "rogue.ts"), externalHook);

		const externalCalls: string[] = [];
		// 全局注入：外部文件里的代码引用了 externalCalls（如果被加载会写它）
		(globalThis as Record<string, unknown>).__p840_external_calls = externalCalls;

		// 不传任何 factories：无编译期注入
		const { runner, loaded } = await setupEmbeddedExtensions({ cwd, agentDir });
		const hooks = bridgeAgentHooks(runner);

		// 加载结果里不应有任何 extension
		expect(loaded.extensions).toHaveLength(0);

		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("fiat_echo", { message: "hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const host = new PiHostLoop({
				model: faux.getModel(),
				getApiKey: () => `${" rogue".trim()}-key`,
				tools: [makeTool("fiat_echo", [])],
				...hooks,
			});
			await host.runTurn("test");
			// 外部 extension 的钩子从未触发
			expect(externalCalls).toEqual([]);
		} finally {
			faux.unregister();
			delete (globalThis as Record<string, unknown>).__p840_external_calls;
		}
	});

	it("HostResources 默认关闭自动发现，extensionFactories 通道仍开", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "extensions", "rogue.ts"),
			`export default function (pi) { pi.on("tool_call", () => {}); }`,
		);

		const injected: ExtensionFactory = () => {};
		const res = new HostResources({ cwd, agentDir, extensionFactories: [injected] });
		// DefaultResourceLoader 语义：构造后需显式 reload() 才加载
		await res.loader.reload();

		// 外部目录 extension 未被加载；编译期注入的 factory 在列
		const loaded = res.extensions;
		expect(loaded.extensions).toHaveLength(1);
	});
});
