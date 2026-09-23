/**
 * P15-101 / P15-102 / P15-103 单测：用户维度的记忆隔离（设计文档 §11 验收的 A 期覆盖）。
 *
 * 三层各锁一条判据：
 *
 *   ① 身份可信（L0）—— 多租户模式解析不出身份 → **抛**，绝不是 fallback 到 "cli"
 *   ② 边界唯一（L2）—— `sanitize` 不碰撞（大小写 / 非法字符），identity 只有一个构造点
 *   ③ 隔离成立（L3）—— A 写的记忆，B 通过热注入**读不到**（最后一段，最要紧）
 *
 * 为什么隔离要按层单测、而不是只靠一次 e2e：**隔离失效的默认表现是「一切正常」**——
 * 不抛异常、不打日志、检索照样返回结果，只是返回了别人的。所以每层都配一个
 * 「故意让它坏」的用例，A/B 双身份是最小的可复现装置。
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/server/evolution/memoryStore.ts";
import {
	assertNotSentinelIdentity,
	IdentityUnavailableError,
	isMultiTenantMemory,
	isSentinelIdentity,
	resolveIdentity,
} from "../src/server/identity/resolver.ts";
import { memoryCollection, resolveMemoryIdentity, sanitizeMemoryKey } from "../src/server/memory/identity.ts";

describe("sanitizeMemoryKey：路径 / collection 安全", () => {
	it("非法字符折叠为下划线，并保留可读前缀 + 8 位 hash", () => {
		expect(sanitizeMemoryKey("alice@example.com")).toMatch(/^alice_example_com_[0-9a-f]{8}$/);
	});

	it("大小写不同的 id **不会**落进同一目录（macOS / Windows 文件系统大小写不敏感）", () => {
		// 只做小写折叠的话 Alice 与 alice 会是同一个目录 —— 那就是两个用户混装
		expect(sanitizeMemoryKey("Alice")).not.toBe(sanitizeMemoryKey("alice"));
	});

	it("替换造成的碰撞被 hash 消解（a@b 与 a_b 不撞）", () => {
		expect(sanitizeMemoryKey("a@b")).not.toBe(sanitizeMemoryKey("a_b"));
	});

	it("超长 key 靠 hash 区分，可读段被截到 32", () => {
		const a = sanitizeMemoryKey(`${"u".repeat(64)}a`);
		const b = sanitizeMemoryKey(`${"u".repeat(64)}b`);
		expect(a).not.toBe(b);
		expect(a.split("_")[0]).toHaveLength(32);
	});

	it("空值 / . / .. 一律抛（宁可起不来，也不要落进谁都能读的目录）", () => {
		expect(() => sanitizeMemoryKey("")).toThrow();
		expect(() => sanitizeMemoryKey("   ")).toThrow();
		expect(() => sanitizeMemoryKey(".")).toThrow();
		expect(() => sanitizeMemoryKey("..")).toThrow();
	});

	it("输出里不可能出现路径分隔符或 ..（路径穿越防护）", () => {
		const s = sanitizeMemoryKey("../../etc/passwd");
		expect(s).not.toContain("/");
		expect(s).not.toContain("..");
	});
});

describe("resolveMemoryIdentity：隔离边界的唯一构造点", () => {
	it("缺省给 user scope，key = userId", () => {
		const id = resolveMemoryIdentity({ user: { id: "alice" } });
		expect(id.scope).toBe("user");
		expect(id.key).toBe("alice");
		expect(id.userId).toBe("alice");
		expect(id.safeKey).toBe(sanitizeMemoryKey("alice"));
		expect(id.collection).toBe(memoryCollection("user", id.safeKey));
		expect(id.collection).toMatch(/^fiat_memory_user_/);
	});

	it("global scope 用固定键 shared，但仍记录「是谁写下的」", () => {
		const id = resolveMemoryIdentity({ user: { id: "alice" } }, { scope: "global" });
		expect(id.key).toBe("shared");
		expect(id.userId).toBe("alice");
	});

	it("repo scope 的 key 由调用方显式给出（不猜）", () => {
		const id = resolveMemoryIdentity({ user: { id: "alice" } }, { scope: "repo", key: "fiat-agent-pi" });
		expect(id.key).toBe("fiat-agent-pi");
		expect(id.collection).toBe(memoryCollection("repo", id.safeKey));
	});

	it("identity 不含 sessionId（必须是会话无关的稳定值）", () => {
		expect(Object.keys(resolveMemoryIdentity({ user: { id: "alice" } }))).not.toContain("sessionId");
	});

	it("缺 user.id 直接抛（不做默认值兜底）", () => {
		expect(() => resolveMemoryIdentity({ user: { id: "" } })).toThrow();
		expect(() => resolveMemoryIdentity({ user: { id: "   " } })).toThrow();
	});
});

describe("resolveIdentity：可信身份解析（L0）", () => {
	it("两个开关都不配 → 保持改造前行为（cli / cli）", () => {
		expect(resolveIdentity({}, {})).toEqual({ id: "cli", source: "cli" });
	});

	it("FIAT_USER_ID 生效", () => {
		expect(resolveIdentity({}, { FIAT_USER_ID: "alice" })).toEqual({ id: "alice", source: "env" });
	});

	it("**多租户 + 无身份 → 抛**（不是 fallback 到 cli）", () => {
		// 整个设计里最要紧的一条：现状的 `?? "cli"` 会让所有人的记忆并进同一分区且不报错
		expect(() => resolveIdentity({}, { FIAT_MEMORY_MULTI_TENANT: "1" })).toThrow(IdentityUnavailableError);
	});

	it("多租户 + FIAT_USER_ID → 正常", () => {
		expect(resolveIdentity({}, { FIAT_MEMORY_MULTI_TENANT: "1", FIAT_USER_ID: "alice" })).toEqual({
			id: "alice",
			source: "env",
		});
	});

	it("FIAT_IDENTITY_SOURCE=os → 取 OS 登录名", () => {
		expect(resolveIdentity({}, { FIAT_IDENTITY_SOURCE: "os" }, () => "tog")).toEqual({ id: "tog", source: "os" });
	});

	it("显式要 OS 身份却取不到：多租户下抛，非多租户下回落", () => {
		expect(() =>
			resolveIdentity({}, { FIAT_IDENTITY_SOURCE: "os", FIAT_MEMORY_MULTI_TENANT: "1" }, () => "  "),
		).toThrow(IdentityUnavailableError);
		expect(resolveIdentity({}, { FIAT_IDENTITY_SOURCE: "os" }, () => "")).toEqual({ id: "cli", source: "cli" });
	});

	it("传入的已鉴权身份优先级最高（服务端形态：JWT 解出的 id 覆盖一切）", () => {
		expect(
			resolveIdentity({ trustedId: "from-jwt" }, { FIAT_USER_ID: "alice", FIAT_IDENTITY_SOURCE: "os" }, () => "tog"),
		).toEqual({ id: "from-jwt", source: "token" });
	});

	it('isMultiTenantMemory 只认 "1"', () => {
		expect(isMultiTenantMemory({ FIAT_MEMORY_MULTI_TENANT: "1" })).toBe(true);
		expect(isMultiTenantMemory({ FIAT_MEMORY_MULTI_TENANT: "true" })).toBe(false);
		expect(isMultiTenantMemory({})).toBe(false);
	});
});

describe("P15-104 哨兵语义：cli 只表示「没配」，不是用户", () => {
	it("哨兵判据与来源无关（trustedId / OS / 环境变量一视同仁）", () => {
		expect(isSentinelIdentity("cli")).toBe(true);
		expect(isSentinelIdentity("  cli  ")).toBe(true);
		expect(isSentinelIdentity("cli2")).toBe(false);
		expect(isSentinelIdentity("CLI")).toBe(false);
	});

	it("方案二：多租户 + FIAT_USER_ID=cli → 抛（它不再是一个「真身份」）", () => {
		// 这是 §2.4 记的那个真实失效路径：setup 默认值被写进 .env 之后，
		// 哨兵就伪装成真值，fail-fast 再也拦不住 —— 而且全程不报错。
		expect(() => resolveIdentity({}, { FIAT_MEMORY_MULTI_TENANT: "1", FIAT_USER_ID: "cli" })).toThrow(
			IdentityUnavailableError,
		);
		// 报错文本要点出哨兵，否则运维只会看到「未提供可信身份」而以为自己配了
		expect(() => resolveIdentity({}, { FIAT_MEMORY_MULTI_TENANT: "1", FIAT_USER_ID: "cli" })).toThrow(/哨兵/);
	});

	it("方案二：单租户 + FIAT_USER_ID=cli → 与「没配」完全等价（改造前行为不变）", () => {
		expect(resolveIdentity({}, { FIAT_USER_ID: "cli" })).toEqual({ id: "cli", source: "cli" });
		expect(resolveIdentity({}, { FIAT_USER_ID: "cli" })).toEqual(resolveIdentity({}, {}));
	});

	it("非哨兵值不受影响（多租户 + 真实 id 照常通过）", () => {
		expect(resolveIdentity({}, { FIAT_MEMORY_MULTI_TENANT: "1", FIAT_USER_ID: "alice" })).toEqual({
			id: "alice",
			source: "env",
		});
	});

	it("方案一：存储边界拒收哨兵身份（多租户）", () => {
		expect(() => resolveMemoryIdentity({ user: { id: "cli" } }, {}, { FIAT_MEMORY_MULTI_TENANT: "1" })).toThrow(
			IdentityUnavailableError,
		);
	});

	it("方案一：单租户下 cli 是合法身份（本地单人部署照旧可用）", () => {
		const id = resolveMemoryIdentity({ user: { id: "cli" } }, {}, {});
		expect(id.userId).toBe("cli");
		expect(id.collection).toMatch(/^fiat_memory_user_cli_[0-9a-f]{8}$/);
	});

	it("方案一覆盖 trustedId / OS 来源：多租户下三者都叫 cli 时同样拒（歧义即失效）", () => {
		const multi = { FIAT_MEMORY_MULTI_TENANT: "1" } as NodeJS.ProcessEnv;
		// 经 resolveIdentity 拿到的 id 再进边界 —— 与生产接线同形
		const fromToken = resolveIdentity({ trustedId: "cli" }, multi, () => "ignored");
		expect(fromToken).toEqual({ id: "cli", source: "token" });
		expect(() => resolveMemoryIdentity({ user: { id: fromToken.id } }, {}, multi)).toThrow(IdentityUnavailableError);

		const fromOs = resolveIdentity({}, { ...multi, FIAT_IDENTITY_SOURCE: "os" }, () => "cli");
		expect(fromOs).toEqual({ id: "cli", source: "os" });
		expect(() => resolveMemoryIdentity({ user: { id: fromOs.id } }, {}, multi)).toThrow(IdentityUnavailableError);
	});

	it("assertNotSentinelIdentity 在非多租户下是空操作", () => {
		expect(() => assertNotSentinelIdentity("cli", {})).not.toThrow();
		expect(() => assertNotSentinelIdentity("alice", { FIAT_MEMORY_MULTI_TENANT: "1" })).not.toThrow();
		expect(() => assertNotSentinelIdentity("cli", { FIAT_MEMORY_MULTI_TENANT: "1" })).toThrow(IdentityUnavailableError);
	});

	it("抛的是 IdentityUnavailableError（入口层据此拒绝会话，而不是当普通错误吞掉）", () => {
		try {
			resolveMemoryIdentity({ user: { id: "cli" } }, {}, { FIAT_MEMORY_MULTI_TENANT: "1" });
			expect.unreachable("应当抛错");
		} catch (err) {
			expect(err).toBeInstanceOf(IdentityUnavailableError);
			expect((err as Error).name).toBe("IdentityUnavailableError");
		}
	});
});

describe("P15-103 隔离成立：A 写的记忆，B 读不到", () => {
	let workspace: string;
	let store: MemoryStore;
	const alice = resolveMemoryIdentity({ user: { id: "alice" } });
	const bob = resolveMemoryIdentity({ user: { id: "bob" } });
	const at = new Date("2026-09-12T00:00:00.000Z");

	beforeEach(() => {
		workspace = join(tmpdir(), `fiat-mem-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(workspace, { recursive: true });
		store = new MemoryStore({ workspace });
	});

	afterEach(() => {
		if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
	});

	it("落盘按身份**物理分区**（不是「同目录 + 过滤条件」）", () => {
		const p = store.appendFacts(alice, { title: "我的偏好", entries: ["回复要短"] }, at);
		expect(p).toBe(join(workspace, "users", alice.safeKey, "memory", "2026-09-12.md"));
		expect(existsSync(join(workspace, "users", bob.safeKey, "memory"))).toBe(false);
		// 旧的 flat 共享目录**不再被创建** —— 它正是「同事能看到我的偏好」的成因
		expect(existsSync(join(workspace, "memory"))).toBe(false);
	});

	it("热注入只读本身份分区：A 看得到，B 看不到", () => {
		store.appendFacts(alice, { title: "我的偏好", entries: ["回复要短"] }, at);
		expect(store.recentFacts(alice)).toContain("回复要短");
		expect(store.recentFacts(bob)).toBe("");
	});

	it("B 无法通过任何参数组合读到 A 的条目（边界只在 identity 里，没有可拼的口子）", () => {
		store.appendFacts(alice, { title: "x", entries: ["ALICE-SECRET"] }, at);
		// recentFacts 的入参只有 identity 与两个截断阈值：没有 scope / key 这种外部可拼的参数
		expect(store.recentFacts(bob, 365, 100_000)).toBe("");
	});

	it("文件头声明隔离分区，便于人肉核对", () => {
		const p = store.appendFacts(alice, { title: "x", entries: ["y"] }, at);
		expect(readFileSync(p, "utf-8")).toContain("scope=user · key=alice");
	});

	it("role 运行约定**有意保持共享**（不是隔离失效）", () => {
		store.appendRoleFacts("ops", { title: "约定", entries: ["先 dry-run"] }, at);
		expect(store.roleFacts("ops")).toContain("先 dry-run");
		// 按 role 聚合、不按人 —— 这是设计意图（设计文档 §3-L2 的 ⚠️ 框）
		expect(existsSync(join(workspace, "facts", "roles", "ops.md"))).toBe(true);
	});
});
