/**
 * P12-72 单元 / 集成测试：`evolution-trigger` 计数器与 `EvolutionService` 触发阈值。
 *
 * 三块覆盖：
 *   1. **纯计数语义**（假 ExtensionAPI 直接喂事件）：`turn_end` 有 toolResults 才 +1、
 *      且**按轮计不按调用数累加**；`agent_end` 上报快照；`reset` 归零。
 *   2. **真实循环里的计数**（faux 驱动 PiHostLoop + setupEmbeddedExtensions）：
 *      验证「计数器分居两层」这件事在真实事件流里成立——L1a 看得到 toolResults，
 *      而用户轮次只有宿主的 `onUserTurn` 知道。
 *   3. **阈值与预算**（EvolutionService）：`itersSinceSkill ≥ intervalIters` 优先于
 *      `turnsSinceMemory ≥ intervalTurns`；命中后两个计数器归零；预算用尽后跳过。
 *
 * 第 3 块用**真实的 EvolutionReviewer**（只把 `runFork` 换成假实现）——
 * 这样「触发 → 起评审 → 计数归零」是一条真链路，而不是把 reviewer mock 掉的自证。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryProposalStore, InMemoryRunStore } from "../src/server/evolution/proposalStore.ts";
import { EvolutionReviewer } from "../src/server/evolution/reviewer.ts";
import { EvolutionService } from "../src/server/evolution/service.ts";
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig, type TriggerKind } from "../src/server/evolution/types.ts";
import { bridgeAgentHooks, bridgeLifecycleEvents, setupEmbeddedExtensions } from "../src/server/host/extensions.ts";
import { createEvolutionTrigger, type EvolutionTriggerSnapshot } from "../src/server/host/l1a/evolution-trigger.ts";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { defineHostTool, type HostTool } from "../src/server/host/tools.ts";

// ---------- 1. 纯计数语义（假 ExtensionAPI） ----------

/** 最小假的 ExtensionAPI：只留 `on`，把 handler 收进表里供测试手动触发 */
function fakePi(): { pi: ExtensionAPI; fire: (type: string, event: unknown) => void } {
	const handlers = new Map<string, (e: unknown) => void>();
	const pi = {
		on: (type: string, handler: (e: unknown) => void) => {
			handlers.set(type, handler);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		fire: (type, event) => {
			const h = handlers.get(type);
			if (!h) throw new Error(`no handler for ${type}`);
			h(event);
		},
	};
}

function turnEnd(toolResults: unknown[]) {
	return { type: "turn_end", turnIndex: 1, message: {}, toolResults };
}

describe("P12-63 evolution-trigger：计数语义", () => {
	it("turn_end 无 toolResults → 不推进工具迭代，但 turn 数 +1", () => {
		const t = createEvolutionTrigger();
		const { pi, fire } = fakePi();
		t.factory(pi);
		fire("turn_end", turnEnd([]));
		expect(t.snapshot()).toEqual({ itersSinceSkill: 0, turns: 1 });
	});

	it("turn_end 有 toolResults → itersSinceSkill +1（按轮计，不按调用数累加）", () => {
		const t = createEvolutionTrigger();
		const { pi, fire } = fakePi();
		t.factory(pi);
		// 一轮里并发 3 个工具调用 —— 仍然只算 1 次「工具迭代」（对齐 Hermes 的 _iters_since_skill）
		fire("turn_end", turnEnd([{ toolName: "a" }, { toolName: "b" }, { toolName: "c" }]));
		expect(t.snapshot().itersSinceSkill).toBe(1);
	});

	it("agent_end 上报快照（宿主在此时记下 EvolutionRun.toolSteps）", () => {
		const seen: EvolutionTriggerSnapshot[] = [];
		const t = createEvolutionTrigger({ onSnapshot: (s) => seen.push(s) });
		const { pi, fire } = fakePi();
		t.factory(pi);
		fire("turn_end", turnEnd([{ toolName: "a" }]));
		fire("turn_end", turnEnd([]));
		fire("agent_end", { type: "agent_end", messages: [] });
		expect(seen).toEqual([{ itersSinceSkill: 1, turns: 2 }]);
	});

	it("reset 归零（递归防护 / 新会话复用实例）", () => {
		const t = createEvolutionTrigger();
		const { pi, fire } = fakePi();
		t.factory(pi);
		fire("turn_end", turnEnd([{ toolName: "a" }]));
		t.reset();
		expect(t.snapshot()).toEqual({ itersSinceSkill: 0, turns: 0 });
	});
});

// ---------- 2. 真实循环里的计数（faux 驱动） ----------

describe("P12-63/65 真实循环：计数器分居两层", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-evo-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const echoTool: HostTool = defineHostTool({
		name: "echo",
		label: "Echo",
		description: "回显",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		async execute(_id, params) {
			return {
				content: [{ type: "text" as const, text: String((params as { text: string }).text) }],
				details: { echo: true },
			};
		},
	});

	it("两个用户轮各带一次工具调用 → iters=2 / turns=2；宿主 onUserTurn 也各触发一次", async () => {
		const trigger = createEvolutionTrigger();
		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: [trigger.factory],
		});

		let userTurns = 0;
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: "s-evo-trigger",
			tools: [echoTool],
			onUserTurn: () => {
				userTurns += 1;
			},
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		const unsub = bridgeLifecycleEvents(host.agent, runner);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("完成 1"),
			fauxAssistantMessage([fauxToolCall("echo", { text: "2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("完成 2"),
		]);

		await host.runTurn("第一轮");
		await host.runTurn("第二轮");

		// L1a 侧：两次带工具的轮 → 2 次工具迭代
		expect(trigger.snapshot().itersSinceSkill).toBe(2);
		// 宿主侧：两次用户轮（L1a 的 turns 是 LLM 轮 = 4，两者语义不同，这正是要分居两层的原因）
		expect(userTurns).toBe(2);
		expect(trigger.snapshot().turns).toBe(4);
		unsub();
	});

	it("纯对话轮不推进工具迭代计数", async () => {
		const trigger = createEvolutionTrigger();
		const { runner } = await setupEmbeddedExtensions({
			cwd: tempDir,
			agentDir: tempDir,
			factories: [trigger.factory],
		});
		const host = new PiHostLoop({
			model: faux.getModel(),
			getApiKey: () => "faux-key",
			sessionId: "s-evo-chat",
			tools: [echoTool],
			...bridgeAgentHooks(runner, { cwd: tempDir }),
		});
		const unsub = bridgeLifecycleEvents(host.agent, runner);
		faux.setResponses([fauxAssistantMessage("直接就答了")]);
		await host.runTurn("问个问题");
		expect(trigger.snapshot().itersSinceSkill).toBe(0);
		unsub();
	});
});

