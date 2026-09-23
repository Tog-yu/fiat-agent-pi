/**
 * P15-97 / P15-100 端到端：**组合根**（`session/factory.ts` 的 `buildSession`）的记忆接线。
 *
 * 为什么这一层必须单独测（而不是相信「各模块单测都绿了」）：
 *
 *   单测各自绿、组合根漏接，是本阶段**最可能**的失效形态，因为接线点分散在四个地方：
 *   ① 工具注册（`createMemoryTools`）② 热注入（`composeHotSegment`）
 *   ③ 身份派生（`resolveMemoryIdentity(subject)`）④ 缺省关时的**完全不装配**。
 *   漏掉 ①②④ 任何一处，症状都是「单测全绿、跑起来没有记忆」——而 ④ 漏掉的症状反过来：
 *   「关着记忆却在注册工具」，会污染现有会话（硬约束 7 要求关时零行为变化）。
 *
 * 这里刻意用**真实** `buildSession` + **真实** `MemoryStoreBridge` + 假 MCP 服务，
 * 只有 MCP 那一跳是假的 —— 于是断言的就是「接线真的接上了」，而不是「我 mock 了它」。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEMORY_SEARCH_TOOL } from "../src/server/host/l1b/memory-tools.ts";
import type { HostTool } from "../src/server/host/tools.ts";
import { loadMemoryConfig } from "../src/server/memory/config.ts";
import { resolveMemoryIdentity } from "../src/server/memory/identity.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/memory/types.ts";
import {
	buildSession,
	type MemoryWiring,
	type SessionFactoryResult,
	type SessionSubject,
} from "../src/server/session/factory.ts";
import { FakeMemoryServer } from "./memory-fake-mcp.ts";

const POLICY_PATH = fileURLToPath(new URL("../config/tool_policies.yaml", import.meta.url));
const MEMORY_CONFIG_PATH = fileURLToPath(new URL("../config/memory.yaml", import.meta.url));

/** `memory_search` 的 `allowed_roles` 是 `[oncall, ops, viewer]` —— 取 `ops` */
const ALICE: SessionSubject = { user: { id: "alice", role: "ops" }, environment: "dev" };
const BOB: SessionSubject = { user: { id: "bob", role: "ops" }, environment: "dev" };

const CONFIG = { ...DEFAULT_MEMORY_CONFIG, enabled: true };
const MEMORY_ID = `m_${"a".repeat(32)}`;

/** 起一个组合根，返回它的记忆接线与工具表 */
async function session(
	subject: SessionSubject,
	server: FakeMemoryServer,
	opts: { enabled?: boolean; sessionId?: string } = {},
) {
	return buildSession(subject, {
		policiesPath: POLICY_PATH,
		sessionId: opts.sessionId ?? "s-1",
		memory: {
			config: { ...CONFIG, enabled: opts.enabled ?? true },
			clientFactory: server.clientFactory,
			log: () => {},
		},
	});
}

/** 预置一条「上一轮会话写下的」记忆 */
function seed(server: FakeMemoryServer, subject: SessionSubject): string {
	const identity = resolveMemoryIdentity(subject, {}, {});
	server.seed("user", identity.safeKey, {
		id: MEMORY_ID,
		kind: "user",
		text: "用户偏好函数式编码风格，不喜欢命令式循环",
	});
	return identity.safeKey;
}

/** 断言记忆接线**存在**（把 `[!]` 换成一次带原因的收窄，失败时报的是原因而不是 `undefined.x`） */
function wiring(built: SessionFactoryResult): MemoryWiring {
	if (!built.memory) throw new Error("前置断言失败：记忆接线缺失（buildSession 没有装配 memory）");
	return built.memory;
}

/** 取指定注册名的工具；不存在即失败（顺带证明「它真的被注册了」） */
function tool(built: SessionFactoryResult, name: string): HostTool {
	const found = built.hostTools.find((t) => t.name === name);
	if (!found) throw new Error(`前置断言失败：工具未注册 ${name}`);
	return found;
}

describe("P15-100⑤ 组合根：缺省关记忆（硬约束 7）", () => {
	it("★ 关记忆时 `memory` 接线**不存在**，且工具表里没有 `fiat_memory_search`", async () => {
		const server = new FakeMemoryServer();
		const built = await session(ALICE, server, { enabled: false });

		expect(built.memory).toBeUndefined();
		expect(built.hostTools.map((t) => t.name)).not.toContain(MEMORY_SEARCH_TOOL);
		expect(server.calls).toEqual([]); // ← 一次请求都不发
	});

	it("`config/memory.yaml` 的缺省确实是**关**（否则上面那条测试会在真实配置下失效）", () => {
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, {}).enabled).toBe(false);
	});

	it("关记忆时工具表非空（mcp-rag 等照常注册）—— 证明上面不是「整个工具表都空了」", async () => {
		const built = await session(ALICE, new FakeMemoryServer(), { enabled: false });
		// 至少还有 L1b 的其它工具（RAG 查询 / fiat 工具），只是没有记忆那一个
		expect(built.hostTools.length).toBeGreaterThan(0);
		expect(built.hostTools.map((t) => t.name)).not.toContain(MEMORY_SEARCH_TOOL);
	});
});

