/**
 * P15-95 单测：存储桥（`memory/store.ts`）。
 *
 * 这个模块的价值全在**边界**上，所以测试也全部针对边界：
 *
 *   - 入参形态：只给 `scope` + `key`（契约 1）、key 必须是 sanitize 后的（契约 2/3）
 *   - 出参形态：`snake_case` 只在本文件转一次；`isError` **不等于**「没有 payload」
 *   - 第 ③ 道防线：返回体里的 `scope`/`key` 与闭包身份不符 → 丢弃 + 记录 + **不抛**
 *   - 降级与熔断：`degraded` 要能驱动断路器，且熔断期内**不再发请求**
 *   - 写入门禁：越界 / 非法 id / 敏感正文一律**在本地拦掉，不发请求**
 *
 * 为什么这些用例不能靠集成测试覆盖：它们的失效都是**静默的** ——
 * 越界结果照样返回（只是返回了别人的）、熔断没接上照样能用（只是每次等 30s）、
 * 半写照样「成功」（只是检索时有时看不见）。静默失效必须靠「故意让它坏」的单测钉住。
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditClient } from "../src/server/audit/client.ts";
import type { McpClientLike, RagMcpConfig } from "../src/server/host/l1b/mcp-rag.ts";
import { MemoryCircuitBreaker } from "../src/server/memory/circuit.ts";
import type { MemoryWritePlan } from "../src/server/memory/extractor.ts";
import { resolveMemoryIdentity, sanitizeMemoryKey } from "../src/server/memory/identity.ts";
import { assertOwned, type MemoryClientRole, MemoryStoreBridge } from "../src/server/memory/store.ts";
import type { MemoryEntry, MemoryKind, MemoryStatus } from "../src/server/memory/types.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/memory/types.ts";

// ---------------------------------------------------------------------------
// 测试装置：一个可脚本化的 MCP mock（读 / 写通道分别记录）
// ---------------------------------------------------------------------------

interface Call {
	role: MemoryClientRole;
	name: string;
	args: Record<string, unknown>;
}

interface Scripted {
	/** 返回体（会被 JSON.stringify 成 text block） */
	payload?: Record<string, unknown>;
	/** 强制 isError（RAG 的降级路径都是「isError + 带 payload」） */
	isError?: boolean;
	/** 覆盖 text（模拟「非 JSON 返回体」，如 SDK 的 schema 报错） */
	text?: string;
	/** 直接抛（模拟超时 / 传输错误） */
	throw?: string;
}

type Responder = (name: string, args: Record<string, unknown>, role: MemoryClientRole) => Scripted;

function harness(opts: { userId?: string; respond?: Responder; config?: Partial<typeof DEFAULT_MEMORY_CONFIG> } = {}) {
	const calls: Call[] = [];
	let responder: Responder = opts.respond ?? (() => ({ payload: {} }));

	const clientFactory = (_cfg: RagMcpConfig, role: MemoryClientRole): McpClientLike => ({
		connect: async () => {},
		listTools: async () => ({ tools: [] }),
		callTool: async (req) => {
			calls.push({ role, name: req.name, args: req.arguments });
			const r = responder(req.name, req.arguments, role);
			if (r.throw) throw new Error(r.throw);
			const text = r.text ?? JSON.stringify(r.payload ?? {});
			return { content: [{ type: "text", text }], ...(r.isError ? { isError: true } : {}) };
		},
		close: async () => {},
	});

	const identity = resolveMemoryIdentity({ user: { id: opts.userId ?? "U-1024" } }, {}, {});
	const bridge = new MemoryStoreBridge({
		rag: { transport: "stdio" },
		memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true, ...opts.config },
		identity,
		clientFactory,
	});
	return {
		bridge,
		calls,
		identity,
		/** 重设响应脚本 */
		onRespond: (fn: Responder) => {
			responder = fn;
		},
		/** 某次调用的入参 */
		argsOf: (i = 0) => calls[i]?.args ?? {},
	};
}

/** 一条「合格的」检索命中（默认就是「自己的」，测试按需改字段） */
function hit(over: Record<string, unknown> = {}, key: string): Record<string, unknown> {
	return {
		id: `m_${"a".repeat(32)}`,
		kind: "user",
		text: "偏好函数式风格",
		score: 0.5,
		score_type: "rrf_fusion",
		status: "active",
		scope: "user",
		key,
		created_at: "2026-09-23T00:00:00.000Z",
		...over,
	};
}

