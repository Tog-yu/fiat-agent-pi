import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHelloExtension } from "../workspace/pi-extensions/hello.ts";

describe("P0-4 faux provider 端到端会话", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("模型发起 fiat_hello 工具调用，Pi 执行扩展工具并回灌结果", async () => {
		const faux = registerFauxProvider();
		// 第一轮：模型要求调用 fiat_hello；第二轮：拿到工具结果后收尾
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_hello", { name: "World" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [createHelloExtension({ greeting: "Fiat" })],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		await runtimeHost.session.prompt("greet World");

		// 会话消息中应出现工具执行结果，证明模型→工具→执行的完整链路打通
		const toolResultText = runtimeHost.session.messages
			.filter((m) => m.role === "toolResult")
			.flatMap((m) => m.content)
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		expect(toolResultText).toContain("Fiat, World!");

		runtimeHost.dispose();
		faux.unregister();
	});
});
