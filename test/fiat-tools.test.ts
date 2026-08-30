/**
 * P3-13 / P3-14 fiat 业务工具（fiat-tools 扩展）+ 三道闸门联动。
 *
 * 覆盖：
 *   - ops 调 fiat_es_search_logs：放行执行，LocalFiatClient 收到原样参数，审计记 allowed
 *   - viewer 调 fiat_es_search_logs：gate ② 按角色拦截（es_search_logs 仅 oncall/ops），审计 isError
 *   - fiat_test_env：仅 DEV 可用；prod 环境被 gate ② 按环境拦截（验收：测试工具不会误上生产）
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import { LocalFiatClient } from "../src/server/fiat-tools/client.ts";
import { LocalPolicyClient } from "../src/server/policy/client.ts";
import { createAuditHook } from "../workspace/pi-extensions/audit-hook/index.ts";
import { createFiatTools } from "../workspace/pi-extensions/fiat-tools/index.ts";
import { createPermissionGate } from "../workspace/pi-extensions/permission-gate/index.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

describe("P3-13/P3-14 fiat-tools + 三道闸门", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(role: string, environment: string) {
		const audit = new InMemoryAuditClient();
		const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
		const client = new LocalFiatClient();
		const wrapped: typeof client = {
			async execute(tool, input) {
				calls.push({ tool, input });
				return client.execute(tool, input);
			},
		};

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						createPermissionGate({
							policy: new LocalPolicyClient(POLICY_PATH),
							user: { id: "u1", role },
							environment,
							sessionId: "sess-test",
							audit,
						}),
						createFiatTools({ client: wrapped }),
						createAuditHook({ audit, user: { id: "u1", role }, environment, sessionId: "sess-test" }),
					],
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
		return { runtimeHost, calls, audit };
	}

	it("ops 调 fiat_es_search_logs：放行执行，client 收到原样参数，审计 allowed", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_es_search_logs", { index: "alerts-*", query: "level:error" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, audit } = await setup("ops", "dev");

		await runtimeHost.session.prompt("查一下 error 级告警");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.tool).toBe("fiat_es_search_logs");
		expect(calls[0]?.input).toEqual({ index: "alerts-*", query: "level:error" });
		const entries = audit.entries() ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.outcome).toBe("allowed");
		expect(entries[0]?.isError).toBe(false);

		runtimeHost.dispose();
	});

	it("viewer 调 fiat_es_search_logs：gate ② 按角色拦截，审计 isError，client 未被调", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_es_search_logs", { index: "alerts-*", query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, audit } = await setup("viewer", "dev");

		await runtimeHost.session.prompt("查一下告警");

		expect(calls).toEqual([]);
		const entries = audit.entries() ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.isError).toBe(true);
		expect(entries[0]?.detail).toContain("角色 viewer 无权");

		runtimeHost.dispose();
	});

	it("fiat_test_env：prod 环境被 gate ② 按环境拦截（仅 DEV 可用）", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_test_env", { action: "reset_data" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { runtimeHost, calls, audit } = await setup("ops", "prod");

		await runtimeHost.session.prompt("重置测试数据");

		expect(calls).toEqual([]);
		const entries = audit.entries() ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.isError).toBe(true);
		expect(entries[0]?.detail).toContain("环境 prod 不允许");

		runtimeHost.dispose();
	});
});
