/**
 * P15-96 / P15-100 单测：检索工具（`host/l1b/memory-tools.ts`）。
 *
 * 本文件只钉**形状与措辞**，不钉业务：
 *
 *   - **schema 里没有隔离边界**（硬约束 3）。这一条是「模型既看不到也改不了分区」
 *     的唯一机械证据 —— 提示词的约束会被人改掉，schema 的字段表不会。
 *   - **三种「什么都没有」的措辞必须不同**（命中 / 真空 / 降级）。混在一起最典型的
 *     事故是：RAG 挂了，模型看到空结果，然后告诉用户「你之前没提过」。
 *   - **`details` 只带结构性事实**（ids / count），**不带正文**（硬约束 6）。
 *   - 越界丢弃**不告诉模型**（说了等于邀请它想办法看见那 N 条），只留宿主日志。
 */

import { describe, expect, it } from "vitest";
import { createMemoryTools, MEMORY_SEARCH_TOOL, renderOutcome } from "../src/server/host/l1b/memory-tools.ts";
import type { MemoryReadChannel, MemorySearchOptions, MemorySearchOutcome } from "../src/server/memory/store.ts";
import type { MemoryHit } from "../src/server/memory/types.ts";

// ---------------------------------------------------------------------------
// 装置：一个只实现 `MemoryReadChannel` 三个成员的假通道
// ---------------------------------------------------------------------------

const COLLECTION = "fiat_memory_user_ops_a1b2c3d4";

function fakeHit(over: Partial<MemoryHit> = {}): MemoryHit {
	return {
		id: `m_${"a".repeat(32)}`,
		kind: "feedback",
		text: "上次用 forEach 被要求改成 map",
		score: 0.0164,
		scoreType: "rrf_fusion",
		status: "active",
		scope: "user",
		key: "ops_a1b2c3d4",
		createdAt: "2026-09-23T00:00:00.000Z",
		...over,
	};
}

function harness(respond: (query: string, opts?: MemorySearchOptions) => Partial<MemorySearchOutcome> = () => ({})) {
	const calls: { query: string; opts?: MemorySearchOptions }[] = [];
	const logs: { level: string; message: string }[] = [];
	const channel: MemoryReadChannel = {
		collection: COLLECTION,
		circuit: () => ({
			state: "closed",
			consecutiveFailures: 0,
			remainingCooldownMs: 0,
			shortCircuited: 0,
			openedCount: 0,
		}),
		search: async (query, opts) => {
			calls.push({ query, ...(opts ? { opts } : {}) });
			return {
				hits: [],
				collection: COLLECTION,
				count: 0,
				degraded: false,
				isolationViolations: [],
				...respond(query, opts),
			};
		},
	};
	const tools = createMemoryTools({
		channel,
		log: (level, message) => logs.push({ level, message }),
	});
	const [tool] = tools;
	if (!tool) throw new Error("harness: 记忆检索工具未注册（测试装置错误）");
	return { channel, tools, calls, logs, tool };
}

// ---------------------------------------------------------------------------
// §1 形状：隔离边界不在 schema 里
// ---------------------------------------------------------------------------

