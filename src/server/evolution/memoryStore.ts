/**
 * memoryStore —— 第 ②③ 路沉淀的落盘（阶段 12 / P12-64 配套，§10.3）。
 *
 * 两条落点，都是**追加式**（append-only）——记忆是流水，不是可编辑文档：
 *
 *   ② 事实性知识  workspace/memory/YYYY-MM-DD.md        （按天一个文件）
 *   ③ 运行约定    workspace/facts/roles/<role>.md       （按 role 聚合，默认关）
 *
 * ⚠️ **铁律：fiat 的「记忆」绝不能变成第二套规则源。**
 * 权威只有三处：RAG 知识库、`config/tool_policies.yaml`、L2 规则引擎。
 * `workspace/memory/` 只回答「这次对话澄清了什么」，是**提示层**。
 * 任何「从记忆里读到规则并据此算钱 / 改状态」的路径在设计评审阶段直接拒。
 * 本模块因此在两处做了物理约束：
 *   - 写入走 `memoryStore`（只有自进化的 propose → apply 链路能到）；
 *   - 注入走「近期事实摘要段」（条数 / 字数双截断），**不进判定链**。
 *
 * 与 skillStore 同口径：同步实现、原子写、路径穿越防护。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** role 名规范（挡住 `../` 之类的路径穿越；与 tool_policies 里的角色名同构） */
const ROLE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export function isValidRoleName(role: string): boolean {
	return ROLE_PATTERN.test(role) && !role.includes("..");
}

/** `YYYY-MM-DD`（UTC）；同时作为 memory 提案的 target */
export function dayStamp(at = new Date()): string {
	return at.toISOString().slice(0, 10);
}

interface MemorySection {
	/** 条目标题（写入时变成 `#### 标题`） */
	title: string;
	/** 条目正文（一行一条） */
	entries: string[];
}

export interface MemoryStoreOptions {
	/** `workspace` 根；memory 与 facts 都挂在它下面 */
	workspace: string;
}

export class MemoryStore {
	readonly workspace: string;

	constructor(opts: MemoryStoreOptions) {
		this.workspace = resolve(opts.workspace);
	}

	private get memoryDir(): string {
		return join(this.workspace, "memory");
	}

	private factsDir(): string {
		return join(this.workspace, "facts", "roles");
	}

	/** 原子追加：读全文 → 拼 → 临时文件 → rename（避免并发/中断写出半截文件） */
	private appendAtomic(path: string, chunk: string, headerIfNew: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const prev = existsSync(path) ? readFileSync(path, "utf-8") : headerIfNew;
		const sepText = prev.endsWith("\n") ? "" : "\n";
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${prev}${sepText}${chunk}`, "utf-8");
		renameSync(tmp, path);
	}

	/** ② 追加一条事实到当天文件；返回写入的文件路径 */
	appendFact(entry: string, at = new Date()): string {
		const day = dayStamp(at);
		const path = join(this.memoryDir, `${day}.md`);
		const header = `# 事实记忆 ${day}\n\n> 由自进化循环落盘（§10.3 第 ② 路）。**提示层，不是规则源**——不得据此算金额 / 改状态 / 校验字段。\n`;
		this.appendAtomic(path, `- ${entry.trim()}\n`, header);
		return path;
	}

	/** ② 批量追加（一个 memory 提案可含多条） */
	appendFacts(section: MemorySection, at = new Date()): string {
		const day = dayStamp(at);
		const path = join(this.memoryDir, `${day}.md`);
		const header = `# 事实记忆 ${day}\n\n> 由自进化循环落盘（§10.3 第 ② 路）。**提示层，不是规则源**——不得据此算金额 / 改状态 / 校验字段。\n`;
		const chunk = `#### ${section.title.trim()}\n${section.entries.map((e) => `- ${e.trim()}`).join("\n")}\n`;
		this.appendAtomic(path, `${chunk}\n`, header);
		return path;
	}

	/** ③ 追加运行约定到 `facts/roles/<role>.md`（调用方保证 roleFactsEnabled 已开） */
	appendRoleFacts(role: string, section: MemorySection, at = new Date()): string {
		if (!isValidRoleName(role)) throw new Error(`memoryStore: 非法 role 名 ${role}`);
		const path = join(this.factsDir(), `${role}.md`);
		const header = `# 运行约定 · ${role}\n\n> 由自进化循环落盘（§10.3 第 ③ 路，默认关）。**按 role 聚合，不是个人画像**；\n> 提示层，不得作为权限 / 金额 / 状态机的判定依据。\n`;
		const chunk = `## ${dayStamp(at)} · ${section.title.trim()}\n${section.entries.map((e) => `- ${e.trim()}`).join("\n")}\n`;
		this.appendAtomic(path, `${chunk}\n`, header);
		return path;
	}

	/**
	 * 读「近期事实」摘要段（注入用）。
	 * **双截断**（§10.3）：先取最近 `maxDays` 个文件，再按 `maxChars` 裁字数。
	 * 截断是硬要求——记忆无限增长会让 systemPrompt 每轮都在变，prefix cache 全废。
	 */
	recentFacts(maxDays = 3, maxChars = 1200): string {
		if (!existsSync(this.memoryDir)) return "";
		const files = readdirSync(this.memoryDir)
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.sort()
			.slice(-maxDays);
		const text = files
			.map((f) => readFileSync(join(this.memoryDir, f), "utf-8").trim())
			.join("\n\n")
			.trim();
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
	}

	/** role 运行约定（注入用；无文件返回空串） */
	roleFacts(role: string, maxChars = 600): string {
		if (!isValidRoleName(role)) return "";
		const path = join(this.factsDir(), `${role}.md`);
		if (!existsSync(path)) return "";
		const text = readFileSync(path, "utf-8").trim();
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
	}
}
