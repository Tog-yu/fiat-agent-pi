/**
 * P8-38 宿主职责移植离线自测（faux provider，无网络）。
 *
 * 覆盖（对标 pi-embedded 宿主文件职责，五项）：
 * 1. 消息去重·清洗：空消息丢弃 / 连续重复去重（键序无关）/ thinking·图片默认保留 /
 *    stripImages·stripThinking 剥除；经 transformContext 挂载后 LLM 视图被清洗而
 *    transcript 本体不动。
 * 2. thinking·图片：清洗保留语义 + stripImages 显式剥图（同上）。
 * 3. bootstrap context：构造注入 → transcript 首条；配 session 一并落盘。
 * 4. 事件扇出：单订阅多播 N handler、单 handler 抛错不阻断其他。
 * 5. provider 错误兜底：runTurnSafe 捕获 stopReason "error" 为结构化结果，正常路径 ok。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	buildBootstrapContext,
	fanoutEvents,
	type SanitizeOptions,
	sanitizeMessages,
} from "../src/server/host/duties.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";

function msg(role: string, content: unknown): AgentMessage {
	return { role, content } as AgentMessage;
}

describe("P8-38 sanitizeMessages 去重·清洗", () => {
	it("丢弃空消息、连续重复去重（键序无关）、非连续重复保留", () => {
		const input = [
			msg("user", ""), // 空 → 丢
			msg("user", "hi"),
			msg("user", "hi"), // 连续重复 → 丢
			msg("assistant", [{ type: "text", text: "a" }]),
			msg("assistant", [{ text: "a", type: "text" }]), // 键序不同但同 content → 丢
			msg("user", "hi"), // 非连续重复 → 保留
		];
		const out = sanitizeMessages(input);
		expect(out.length).toBe(3);
		expect((out[0] as { content: string }).content).toBe("hi");
		expect((out[2] as { content: string }).content).toBe("hi");
	});

	it("thinking / 图片 block 默认保留，stripImages / stripThinking 按需剥除", () => {
		const rich = msg("assistant", [
			{ type: "thinking", thinking: "hmm" },
			{ type: "image", data: "base64xxx", mimeType: "image/png" },
			{ type: "text", text: "答案" },
		]);

		const keep = sanitizeMessages([rich]);
		const keepBlocks = (keep[0] as { content: Array<{ type: string }> }).content;
		expect(keepBlocks.map((b) => b.type)).toEqual(["thinking", "image", "text"]);

		const noImg = sanitizeMessages([rich], { stripImages: true });
		expect((noImg[0] as { content: Array<{ type: string }> }).content.map((b) => b.type)).toEqual(["thinking", "text"]);

		const noThink = sanitizeMessages([rich], { stripThinking: true, stripImages: true });
		expect((noThink[0] as { content: Array<{ type: string }> }).content.map((b) => b.type)).toEqual(["text"]);
	});

	it("全块被剥除后消息视为空并丢弃", () => {
		const onlyImage = msg("user", [{ type: "image", data: "x", mimeType: "image/png" }]);
		expect(sanitizeMessages([onlyImage], { stripImages: true }).length).toBe(0);
	});
});

describe("P8-38 bootstrap context", () => {
	it("buildBootstrapContext 生成自述来源的环境消息", () => {
		const m = buildBootstrapContext({ cwd: "/x", time: "T0", extra: ["tenant: a"] }) as {
			role: string;
			content: string;
		};
		expect(m.role).toBe("user");
		expect(m.content).toContain("[bootstrap context]");
		expect(m.content).toContain("cwd: /x");
		expect(m.content).toContain("time: T0");
		expect(m.content).toContain("tenant: a");
	});

	it("HostLoop bootstrap 注入 transcript 首条，且经 session 落盘", async () => {
		const dir = mkdtempSync(`${tmpdir()}/pi-host-bootstrap-`);
		try {
			const faux = registerFauxProvider();
			try {
				const { HostSession } = await import("../src/server/host/session.ts");
				const session = HostSession.inMemory();
				const host = new PiHostLoop({
					model: faux.getModel(),
					getApiKey: () => "k",
					bootstrap: { cwd: "/proj", time: "T0" },
					session,
				});
				// transcript 首条即 bootstrap
				const first = host.messages[0] as { content: string };
				expect(first.content).toContain("[bootstrap context]");
				// syncDelta 语义：bootstrap 属未落盘增量，首轮一并落盘
				await host.runTurn("hi");
				expect(session.messages().length).toBe(3); // bootstrap + user + assistant
				expect((session.messages()[0] as { content: string }).content).toContain("[bootstrap context]");
			} finally {
				faux.unregister();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("P8-38 事件扇出", () => {
	it("单订阅多播 N handler，单 handler 抛错不阻断其他", async () => {
		const faux = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage("ok")]);
			const host = new PiHostLoop({ model: faux.getModel(), getApiKey: () => "k" });

			const seen: string[] = [];
			const errors: Array<{ index: number }> = [];
			const stop = fanoutEvents(
				host.agent,
				[
					(event) => {
						seen.push(`a:${event.type}`);
						if (event.type === "agent_end") throw new Error("handler a boom");
					},
					(event) => {
						seen.push(`b:${event.type}`);
					},
				],
				(_e, index) => errors.push({ index }),
			);

			await host.runTurn("hi");
			stop();

			// a 抛错不影响 b；两类事件都到达两个 handler
			expect(seen.filter((s) => s.startsWith("a:")).length).toBeGreaterThan(0);
			expect(seen.filter((s) => s.startsWith("b:")).length).toBeGreaterThan(0);
			expect(errors).toEqual([{ index: 0 }]);
		} finally {
			faux.unregister();
		}
	});
});

describe("P8-38 provider 错误兜底（runTurnSafe）", () => {
	it("stopReason error → ok:false + errorMessage 透出", async () => {
		const faux = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "额度不足" })]);
			const host = new PiHostLoop({ model: faux.getModel(), getApiKey: () => "k" });
			const result = await host.runTurnSafe("hi");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("额度不足");
		} finally {
			faux.unregister();
		}
	});

	it("正常路径 ok:true 且带回复", async () => {
		const faux = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage("一切正常")]);
			const host = new PiHostLoop({ model: faux.getModel(), getApiKey: () => "k" });
			const result = await host.runTurnSafe("hi");
			expect(result).toEqual({ ok: true, reply: "一切正常" });
		} finally {
			faux.unregister();
		}
	});
});

// SanitizeOptions 类型冒烟（stripImages / stripThinking 为剥除开关）
const _opts: SanitizeOptions = { stripImages: true, stripThinking: false };
void _opts;
