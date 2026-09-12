/**
 * skillStore —— 技能库存储（阶段 12 / P12-64），自进化的**唯一落盘出口**。
 *
 * 目录约定（§10.6）：
 *
 *   workspace/pi-skills/
 *     .origin.json            # name → "agent" | "human"  只有 agent 的才可被自进化改写
 *     .usage.json             # 使用遥测：use_count / last_used_at / state / pinned
 *     .archive/               # 归档软删，可 restore
 *     .backups/<utc-iso>/     # tar.gz 快照，applyProposal 前必拍
 *     cashback-reconcile/SKILL.md
 *
 * 三条设计口径（与阶段 8 铁律一致）：
 *
 * 1. **不用 Pi 的 skills 通道**。`resources.ts` 传 `noSkills: true` 是阶段 8 的铁律
 *    （打开它 = 把目录自动发现一起带回来）。索引 / 正文 / 写入**全部自研**，就是本模块。
 *
 * 2. **扁平一层**。扫描只认 `pi-skills/<name>/SKILL.md`，不递归——对齐踩坑表
 *    「扩展路径只递归一层」。`list()` 用 `readdirSync(withFileTypes)` 显式过滤目录，
 *    天然把 `.origin.json` / `.archive` / `.backups` 这些点开头的条目排除在外。
 *
 * 3. **同步实现**。自进化是旁路能力（一次评审最多写 1~3 个文件），不追求并发；
 *    同步语义让「写 → 拍快照 → 回滚」这条链在代码上一眼可读，也免去与 PG 异步
 *    ProposalStore 混用时的时序陷阱。落盘前的**判定**仍是纯函数（policy.ts）。
 *
 * 写路径只有一条：`writeSkill()`。它先原子写临时文件再 rename（同目录内 rename 是
 * 原子操作），所以「文件存在」永远意味着「内容完整」。调用方（apply.ts）负责在调用
 * 之前拍快照。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { SkillOrigin, SkillState } from "./types.ts";

/** 技能正文的固定章节顺序（§10.6）；缺失不报错，只在索引时标注 */
export const SKILL_SECTIONS = ["## When to Use", "## Procedure", "## Pitfalls", "## Verification"] as const;

/**
 * 评测凭证（§10.6 / §10.10）。
 *
 * ⚠️ `case_id` 与 `score` 的**生命周期不同**，这正是本类型两个字段都可选的原因：
 *   - `case_id`：**锚点**。落盘时写入（提案里带过来的），决定「该跑哪个 case 来验它」。
 *   - `score` / `verified_at`：**凭证**。只有评测真的通过后才由 `verify.ts` 回写。
 *
 * 把两者混为一谈会导致一个很隐蔽的错误：刚落盘的技能因为「有 verified_by」被当成
 * 已通过评测（分数 0 或伪造的分数），从而在索引里排到 verified 组——**自进化的准入门槛
 * 就被绕过了**。所以「有锚点」≠「已验证」，判定一律看 `score` 是否存在。
 */
export interface SkillVerifiedBy {
	caseId: string;
	score?: number;
	verifiedAt?: string;
}

/** 一个技能的完整视图（frontmatter + 正文 + 遥测） */
export interface SkillMeta {
	name: string;
	description: string;
	whenToUse: string[];
	author: string;
	/** 有效来源：`.origin.json` 优先，其次 frontmatter，最后兜底 `human`（保守） */
	origin: SkillOrigin;
	version: string;
	createdAt: string;
	/** §10.10 评测回写；缺失 = unverified（仍可注入，但排在 verified 之后） */
	verifiedBy?: SkillVerifiedBy;
	body: string;
	/** SKILL.md 的绝对路径 */
	path: string;
	/** 遥测（.usage.json） */
	state: SkillState;
	pinned: boolean;
	useCount: number;
	lastUsedAt?: number;
}

/** 注入 systemPrompt 的索引条目（§10.6） */
export interface SkillIndexEntry {
	name: string;
	description: string;
	whenToUse: string[];
	/** verified 的分数；unverified 为 undefined */
	score?: number;
	pinned: boolean;
}