function entry(
	over: Partial<MemoryEntry> = {},
	identityKey: string,
	scope: "user" | "repo" | "global" = "user",
): MemoryEntry {
	return {
		id: `m_${"b".repeat(32)}`,
		scope,
		key: identityKey,
		kind: "user",
		text: "偏好函数式风格",
		evidence: { sessionId: "s-1", userId: "U-1024", createdAt: "2026-09-23T00:00:00.000Z", trigger: "correction" },
		confidence: 0.9,
		supersedes: [],
		status: "active" as MemoryStatus,
		usedCount: 0,
		...over,
	};
}

const plan = (...items: MemoryWritePlan["items"]): MemoryWritePlan => ({ items });

// ---------------------------------------------------------------------------
// §1 契约 1/2/3：入参形态
// ---------------------------------------------------------------------------

describe("P15-95① 入参形态（契约 1 / 2 / 3）", () => {
	it("★ 检索只给 scope + key，**不给 collection**（拼 collection 是 RAG 的职责）", async () => {
		const h = harness({ respond: () => ({ payload: { hits: [], collection: "x", count: 0, degraded: false } }) });
		await h.bridge.search("代码风格");
		const args = h.argsOf();
		expect(args.scope).toBe("user");
		expect(args.key).toBe(h.identity.safeKey);
		expect(args).not.toHaveProperty("collection"); // ← 契约 1 的核心断言
	});

	it("传入的 key 是 **sanitize 后**的，不是原始 userId（RAG 侧要求 [a-z0-9_-]）", async () => {
		const h = harness({
			userId: "Alice@Example.COM",
			respond: () => ({ payload: { hits: [], collection: "x", count: 0, degraded: false } }),
		});
		await h.bridge.search("q");
		expect(h.argsOf().key).toBe(sanitizeMemoryKey("Alice@Example.COM"));
		expect(h.argsOf().key).not.toBe("Alice@Example.COM");
		expect(String(h.argsOf().key)).toMatch(/^[a-z0-9_-]+$/);
	});

	it("检索缺省不带 kinds（让 RAG 用自己的缺省）；显式给才带", async () => {
		const h = harness({ respond: () => ({ payload: { hits: [], collection: "x", count: 0, degraded: false } }) });
		await h.bridge.search("q");
		expect(h.argsOf()).not.toHaveProperty("kinds");
		await h.bridge.search("q", { kinds: ["feedback"] });
		expect(h.argsOf(1).kinds).toEqual(["feedback"]);
	});

	it("写入入参：`entry_id` 原样透传、`evidence` 转成 snake_case、`status` 恒为 active", async () => {
		const h = harness({
			respond: () => ({ payload: { stored: `m_${"b".repeat(32)}`, collection: "c", superseded: [] } }),
		});
		const e = entry({}, h.identity.key);
		await h.bridge.write(plan({ entry: e, supersedes: [] }), h.identity);
		const args = h.argsOf();
		expect(args.entry_id).toBe(e.id);
		expect(args.status).toBe("active");
		expect(args.evidence).toEqual({
			session_id: "s-1",
			user_id: "U-1024",
			created_at: "2026-09-23T00:00:00.000Z",
			trigger: "correction",
		});
		expect(args).not.toHaveProperty("promoted_from"); // 空数组不带
		expect(args).not.toHaveProperty("supersedes");
	});

	it("写入入参：`supersedes` / `promoted_from` 非空才带，且与 entry 上的一致", async () => {
		const h = harness({
			respond: () => ({ payload: { stored: `m_${"b".repeat(32)}`, collection: "c", superseded: [] } }),
		});
		const ids = [`m_${"c".repeat(32)}`, `m_${"d".repeat(32)}`];
		const e = entry({ promotedFrom: ids }, h.identity.key);
		await h.bridge.write(plan({ entry: e, supersedes: ids }), h.identity);
		expect(h.argsOf().supersedes).toEqual(ids);
		expect(h.argsOf().promoted_from).toEqual(ids);
	});
});

// ---------------------------------------------------------------------------
// §2 第 ③ 道防线：后置校验（硬约束 15）
// ---------------------------------------------------------------------------

