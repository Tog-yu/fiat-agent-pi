/**
 * P15-99 单测：`fiat memory <子命令>`（记忆维护命令）。
 *
 * 与 `cli.test.ts` 同一条纪律：整条命令链路（`runCli`）依赖全注入 ——
 * 因此「参数校验 / 退出码 / 输出措辞」都能离线断言，不需要 RAG、不需要模型。
 *
 * 四类用例：
 *
 *   ① **参数校验**：`--scope` / `--kind` / `--top` / `--mode` 非法**要报错**，
 *      不能静默回落到缺省 —— 一个拼错的 `--kind` 会让「还是没有」看起来像结论。
 *   ② **缺省值**：`list` 含退役条目（维护视角）、`search` 只含可检索条目（排序视角）。
 *      两者缺省相反是刻意的，所以必须有测试钉住，否则某次重构会悄悄把它们统一掉。
 *   ③ **退出码**：`forget` 有 `notFound` 时非 0（脚本能发现「照着 id 删却没删掉」）。
 *   ④ **零 Pi 依赖**：源码级断言 —— 这是本命令「不需要 FIAT_MODEL 也能跑」的机械证据。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	renderMemoryForget,
	renderMemoryList,
	renderMemorySearch,
	renderMemoryStats,
} from "../src/server/cli/commands.ts";
import { type CliDeps, runCli } from "../src/server/cli/index.ts";
import type { MemoryOps } from "../src/server/cli/memory.ts";
import { createMemoryOps, MEMORY_FORGET_MODES } from "../src/server/cli/memory.ts";
import { resolveMemoryIdentity } from "../src/server/memory/identity.ts";
import type { MemorySearchOutcome } from "../src/server/memory/store.ts";
import { DEFAULT_MEMORY_CONFIG, type MemoryHit } from "../src/server/memory/types.ts";
import { FakeMemoryServer } from "./memory-fake-mcp.ts";

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const COLLECTION = "fiat_memory_user_ops_a1b2c3d4";

function hit(over: Partial<MemoryHit> = {}): MemoryHit {
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

function outcome(over: Partial<MemorySearchOutcome> = {}): MemorySearchOutcome {
	return { hits: [], collection: COLLECTION, count: 0, degraded: false, isolationViolations: [], ...over };
}

/** 假能力层：记录调用、按脚本返回 */
function fakeOps(over: Partial<MemoryOps> = {}) {
	const seen: {
		stats: unknown[];
		list: { probe: string; opts?: unknown }[];
		search: { query: string; opts?: unknown }[];
		forget: { ids: readonly string[]; opts?: unknown }[];
	} = { stats: [], list: [], search: [], forget: [] };

	const stats = () =>
		({
			enabled: true,
			config: DEFAULT_MEMORY_CONFIG,
			configPath: "/repo/config/memory.yaml",
			endpoint: "stdio: python3 -m src.mcp_server.server",
		}) as ReturnType<MemoryOps["stats"]>;

	const ops: MemoryOps = {
		stats: (scope) => {
			seen.stats.push(scope);
			return stats();
		},
		list: async (probe, opts) => {
			seen.list.push({ probe, ...(opts ? { opts } : {}) });
			return outcome();
		},
		search: async (query, opts) => {
			seen.search.push({ query, ...(opts ? { opts } : {}) });
			return outcome();
		},
		forget: async (ids, opts) => {
			seen.forget.push({ ids, ...(opts ? { opts } : {}) });
			return { forgotten: ids.length, notFound: [], collection: COLLECTION, mode: "delete" };
		},
		close: async () => {},
		...over,
	};
	return { ops, seen };
}

function makeDeps(memory?: MemoryOps): CliDeps {
	return {
		policies: new Map(),
		audit: { query: async () => [] },
		listTickets: async () => [],
		approveTicket: async (id) => ({ ticketId: id, status: "approved" }) as never,
		rejectTicket: async (id) => ({ ticketId: id, status: "rejected" }) as never,
		...(memory ? { memory } : {}),
	};
}