describe("P15-96① 工具 schema（硬约束 3）", () => {
	it("注册名是 `fiat_memory_search`（`policyToolName` 会剥 `fiat_` → `memory_search`）", () => {
		expect(MEMORY_SEARCH_TOOL).toBe("fiat_memory_search");
		expect(harness().tool.name).toBe(MEMORY_SEARCH_TOOL);
	});

	it("★ schema 参数只有 query / kinds / top_k —— **没有** scope / key / collection / user_id", () => {
		const { tool } = harness();
		const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(props).sort()).toEqual(["kinds", "query", "top_k"]);

		// 逐字扫一遍整个 schema 文本：漏一个字段名就等于给「换个分区」留了语法
		const schemaText = JSON.stringify(tool.parameters);
		for (const banned of ["scope", "key", "collection", "partition", "user_id", "userId"]) {
			expect(schemaText).not.toContain(banned);
		}
	});

	it("`query` 是必填项（否则工具对模型而言是「可以空调用」的）", () => {
		const { tool } = harness();
		expect((tool.parameters as { required?: string[] }).required).toEqual(["query"]);
	});

	it("闸门①：`allowedTools` 返回 false 时**完全不注册**（模型看不到，比被拒更省）", () => {
		const tools = createMemoryTools({ channel: harness().channel, allowedTools: () => false });
		expect(tools).toEqual([]);
	});

	it("闸门①：允许时注册，且**只注册一个**工具（写 / 忘在这条链上不存在）", () => {
		const tools = createMemoryTools({ channel: harness().channel, allowedTools: () => true });
		expect(tools).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// §2 执行：参数透传 + details 的边界
// ---------------------------------------------------------------------------

describe("P15-96② 执行（参数透传 / details 只带结构性事实）", () => {
	it("kinds / top_k 透传为 store 侧的 camelCase（`topK`）", async () => {
		const h = harness(() => ({ hits: [fakeHit()], count: 1 }));
		await h.tool.execute("c1", { query: "编码风格", kinds: ["feedback"], top_k: 3 });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.query).toBe("编码风格");
		expect(h.calls[0]?.opts).toEqual({ kinds: ["feedback"], topK: 3 });
	});

	it("kinds 缺失时不传 `kinds`（由 store 侧决定范围，不在这里塞默认值）", async () => {
		const h = harness();
		await h.tool.execute("c1", { query: "x" });
		expect(h.calls[0]?.opts).toEqual({});
	});

	it("★ `details` 带 id 但**不带正文**（硬约束 6：正文不进审计 / span）", async () => {
		const secret = "上次用 forEach 被要求改成 map";
		const h = harness(() => ({ hits: [fakeHit({ text: secret })], count: 1 }));
		const r = await h.tool.execute("c1", { query: "风格" });
		const details = r.details as { memorySearch: { ids: string[]; count: number; degraded: boolean } };
		expect(details.memorySearch.count).toBe(1);
		expect(details.memorySearch.ids).toEqual([`m_${"a".repeat(32)}`]);
		expect(JSON.stringify(details)).not.toContain(secret);
	});

	it("越界结果**不告诉模型**，只留 error 级宿主日志（说了等于邀请它想办法看见那几条）", async () => {
		const violation = { id: `m_${"b".repeat(32)}`, reason: "scope 越界" };
		const h = harness(() => ({ hits: [fakeHit()], count: 1, isolationViolations: [violation] }));
		const r = await h.tool.execute("c1", { query: "风格" });
		const block = r.content[0] as { text: string };

		// 强断言：输出**逐字等于**「没有违规」时的输出 —— 即违规对模型完全不可见。
		// （弱一点的 `not.toContain("越界")` 挡不住「另有 N 条被丢弃」这种泄漏。）
		const clean = renderOutcome(
			{ hits: [fakeHit()], collection: COLLECTION, count: 1, degraded: false, isolationViolations: [] },
			"风格",
		);
		expect(block.text).toBe(clean);

		expect(h.logs.some((l) => l.level === "error" && l.message.includes("越界"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// §3 三种「什么都没有」必须说得不一样
// ---------------------------------------------------------------------------

describe("P15-96③ 三种空/满的措辞", () => {
	it("命中：逐条列出 + **带 id** + 说明分数语义（RRF 融合分不是置信度）", () => {
		const text = renderOutcome(
			{
				hits: [fakeHit()],
				collection: COLLECTION,
				count: 1,
				degraded: false,
				isolationViolations: [],
			},
			"风格",
		);
		expect(text).toContain(`m_${"a".repeat(32)}`);
		expect(text).toContain("[feedback]");
		expect(text).toContain("融合分");
	});

	it("真空：明说「没有匹配」并回显查询词（空结果最常见的成因是 query 写偏了）", () => {
		const text = renderOutcome(
			{ hits: [], collection: COLLECTION, count: 0, degraded: false, isolationViolations: [] },
			"返现规则",
		);
		expect(text).toContain("没有找到");
		expect(text).toContain("返现规则");
		expect(text).not.toContain("不可用");
	});

	it("★ 降级：明说「暂不可用」+ **不要据此否定用户**（这一句是这条分支存在的全部理由）", () => {
		const text = renderOutcome(
			{
				hits: [],
				collection: COLLECTION,
				count: 0,
				degraded: true,
				error: "读通道不可用",
				isolationViolations: [],
			},
			"风格",
		);
		expect(text).toContain("暂不可用");
		expect(text).toContain("读通道不可用");
		expect(text).toContain("不代表用户没说过");
		expect(text).not.toContain("没有找到");
	});

	it("长查询词会被截断（回显不该把工具输出撑大）", () => {
		const long = "很".repeat(200);
		const text = renderOutcome(
			{ hits: [], collection: COLLECTION, count: 0, degraded: false, isolationViolations: [] },
			long,
		);
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(long.length);
	});
});