// ---------- 3. 阈值与预算（EvolutionService + 真实 reviewer） ----------

/** 用真实 EvolutionReviewer，只把 runFork 换成假实现（不产生提案，只验证触发链路） */
function makeService(config: EvolutionConfig, _opts: { onReview?: (trigger: TriggerKind) => void } = {}) {
	const trigger = createEvolutionTrigger();
	const proposals = new InMemoryProposalStore();
	const runs = new InMemoryRunStore();
	const reviewer = new EvolutionReviewer({
		proposals,
		runs,
		config,
		sessionId: "s1",
		proposer: "u1",
		runFork: async () => {
			return "本轮无提案";
		},
		transcript: () => [{ role: "user", content: [{ type: "text", text: "帮我看看" }] }],
	});
	const service = new EvolutionService({
		config,
		trigger,
		reviewer,
		proposals,
		existingSkills: () => [],
		proposer: "u1",
		sessionId: "s1",
		environment: "dev",
	});
	return { trigger, service, proposals, runs, reviewer };
}

describe("P12-63 EvolutionService：阈值与预算", () => {
	const CFG: EvolutionConfig = {
		...DEFAULT_EVOLUTION_CONFIG,
		intervalIters: 3,
		intervalTurns: 2,
		maxRunsPerSession: 2,
	};

	it("低于阈值 → skip(below_threshold)，不产生任何 run", async () => {
		const { service, runs } = makeService(CFG);
		expect(service.shouldTrigger()).toEqual({ kind: "skip", reason: "below_threshold" });
		expect(await service.afterTurn()).toBeNull();
		expect(await runs.list()).toHaveLength(0);
	});

	it("工具迭代达标优先于用户轮次（trigger=tool_iters）", async () => {
		const { service, trigger } = makeService(CFG);
		// 用宿主侧计数与 L1a 计数一起推：让两者都达标，断言取 tool_iters
		for (let i = 0; i < 3; i += 1) service.noteUserTurn();
		const { pi, fire } = fakePi();
		trigger.factory(pi);
		for (let i = 0; i < 3; i += 1) fire("turn_end", turnEnd([{ toolName: "echo" }]));

		const r = await service.afterTurn();
		expect(r?.trigger).toBe("tool_iters");
		expect(r?.run.toolSteps).toBe(3);
		expect(r?.run.status).toBe("ok");
	});

	it("只有用户轮次达标 → trigger=turn", async () => {
		const { service } = makeService(CFG);
		service.noteUserTurn();
		service.noteUserTurn();
		const r = await service.afterTurn();
		expect(r?.trigger).toBe("turn");
		expect(r?.run.turns).toBe(2);
	});

	it("触发后两个计数器归零（否则会变成每轮都评审）", async () => {
		const { service, trigger } = makeService(CFG);
		for (let i = 0; i < 3; i += 1) service.noteUserTurn();
		const { pi, fire } = fakePi();
		trigger.factory(pi);
		for (let i = 0; i < 3; i += 1) fire("turn_end", turnEnd([{ toolName: "echo" }]));

		await service.afterTurn();
		expect(trigger.snapshot().itersSinceSkill).toBe(0);
		expect(service.snapshot().turnsSinceMemory).toBe(0);
		// 再跑一次不触发
		expect(await service.afterTurn()).toBeNull();
	});

	it("预算用尽 → skip(budget_exhausted)（maxRunsPerSession=2）", async () => {
		const { service, trigger } = makeService(CFG);
		const { pi, fire } = fakePi();
		trigger.factory(pi);

		for (let n = 0; n < 2; n += 1) {
			for (let i = 0; i < 3; i += 1) fire("turn_end", turnEnd([{ toolName: "echo" }]));
			expect((await service.afterTurn())?.run.status).toBe("ok");
		}
		expect(service.snapshot().runs).toBe(2);

		for (let i = 0; i < 3; i += 1) fire("turn_end", turnEnd([{ toolName: "echo" }]));
		expect(service.shouldTrigger()).toEqual({ kind: "skip", reason: "budget_exhausted" });
		expect(await service.afterTurn()).toBeNull();
	});

	it("reviewer 抛异常时 afterTurn 返回 null（永不把旁路失败上抛）", async () => {
		const trigger = createEvolutionTrigger();
		const proposals = new InMemoryProposalStore();
		const reviewer = new EvolutionReviewer({
			proposals,
			runs: new InMemoryRunStore(),
			config: CFG,
			sessionId: "s1",
			proposer: "u1",
			runFork: async () => {
				throw new Error("fork 炸了");
			},
			transcript: () => [],
			log: () => {},
		});
		const service = new EvolutionService({
			config: CFG,
			trigger,
			reviewer,
			proposals,
			existingSkills: () => [],
			proposer: "u1",
			sessionId: "s1",
			environment: "dev",
		});
		service.noteUserTurn();
		service.noteUserTurn();
		// reviewer 内部兜底 → run.status=error，不抛；编排层拿到结果
		const r = await service.afterTurn();
		expect(r?.run.status).toBe("error");
		expect(r?.run.error).toBe("fork 炸了");
	});
});
