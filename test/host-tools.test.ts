/**
 * P8-36 工具注册通道（L1b）离线自测（faux provider，无网络）。
 *
 * 覆盖：
 * 1. `defineHostTool` 契约防呆（name / execute 缺失即抛）。
 * 2. 全链路：faux 第 1 轮发 `fauxToolCall`（stopReason "toolUse"）→ Agent 循环本地执行
 *    `execute` → toolResult 回灌 → 第 2 轮 factory 断言 context 里工具与工具结果俱在 →
 *    返回最终文本。
 * 3. `registerTools` / loop `tools` 注入：`agent.state.tools` 生效；未注册时 provider
 *    收到的 `context.tools` 为空。
 */

import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { defineHostTool, type HostTool, registerTools } from "../src/server/host/tools.ts";

describe("P8-36 defineHostTool 契约", () => {
	it("name / execute 缺失即抛，合法工具恒等返回", () => {
		expect(() => defineHostTool({} as unknown as HostTool)).toThrow(/name/);
		expect(() => defineHostTool({ name: "x" } as unknown as HostTool)).toThrow(/execute/);
		const ok = defineHostTool({
			name: "fiat_ok",
			label: "OK",
			description: "合法工具",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		});
		expect(ok.name).toBe("fiat_ok");
	});
});

describe("P8-36 工具全链路（tool call → execute → 回灌 → 最终回复）", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	const executed: Array<{ toolCallId: string; args: { message: string } }> = [];

	const echoTool = defineHostTool({
		name: "fiat_echo",
		label: "Echo",
		description: "回显输入消息（测试工具）",
		parameters: Type.Object({ message: Type.String() }),
		execute: async (toolCallId, params) => {
			executed.push({ toolCallId, args: params });
			return { content: [{ type: "text", text: `echo: ${params.message}` }], details: undefined };
		},
	});

	beforeEach(() => {
		faux = registerFauxProvider();
		executed.length = 0;
	});

	afterEach(() => {
		faux.unregister();
	});

	it("模型发起 tool call，工具本地执行，结果回灌后收最终回复", async () => {
		// 第 2 轮 factory：断言 provider 看到了工具与 toolResult，再给最终回复
		let sawToolNames: string[] | undefined;
		let sawToolResult = false;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_echo", { message: "你好" })], { stopReason: "toolUse" }),
			(context) => {
				sawToolNames = (context.tools ?? []).map((t) => t.name);
				sawToolResult = context.messages.some((m) => (m as { role?: string }).role === "toolResult");
				return fauxAssistantMessage("工具已执行完毕。");
			},
		]);

		const host = new PiHostLoop({ model: faux.getModel(), getApiKey: () => "faux-key", tools: [echoTool] });

		const reply = await host.runTurn("请调用 echo 工具");
		expect(reply).toBe("工具已执行完毕。");

		// execute 被本地调用 1 次，参数经 schema 校验
		expect(executed.length).toBe(1);
		expect(executed[0].args.message).toBe("你好");
		expect(executed[0].toolCallId).toBeTruthy();

		// 第 2 轮 provider 视角：工具已注册、toolResult 已回灌
		expect(sawToolNames).toContain("fiat_echo");
		expect(sawToolResult).toBe(true);

		// transcript 含 toolResult 消息
		const roles = host.messages.map((m) => (m as { role: string }).role);
		expect(roles).toContain("toolResult");
	});

	it("未注册工具时 provider 收到的 context.tools 为空", async () => {
		let sawToolNames: string[] | undefined;
		faux.setResponses([
			(context) => {
				sawToolNames = (context.tools ?? []).map((t) => t.name);
				return fauxAssistantMessage("没有工具。");
			},
		]);

		const host = new PiHostLoop({ model: faux.getModel(), getApiKey: () => "faux-key" });
		await host.runTurn("hi");
		expect(sawToolNames).toEqual([]);
	});
});

describe("P8-36 registerTools 通道", () => {
	it("写入 agent.state.tools（赋值即拷贝，可重复覆盖）", () => {
		const faux = registerFauxProvider();
		try {
			const host = new PiHostLoop({ model: faux.getModel() });
			expect(host.agent.state.tools).toEqual([]);

			const tool: HostTool = defineHostTool({
				name: "fiat_a",
				label: "A",
				description: "a",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "a" }], details: undefined }),
			});
			registerTools(host.agent, [tool]);
			expect(host.agent.state.tools.map((t) => t.name)).toEqual(["fiat_a"]);

			// 覆盖式注册：替换整组
			registerTools(host.agent, []);
			expect(host.agent.state.tools).toEqual([]);
		} finally {
			faux.unregister();
		}
	});
});
