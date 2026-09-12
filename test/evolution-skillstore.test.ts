/**
 * P12-72 补充测试：技能库存储 / Curator / 索引注入（P12-64 / P12-65 / P12-71）。
 *
 * 这三块在 DEV_SPEC 的任务拆分里没有点名测试文件（只列了 trigger / policy / reviewer / apply），
 * 但它们同样决定「自进化会不会写坏磁盘」与「注入会不会每轮打掉 prefix cache」，
 * 所以单独补一个文件。三类断言：
 *
 *   1. **能力**：扁平一层扫描、frontmatter 往返、原子写、归档 / 恢复、快照 / 回滚。
 *   2. **防护**：`origin` 缺省为 `human`（保守保护）、路径穿越读不出技能目录外的文件。
 *   3. **确定性**：索引顺序只由 name 决定（分数刷新不打乱顺序）、Curator 幂等。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "../src/server/evolution/curator.ts";
import { composeSystemPrompt, renderSkillIndex } from "../src/server/evolution/index-prompt.ts";
import { SkillStore, slugify, splitFrontmatter } from "../src/server/evolution/skillStore.ts";
import { DEFAULT_EVOLUTION_CONFIG, type EvolutionConfig } from "../src/server/evolution/types.ts";

const CFG: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG };
const DAY = 24 * 60 * 60 * 1000;

describe("P12-64 SkillStore", () => {
	let tempDir: string;
	let root: string;
	let store: SkillStore;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-evo-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		root = join(tempDir, "pi-skills");
		mkdirSync(root, { recursive: true });
		store = new SkillStore(root);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const BODY = { description: "核对返现表格", whenToUse: ["上传返现表格时"], body: "## Procedure\n1. parse" };

	it("upsert → get：frontmatter 往返无损，且 origin 记为 agent", () => {
		store.upsertSkill({ name: "cashback-reconcile", ...BODY, now: "2026-09-12T00:00:00.000Z" });
		const s = store.get("cashback-reconcile");
		expect(s?.description).toBe("核对返现表格");
		expect(s?.whenToUse).toEqual(["上传返现表格时"]);
		expect(s?.origin).toBe("agent");
		expect(s?.version).toBe("0.1.0");
		expect(s?.body).toContain("1. parse");
		// 磁盘上没有 .tmp 残留（原子写成功的侧证）
		expect(readdirSync(join(root, "cashback-reconcile")).some((f) => f.includes(".tmp-"))).toBe(false);
	});

	it("重写同名技能：版本 minor 递增，且**旧的评测凭证被清掉**（改过的技能必须重新证明）", () => {
		const first = store.upsertSkill({ name: "sk", ...BODY, caseId: "c1" });
		store.setVerified("sk", { caseId: "c1", score: 0.9, verifiedAt: "2026-09-12T01:00:00.000Z" });
		expect(store.get("sk")?.verifiedBy?.score).toBe(0.9);

		const second = store.upsertSkill({ name: "sk", ...BODY, body: "## Procedure\n1. 改了流程", caseId: "c1" });
		expect(second.version).toBe("0.2.0");
		expect(first.version).toBe("0.1.0");
		// 锚点还在（知道该跑哪个 case），但分数没了 → 索引里回到 unverified
		expect(second.verifiedBy?.caseId).toBe("c1");
		expect(second.verifiedBy?.score).toBeUndefined();
		expect(store.index()[0]?.score).toBeUndefined();
	});

	it("扁平一层扫描：不含 SKILL.md 的目录、嵌套技能、点开头目录都不算技能", () => {
		store.upsertSkill({ name: "top-level", ...BODY });
		// 手工造：一个普通目录、一个嵌套技能、一个 .backups —— 都不该被看到
		mkdirSync(join(root, "nested", "inner"), { recursive: true });
		writeFileSync(join(root, "nested", "inner", "SKILL.md"), "---\nname: inner\n---\n", "utf-8");
		mkdirSync(join(root, ".backups"), { recursive: true });
		expect(store.names()).toEqual(["top-level"]);
		expect(store.list().map((s) => s.name)).toEqual(["top-level"]);
	});

	describe("origin 判定（保护清单第 1 条的输入）", () => {
		/** 人手写一个技能目录（不经过 upsertSkill） */
		function writeHumanSkill(name: string, originLine = ""): void {
			mkdirSync(join(root, name), { recursive: true });
			writeFileSync(
				join(root, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: 人写的\nwhen_to_use:\n  - 任何时候\n${originLine}---\n\n## Procedure\n人工流程\n`,
				"utf-8",
			);
		}

		it("清单存在但没记它 → human（有人维护过清单却不含它 = 不是自进化建的）", () => {
			store.upsertSkill({ name: "agent-made", ...BODY });
			writeHumanSkill("human-skill");
			expect(store.get("agent-made")?.origin).toBe("agent");
			expect(store.get("human-skill")?.origin).toBe("human");
			// 即使 frontmatter 自称 agent，也不采信 —— frontmatter 就在自进化要写的那个文件里，
			// 拿它当授权依据是循环论证（清单在技能目录外，只由 applyProposal 写）
			expect(store.get("human-skill")?.origin).toBe("human");
		});

		it("清单整体缺失 → 退到 frontmatter，并**告警一次**（不静默降级）", () => {
			const warnings: string[] = [];
			const bare = new SkillStore(root, { onWarn: (m) => warnings.push(m) });
			writeHumanSkill("boot", "origin: agent\n");
			expect(bare.get("boot")?.origin).toBe("agent");
			expect(store.get("boot")?.origin).toBe("agent");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(".origin.json");

			// frontmatter 也没有 origin → 保守兜底 human
			writeHumanSkill("boot2");
			expect(bare.get("boot2")?.origin).toBe("human");
			expect(warnings).toHaveLength(1); // 只告警一次，不刷屏
		});

		it("upsertSkill 会同时写清单与 frontmatter（两条来源一致）", () => {
			store.upsertSkill({ name: "agent-made", ...BODY });
			const raw = readFileSync(join(root, "agent-made", "SKILL.md"), "utf-8");
			expect(raw).toContain("origin: agent");
			expect(JSON.parse(readFileSync(join(root, ".origin.json"), "utf-8"))["agent-made"]).toBe("agent");
		});
	});

	it("read：file_path 不能穿越出技能目录", () => {
		store.upsertSkill({ name: "sk", ...BODY });
		writeFileSync(join(tempDir, "secret.txt"), "机密", "utf-8");
		expect(store.read("sk", "../../secret.txt")).toBeNull();
		expect(store.read("sk", "references/missing.md")).toBeNull();
		// 目录内的支持文件可以读
		mkdirSync(join(root, "sk", "references"), { recursive: true });
		writeFileSync(join(root, "sk", "references", "faq.md"), "常见问题", "utf-8");
		expect(store.read("sk", "references/faq.md")).toBe("常见问题");
	});

	it("read 不存在 → null，且不抛（fiat_skill_view 据此回「可用技能清单」）", () => {
		expect(store.read("nope")).toBeNull();
	});

	it("归档 / 恢复：软删，正文仍在磁盘上，restore 拿得回来；pinned 不可归档", () => {
		store.upsertSkill({ name: "sk", ...BODY });
		expect(store.archive("sk", 1_700_000_000_000)).toBe(true);
		expect(store.list()).toHaveLength(0);
		expect(store.archivedNames()).toHaveLength(1);
		// 软删：文件没被删掉
		expect(existsSync(join(root, ".archive"))).toBe(true);
		expect(store.restore("sk")).toBe(true);
		expect(store.list().map((x) => x.name)).toEqual(["sk"]);

		store.setPinned("sk", true);
		expect(store.archive("sk", 1_700_000_000_001)).toBe(false);
	});

	it("快照 / 回滚是**精确还原**：回滚掉一个新技能后它必须消失", () => {
		store.upsertSkill({ name: "old", ...BODY });
		const snap = store.snapshot("2026-09-12T00:00:00.000Z");
		store.upsertSkill({ name: "brand-new", ...BODY, description: "新技能" });
		expect(
			store
				.list()
				.map((s) => s.name)
				.sort(),
		).toEqual(["brand-new", "old"]);

		store.rollback(snap);
		// tar 解包不会删除快照里没有的文件 —— 所以 rollback 必须先清空再解包
		expect(store.list().map((s) => s.name)).toEqual(["old"]);
	});

	it("回滚保留 .backups 与遥测清单（人后来设的 pin / 状态不被撤销）", () => {
		store.upsertSkill({ name: "sk", ...BODY });
		const snap = store.snapshot("2026-09-12T00:00:00.000Z");
		store.setPinned("sk", true);
		store.rollback(snap);
		expect(store.get("sk")?.pinned).toBe(true);
		expect(existsSync(snap)).toBe(true);
	});

	it("recordUsage 累计使用遥测（Curator 的时间衰减依据）", () => {
		store.upsertSkill({ name: "sk", ...BODY });
		store.recordUsage("sk", 1_000);
		store.recordUsage("sk", 2_000);
		expect(store.get("sk")?.useCount).toBe(2);
		expect(store.get("sk")?.lastUsedAt).toBe(2_000);
	});

	it("非法技能名一律拒绝（slug 规范顺带挡住路径穿越）", () => {
		expect(() => store.writeSkill("../evil", "x")).toThrow();
		expect(store.get("../evil")).toBeNull();
		expect(slugify("返现对账流程 v2")).toBe("v2"); // 中文被剥掉后只剩 v2 —— 太长/太空时兜底
		expect(slugify("Cashback Reconcile")).toBe("cashback-reconcile");
	});

	it("splitFrontmatter：无 frontmatter / 缺结束标记时按「纯正文」处理，不抛", () => {
		expect(splitFrontmatter("## Procedure\n正文").meta).toEqual({});
		expect(splitFrontmatter("---\nname: x\n没有结束").body).toContain("---");
	});
});