/** frontmatter 的形状（写回时按此顺序序列化，保证 diff 稳定） */
interface SkillFrontmatter {
	name: string;
	description: string;
	when_to_use: string[];
	author: string;
	origin: SkillOrigin;
	version: string;
	created_at: string;
	/** 锚点必填、凭证可缺（见 SkillVerifiedBy 的说明：有锚点 ≠ 已验证） */
	verified_by?: { case_id: string; score?: number; verified_at?: string };
	pinned: boolean;
}

interface UsageEntry {
	use_count: number;
	last_used_at?: number;
	state: SkillState;
	pinned: boolean;
}

type OriginMap = Record<string, SkillOrigin>;
type UsageMap = Record<string, UsageEntry>;

/** slug 规范：小写字母 / 数字 / 连字符，2..48 字。同时挡住路径穿越 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function isValidSkillSlug(name: string): boolean {
	return SKILL_SLUG_PATTERN.test(name) && !name.includes("..");
}

/** 把任意标题归一成合法 slug（提案 target 可能是「返现对账流程」这类中文标题） */
export function slugify(input: string): string {
	const base = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const trimmed = base.slice(0, 48).replace(/-+$/g, "");
	return trimmed.length >= 2 ? trimmed : "skill-draft";
}

/** 拆 frontmatter：返回 raw 元数据对象与正文。无 frontmatter 时元数据为空对象 */
export function splitFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("\n---", 3);
	if (end < 0) return { meta: {}, body: content };
	const raw = content.slice(3, end);
	const body = content.slice(end + 4).replace(/^\r?\n/, "");
	try {
		const parsed = parse(raw);
		return { meta: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}, body };
	} catch {
		return { meta: {}, body };
	}
}

/** 组装 SKILL.md 全文（frontmatter 顺序固定 → 同内容同哈希 → 幂等键稳定） */
export function composeSkill(meta: SkillFrontmatter, body: string): string {
	const fm = stringify(meta).trimEnd();
	return `---\n${fm}\n---\n\n${body.replace(/^\s+/, "")}`;
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((v) => String(v)).filter((v) => v.length > 0);
	if (typeof raw === "string" && raw.length > 0) return [raw];
	return [];
}

