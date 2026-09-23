/**
 * P15-100 单测：**用户维度记忆隔离**（本阶段最该被测的一类）。
 *
 * 需求原话（`DEV_SPEC.md` §15.13）：
 *
 *   > `memory-isolation.test.ts`（必测：user A 写的记忆，user B 检索不到）
 *
 * ### 为什么这条不能只靠单测「函数返回了正确的 key」
 *
 * 「传对 key」是**一道**防线，而设计里有三道（§15 硬约束 3 / 15 / 契约 7）：
 *
 *   | 防线 | 位置 | 失效时的样子 |
 *   |---|---|---|
 *   | ① 物理分区 | collection = `fiat_memory_<scope>_<safeKey>` | A 的记忆落在 B 的分区里 |
 *   | ② 闭包注入 | `scope`/`key` 不在任何 schema 里 | 模型/调用方能「指定别人的分区」 |
 *   | ③ 后置校验 | 返回体逐字比对，不等即丢 | 对端返回了别人的条目，本侧照单全收 |
 *
 * 只测 ① 的话，②③ 任何一道被改坏都不会有人发现 —— 而三道里**任何一道单独失效**
 * 都足以造成越界。所以本文件对每一道都给了一条「故意让它坏」的用例：
 * ① 用真实分区语义的假服务（不喂脚本化返回体）；② 用两个不同身份跑同一套代码；
 * ③ 打开假服务的 `leakPartition`，让它**真的返回别人的条目**。
 *
 * 为什么 ③ 值得单独写：越界结果的失效是**静默的** —— 它不会抛、不会报错，
 * 只会让 B 看到 A 的一句话。没有这条用例，第 ③ 道防线就只能靠读代码来相信。
 */

import { describe, expect, it } from "vitest";
import type { MemoryWritePlan } from "../src/server/memory/extractor.ts";
import { composeHotSegment } from "../src/server/memory/hot.ts";
import { resolveMemoryIdentity } from "../src/server/memory/identity.ts";
import { MemoryStoreBridge } from "../src/server/memory/store.ts";
import { DEFAULT_MEMORY_CONFIG, type MemoryEntry } from "../src/server/memory/types.ts";
import { FakeMemoryServer } from "./memory-fake-mcp.ts";

const CONFIG = { ...DEFAULT_MEMORY_CONFIG, enabled: true };

/** 两个用户两个分区：唯一构造点 `resolveMemoryIdentity`，不给任何手拼的机会 */
const identityA = resolveMemoryIdentity({ user: { id: "alice" } }, {}, {});
const identityB = resolveMemoryIdentity({ user: { id: "bob" } }, {}, {});

function bridgeFor(server: FakeMemoryServer, identity: ReturnType<typeof resolveMemoryIdentity>): MemoryStoreBridge {
	return new MemoryStoreBridge({
		rag: { transport: "stdio" },
		memory: CONFIG,
		identity,
		clientFactory: server.clientFactory,
	});
}

/** 一条合格的 `MemoryEntry`：key 用**原始** key（`store.ts` 的 preflight 比的是原始值） */
function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: `m_${"a".repeat(32)}`,
		scope: "user",
		key: identityA.key,
		kind: "user",
		text: "用户偏好函数式风格，不喜欢命令式循环",
		evidence: { sessionId: "s-alice-1", userId: "alice", createdAt: "2026-09-23T00:00:00.000Z", trigger: "correction" },
		confidence: 0.9,
		supersedes: [],
		status: "active",
		usedCount: 0,
		...over,
	};
}

const plan = (...items: MemoryWritePlan["items"]): MemoryWritePlan => ({ items });

/** 把 A 的一条记忆写进去（走桥，不经任何模型），并断言它**真的**落进了 A 的分区 */
async function writeA(server: FakeMemoryServer, bridge: MemoryStoreBridge): Promise<void> {
	const report = await bridge.write(plan({ entry: entry(), supersedes: [] }), identityA);
	expect(report.stored).toEqual([entry().id]);
	expect(report.failed).toEqual([]);
	expect(server.has("user", identityA.safeKey, entry().id)).toBe(true);
}

describe("P15-100① 物理分区：A 写的记忆落在 A 的分区里", () => {
	it("两个身份得到**两个不同的 collection**（同 scope，不同 safeKey）", () => {
		expect(identityA.collection).not.toBe(identityB.collection);
		expect(identityA.collection).toContain(identityA.safeKey);
		expect(identityB.collection).toContain(identityB.safeKey);
	});

	it("写入请求里给的是 **sanitize 后** 的 key，不是原始 userId（RAG 侧只接受 [a-z0-9_-]）", async () => {
		const server = new FakeMemoryServer();
		const bridge = bridgeFor(server, identityA);
		await writeA(server, bridge);

		expect(server.lastArgs().key).toBe(identityA.safeKey);
		expect(server.lastArgs().scope).toBe("user");
		// 契约 1：**不给 collection** —— 拼 collection 是 RAG 的职责
		expect(server.lastArgs()).not.toHaveProperty("collection");
		// 物理结果：条目真的在 A 的分区里
		expect(server.active("user", identityA.safeKey)).toHaveLength(1);
		expect(server.active("user", identityB.safeKey)).toHaveLength(0);
	});
});