async function run(args: string[], deps: CliDeps) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(args, deps, { out: (s) => out.push(s), err: (s) => err.push(s) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

// ---------------------------------------------------------------------------
// §1 参数校验：非法值必须报错，不静默回落
// ---------------------------------------------------------------------------

describe("P15-99① 参数校验", () => {
	it("未装配记忆能力时明确提示（而不是静默成功）", async () => {
		const r = await run(["memory", "stats"], makeDeps());
		expect(r.code).toBe(1);
		expect(r.err).toContain("记忆维护未装配");
	});

	it("`--scope` 非法 → 报错并列出合法值", async () => {
		const r = await run(["memory", "stats", "--scope", "tenant"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("--scope");
		expect(r.err).toContain("user");
	});

	it("`--kind` 非法 → 报错（拼错的限定词会让「还是没有」看起来像结论）", async () => {
		const r = await run(["memory", "list", "风格", "--kind", "perf"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("--kind");
	});

	it("`--top` 给了非数字 → 报错（静默用缺省会让人以为「库里就这么多」）", async () => {
		const r = await run(["memory", "list", "风格", "--top", "abc"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("--top");
	});

	it("`--mode` 非法 → 报错并列出合法值", async () => {
		const r = await run(["memory", "forget", "m_x", "--mode", "purge"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain(MEMORY_FORGET_MODES.join(" / "));
	});

	it("未知子命令 → 报错并列出可用子命令", async () => {
		const r = await run(["memory", "dump"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("stats / list / search / forget");
	});
});

// ---------------------------------------------------------------------------
// §2 缺省值与参数透传
// ---------------------------------------------------------------------------

describe("P15-99② 缺省值与参数透传", () => {
	it("无子命令 → 走 stats（缺省是只读的那一个）", async () => {
		const f = fakeOps();
		const r = await run(["memory"], makeDeps(f.ops));
		expect(r.code).toBe(0);
		expect(f.seen.stats).toEqual(["user"]);
	});

	it("`list` 缺省 **含**退役条目（维护视角：看「这条为什么不见了」）", async () => {
		const f = fakeOps();
		await run(["memory", "list", "风格"], makeDeps(f.ops));
		expect(f.seen.list[0]?.opts).toMatchObject({ includeSuperseded: true, scope: "user" });
	});

	it("`list --active-only` 反转为不含退役条目", async () => {
		const f = fakeOps();
		await run(["memory", "list", "风格", "--active-only"], makeDeps(f.ops));
		expect(f.seen.list[0]?.opts).toMatchObject({ includeSuperseded: false });
	});

	it("`search` 不自己塞 `includeSuperseded`（缺省由能力层决定 —— 见 §7）", async () => {
		const f = fakeOps();
		await run(["memory", "search", "风格"], makeDeps(f.ops));
		expect(f.seen.search[0]?.opts).toEqual({ scope: "user" });
	});

	it("多词查询按空格拼回一个整串（`fiat memory search 我的 编码 风格`）", async () => {
		const f = fakeOps();
		await run(["memory", "search", "我的", "编码", "风格"], makeDeps(f.ops));
		expect(f.seen.search[0]?.query).toBe("我的 编码 风格");
	});

	it("`--scope` / `--kind` / `--top` 透传（kind 包装成单元素数组）", async () => {
		const f = fakeOps();
		await run(["memory", "search", "风格", "--scope", "repo", "--kind", "project", "--top", "3"], makeDeps(f.ops));
		expect(f.seen.search[0]?.opts).toEqual({ scope: "repo", kinds: ["project"], topK: 3 });
	});

	it("`list` 没有探针 → 报错并说明「对端没有全量列举接口」（不造一个假的「列全部」）", async () => {
		const f = fakeOps();
		const r = await run(["memory", "list"], makeDeps(f.ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("全量列举");
		expect(f.seen.list).toEqual([]); // ← 校验不过就**不发请求**
	});
});

// ---------------------------------------------------------------------------
// §3 forget：退出码与模式
// ---------------------------------------------------------------------------

describe("P15-99③ forget", () => {
	it("没有 id → 报错", async () => {
		const r = await run(["memory", "forget"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("用法");
	});

	it("多个 id 一次传入，缺省模式不显式传 `mode`（由桥的缺省决定）", async () => {
		const f = fakeOps();
		await run(["memory", "forget", "m_a", "m_b"], makeDeps(f.ops));
		expect(f.seen.forget[0]).toEqual({ ids: ["m_a", "m_b"], opts: { scope: "user" } });
	});

	it("`--mode mark_forgotten` 透传（「真删」与「打标」要能被区分）", async () => {
		const f = fakeOps();
		await run(["memory", "forget", "m_a", "--mode", "mark_forgotten"], makeDeps(f.ops));
		expect(f.seen.forget[0]).toMatchObject({ opts: { mode: "mark_forgotten" } });
	});

	it("全部命中 → 退出码 0", async () => {
		const r = await run(["memory", "forget", "m_a"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(0);
		expect(r.out).toContain("已删除 1 条");
	});

	it("★ 有 notFound → 退出码 1（脚本能发现「照着 id 删却没删掉」）", async () => {
		const f = fakeOps({
			forget: async (ids) => ({
				forgotten: ids.length - 1,
				notFound: [ids.at(-1) ?? ""],
				collection: COLLECTION,
				mode: "delete",
			}),
		});
		const r = await run(["memory", "forget", "m_a", "m_b"], makeDeps(f.ops));
		expect(r.code).toBe(1);
		expect(r.out).toContain("未在本分区找到 1 条");
	});

	it("能力层抛错（如关记忆）→ 报错 + 非 0，**不伪装成「找不到」**", async () => {
		const f = fakeOps({
			forget: async () => {
				throw new Error("记忆未启用（FIAT_MEMORY 未开），未执行任何撤销");
			},
		});
		const r = await run(["memory", "forget", "m_a"], makeDeps(f.ops));
		expect(r.code).toBe(1);
		expect(r.err).toContain("撤销失败");
		expect(r.err).toContain("记忆未启用");
	});
});

// ---------------------------------------------------------------------------
// §4 stats：零网络 + 分区不可用也要能跑
// ---------------------------------------------------------------------------

describe("P15-99④ stats", () => {
	it("渲染出关键配置面（排查「为什么没写进去 / 为什么没有热注入」要的都在）", async () => {
		const r = await run(["memory", "stats"], makeDeps(fakeOps().ops));
		expect(r.code).toBe(0);
		expect(r.out).toContain("记忆：已开启");
		expect(r.out).toContain("minConfidence".replace("minConfidence", "最小置信度"));
		expect(r.out).toContain("单条上限 300 字");
		expect(r.out).toContain("热注入 user/feedback");
		expect(r.out).toContain("同族 ≥3 条");
	});

	it("关记忆：说清「不注入、不检索、不写入，零网络」，且分区标为不适用", () => {
		const text = renderMemoryStats({
			enabled: false,
			config: DEFAULT_MEMORY_CONFIG,
			configPath: "/repo/config/memory.yaml",
			endpoint: "stdio: python3 -m src.mcp_server.server",
		});
		expect(text).toContain("记忆：已关闭");
		expect(text).toContain("分区：不适用");
		expect(text).toContain("零网络");
	});

	it("★ 身份解析失败时 stats **仍然可跑**，把原因作为报告内容（这是它最该工作的时刻）", () => {
		const text = renderMemoryStats({
			enabled: true,
			identityError: "多租户模式需要可信身份（FIAT_USER_ID 视为未配置）",
			config: DEFAULT_MEMORY_CONFIG,
			configPath: "/repo/config/memory.yaml",
			endpoint: "stdio: python3 -m src.mcp_server.server",
		});
		expect(text).toContain("记忆：已开启");
		expect(text).toContain("分区：不可用");
		expect(text).toContain("多租户模式需要可信身份");
	});

	it("通道与熔断状态：`idle` 必须与 `unavailable` 说得不一样（一次都没用过 ≠ 连不上）", () => {
		const base = {
			enabled: true,
			identity: { scope: "user" as const, key: "ops", collection: COLLECTION, userId: "ops" },
			config: DEFAULT_MEMORY_CONFIG,
			configPath: "/repo/config/memory.yaml",
			endpoint: "stdio: python3 -m src.mcp_server.server",
			circuit: {
				state: "closed" as const,
				consecutiveFailures: 0,
				remainingCooldownMs: 0,
				shortCircuited: 0,
				openedCount: 0,
			},
		};
		expect(renderMemoryStats({ ...base, channels: { read: "idle", write: "idle" } })).toContain("未使用");
		expect(renderMemoryStats({ ...base, channels: { read: "unavailable", write: "ready" } })).toContain("不可用");
		expect(renderMemoryStats({ ...base, channels: { read: "ready", write: "ready" } })).not.toContain("不可用");
	});

	it("熔断打开时显示冷却剩余（打开却不显示剩余 = 人不知道该等多久）", () => {
		const text = renderMemoryStats({
			enabled: true,
			identity: { scope: "user", key: "ops", collection: COLLECTION, userId: "ops" },
			config: DEFAULT_MEMORY_CONFIG,
			configPath: "/repo/config/memory.yaml",
			endpoint: "stdio: x",
			channels: { read: "unavailable", write: "unavailable" },
			circuit: {
				state: "open",
				consecutiveFailures: 5,
				remainingCooldownMs: 90_000,
				shortCircuited: 3,
				openedCount: 1,
			},
		});
		expect(text).toContain("已熔断");
		expect(text).toContain("冷却剩余 90s");
	});
});

// ---------------------------------------------------------------------------
// §5 三个渲染函数的形态（读者是人：要能区分「空」与「挂」）
// ---------------------------------------------------------------------------

describe("P15-99⑤ 渲染（list / search / forget）", () => {
	it("list 命中：带 status 列（退役条目必须一眼看出来）", () => {
		const text = renderMemoryList(outcome({ hits: [hit({ status: "superseded" })], count: 1 }), "风格");
		expect(text).toContain("superseded");
		expect(text).toContain(COLLECTION);
	});

	it("search 命中：带 score 与 score_type，并注明融合分不是置信度", () => {
		const text = renderMemorySearch(outcome({ hits: [hit()], count: 1 }), "风格");
		expect(text).toContain("0.0164");
		expect(text).toContain("rrf_fusion");
		expect(text).toContain("不代表记忆的可靠程度");
	});

	it("★ 降级与真空说得不一样（人也不该把「挂了」读成「库里空的」）", () => {
		const degraded = renderMemoryList(outcome({ degraded: true, error: "读通道不可用" }), "风格");
		expect(degraded).toContain("不可用");
		expect(degraded).toContain("不代表该分区没有记忆");

		const empty = renderMemoryList(outcome(), "风格");
		expect(empty).toContain("没有匹配");
		expect(empty).not.toContain("不可用");
	});

	it("越界丢弃**要显式报条数** —— 它不是「没有数据」，是「有数据但不该给你看」", () => {
		const text = renderMemorySearch(
			outcome({ hits: [hit()], count: 1, isolationViolations: [{ id: "m_x", reason: "scope 越界" }] }),
			"风格",
		);
		expect(text).toContain("1 条结果因分区不匹配被丢弃");
		// 但**明细与正文永不出现**（只有条数；id 与正文由 store.ts 以 error 级别留痕）
		expect(text).not.toContain("m_x");
		expect(text).not.toContain("scope 越界");
	});

	it("forget 渲染按模式分叉（「已删除」≠「已标记遗忘」）", () => {
		expect(renderMemoryForget({ forgotten: 2, notFound: [], collection: COLLECTION, mode: "delete" })).toContain(
			"已删除 2 条",
		);
		expect(
			renderMemoryForget({ forgotten: 2, notFound: [], collection: COLLECTION, mode: "mark_forgotten" }),
		).toContain("已标记遗忘 2 条");
		expect(renderMemoryForget({ forgotten: 0, notFound: ["m_x"], collection: COLLECTION })).toContain("没有条目被撤销");
	});
});

// ---------------------------------------------------------------------------
// §7 能力层的缺省（用**真实桥 + 假 MCP 服务**，不是假的 ops）
// ---------------------------------------------------------------------------

describe("P15-99⑦ 能力层缺省：list 含退役、search 不含", () => {
	/** 一条已退役的条目 —— 「这条记忆怎么不见了」的答案就长这样 */
	const RETIRED_ID = `m_${"c".repeat(32)}`;

	function realOps() {
		const server = new FakeMemoryServer();
		const identity = resolveMemoryIdentity({ user: { id: "alice" } }, {}, {});
		server.seed("user", identity.safeKey, {
			id: RETIRED_ID,
			text: "用户偏好函数式编码风格",
			status: "superseded",
		});
		const ops = createMemoryOps({
			config: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity: () => identity,
			rag: { transport: "stdio" },
			clientFactory: server.clientFactory,
			log: () => {},
		});
		return { ops, server, identity };
	}

	it("`list` 看得到退役条目（维护视角），`search` 看不到（排序视角，与模型侧工具同口径）", async () => {
		const { ops } = realOps();
		const listed = await ops.list("函数式编码风格");
		expect(listed.degraded).toBe(false);
		expect(listed.hits.map((h) => h.id)).toEqual([RETIRED_ID]);

		const searched = await ops.search("函数式编码风格");
		expect(searched.degraded).toBe(false);
		expect(searched.hits).toEqual([]); // ← 与模型侧 `fiat_memory_search` 同口径
	});

	it("`list --active-only` 传给对端的是「不含退役」（两个子命令的缺省因此可以对齐）", async () => {
		const { ops, server } = realOps();
		await ops.list("函数式编码风格", { includeSuperseded: false });
		expect(server.callsOf("memory_search")[0]?.include_superseded).toBeUndefined();
	});

	it("`stats` 报告真实分区（scope / key / collection 与身份一致）", () => {
		const { ops, identity } = realOps();
		const s = ops.stats();
		expect(s.enabled).toBe(true);
		expect(s.identity).toMatchObject({
			scope: "user",
			key: identity.key,
			collection: identity.collection,
			userId: "alice",
		});
		// 还没用过 → 两个通道都是 `idle`，**不是**「不可用」
		expect(s.channels).toEqual({ read: "idle", write: "idle" });
	});

	it("★ 关记忆时 `stats` 不解析身份也能跑（身份构造器会抛，也不该被调用）", () => {
		const ops = createMemoryOps({
			config: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
			identity: () => {
				throw new Error("不该被调用");
			},
			rag: { transport: "stdio" },
			log: () => {},
		});
		const s = ops.stats();
		expect(s.enabled).toBe(false);
		expect(s.identity).toBeUndefined();
		expect(s.identityError).toBeUndefined();
	});

	it("★ 开记忆但身份解析失败：`stats` 照常出报告（把原因当内容），而不是抛", () => {
		const ops = createMemoryOps({
			config: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			identity: () => {
				throw new Error("多租户模式需要可信身份");
			},
			rag: { transport: "stdio" },
			log: () => {},
		});
		const s = ops.stats();
		expect(s.enabled).toBe(true);
		expect(s.identity).toBeUndefined();
		expect(s.identityError).toContain("多租户模式需要可信身份");
	});

	it("★ 关记忆时 `forget` **抛**（不能让它看起来像「本分区找不到这些 id」）", async () => {
		const ops = createMemoryOps({
			config: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
			identity: () => resolveMemoryIdentity({ user: { id: "alice" } }, {}, {}),
			rag: { transport: "stdio" },
			log: () => {},
		});
		await expect(ops.forget([`m_${"a".repeat(32)}`])).rejects.toThrow("记忆未启用");
	});
});

// ---------------------------------------------------------------------------
// §6 零 Pi 依赖（源码级断言）
// ---------------------------------------------------------------------------

describe("P15-99⑥ 零 Pi 依赖", () => {
	it("★ `memory/` 与 `cli/memory.ts` 都不 import Pi 运行时（这是「不需要 FIAT_MODEL」的机械证据）", () => {
		const root = new URL("../src/server/", import.meta.url);
		const files = [
			...readdirSync(fileURLToPath(new URL("memory/", root)))
				.filter((f) => f.endsWith(".ts"))
				.map((f) => fileURLToPath(new URL(`memory/${f}`, root))),
			fileURLToPath(new URL("cli/memory.ts", root)),
		];
		expect(files.length).toBeGreaterThan(10); // 别把「目录读空了」当成通过
		for (const file of files) {
			const src = readFileSync(file, "utf-8");
			expect(src, `${file} 不应依赖 Pi 运行时`).not.toContain("@earendil-works/pi-");
		}
	});
});
