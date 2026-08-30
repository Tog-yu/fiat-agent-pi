import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelloExtension } from "../workspace/pi-extensions/hello.ts";

interface CapturedTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

describe("P0-3 hello 扩展加载链路", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-hello-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("① 通过 Pi 真实加载链路注册 fiat_hello 工具", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [createHelloExtension({ greeting: "Test" })],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		if (!model) throw new Error("test model unavailable");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});

		// 工具经 Pi 加载链路被发现并注册
		expect(session.getAllTools().map((t) => t.name)).toContain("fiat_hello");
		expect(session.getActiveToolNames()).toContain("fiat_hello");
		// system prompt 中也应出现该工具的 snippet
		expect(session.systemPrompt).toContain("fiat_hello");

		session.dispose();
	});

	it("② 扩展工厂注入 deps 并注册可执行的工具", async () => {
		// 用 mock ExtensionAPI 捕获注册的工具，直接调用其 execute 验证逻辑与 DI
		const registered: CapturedTool[] = [];
		const pi = {
			registerTool: (t: CapturedTool) => registered.push(t),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		createHelloExtension({ greeting: "Fiat" })(pi);

		const hello = registered.find((t) => t.name === "fiat_hello");
		expect(hello).toBeDefined();
		if (!hello) throw new Error("fiat_hello was not registered");

		const result = (await hello.execute("call-1", { name: "World" }, undefined, undefined, {})) as {
			content: Array<{ type: string; text: string }>;
			details: { greeted: string };
		};

		expect(result.content[0].text).toBe("Fiat, World!");
		expect(result.details).toMatchObject({ greeted: "World" });
	});
});
