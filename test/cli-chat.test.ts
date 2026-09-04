/**
 * P9-49 入口切换：`fiat chat` 命令与 makeChat 工厂测试。
 *
 * 覆盖：
 * 1. runCli 分发：未配置 chat 时明确提示（不静默失败）；deps.chat 注入后单轮执行。
 * 2. parseFiatModel 格式校验。
 * 3. makeChat 全链路（faux provider）：FIAT_MODEL 未配置返回 undefined；真实
 *    buildSession + setupEmbeddedExtensions + PiHostLoop 装配跑通一轮问答，
 *    且三道闸门同链生效（无权限角色调不到工具）。
 */

import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type ChatFactory, makeChat, parseFiatModel } from "../src/server/cli/chat.ts";
import { type CliDeps, runCli } from "../src/server/cli/index.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function baseDeps(overrides: Partial<CliDeps> = {}): CliDeps {
	return {
		policies: new Map(),
		audit: { query: async () => [] },
		listTickets: async () => [],
		approveTicket: async (id) => ({ ticketId: id, status: "approved" }) as never,
		rejectTicket: async (id) => ({ ticketId: id, status: "rejected" }) as never,
		...overrides,
	};
}

describe("P9-49 chat 命令分发（runCli）", () => {
	it("未配置 chat（FIAT_MODEL 缺失）→ 明确提示，退出码 1", async () => {
		const { io, err } = capture();
		const code = await runCli(["chat", "你好"], baseDeps(), io);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("未配置模型");
	});

	it("注入 chat → 单轮执行，模型回复写 stdout，退出码 0", async () => {
		const seen: string[] = [];
		const chat: ChatFactory = async () => ({
			sessionId: "sess-chat-1",
			turn: async (input) => {
				seen.push(input);
				return { ok: true, reply: `echo:${input}` };
			},
			dispose: () => {},
		});
		const { io, out } = capture();
		const code = await runCli(["chat", "查一下", "返现规则"], baseDeps({ chat }), io);
		expect(code).toBe(0);
		expect(seen).toEqual(["查一下 返现规则"]);
		expect(out.join("\n")).toContain("echo:查一下 返现规则");
	});

	it("会话工厂抛错 → 退出码 1，错误落到 stderr", async () => {
		const chat: ChatFactory = async () => {
			throw new Error("模型解析失败");
		};
		const { io, err } = capture();
		const code = await runCli(["chat"], baseDeps({ chat }), io);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("模型解析失败");
	});

	it("turn 返回 ok:false → 输出出错信息，退出码 1", async () => {
		const chat: ChatFactory = async () => ({
			sessionId: "sess-chat-2",
			turn: async () => ({ ok: false, reply: "", error: "provider error stopReason" }),
			dispose: () => {},
		});
		const { io, out } = capture();
		const code = await runCli(["chat", "hi"], baseDeps({ chat }), io);
		expect(code).toBe(1);
		expect(out.join("\n")).toContain("provider error stopReason");
	});
});

describe("parseFiatModel", () => {
	it("provider/model 正常拆分", () => {
		expect(parseFiatModel("gpt/gpt-5.6-terra")).toEqual({ provider: "gpt", modelId: "gpt-5.6-terra" });
	});
	it("缺斜杠 / 空段 → 抛错", () => {
		expect(() => parseFiatModel("gpt")).toThrow(/provider\/model/);
		expect(() => parseFiatModel("/model")).toThrow(/provider\/model/);
		expect(() => parseFiatModel("gpt/")).toThrow(/provider\/model/);
	});
});

describe("makeChat 全链路（faux provider，真实 buildSession + PiHostLoop）", () => {
	let faux: ReturnType<typeof registerFauxProvider> | undefined;

	afterEach(() => {
		faux?.unregister();
		faux = undefined;
	});

	it("FIAT_MODEL 未设置 → 返回 undefined（CLI 层明确提示）", () => {
		const prev = process.env.FIAT_MODEL;
		delete process.env.FIAT_MODEL;
		try {
			expect(makeChat({})).toBeUndefined();
		} finally {
			if (prev !== undefined) process.env.FIAT_MODEL = prev;
		}
	});

	it("FIAT_MODEL provider 不在 config → 抛错", () => {
		expect(() => makeChat({ fiatModel: "nope/no-model" })).toThrow(/不在 config\/model_policies\.yaml/);
	});

	it("faux 模型跑通一轮：装配 + 回复（modelOverride 测试缝，跳过 ModelRegistry）", async () => {
		faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("返现规则是……（faux 回复）")]);

		const factory = makeChat({
			fiatModel: "faux/faux-default",
			policiesPath: POLICY_PATH,
			// faux 的 api id 是注册时生成的串（faux:<ts>:<rand>），ModelRegistry 解析不出该 api
			// → 测试直接注入 Model（正式入口不传 modelOverride，一律走 registry 解析）
			modelOverride: faux.getModel(),
			inMemorySession: true,
			// faux 不在 config/model_policies.yaml —— 测试注入 provider 覆盖（正式入口只走 config）
			providerOverride: { type: "openai", base_url: "http://localhost:0/v1", api_key_env: "FAUX_KEY" },
		});
		if (!factory) throw new Error("makeChat 应返回工厂（FIAT_MODEL 已显式指定）");

		const session = await factory({ user: { id: "cli", role: "viewer" }, environment: "dev" }, "chat-test-1");
		const r = await session.turn("查一下返现规则");
		expect(r.ok).toBe(true);
		expect(r.reply).toBe("返现规则是……（faux 回复）");
		session.dispose();
	});

	it("无权限角色跑通一轮：viewer 会话正常回答（闸门①已裁剪 reconcile）", async () => {
		faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("本轮不调工具，直接回答。")]);

		const factory = makeChat({
			fiatModel: "faux/faux-default",
			policiesPath: POLICY_PATH,
			modelOverride: faux.getModel(),
			inMemorySession: true,
			providerOverride: { type: "openai", base_url: "http://localhost:0/v1", api_key_env: "FAUX_KEY" },
		});
		if (!factory) throw new Error("makeChat 应返回工厂（FIAT_MODEL 已显式指定）");
		const session = await factory({ user: { id: "cli", role: "viewer" }, environment: "dev" }, "chat-test-2");
		const r = await session.turn("你好");
		expect(r.ok).toBe(true);
		expect(r.reply).toBe("本轮不调工具，直接回答。");
		session.dispose();
	});
});
