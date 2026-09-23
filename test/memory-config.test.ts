/**
 * P15-92 单测：契约（types.ts）+ 配置（config/memory.yaml）+ 策略锚点。
 *
 * 三件事各自锁一条最容易静默失效的东西：
 *
 *   ① **跨仓库契约 8**：`maxTextChars` 必须与 RAG 侧一致 —— 不一致 = 「fiat 认为合法、
 *      RAG 拒写」，两侧各锁自己的值（本文件锁 fiat 侧 = 300）。
 *   ② **契约 3**：`entry_id` 定长 `m_<32hex>` —— 变长会让 RAG 侧按前缀删时误删他人条目。
 *   ③ **策略锚点**：`config/tool_policies.yaml` 里没有 `memory_search` 的话，
 *      闸门③（`canExecute`）对未知工具**默认拒绝**，工具会静默全灭。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMemoryConfig, MemoryConfigError, normalizeMemoryConfig } from "../src/server/memory/config.ts";
import { memoryCollection, resolveMemoryIdentity, sanitizeMemoryKey } from "../src/server/memory/identity.ts";
import {
	DEFAULT_MEMORY_CONFIG,
	KIND_DEFAULT_SCOPE,
	MEMORY_ENTRY_ID_PATTERN,
	MEMORY_KINDS,
	MEMORY_PROMPT_VERSION,
	MEMORY_SCOPES,
} from "../src/server/memory/types.ts";
import { canExecute, loadPolicies } from "../src/server/policy/engine.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MEMORY_CONFIG_PATH = `${ROOT}config/memory.yaml`;
const POLICIES_PATH = `${ROOT}config/tool_policies.yaml`;

describe("P15-92 契约：types.ts 的形状与常量", () => {
	it("四类 kind 就是 §15.5 定稿的四类（performance 已撤销）", () => {
		expect([...MEMORY_KINDS]).toEqual(["user", "feedback", "project", "reference"]);
		expect(MEMORY_KINDS).not.toContain("performance");
	});

	it("三个 scope 与 §15.6 一致", () => {
		expect([...MEMORY_SCOPES]).toEqual(["user", "repo", "global"]);
	});

	it("kind → 默认 scope 映射覆盖全部 kind，且判定落在代码侧", () => {
		for (const kind of MEMORY_KINDS) expect(KIND_DEFAULT_SCOPE[kind]).toBeTruthy();
		expect(KIND_DEFAULT_SCOPE.user).toBe("user");
		// feedback 也落 user（「用户对助手的纠正」是关于这个人的）
		expect(KIND_DEFAULT_SCOPE.feedback).toBe("user");
		expect(KIND_DEFAULT_SCOPE.project).toBe("repo");
		expect(KIND_DEFAULT_SCOPE.reference).toBe("repo");
	});

	it("★ 契约 3：entry_id 必须定长 m_ + 32 hex（变长 = RAG 前缀删误伤）", () => {
		expect(MEMORY_ENTRY_ID_PATTERN.test(`m_${"a".repeat(32)}`)).toBe(true);
		// 前缀形态合法但长度不足 —— 正是「m_abc 是 m_abcd 的前缀」那类误删的来源
		expect(MEMORY_ENTRY_ID_PATTERN.test("m_abc")).toBe(false);
		expect(MEMORY_ENTRY_ID_PATTERN.test(`m_${"a".repeat(31)}`)).toBe(false);
		expect(MEMORY_ENTRY_ID_PATTERN.test(`m_${"a".repeat(33)}`)).toBe(false);
		// 大写 hex 不收（RAG 侧正则一致，避免两侧形态判断分叉）
		expect(MEMORY_ENTRY_ID_PATTERN.test(`m_${"A".repeat(32)}`)).toBe(false);
		expect(MEMORY_ENTRY_ID_PATTERN.test(`x_${"a".repeat(32)}`)).toBe(false);
	});

	it("提示词版本存在（提示词改动后可回溯某批记忆是谁生成的）", () => {
		expect(MEMORY_PROMPT_VERSION).toMatch(/^fiat-mem-v\d+$/);
	});

	it("MemoryScope 的权威定义在 types.ts，identity.ts 只 re-export（避免两份枚举漂移）", () => {
		// 能同时从两个模块拿到同一个值，且拼出的 collection 一致
		const id = resolveMemoryIdentity({ user: { id: "alice" } });
		expect(id.collection).toBe(memoryCollection("user", sanitizeMemoryKey("alice")));
	});
});

describe("P15-92 配置：config/memory.yaml", () => {
	it("缺省关：未设 FIAT_MEMORY 时 enabled=false（零网络、零行为变化）", () => {
		const cfg = loadMemoryConfig(MEMORY_CONFIG_PATH, {});
		expect(cfg.enabled).toBe(false);
	});

	it("FIAT_MEMORY=1 / true 打开开关（VAR:-default 插值语法）", () => {
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, { FIAT_MEMORY: "1" }).enabled).toBe(true);
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, { FIAT_MEMORY: "true" }).enabled).toBe(true);
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, { FIAT_MEMORY: "0" }).enabled).toBe(false);
	});

	it("★ 契约 8：maxTextChars 锁在 300，且与 RAG 侧约定值一致", () => {
		// RAG 侧 MODULAR-RAG-MCP-SERVER/config/settings.yaml → memory.write.max_text_chars 同为 300。
		// 两侧各有一条断言测试锁住自己的值 —— 不互相读文件（跨仓库测试不可移植）。
		expect(DEFAULT_MEMORY_CONFIG.write.maxTextChars).toBe(300);
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, {}).write.maxTextChars).toBe(300);
	});

	it("随包的配置文件与 DEFAULT_MEMORY_CONFIG 在设计值上逐项一致（防「改了 yaml 忘了改默认」）", () => {
		const cfg = loadMemoryConfig(MEMORY_CONFIG_PATH, {});
		const d = { ...DEFAULT_MEMORY_CONFIG, enabled: cfg.enabled };
		expect(cfg).toEqual(d);
	});

	it("§15.12 的设计值逐项核对（触发 / 提取 / 写入 / 晋升 / 读取 / retention）", () => {
		const cfg = loadMemoryConfig(MEMORY_CONFIG_PATH, {});
		expect(cfg.trigger).toEqual({
			onCorrectionSignal: true,
			minTurns: 3,
			atSessionEnd: true,
			maxRunsPerSession: 2,
		});
		expect(cfg.extract).toEqual({ timeoutMs: 45_000, sliceTurns: 12 });
		expect(cfg.write).toEqual({ minConfidence: 0.6, maxTextChars: 300, maxPerRun: 5 });
		expect(cfg.promote).toEqual({ promotionThreshold: 3, similarityFloor: 0.82 });
		expect(cfg.read).toEqual({
			hotInjectionMaxEntries: 8,
			hotInjectionMaxChars: 400,
			defaultTopK: 5,
			hotKinds: ["user", "feedback"],
		});
		expect(cfg.retention).toEqual({ referenceTtlDays: 90, projectTtlDays: 180 });
	});

	it("只有 user / feedback 进热注入（project / reference 易过时，塞进 systemPrompt 更危险）", () => {
		expect(loadMemoryConfig(MEMORY_CONFIG_PATH, {}).read.hotKinds).toEqual(["user", "feedback"]);
	});

	it("文件读不到 → 全默认且不抛（配置缺失 = 这个旁路不开，同 evolution 口径）", () => {
		const cfg = loadMemoryConfig(`${ROOT}config/does-not-exist.yaml`, {});
		expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG);
		expect(cfg.enabled).toBe(false);
	});

	it("★ 关记忆时宽容到底：字段写坏也回落默认、不抛（硬约束 7 的「现有测试零改动」）", () => {
		const cfg = normalizeMemoryConfig(
			{ enabled: false, write: { min_confidence: "abc", max_text_chars: -5 }, read: { hot_kinds: ["nope"] } },
			{},
		);
		expect(cfg.enabled).toBe(false);
		expect(cfg.write.minConfidence).toBe(DEFAULT_MEMORY_CONFIG.write.minConfidence);
		expect(cfg.write.maxTextChars).toBe(DEFAULT_MEMORY_CONFIG.write.maxTextChars);
		expect(cfg.read.hotKinds).toEqual(DEFAULT_MEMORY_CONFIG.read.hotKinds);
	});

	it("★ 开记忆时严格：非法阈值 / 非法 hot_kinds 直接抛（配错了别静默回落）", () => {
		expect(() => normalizeMemoryConfig({ enabled: true, write: { min_confidence: 1.5 } }, {})).toThrow(
			MemoryConfigError,
		);
		expect(() => normalizeMemoryConfig({ enabled: true, write: { max_text_chars: "many" } }, {})).toThrow(
			MemoryConfigError,
		);
		expect(() => normalizeMemoryConfig({ enabled: true, read: { hot_kinds: ["user", "bogus"] } }, {})).toThrow(
			MemoryConfigError,
		);
	});

	it("enabled 是布尔插值：写错字符串直接抛（开关写错最不该静默）", () => {
		expect(() => normalizeMemoryConfig({ enabled: "maybe" }, {})).toThrow(MemoryConfigError);
	});

	it("开记忆 + 全部字段合法 → 正常通过（严格模式不该误杀）", () => {
		const cfg = normalizeMemoryConfig({ enabled: true, write: { min_confidence: 0.75, max_text_chars: 200 } }, {});
		expect(cfg).toMatchObject({ enabled: true, write: { minConfidence: 0.75, maxTextChars: 200 } });
	});
});

describe("P15-92 策略锚点：tool_policies.yaml 的 memory_search 条目", () => {
	const policies = loadPolicies(POLICIES_PATH);

	it("条目存在（漏配 = 闸门③ 默认拒绝 = 工具静默全灭）", () => {
		expect(policies.has("memory_search")).toBe(true);
	});

	it("L1 只读，三环境可读，三个角色可读", () => {
		const p = policies.get("memory_search");
		expect(p?.risk_level).toBe("L1");
		expect(p?.allowed_environments).toEqual(["dev", "staging", "prod"]);
		expect(p?.allowed_roles).toEqual(["oncall", "ops", "viewer"]);
		expect(p?.approval_required).toBeFalsy();
	});

	it("刻意不给 collection_scopes（否则引擎会往入参注入 collection，多一个「谁决定分区」的说法）", () => {
		expect(policies.get("memory_search")?.collection_scopes).toBeUndefined();
	});

	it("注册名 fiat_memory_search 经 policyToolName 剥前缀后命中该条目", () => {
		const verdict = canExecute(policies, {
			tool: "fiat_memory_search",
			user: { id: "u1", role: "viewer" },
			environment: "prod",
			input: { query: "x" },
		});
		expect(verdict.allowed).toBe(true);
		// 且不该注入任何 rewrite
		expect(verdict.rewrite).toBeUndefined();
	});

	it("反面：未配策略的相邻工具名仍然 fail-closed（证明上面那条断言不是恒真）", () => {
		const verdict = canExecute(policies, {
			tool: "fiat_memory_store",
			user: { id: "u1", role: "ops" },
			environment: "dev",
			input: {},
		});
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toContain("未知工具");
	});

	it("硬约束 1 的锚点：tool_policies.yaml 里不得出现任何记忆**写**工具", () => {
		const raw = readFileSync(POLICIES_PATH, "utf-8");
		expect(raw).not.toMatch(/tool:\s*memory_(store|write|forget)\b/);
	});
});