describe("P12-65 索引注入", () => {
	it("索引：verified 排在前、组内按 name；分数只影响括号里的数字，不影响顺序", () => {
		const entries = [
			{ name: "zebra", description: "z", whenToUse: [], score: 0.9, pinned: false },
			{ name: "alpha", description: "a", whenToUse: ["场景 A"], score: 0.5, pinned: false },
			{ name: "beta", description: "b", whenToUse: [], pinned: false },
		];
		const text = renderSkillIndex(entries);
		const order = text
			.split("\n")
			.slice(1)
			.map((l) => l.slice(2, l.indexOf(" (")));
		expect(order).toEqual(["alpha", "zebra", "beta"]); // verified(按名) → unverified

		// 分数变化不改变顺序 → 不打掉 prefix cache
		const bumped = entries.map((e) => (e.score !== undefined ? { ...e, score: e.score - 0.1 } : e));
		expect(renderSkillIndex(bumped)).not.toBe(text); // 数字变了
		expect(
			renderSkillIndex(bumped)
				.split("\n")
				.slice(1)
				.map((l) => l.slice(2, l.indexOf(" ("))),
		).toEqual(order); // 顺序没变
	});

	it("索引行格式：unverified 与 pinned 都有显式标记", () => {
		const text = renderSkillIndex([
			{ name: "a", description: "d", whenToUse: ["写"], pinned: false },
			{ name: "b", description: "d", whenToUse: [], score: 0.92, pinned: true },
		]);
		expect(text).toContain("- a (unverified): d → 写");
		expect(text).toContain("- b (0.92) [pinned]: d");
	});

	it("空技能库 → 空串（不产出空标题，避免每轮多一段恒定文本）", () => {
		expect(renderSkillIndex([])).toBe("");
		expect(composeSystemPrompt("", {})).toBe("");
	});

	it("composeSystemPrompt：追加在**末尾**，base 为空时不产生前导空行", () => {
		const base = "你是 fiat-agent。\n\n## 合规硬约束\n1. 生产写必须审批";
		const composed = composeSystemPrompt(base, {
			skills: [{ name: "sk", description: "d", whenToUse: [], score: 0.9, pinned: false }],
			memory: "列名约定",
		});
		expect(composed.startsWith(base)).toBe(true);
		expect(composed.indexOf("## 合规硬约束")).toBeLessThan(composed.indexOf("## 可用技能"));
		expect(composed.indexOf("## 可用技能")).toBeLessThan(composed.indexOf("## 近期事实"));

		const onlySkills = composeSystemPrompt("", {
			skills: [{ name: "sk", description: "d", whenToUse: [], score: 0.9, pinned: false }],
		});
		expect(onlySkills.startsWith("## 可用技能")).toBe(true);
	});

	it("记忆段自带「提示层，不是规则源」的警示（铁律 4 的可见化）", () => {
		const text = composeSystemPrompt("base", { memory: "本次澄清了列名" });
		expect(text).toContain("不得作为金额 / 状态机 / 字段校验的依据");
	});
});