describe("P15-95② 第 ③ 道防线：返回体后置校验", () => {
	it("★ scope 越界的命中被丢弃 + 记 isolationViolation + **不抛**", async () => {
		const h = harness({
			respond: () => ({
				payload: { hits: [hit({ scope: "global" }, h0key())], collection: "c", count: 1, degraded: false },
			}),
		});
		const out = await h.bridge.search("q");
		expect(out.hits).toHaveLength(0);
		expect(out.degraded).toBe(false); // 不是降级 —— 是「有结果但都被拦了」
		expect(out.isolationViolations).toHaveLength(1);
		expect(out.isolationViolations[0]?.reason).toMatch(/scope 越界/);
	});

	it("★ key 越界（别人的分区）被丢弃 —— 这就是「user A 写的记忆 user B 检索不到」", async () => {
		const h = harness({
			respond: () => ({
				payload: { hits: [hit({}, "someone_else_key")], collection: "c", count: 1, degraded: false },
			}),
		});
		const out = await h.bridge.search("q");
		expect(out.hits).toHaveLength(0);
		expect(out.isolationViolations[0]?.reason).toMatch(/key 越界/);
	});

	it("缺 scope / key 的命中 **fail-closed** 丢弃（无从比对的安全解是丢弃）", async () => {
		const h = harness({
			respond: () => ({
				payload: {
					hits: [hit({ scope: undefined }, undefined as unknown as string), { id: "m_x", text: "t" }],
					collection: "c",
					count: 2,
					degraded: false,
				},
			}),
		});
		const out = await h.bridge.search("q");
		expect(out.hits).toHaveLength(0);
		expect(out.isolationViolations).toHaveLength(2);
		expect(out.isolationViolations[0]?.reason).toMatch(/缺少 scope\/key/);
	});

	it("混合结果：只有越界的被丢，合规的照常返回（拦一条不该拖累整批）", async () => {
		const h = harness({
			respond: () => ({
				payload: {
					hits: [
						hit({ id: `m_${"1".repeat(32)}` }, h0key()),
						hit({ id: `m_${"2".repeat(32)}` }, "other"),
						hit({ id: `m_${"3".repeat(32)}` }, h0key()),
					],
					collection: "c",
					count: 3,
					degraded: false,
				},
			}),
		});
		const out = await h.bridge.search("q");
		expect(out.hits.map((x) => x.id)).toEqual([`m_${"1".repeat(32)}`, `m_${"3".repeat(32)}`]);
		expect(out.count).toBe(2);
		expect(out.isolationViolations).toHaveLength(1);
	});

	it("`assertOwned` 是纯函数且**不做大小写折叠**（折叠会掩盖「对端改了我的 key」）", () => {
		const id = resolveMemoryIdentity({ user: { id: "Alice" } }, {}, {});
		expect(assertOwned({ scope: "user", key: id.safeKey }, id)).toBeNull();
		expect(assertOwned({ scope: "user", key: id.safeKey.toUpperCase() }, id)).toMatch(/key 越界/);
		expect(assertOwned({ scope: "repo", key: id.safeKey }, id)).toMatch(/scope 越界/);
		expect(assertOwned({}, id)).toMatch(/缺少 scope\/key/);
	});

	/** 装置里第一个身份的 safeKey（`hit()` 缺省 key 用不到，因为总是显式传） */
	function h0key(): string {
		return resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {}).safeKey;
	}
});

// ---------------------------------------------------------------------------
// §3 降级与熔断
// ---------------------------------------------------------------------------