describe("P15-100⑤ 组合根：开记忆后的四项接线", () => {
	it("① 工具注册：`fiat_memory_search` 出现在 hostTools 里（且过了闸门①）", async () => {
		const built = await session(ALICE, new FakeMemoryServer());
		expect(built.hostTools.map((t) => t.name)).toContain(MEMORY_SEARCH_TOOL);
		expect(built.memory).toBeDefined();
	});

	it('③ 身份派生：接线里的 identity 来自 subject（不是环境变量、不是 `"cli"`）', async () => {
		const built = await session(ALICE, new FakeMemoryServer());
		expect(wiring(built).identity.key).toBe("alice");
		expect(wiring(built).identity.collection).toBe(resolveMemoryIdentity(ALICE, {}, {}).collection);
	});

	it("② 热注入：段里出现该用户的记忆，且**不带 id**（进 systemPrompt，每轮都发）", async () => {
		const server = new FakeMemoryServer();
		seed(server, ALICE);
		const built = await session(ALICE, server);
		const seg = await wiring(built).hotSegment();

		expect(seg).toContain("跨会话记忆");
		expect(seg).toContain("偏好函数式编码风格");
		expect(seg).toContain("[user]");
		expect(seg).not.toContain(MEMORY_ID);
	});

	it("★ 新会话召回：**再起一个** `buildSession`（新 sessionId）照样拿到同一份记忆", async () => {
		const server = new FakeMemoryServer();
		seed(server, ALICE);

		const first = await session(ALICE, server, { sessionId: "s-1" });
		const second = await session(ALICE, server, { sessionId: "s-2" }); // ← 新会话

		const seg1 = await wiring(first).hotSegment();
		const seg2 = await wiring(second).hotSegment();
		expect(seg2).toContain("偏好函数式编码风格");
		expect(seg2).toBe(seg1); // 同一份检索 → 同一段文字（记忆不在会话状态里）
	});

	it("★ 跨用户：A 的记忆进不了 B 的热注入（在**组合根**这一层就隔离）", async () => {
		const server = new FakeMemoryServer();
		seed(server, ALICE);

		const asBob = await session(BOB, server);
		expect(asBob.memory?.identity.collection).not.toBe(resolveMemoryIdentity(ALICE, {}, {}).collection);
		expect(await wiring(asBob).hotSegment()).toBe("");
	});
});

describe("P15-100⑤ 组合根：检索工具的输出（「回答带 id 引用」的前半段）", () => {
	it("★ 模型经工具拿到的是**带 id 的**检索结果 —— 不给 id 就无法撤销（硬约束 10）", async () => {
		const server = new FakeMemoryServer();
		seed(server, ALICE);
		const built = await session(ALICE, server);

		const r = await tool(built, MEMORY_SEARCH_TOOL).execute("call-1", { query: "我的编码风格偏好" });
		const block = (r.content as { type: string; text: string }[])[0];
		expect(block?.text).toContain(MEMORY_ID);
		expect(block?.text).toContain("[user]");
		// 工具输出里**不含分区名**（契约 9：别把「这次会话属于谁」写进对话记录）
		expect(block?.text).not.toContain(resolveMemoryIdentity(ALICE, {}, {}).collection);
	});

	it("工具被 RAG 降级时，输出说明「暂不可用」而不是「没有」（否则模型会否定用户）", async () => {
		const server = new FakeMemoryServer();
		seed(server, ALICE);
		server.degrade = true;
		const built = await session(ALICE, server);

		const r = await tool(built, MEMORY_SEARCH_TOOL).execute("call-1", { query: "我的编码风格偏好" });
		const block = (r.content as { type: string; text: string }[])[0];
		expect(block?.text).toContain("暂不可用");
		expect(block?.text).not.toContain("没有找到");
	});
});

describe("P15-100⑤ 组合根：写入通道不暴露在工具表里（硬约束 1 / 12）", () => {
	it("工具表里**只有**检索工具，没有写 / 遗忘（模型不可能写出记忆）", async () => {
		const built = await session(ALICE, new FakeMemoryServer());
		const names = built.hostTools.map((t) => t.name);
		expect(names).toContain(MEMORY_SEARCH_TOOL);
		for (const banned of ["fiat_memory_store", "fiat_memory_forget", "fiat_memory_submit"]) {
			expect(names).not.toContain(banned);
		}
	});

	it("★ 会话侧的只读通道上**没有** `write` / `forget`（隔离是结构性的，不是纪律）", async () => {
		const built = await session(ALICE, new FakeMemoryServer());
		const channel = wiring(built).read;
		expect(Object.keys(channel).sort()).toEqual(["circuit", "collection", "search"]);
		// 桥本体才是写通道，而它**不在**工具能拿到的作用域里（只挂在 `memory.store`）
		expect(typeof (channel as unknown as Record<string, unknown>).write).toBe("undefined");
		expect(typeof (channel as unknown as Record<string, unknown>).forget).toBe("undefined");
	});
});