/** UTC ISO 里的 `:` 在部分文件系统上是非法字符（也难读），统一换成 `-` */
function stampForDir(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

export class SkillStore {
	readonly root: string;
	private readonly onWarn?: (message: string) => void;
	private warnedMissingOrigin = false;

	constructor(root: string, opts: { onWarn?: (message: string) => void } = {}) {
		this.root = resolve(root);
		this.onWarn = opts.onWarn;
	}

	// ---------- 内部：清单读写 ----------

	private get originPath(): string {
		return join(this.root, ".origin.json");
	}

	private get usagePath(): string {
		return join(this.root, ".usage.json");
	}

	private readJson<T extends object>(path: string): T {
		try {
			return (JSON.parse(readFileSync(path, "utf-8")) as T) ?? ({} as T);
		} catch {
			return {} as T;
		}
	}

	/** 清单一律原子写：先临时文件再 rename，避免半截 JSON 让整个技能库读不出来 */
	private writeJson(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
	}

	private origins(): OriginMap {
		return this.readJson<OriginMap>(this.originPath);
	}

	private usages(): UsageMap {
		return this.readJson<UsageMap>(this.usagePath);
	}

	/** `.origin.json` 是本模块的**权威**来源；frontmatter 的 origin 只作兜底 */
	setOrigin(name: string, origin: SkillOrigin): void {
		const m = this.origins();
		m[name] = origin;
		this.writeJson(this.originPath, m);
	}

	/**
	 * 有效来源判定（保护清单第 1 条的输入）。三分支，按安全性从高到低：
	 *
	 *   1. `.origin.json` **存在且有该技能** → 以它为准。清单在技能目录**之外**、
	 *      只由 `applyProposal` 写，所以它是「授权来源」；而 frontmatter 就在自进化
	 *      要写的那个文件里 —— 拿它当授权依据是循环论证。
	 *   2. `.origin.json` **存在但没有该技能** → `human`。有人维护过清单却不包含它，
	 *      说明它不是自进化建的 → 保护。
	 *   3. `.origin.json` **整体缺失**（新克隆的仓库漏提交了 dotfile）→ 退到 frontmatter；
	 *      再缺则 `human`。这一支是为了让「清单没被提交」不至于让整个技能库永久只读，
	 *      但它**会告警一次** —— 静默降级比报错更难查。
	 */
	originOf(name: string, frontmatterOrigin?: unknown): SkillOrigin {
		if (existsSync(this.originPath)) {
			const recorded = this.origins()[name];
			if (recorded === "agent" || recorded === "human") return recorded;
			return "human";
		}
		if (!this.warnedMissingOrigin) {
			this.warnedMissingOrigin = true;
			this.onWarn?.(`.origin.json 缺失（${this.originPath}）：来源判定退到 frontmatter。建议把该文件纳入版本管理。`);
		}
		if (frontmatterOrigin === "agent" || frontmatterOrigin === "human") return frontmatterOrigin;
		return "human";
	}

	private usageOf(name: string): UsageEntry {
		const u = this.usages()[name];
		return {
			use_count: u?.use_count ?? 0,
			...(u?.last_used_at !== undefined ? { last_used_at: u.last_used_at } : {}),
			state: u?.state ?? "active",
			pinned: u?.pinned ?? false,
		};
	}

	private putUsage(name: string, patch: Partial<UsageEntry>): void {
		const m = this.usages();
		m[name] = { ...this.usageOf(name), ...patch };
		this.writeJson(this.usagePath, m);
	}

	// ---------- 读 ----------

	/**
	 * 技能目录名（扁平一层）：跳过点开头条目，天然排除 `.archive` / `.backups` / 清单文件；
	 * 且**必须真的含 SKILL.md** ——否则一个碰巧叫合法 slug 的普通目录（如 `nested/`）
	 * 会被当成技能，`list()` 里出现一个读不出 description 的空壳。
	 */
	names(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && isValidSkillSlug(e.name))
			.filter((e) => existsSync(join(this.root, e.name, "SKILL.md")))
			.map((e) => e.name)
			.sort();
	}

	get(name: string): SkillMeta | null {
		if (!isValidSkillSlug(name)) return null;
		const path = join(this.root, name, "SKILL.md");
		if (!existsSync(path)) return null;
		const { meta, body } = splitFrontmatter(readFileSync(path, "utf-8"));
		const usage = this.usageOf(name);
		const verified = meta.verified_by as Record<string, unknown> | undefined;
		const verifiedScore = typeof verified?.score === "number" ? verified.score : undefined;
		return {
			name,
			description: String(meta.description ?? ""),
			whenToUse: asStringArray(meta.when_to_use),
			author: String(meta.author ?? ""),
			origin: this.originOf(name, meta.origin),
			version: String(meta.version ?? "0.1.0"),
			createdAt: String(meta.created_at ?? ""),
			...(verified?.case_id
				? {
						verifiedBy: {
							caseId: String(verified.case_id),
							// 只有评测回写过分数才算「已验证」；只有锚点时为 undefined = unverified
							...(verifiedScore !== undefined ? { score: verifiedScore } : {}),
							...(typeof verified.verified_at === "string" ? { verifiedAt: verified.verified_at } : {}),
						},
					}
				: {}),
			body,
			path,
			state: usage.state,
			pinned: usage.pinned,
			useCount: usage.use_count,
			...(usage.last_used_at !== undefined ? { lastUsedAt: usage.last_used_at } : {}),
		};
	}

	/** 全部技能（按 name 升序）；已归档的**不在**其中——归档 = 软删，注入与索引都不再看到 */
	list(): SkillMeta[] {
		const out: SkillMeta[] = [];
		for (const n of this.names()) {
			const s = this.get(n);
			if (s && s.state !== "archived") out.push(s);
		}
		return out;
	}

	/** 注入用索引：**按 name 稳定排序**（§10.6——顺序稳定才不会每轮打掉 prefix cache） */
	index(): SkillIndexEntry[] {
		return this.list().map((s) => ({
			name: s.name,
			description: s.description,
			whenToUse: s.whenToUse,
			// 只有评测回过分数才算 verified；仅带锚点的仍是 unverified
			...(s.verifiedBy?.score !== undefined ? { score: s.verifiedBy.score } : {}),
			pinned: s.pinned,
		}));
	}

	/**
	 * 读正文（`fiat_skill_view` 的落点）。
	 * `filePath` 允许读技能目录内的支持文件（如 `references/xxx.md`），
	 * 但必须落在该技能目录内——`normalize` 后前缀校验挡住 `../../` 穿越。
	 */
	read(name: string, filePath?: string): string | null {
		const skill = this.get(name);
		if (!skill) return null;
		if (!filePath) return skill.body;
		const dir = resolve(this.root, name);
		const target = resolve(dir, filePath);
		if (target !== dir && !target.startsWith(dir + sep)) return null;
		if (!existsSync(target)) return null;
		return readFileSync(target, "utf-8");
	}

	// ---------- 写 ----------

	/** 原子写 SKILL.md（同目录 rename）；目录不存在则建 */
	writeSkill(name: string, content: string): string {
		if (!isValidSkillSlug(name)) throw new Error(`skillStore: 非法技能名 ${name}`);
		const dir = join(this.root, name);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "SKILL.md");
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, content, "utf-8");
		renameSync(tmp, path);
		return path;
	}

	/** 把提案载荷写成 SKILL.md（isNew 决定 version 起点与 created_at 是否沿用） */
	upsertSkill(args: {
		name: string;
		description: string;
		whenToUse: string[];
		body: string;
		caseId?: string;
		now?: string;
	}): SkillMeta {
		const existing = this.get(args.name);
		const nowIso = args.now ?? new Date().toISOString();
		const caseId = args.caseId ?? existing?.verifiedBy?.caseId;
		const meta: SkillFrontmatter = {
			name: args.name,
			description: args.description,
			when_to_use: args.whenToUse,
			author: "Fiat",
			origin: "agent",
			version: bumpVersion(existing?.version),
			created_at: existing?.createdAt || nowIso,
			// ⚠️ 只写**锚点**，不写分数：内容一改，旧的验证结论就失效了。
			// 「重写即失效」是刻意的——把上一次的分数带过来会让一个改过的技能继续冒充已过关。
			// 分数由 verify.ts 在这次落盘后重新跑 case 拿到（见 SkillVerifiedBy 的注释）。
			...(caseId ? { verified_by: { case_id: caseId } } : {}),
			pinned: existing?.pinned ?? false,
		};
		this.writeSkill(args.name, composeSkill(meta, args.body));
		this.setOrigin(args.name, "agent");
		// 新技能第一次落盘时补一条遥测，保证 Curator 有时间基准
		if (!this.usages()[args.name]) this.putUsage(args.name, { use_count: 0 });
		const after = this.get(args.name);
		if (!after) throw new Error(`skillStore: 写入后读不到 ${args.name}`);
		return after;
	}

	/** §10.10 评测通过后回写 verified_by（正文不动） */
	setVerified(name: string, verified: SkillVerifiedBy): boolean {
		const skill = this.get(name);
		if (!skill) return false;
		const { meta, body } = splitFrontmatter(readFileSync(skill.path, "utf-8"));
		const next = {
			...meta,
			verified_by: { case_id: verified.caseId, score: verified.score, verified_at: verified.verifiedAt },
		} as Record<string, unknown>;
		this.writeSkill(name, composeSkill(next as unknown as SkillFrontmatter, body));
		return true;
	}

	/** `fiat_skill_view` 命中一次就记一次（Curator 的时间衰减靠它） */
	recordUsage(name: string, at = Date.now()): void {
		const u = this.usageOf(name);
		this.putUsage(name, { use_count: u.use_count + 1, last_used_at: at });
	}

	setPinned(name: string, pinned: boolean): boolean {
		if (!this.get(name)) return false;
		this.putUsage(name, { pinned });
		return true;
	}

	setState(name: string, state: SkillState): boolean {
		if (!this.get(name)) return false;
		this.putUsage(name, { state });
		return true;
	}

	// ---------- 归档 / 恢复（软删，可 restore） ----------

	private get archiveDir(): string {
		return join(this.root, ".archive");
	}

	/** 归档 = 目录移进 `.archive/`；文件还在，`restore` 能拿回来 */
	archive(name: string, at = Date.now()): boolean {
		const skill = this.get(name);
		if (!skill) return false;
		if (skill.pinned) return false;
		mkdirSync(this.archiveDir, { recursive: true });
		const dest = join(this.archiveDir, `${name}-${at}`);
		renameSync(join(this.root, name), dest);
		this.putUsage(name, { state: "archived" });
		return true;
	}

	/** 恢复：优先用最近一次归档目录；也可指定具体归档名 */
	restore(name: string, archiveEntry?: string): boolean {
		if (!existsSync(this.archiveDir)) return false;
		const candidates = readdirSync(this.archiveDir)
			.filter((e) => (archiveEntry ? e === archiveEntry : e.startsWith(`${name}-`)))
			.sort();
		const pick = candidates.at(-1);
		if (!pick) return false;
		renameSync(join(this.archiveDir, pick), join(this.root, name));
		this.putUsage(name, { state: "active" });
		return true;
	}

	archivedNames(): string[] {
		if (!existsSync(this.archiveDir)) return [];
		return readdirSync(this.archiveDir).sort();
	}

	// ---------- 快照 / 回滚 ----------

	private get backupDir(): string {
		return join(this.root, ".backups");
	}

	/**
	 * 拍 tar.gz 快照。**applyProposal 前必拍**——没有快照就没有 rollback，
	 * 而「能被回滚」是这套设计敢自动落盘的前提（§10.2 第 3 条）。
	 *
	 * 排除三类内容，各有理由：
	 *   - `.backups`：否则每次快照都把历史快照再打一遍，指数膨胀。
	 *   - `.origin.json` / `.usage.json`：这是**维护侧状态**（来源、pin、使用遥测），
	 *     不是「技能内容」。把它们纳入回滚会连带撤销人后来设的 pin / 状态，
	 *     而人 vs 自进化的裁量权恰恰要靠 pin 保留（§10.1 第 6 条）。
	 */
	snapshot(at = new Date().toISOString()): string {
		const dir = join(this.backupDir, stampForDir(at));
		mkdirSync(dir, { recursive: true });
		const out = join(dir, "pi-skills.tar.gz");
		if (!existsSync(this.root)) {
			mkdirSync(this.root, { recursive: true });
		}
		// -C 到父目录 + 相对路径，快照里保留 `pi-skills/` 这一层，rollback 才能原地还原
		execFileSync(
			"tar",
			[
				"-czf",
				out,
				"--exclude=.backups",
				"--exclude=.origin.json",
				"--exclude=.usage.json",
				"-C",
				dirname(this.root),
				basenameOf(this.root),
			],
			{ stdio: "ignore" },
		);
		return out;
	}

	/**
	 * 回滚到快照。**必须先清空再解包**——这是本方法最容易写错的地方：
	 * `tar -xzf` 只覆盖 / 新增，**不会删除**快照里不存在的文件。若只解包不清空，
	 * 「回滚一个新建的技能」会失效：技能目录不是被还原，而是**留在原地**，
	 * 于是评测判定它不达标、状志标成 rolled_back，磁盘上却还躺着一个不该存在的技能。
	 *
	 * 保留 `.backups`（历史快照）与两份遥测清单（维护侧状态，见 snapshot 的说明）。
	 */
	rollback(snapshotPath: string): void {
		if (!existsSync(snapshotPath)) throw new Error(`skillStore: 快照不存在 ${snapshotPath}`);
		mkdirSync(this.root, { recursive: true });
		for (const entry of readdirSync(this.root)) {
			if (entry === ".backups" || entry === ".origin.json" || entry === ".usage.json") continue;
			rmSync(join(this.root, entry), { recursive: true, force: true });
		}
		execFileSync("tar", ["-xzf", snapshotPath, "-C", dirname(this.root)], { stdio: "ignore" });
	}

	/** 清空整个技能库（测试 / 本地重置用；归档一并清掉） */
	clear(): void {
		if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
	}
}

function basenameOf(p: string): string {
	const n = normalize(p).split(sep);
	return n[n.length - 1] ?? p;
}

/** 0.1.0 → 0.2.0（minor 递增；技能没有 patch 级的语义） */
function bumpVersion(prev?: string): string {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(prev ?? "");
	if (!m) return "0.1.0";
	return `${m[1]}.${Number(m[2]) + 1}.0`;
}