describe("P15-100② 隔离的核心断言：A 写的，B 检索不到", () => {
	it("★ 同一个假服务、同一句查询：A 召回得到，B 一条都拿不到（且不是降级）", async () => {
		const server = new FakeMemoryServer();
		const a = bridgeFor(server, identityA);
		await writeA(server, a);

		const query = "我的编码风格偏好";
		const fromA = await a.search(query);
		expect(fromA.degraded).toBe(false);
		expect(fromA.hits.map((h) => h.id)).toEqual([entry().id]);

		const fromB = await bridgeFor(server, identityB).search(query);
		// 关键：B 的空结果必须是「真没有」，**不是**「检索挂了」——
		// 两者在业务上的含义完全相反（后者不得据此否定用户）
		expect(fromB.degraded).toBe(false);
		expect(fromB.hits).toEqual([]);
		expect(fromB.count).toBe(0);
		expect(fromB.isolationViolations).toEqual([]);
	});

	it("B 的检索请求里带的是 **B 自己的** collection 键（不是 A 的）", async () => {
		const server = new FakeMemoryServer();
		await writeA(server, bridgeFor(server, identityA));
		const b = bridgeFor(server, identityB);
		await b.search("编码风格");

		const searchCall = server.callsOf("memory_search")[0];
		expect(searchCall?.key).toBe(identityB.safeKey);
		expect(JSON.stringify(searchCall)).not.toContain(identityA.safeKey);
	});

	it("B 用 A 的 entry_id 去 forget 只会得到 `not_found`（属主校验靠分区天然提供，契约 7）", async () => {
		const server = new FakeMemoryServer();
		const a = bridgeFor(server, identityA);
		await writeA(server, a);

		const result = await bridgeFor(server, identityB).forget([entry().id]);
		expect(result.forgotten).toBe(0);
		expect(result.notFound).toEqual([entry().id]);
		// A 的条目**还在** —— 撤销没有越界生效
		expect(server.active("user", identityA.safeKey)).toHaveLength(1);
	});

	it("热注入同样隔离：A 的会话拿到含记忆的段，B 的是空串", async () => {
		const server = new FakeMemoryServer();
		await writeA(server, bridgeFor(server, identityA));

		const hotA = await composeHotSegment(bridgeFor(server, identityA).readChannel(), CONFIG);
		expect(hotA).toContain("跨会话记忆");
		expect(hotA).toContain("偏好函数式风格");
		// 热注入段刻意**不带 id**（进 systemPrompt，每轮都发；引用具体条目走工具）
		expect(hotA).not.toContain(entry().id);

		const hotB = await composeHotSegment(bridgeFor(server, identityB).readChannel(), CONFIG);
		expect(hotB).toBe("");
	});
});

describe("P15-100③ 第 ③ 道防线：对端返回了别人的条目 → 丢弃 + 留证", () => {
	it("★ 恶意/有 bug 的对端把 A 的条目塞给 B：B 的 `hits` 仍为空，且 `isolationViolations` 记下证据", async () => {
		const server = new FakeMemoryServer();
		await writeA(server, bridgeFor(server, identityA));
		// 假装对端被改坏：检索时不按分区过滤，把所有分区的条目都返回
		server.leakPartition = true;

		const fromB = await bridgeFor(server, identityB).search("编码风格偏好");
		expect(fromB.hits).toEqual([]);
		expect(fromB.count).toBe(0);
		expect(fromB.isolationViolations).toHaveLength(1);
		expect(fromB.isolationViolations[0]?.id).toBe(entry().id);
		// 证据要能说明**哪一项越界**（不是笼统的「有一条不对」）
		expect(fromB.isolationViolations[0]?.reason).toContain("key 越界");
		// 丢弃是丢弃，**不是抛**（硬约束 15：检索侧永不抛）
		expect(fromB.degraded).toBe(false);
	});

	it("对端漏掉 `scope` / `key` 字段时同样丢弃（fail-closed：无从比对的安全解是不放行）", async () => {
		const server = new FakeMemoryServer();
		await writeA(server, bridgeFor(server, identityA));
		// 直接篡改分区里的字段，模拟「返回体里没有隔离标识」
		const stored = server.active("user", identityA.safeKey)[0];
		if (!stored) throw new Error("前置条件失败：A 的条目没写进去");
		(stored as unknown as Record<string, unknown>).key = "";

		// A 自己去检索也拿不到它 —— fail-closed 不区分「谁在问」
		const fromA = await bridgeFor(server, identityA).search("编码风格偏好");
		expect(fromA.hits).toEqual([]);
		expect(fromA.isolationViolations[0]?.reason).toContain("缺少 scope/key");
	});
});

describe("P15-100④ 关记忆时：零请求、零分区", () => {
	it("`config.enabled=false` 时检索不发任何请求，且结果标记为降级（不是「没有记忆」）", async () => {
		const server = new FakeMemoryServer();
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
			identity: identityA,
			clientFactory: server.clientFactory,
		});
		const outcome = await bridge.search("任意");
		expect(outcome.degraded).toBe(true);
		expect(outcome.error).toContain("记忆未启用");
		expect(server.calls).toEqual([]); // ← 关着就是一次请求都不发
	});
});
