import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiHostLoop } from "../src/server/host/loop.ts";

/**
 * P8-34 验收：pi-host 最小内嵌循环（Agent + streamSimple）跑通「问一句答一句」。
 * 全程离线——用 registerFauxProvider 脚本化响应，不触真模型。
 */
describe("P8-34 pi-host 最小内嵌循环", () => {
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
	});

	it("① 单轮：问一句 → 收一句（faux 直驱 streamSimple）", async () => {
		faux.setResponses([fauxAssistantMessage("我是 fiat-agent 的最小循环，已就绪。")]);

		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			systemPrompt: "你是 fiat-agent 的最小循环宿主。",
		});

		const reply = await host.runTurn("你好");
		expect(reply).toContain("最小循环");

		// transcript 中应包含 user 与 assistant 各一条
		const roles = host.messages.map((m) => (m as { role: string }).role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");

		host.reset();
	});

	it("② 多轮：连续两轮各自收一句，且共享同一 transcript", async () => {
		faux.setResponses([fauxAssistantMessage("第一轮回复"), fauxAssistantMessage("第二轮回复")]);

		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
		});

		const r1 = await host.runTurn("第一问");
		expect(r1).toBe("第一轮回复");

		const r2 = await host.runTurn("第二问");
		expect(r2).toBe("第二轮回复");

		// 两轮后 transcript 含 2 条 user + 2 条 assistant
		const assistantCount = host.messages.filter((m) => (m as { role: string }).role === "assistant").length;
		expect(assistantCount).toBe(2);
	});
});