describe("P15-95③ 降级（永不抛）与熔断驱动", () => {
	it("★ 对端 `degraded=true`（isError + 带 payload）→ degraded 空结果，**不是抛**", async () => {
		const h = harness({
			respond: () => ({
				payload: { hits: [], collection: "c", count: 0, degraded: true, error: "chroma 挂了" },
				isError: true,
			}),
		});
		const out = await h.bridge.search("q");
		expect(out.degraded).toBe(true);
		expect(out.error).toMatch(/chroma 挂了/);
		expect(out.hits).toEqual([]);
	});

	it("超时 / 传输错误 → degraded（不抛）", async () => {
		const h = harness({ respond: () => ({ throw: "记忆 MCP memory_search 超时（30000ms）" }) });
		const out = await h.bridge.search("q");
		expect(out.degraded).toBe(true);
		expect(out.error).toMatch(/超时/);
	});

	it("返回体不是 JSON（SDK schema 层的纯文本报错）→ degraded，不抛", async () => {
		const h = harness({ respond: () => ({ text: "Input validation error: scope 不是合法枚举" }) });
		const out = await h.bridge.search("q");
		expect(out.degraded).toBe(true);
		expect(out.degraded && out.error).toMatch(/无法解析/);
	});

	it("★ 连续失败达阈值 → 熔断；熔断期内**不再发出请求**（这才是「快速降级」）", async () => {
		const breaker = new MemoryCircuitBreaker({ threshold: 3, cooldownMs: 120_000 });
		const calls: Call[] = [];
		const identity = resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {});
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity,
			circuit: breaker,
			clientFactory: (_cfg, role) => ({
				connect: async () => {},
				listTools: async () => ({ tools: [] }),
				callTool: async (req) => {
					calls.push({ role, name: req.name, args: req.arguments });
					return {
						content: [{ type: "text", text: JSON.stringify({ hits: [], degraded: true, error: "down" }) }],
						isError: true,
					};
				},
				close: async () => {},
			}),
		});

		for (let i = 0; i < 3; i += 1) {
			const out = await bridge.search("q");
			expect(out.degraded).toBe(true);
		}
		expect(breaker.snapshot().state).toBe("open");
		const sentBefore = calls.length;

		const out = await bridge.search("q");
		expect(out.degraded).toBe(true);
		expect(out.error).toMatch(/熔断/);
		expect(calls.length).toBe(sentBefore); // ← 关键：没有再发请求
		expect(breaker.snapshot().shortCircuited).toBe(1);
	});

	it("一次成功把连续失败归零（成功过的服务不该被历史失败拖进熔断）", async () => {
		let failing = true;
		const breaker = new MemoryCircuitBreaker({ threshold: 2 });
		const identity = resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {});
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity,
			circuit: breaker,
			clientFactory: () => ({
				connect: async () => {},
				listTools: async () => ({ tools: [] }),
				callTool: async () => {
					if (failing) throw new Error("boom");
					return {
						content: [{ type: "text", text: JSON.stringify({ hits: [], collection: "c", count: 0, degraded: false }) }],
					};
				},
				close: async () => {},
			}),
		});
		await bridge.search("q");
		failing = false;
		await bridge.search("q");
		expect(breaker.snapshot().consecutiveFailures).toBe(0);
		expect(breaker.snapshot().state).toBe("closed");
	});

	it("记忆未启用 → degraded（**不是**空结果：两者语义不同）", async () => {
		const h = harness({ respond: () => ({ payload: {} }), config: { enabled: false } });
		const out = await h.bridge.search("q");
		expect(out.degraded).toBe(true);
		expect(out.error).toMatch(/未启用/);
		expect(h.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// §4 写入门禁
// ---------------------------------------------------------------------------

describe("P15-95④ 写入门禁（本地先拦，不发请求）", () => {
	it("成功写入 → stored / superseded 收集（superseded 去重）", async () => {
		const h = harness({
			respond: () => ({
				payload: { stored: `m_${"b".repeat(32)}`, collection: "c", superseded: [`m_${"c".repeat(32)}`] },
			}),
		});
		const r = await h.bridge.write(plan({ entry: entry({}, h.identity.key), supersedes: [] }), h.identity);
		expect(r.stored).toEqual([`m_${"b".repeat(32)}`]);
		expect(r.superseded).toEqual([`m_${"c".repeat(32)}`]);
		expect(r.failed).toEqual([]);
	});

	it("★ 半写（isError + dense_ok=false）→ 记 failed 且措辞含「半写」；**不当成成功**", async () => {
		const h = harness({
			respond: () => ({
				payload: {
					stored: `m_${"b".repeat(32)}`,
					collection: "c",
					superseded: [],
					dense_ok: true,
					sparse_ok: false,
					errors: ["bm25 建索引失败"],
				},
				isError: true,
			}),
		});
		const r = await h.bridge.write(plan({ entry: entry({}, h.identity.key), supersedes: [] }), h.identity);
		expect(r.stored).toEqual([]);
		expect(r.failed).toHaveLength(1);
		expect(r.failed[0]?.error).toMatch(/半写/);
		expect(r.failed[0]?.error).toMatch(/bm25 建索引失败/);
		expect(r.failed[0]?.id).toBe(`m_${"b".repeat(32)}`); // 同一个 id 重试即自愈
	});

	it("★ 非法 id 形态 → 本地拦掉，**一个请求都不发**（契约 3）", async () => {
		const h = harness({ respond: () => ({ payload: { stored: "x", collection: "c", superseded: [] } }) });
		const r = await h.bridge.write(
			plan({ entry: entry({ id: "m_short" }, h.identity.key), supersedes: [] }),
			h.identity,
		);
		expect(h.calls).toHaveLength(0);
		expect(r.failed[0]?.error).toMatch(/id 形态非法/);
	});

	it("★ 越界 entry（分区与绑定身份不符）→ 本地拦掉，不发请求", async () => {
		const h = harness({ respond: () => ({ payload: { stored: "x", collection: "c", superseded: [] } }) });
		const r = await h.bridge.write(plan({ entry: entry({}, "someone_else"), supersedes: [] }), h.identity);
		expect(h.calls).toHaveLength(0);
		expect(r.failed[0]?.error).toMatch(/越界写入已拦截/);
	});

	it("★ 含敏感形态的正文 → 本地拦掉（第一条防线），不发请求", async () => {
		const h = harness({ respond: () => ({ payload: { stored: "x", collection: "c", superseded: [] } }) });
		const r = await h.bridge.write(
			plan({ entry: entry({ text: "客户手机号 13800138000 别写错" }, h.identity.key), supersedes: [] }),
			h.identity,
		);
		expect(h.calls).toHaveLength(0);
		expect(r.failed[0]?.error).toMatch(/候选校验未通过/);
	});

	it("supersedes 里含非法 id → 本地拦掉（否则 RAG 侧会误删他人条目）", async () => {
		const h = harness({ respond: () => ({ payload: { stored: "x", collection: "c", superseded: [] } }) });
		const r = await h.bridge.write(plan({ entry: entry({}, h.identity.key), supersedes: ["m_too_short"] }), h.identity);
		expect(h.calls).toHaveLength(0);
		expect(r.failed[0]?.error).toMatch(/supersedes 含非法 id/);
	});

	it("合格正文**原样**发出（二次脱敏在现有校验下是 no-op，不得改动正文）", async () => {
		const h = harness({
			respond: () => ({ payload: { stored: `m_${"b".repeat(32)}`, collection: "c", superseded: [] } }),
		});
		const text = "偏好函数式风格：用 map 而不是 forEach";
		await h.bridge.write(plan({ entry: entry({ text }, h.identity.key), supersedes: [] }), h.identity);
		expect(h.argsOf().text).toBe(text);
	});

	it("写通道 connect 失败 → 逐条记 failed，**不抛**（传输层问题不该炸掉整轮）", async () => {
		const identity = resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {});
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity,
			clientFactory: () => ({
				connect: async () => {
					throw new Error("ECONNREFUSED");
				},
				listTools: async () => ({ tools: [] }),
				callTool: async () => ({ content: [] }),
				close: async () => {},
			}),
		});
		const r = await bridge.write(plan({ entry: entry({}, identity.key), supersedes: [] }), identity);
		expect(r.failed[0]?.error).toMatch(/写通道不可用/);
	});

	it("空计划 → 空报告，且不发请求", async () => {
		const h = harness({ respond: () => ({ payload: {} }) });
		const r = await h.bridge.write({ items: [] }, h.identity);
		expect(r).toEqual({ stored: [], superseded: [], failed: [] });
		expect(h.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// §5 listActive 探针（supersede / 晋升的取数口）
// ---------------------------------------------------------------------------

describe("P15-95⑤ listActive 探针", () => {
	it("无探针 → 不取数（不发请求），退化为「没有旧条目」", async () => {
		const h = harness({ respond: () => ({ payload: {} }) });
		expect(await h.bridge.listActive(h.identity)).toEqual([]);
		expect(await h.bridge.listActive(h.identity, "   ")).toEqual([]);
		expect(h.calls).toHaveLength(0);
	});

	it("有探针 → 发一次 memory_search，且召回面比展示用 top_k 宽（缺省 5 → 20）", async () => {
		const h = harness({
			respond: () => ({
				payload: {
					hits: [hit({ id: `m_${"1".repeat(32)}`, kind: "feedback", text: "改用 map" }, h0key2())],
					collection: "c",
					count: 1,
					degraded: false,
				},
			}),
		});
		const out = await h.bridge.listActive(h.identity, "改用 map 别用 forEach");
		expect(h.argsOf().top_k).toBe(20);
		expect(out).toHaveLength(1);
		expect(out[0]?.kind).toBe("feedback");
		expect(out[0]?.id).toBe(`m_${"1".repeat(32)}`);
	});

	it("取数降级 → 返回空数组并告警（本轮不 supersede / 不晋升），**不抛**", async () => {
		const h = harness({ respond: () => ({ payload: { hits: [], degraded: true, error: "down" }, isError: true }) });
		expect(await h.bridge.listActive(h.identity, "探针")).toEqual([]);
	});

	function h0key2(): string {
		return resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {}).safeKey;
	}
});

// ---------------------------------------------------------------------------
// §6 forget（撤销）
// ---------------------------------------------------------------------------

describe("P15-95⑥ forget", () => {
	it("非法 id → 抛（调用方 bug 不该伪装成「找不到」）", async () => {
		const h = harness({ respond: () => ({ payload: {} }) });
		await expect(h.bridge.forget(["not-an-id"])).rejects.toThrow(/非法 id/);
		expect(h.calls).toHaveLength(0);
	});

	it("只传自己的 entry_id，属主校验靠分区（契约 7：不传 owner）", async () => {
		const h = harness({
			respond: () => ({ payload: { forgotten: 1, not_found: [], collection: "c", mode: "delete" } }),
		});
		const id = `m_${"e".repeat(32)}`;
		const r = await h.bridge.forget([id]);
		expect(h.argsOf()).toEqual({
			scope: "user",
			key: h.identity.safeKey,
			entry_ids: [id],
			mode: "delete",
		});
		expect(h.argsOf()).not.toHaveProperty("owner");
		expect(r.forgotten).toBe(1);
		expect(r.mode).toBe("delete");
	});

	it("别人的 id 落在 not_found 里（对端分区内找不到）—— 不抛、不删", async () => {
		const h = harness({
			respond: () => ({ payload: { forgotten: 0, not_found: [`m_${"f".repeat(32)}`], collection: "c" } }),
		});
		const r = await h.bridge.forget([`m_${"f".repeat(32)}`], { mode: "mark_forgotten" });
		expect(r.forgotten).toBe(0);
		expect(r.notFound).toEqual([`m_${"f".repeat(32)}`]);
		expect(r.mode).toBe("mark_forgotten"); // 对端没回 mode 时用调用方的
	});

	it("对端报错 → 抛（forget 是人触发的操作，失败必须让人看见）", async () => {
		const h = harness({ respond: () => ({ payload: { error: "memory disabled" }, isError: true }) });
		await expect(h.bridge.forget([`m_${"e".repeat(32)}`])).rejects.toThrow(/memory disabled/);
	});
});

// ---------------------------------------------------------------------------
// §7 结构性隔离（硬约束 12）
// ---------------------------------------------------------------------------

describe("P15-95⑦ 结构性隔离：会话侧手上没有写客户端", () => {
	it("★ `readChannel()` 只有 search / circuit / collection —— 没有 write、没有 forget", async () => {
		const h = harness({ respond: () => ({ payload: { hits: [], collection: "c", count: 0, degraded: false } }) });
		const ch = h.bridge.readChannel();
		expect(Object.keys(ch).sort()).toEqual(["circuit", "collection", "search"]);
		expect(ch).not.toHaveProperty("write");
		expect(ch).not.toHaveProperty("forget");
		await ch.search("q");
		// 检索走的是 **read** 通道；写通道根本没被连接过
		expect(h.calls.every((c) => c.role === "read")).toBe(true);
	});

	it("读 / 写用**两个独立 client**（role 由工厂透出，测试据此区分）", async () => {
		const h = harness({
			respond: (name) =>
				name === "memory_store"
					? { payload: { stored: `m_${"b".repeat(32)}`, collection: "c", superseded: [] } }
					: { payload: { hits: [], collection: "c", count: 0, degraded: false } },
		});
		await h.bridge.search("q");
		await h.bridge.write(plan({ entry: entry({}, h.identity.key), supersedes: [] }), h.identity);
		expect(h.calls.map((c) => c.role)).toEqual(["read", "write"]);
	});

	it("`collection` 回显的是**输出**，不改写入参（契约 1 反向断言）", async () => {
		const h = harness({
			respond: () => ({ payload: { hits: [], collection: "RAG 说的", count: 0, degraded: false } }),
		});
		const out = await h.bridge.search("q");
		expect(out.collection).toBe("RAG 说的");
		expect(h.argsOf()).not.toHaveProperty("collection");
	});
});

// ---------------------------------------------------------------------------
// 编译期护栏：kind 与 status 的联合类型没被 `unknown` 吞掉
// ---------------------------------------------------------------------------

describe("P15-95⑧ 类型面回归（防止 wire 转换把联合类型退化成 string）", () => {
	it("转换后的 kind / status 仍是联合类型可达的取值", async () => {
		const h = harness({
			respond: () => ({
				payload: {
					hits: [hit({ kind: "feedback", status: "superseded" }, h0key3())],
					collection: "c",
					count: 1,
					degraded: false,
				},
			}),
		});
		const out = await h.bridge.search("q");
		const k: MemoryKind = out.hits[0]?.kind ?? "user";
		const s: MemoryStatus = out.hits[0]?.status ?? "active";
		expect(k).toBe("feedback");
		expect(s).toBe("superseded");
	});

	function h0key3(): string {
		return resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {}).safeKey;
	}
});

// ---------------------------------------------------------------------------
// §9 审计双写（P15-98）
// ---------------------------------------------------------------------------

const M32 = `m_${"b".repeat(32)}`;
const M1 = `m_${"1".repeat(32)}`;
const M2 = `m_${"2".repeat(32)}`;
const ME = `m_${"e".repeat(32)}`;
const MF = `m_${"f".repeat(32)}`;

describe("P15-98 审计双写：写入 / 遗忘都是 L2 发起的，走不到 audit-hook", () => {
	/** 带审计的装置（自己造 clientFactory，让审计与 mock 都在手里） */
	function withAudit(respond: Responder) {
		const audit = new InMemoryAuditClient();
		const identity = resolveMemoryIdentity({ user: { id: "U-1024" } }, {}, {});
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity,
			clientFactory: (_cfg, role) => ({
				connect: async () => {},
				listTools: async () => ({ tools: [] }),
				callTool: async (req) => {
					const r = respond(req.name, req.arguments, role);
					if (r.throw) throw new Error(r.throw);
					const text = r.text ?? JSON.stringify(r.payload ?? {});
					return { content: [{ type: "text", text }], ...(r.isError ? { isError: true } : {}) };
				},
				close: async () => {},
			}),
			audit: { audit, user: { id: "U-1024", role: "ops" }, environment: "dev", sessionId: "s-1" },
		});
		return { bridge, audit, identity };
	}

	it("★ 写入成功 → 一条 memory_written，且载荷**不含正文**（硬约束 6）", async () => {
		const { bridge, audit, identity } = withAudit(() => ({
			payload: { stored: M32, collection: "c", superseded: [] },
		}));
		const text = `偏好函数式风格：${"很长的一段正文".repeat(3)}`;
		await bridge.write(plan({ entry: entry({ text }, identity.key), supersedes: [] }), identity);

		expect(audit.entries()).toHaveLength(1);
		const rec = audit.entries()[0];
		expect(rec?.outcome).toBe("memory_written");
		expect(rec?.tool).toBe("memory_store");
		expect(rec?.isError).toBe(false);
		expect(rec?.sessionId).toBe("s-1");
		// 载荷形状：定位 + 核对所需，**没有 text**
		expect(Object.keys(rec?.input ?? {}).sort()).toEqual([
			"collection",
			"evidenceSessionId",
			"hash",
			"id",
			"kind",
			"length",
			"scope",
		]);
		expect(rec?.input.text).toBeUndefined();
		expect(rec?.input.length).toBe(text.length);
		expect(rec?.input.hash).toMatch(/^[0-9a-f]{16}$/);
		expect(JSON.stringify(rec)).not.toContain("偏好函数式风格"); // 整条记录里都不该出现正文
	});

	it("本地前置校验拒绝 → 一条 memory_write_failed（「为什么没写进去」必须可查）", async () => {
		const { bridge, audit, identity } = withAudit(() => ({ payload: {} }));
		await bridge.write(plan({ entry: entry({ id: "m_bad" }, identity.key), supersedes: [] }), identity);
		const rec = audit.entries()[0];
		expect(rec?.outcome).toBe("memory_write_failed");
		expect(rec?.isError).toBe(true);
		expect(rec?.detail).toMatch(/id 形态非法/);
	});

	it("半写 → memory_write_failed（不当成成功）", async () => {
		const { bridge, audit, identity } = withAudit(() => ({
			payload: {
				stored: M32,
				collection: "c",
				superseded: [],
				dense_ok: true,
				sparse_ok: false,
				errors: ["bm25 失败"],
			},
			isError: true,
		}));
		await bridge.write(plan({ entry: entry({}, identity.key), supersedes: [] }), identity);
		const rec = audit.entries()[0];
		expect(rec?.outcome).toBe("memory_write_failed");
		expect(rec?.detail).toMatch(/半写/);
	});

	it("★ 审计条数 = 计划条数（一次多写：成功的记 written、被拒的记 failed）", async () => {
		const { bridge, audit, identity } = withAudit((name, args) => {
			if (name !== "memory_store") return { payload: {} };
			return { payload: { stored: String(args.entry_id), collection: "c", superseded: [] } };
		});
		await bridge.write(
			plan(
				{ entry: entry({ id: M1 }, identity.key), supersedes: [] },
				{ entry: entry({ id: "m_bad" }, identity.key), supersedes: [] },
				{ entry: entry({ id: M2 }, identity.key), supersedes: [] },
			),
			identity,
		);
		expect(audit.entries().map((e) => e.outcome)).toEqual(["memory_written", "memory_write_failed", "memory_written"]);
	});

	it("遗忘 → 一条 memory_forgotten，含 mode / 计数（不留正文）", async () => {
		const { bridge, audit } = withAudit(() => ({
			payload: { forgotten: 1, not_found: [MF], collection: "c", mode: "mark_forgotten" },
		}));
		await bridge.forget([ME], { mode: "mark_forgotten" });
		const rec = audit.entries()[0];
		expect(rec?.outcome).toBe("memory_forgotten");
		expect(rec?.tool).toBe("memory_forget");
		expect(rec?.input).toEqual({ ids: [ME], mode: "mark_forgotten", forgotten: 1, notFound: 1 });
		expect(rec?.detail).toMatch(/not_found/);
	});

	it("★ 审计 client 抛错**不影响写入结果**（审计是旁路，不能回滚已写下的记忆）", async () => {
		const h = harness({ respond: () => ({ payload: { stored: M32, collection: "c", superseded: [] } }) });
		const bridge = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity: h.identity,
			clientFactory: () => ({
				connect: async () => {},
				listTools: async () => ({ tools: [] }),
				callTool: async () => ({
					content: [{ type: "text", text: JSON.stringify({ stored: M32, collection: "c", superseded: [] }) }],
				}),
				close: async () => {},
			}),
			audit: {
				audit: {
					record: async () => {
						throw new Error("PG 挂了");
					},
				},
				user: { id: "U-1024", role: "ops" },
				environment: "dev",
				sessionId: "s-1",
			},
		});
		const r = await bridge.write(plan({ entry: entry({}, h.identity.key), supersedes: [] }), h.identity);
		expect(r.stored).toHaveLength(1);
		expect(r.failed).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// §10 状态快照（P15-99 的 `fiat memory stats` 要它）
// ---------------------------------------------------------------------------

describe("P15-99⑩ 状态快照 `status()`", () => {
	it("★ `idle` 与 `unavailable` 必须分得开：一次都没用过 ≠ 连不上", async () => {
		const h = harness();
		// 还没发过任何调用 → 两个通道都是 idle（**不是** false / 不是 unavailable）
		expect(h.bridge.status().read).toBe("idle");
		expect(h.bridge.status().write).toBe("idle");

		await h.bridge.search("x");
		expect(h.bridge.status().read).toBe("ready");
		expect(h.bridge.status().write).toBe("idle"); // 写通道没被碰过，仍不该被说成「不可用」
	});

	it("connect 失败 → 该通道标 unavailable，另一条不受牵连（读写独立降级）", async () => {
		const h = harness();
		const broken = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity: h.identity,
			clientFactory: () => ({
				connect: async () => {
					throw new Error("RAG 起不来");
				},
				listTools: async () => ({ tools: [] }),
				callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
				close: async () => {},
			}),
		});
		await broken.search("x");
		expect(broken.status().read).toBe("unavailable");
		expect(broken.status().write).toBe("idle");
	});

	it("快照带分区三件套（scope / key / collection）与熔断状态，且**不发请求**", async () => {
		const h = harness();
		const before = h.calls.length;
		const s = h.bridge.status();
		expect(h.calls.length).toBe(before); // ← 零网络
		expect(s).toMatchObject({
			enabled: true,
			scope: "user",
			key: h.identity.key,
			collection: h.identity.collection,
		});
		expect(s.circuit.state).toBe("closed");
	});
});

// ---------------------------------------------------------------------------
// §10 状态快照（P15-99 的 `fiat memory stats` 要它）
// ---------------------------------------------------------------------------

describe("P15-99⑩ 状态快照 `status()`", () => {
	it("★ `idle` 与 `unavailable` 必须分得开：一次都没用过 ≠ 连不上", async () => {
		const h = harness();
		// 还没发过任何调用 → 两个通道都是 idle（**不是** false / 不是 unavailable）
		expect(h.bridge.status().read).toBe("idle");
		expect(h.bridge.status().write).toBe("idle");

		await h.bridge.search("x");
		expect(h.bridge.status().read).toBe("ready");
		expect(h.bridge.status().write).toBe("idle"); // 写通道没被碰过，仍不该被说成「不可用」
	});

	it("connect 失败 → 该通道标 unavailable，另一条不受牵连（读写独立降级）", async () => {
		const h = harness();
		const broken = new MemoryStoreBridge({
			rag: { transport: "stdio" },
			memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity: h.identity,
			clientFactory: () => ({
				connect: async () => {
					throw new Error("RAG 起不来");
				},
				listTools: async () => ({ tools: [] }),
				callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
				close: async () => {},
			}),
		});
		await broken.search("x");
		expect(broken.status().read).toBe("unavailable");
		expect(broken.status().write).toBe("idle");
	});

	it("快照带分区三件套（scope / key / collection）与熔断状态，且**不发请求**", async () => {
		const h = harness();
		const before = h.calls.length;
		const s = h.bridge.status();
		expect(h.calls.length).toBe(before); // ← 零网络
		expect(s).toMatchObject({
			enabled: true,
			scope: "user",
			key: h.identity.key,
			collection: h.identity.collection,
		});
		expect(s.circuit.state).toBe("closed");
	});
});