describe("P12-71 Curator", () => {
	let tempDir: string;
	let store: SkillStore;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fiat-evo-curate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "pi-skills"), { recursive: true });
		store = new SkillStore(join(tempDir, "pi-skills"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/** 造一个「创建于 now-agoDays，从未被使用」的技能 */
	function makeSkill(name: string, agoDays: number, now: number): void {
		store.upsertSkill({
			name,
			description: "d",
			whenToUse: ["x"],
			body: "## Procedure\n1. 调工具",
			now: new Date(now - agoDays * DAY).toISOString(),
		});
	}

	it("未超阈值 → 保持 active；超 30d → stale；超 90d → archived（一步到位）", () => {
		const now = Date.parse("2026-09-12T00:00:00.000Z");
		makeSkill("fresh", 5, now);
		makeSkill("old", 40, now);
		makeSkill("ancient", 120, now);

		const r = curate({ skills: store, config: CFG, now: () => new Date(now) });
		expect(r.staled).toEqual(["old"]);
		expect(r.archived).toEqual(["ancient"]);
		expect(store.get("fresh")?.state).toBe("active");
		expect(store.get("old")?.state).toBe("stale");
		// 归档 = 从 list 里消失（软删，仍在 .archive）
		expect(store.list().map((s) => s.name)).toEqual(["fresh", "old"]);
		expect(store.restore("ancient")).toBe(true);
	});

	it("pin 是免死金牌：既不 stale 也不 archive，且进报告", () => {
		const now = Date.parse("2026-09-12T00:00:00.000Z");
		makeSkill("pinned-skill", 200, now);
		store.setPinned("pinned-skill", true);

		const r = curate({ skills: store, config: CFG, now: () => new Date(now) });
		expect(r.pinned).toEqual(["pinned-skill"]);
		expect(r.archived).toEqual([]);
		expect(store.get("pinned-skill")?.state).toBe("active");
		expect(r.report).toContain("pinned，豁免");
	});

	it("幂等：同一时刻跑两次，第二次零迁移", () => {
		const now = Date.parse("2026-09-12T00:00:00.000Z");
		makeSkill("old", 40, now);
		makeSkill("ancient", 120, now);
		const first = curate({ skills: store, config: CFG, now: () => new Date(now) });
		expect(first.staled).toEqual(["old"]);
		const second = curate({ skills: store, config: CFG, now: () => new Date(now) });
		expect(second.staled).toEqual([]);
		expect(second.archived).toEqual([]);
	});

	it("用过就年轻：last_used_at 覆盖 created_at 作为时间基准", () => {
		const now = Date.parse("2026-09-12T00:00:00.000Z");
		makeSkill("old-but-used", 200, now);
		store.recordUsage("old-but-used", now - 2 * DAY);
		const r = curate({ skills: store, config: CFG, now: () => new Date(now) });
		expect(r.archived).toEqual([]);
		expect(store.get("old-but-used")?.state).toBe("active");
	});

	it("报告可写文件（对齐 Hermes 的 REPORT.md）", () => {
		const now = Date.parse("2026-09-12T00:00:00.000Z");
		makeSkill("fresh", 1, now);
		const reportPath = join(tempDir, "REPORT.md");
		curate({ skills: store, config: CFG, now: () => new Date(now), reportPath });
		expect(readFileSync(reportPath, "utf-8")).toContain("# 技能库维护报告");
	});

	it("空技能库也能出报告（不抛）", () => {
		const r = curate({ skills: store, config: CFG });
		expect(r.report).toContain("技能库为空");
	});
});
