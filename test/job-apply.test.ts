/**
 * P5-20 fiat_job_apply 端到端（faux + buildSession）。
 *
 * 流程：用组合根建会话 → 预建并提交一个已审批工单 → faux 模型调用 fiat_job_apply →
 * 断言工具真正执行底层变更（applied），并写入审计。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeAgentHooks, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { buildSession } from "../src/server/session/factory.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));

describe("P5-20 fiat_job_apply 端到端", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `job-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup() {
		const sess = await buildSession(
			{ user: { id: "u1", role: "ops" }, environment: "dev" },
			{ policiesPath: POLICY_PATH },
		);

		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: sess.extensionFactories,
		});
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: sess.sessionId,
			tools: sess.hostTools,
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		return { host, sess };
	}

	function toolResultTexts(messages: readonly unknown[]): string[] {
		return (messages as Array<{ role: string; content?: Array<{ type: string; text?: string }> }>)
			.filter((m) => m.role === "toolResult")
			.flatMap((m) => m.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
	}

	it("预建已审批工单 → fiat_job_apply 执行底层变更（applied），并写入审计", async () => {
		const { host, sess } = await setup();

		// 预建 + 审批（真实 L2 由 Lark 回调触发 approve）
		const r = await sess.approval.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x", systemOfRecord: "y", mode: "apply" },
			idempotencyKey: "e2e-k1",
			title: "t",
			summary: "s",
		});
		await sess.approval.approve(r.ticketId);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_job_apply", { ticket_id: r.ticketId, token: r.token })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await host.runTurn("执行工单");

		const texts = toolResultTexts(host.messages);
		expect(texts.length).toBeGreaterThan(0);
		const parsed = JSON.parse(texts[0] ?? "{}") as { ok: boolean };
		expect(parsed.ok).toBe(true);

		const entries = sess.auditClient.entries?.() ?? [];
		expect(entries.some((e) => e.outcome === "applied")).toBe(true);
	});

	it("工单未审批就调 fiat_job_apply：返回 pending_approval，不执行", async () => {
		const { host, sess } = await setup();

		const r = await sess.approval.requestApply({
			tool: "fiat_cashback_reconcile",
			subject: { userId: "u1", role: "ops", environment: "dev" },
			payload: { csv: "x", systemOfRecord: "y", mode: "apply" },
			idempotencyKey: "e2e-k2",
			title: "t",
			summary: "s",
		});
		// 不 approve

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fiat_job_apply", { ticket_id: r.ticketId, token: r.token })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await host.runTurn("执行工单");

		const texts = toolResultTexts(host.messages);
		const parsed = JSON.parse(texts[0] ?? "{}") as { ok: boolean; code?: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("pending_approval");

		const entries = sess.auditClient.entries?.() ?? [];
		expect(entries.some((e) => e.outcome === "applied")).toBe(false);
	});
});
