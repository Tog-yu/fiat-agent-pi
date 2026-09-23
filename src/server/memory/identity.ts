/**
 * memory/identity —— 记忆隔离边界的载体（P15-102 / 设计文档 §4.2）。
 *
 * 这是这套设计里**唯一新增的抽象**。它把「谁在看记忆」从散落的参数收敛成**一个值**，
 * 闭包给三个消费点（热注入 reader / 检索工具 / 写入通道），于是隔离边界只有
 * **一个构造点**（`resolveMemoryIdentity`），审计与后置校验也都盯着同一个对象。
 *
 * 三条硬约束（设计文档 §9）：
 *
 * 1. `MemoryIdentity` **只有一个构造点**。任何地方不得手工拼 `key`、路径或 collection 名
 *    —— 手工拼 = 多一个可能漏加身份的地方。
 * 2. `key` / `scope` / `safeKey` / `collection` **不出现在任何对模型的 schema 里**
 *    （§15 硬约束 3）。模型既看不到、也改不了隔离边界。
 * 3. **不带 `sessionId`**。identity 必须是会话无关的**稳定值**；把 sessionId 混进来会让
 *    「同一用户每会话 identity 不同」，闭包传递时一处用错就静默换了分区。
 *    sessionId 属于 `MemoryEntry.evidence`，不属于 identity。
 *
 * 输入类型刻意写成结构化的 `{ user: { id: string } }`，而不是 import `SessionSubject`：
 * 这样 `apply.ts` 能用裸字符串（`proposal.proposer` —— 提案的属主）构造 identity，
 * 不必伪造一个带 `role` 的完整 subject；同时切断了 `memory/` → `session/` 的依赖方向
 * （`session/factory.ts` 本就 import `evolution/memoryStore.ts`，反向再依赖会长出环）。
 *
 * P15-104（设计文档 §2.4）后本模块多一条 `memory/` → `identity/resolver.ts` 的依赖：
 * 那是**叶子模块**（只 import `node:os`），不引入环，方向仍然是单向的
 * （`memory/` 认识 `identity/`，`identity/` 不认识 `memory/`）。
 */

import { createHash } from "node:crypto";
import { assertNotSentinelIdentity } from "../identity/resolver.ts";
import type { MemoryScope } from "./types.ts";

/**
 * 隔离粒度。**权威定义已移到 `types.ts`**（P15-92 / `DEV_SPEC.md` §15.6 是它的出处）；
 * 这里 re-export 只为不打断 A 期既有的 import 路径。
 *
 * 两份定义会漂移，而漂移的表现是「路径按一个枚举拼、collection 按另一个拼」——
 * 那正是硬约束 11 要堵的「多一个拼法」。
 */
export type { MemoryScope };

/** `global` scope 的固定分区键（`DEV_SPEC.md:865`） */
export const GLOBAL_MEMORY_KEY = "shared";

/** collection 前缀：与知识库 collection 在命名空间上物理分开（`DEV_SPEC.md:815`） */
const COLLECTION_PREFIX = "fiat_memory";

/** 可读前缀的长度上限（超出部分由 sha256 前 8 位承担区分度） */
const READABLE_MAX = 32;

export interface MemoryIdentity {
	/** 隔离粒度 */
	scope: MemoryScope;
	/** 原始分区键。**审计 / 展示用**，不参与路径与 collection 拼接 */
	key: string;
	/** 分区键的属主（溯源 + 审计）。`repo` / `global` 下仍记录「是谁写下的」 */
	userId: string;
	/** `sanitizeMemoryKey(key)` —— 路径与 collection **只认它** */
	safeKey: string;
	/** `fiat_memory_<scope>_<safeKey>`（B 期 RAG 的 collection 名） */
	collection: string;
}

/**
 * 把任意 partition key 折叠成**文件系统 / collection 名安全**的字符串。
 *
 * 规则：小写折叠 → 非法字符替换为 `_` → 去掉首尾 `_` → 截断到 32 → 追加**原始值**的
 * sha256 前 8 位。
 *
 * 为什么末尾一定要挂 hash（而不是只用替换后的可读串）——两个都是**真失效模式**：
 *
 *   ① **消除替换造成的碰撞**。`sanitize` 把 `@` / `.` 等都映射成 `_`，于是 `a@b` 与
 *      `a_b` 折叠后完全相同 —— 那是两个不同用户落进同一个分区，属于隔离失效。
 *   ② **绕开文件系统大小写不敏感**。macOS（APFS 默认）与 Windows 上 `Alice` 与
 *      `alice` 是**同一个目录**；只靠小写折叠会把两个 id 混装。hash 取的是**原始值**，
 *      因此二者仍各占一个分区（可读前缀相同、后缀不同）。
 *
 * 空值 / `.` / `..` 直接抛：宁可起不来，也不要落进一个「谁都能读」的目录
 * （与 `memoryStore.ts` 的 `ROLE_PATTERN` 同思路，只是这里要接受更宽的字符集）。
 */
export function sanitizeMemoryKey(key: string): string {
	const raw = key.trim();
	if (raw.length === 0) throw new Error("memory/identity: 隔离键不能为空");
	const folded = raw.toLowerCase();
	if (folded === "." || folded === "..") {
		throw new Error(`memory/identity: 非法隔离键 ${JSON.stringify(key)}`);
	}
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
	const readable = folded
		.replace(/[^a-z0-9_-]/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, READABLE_MAX);
	return readable.length > 0 ? `${readable}_${digest}` : `k_${digest}`;
}

/** collection 名（**唯一拼法**；除本函数外任何地方不得拼它） */
export function memoryCollection(scope: MemoryScope, safeKey: string): string {
	return `${COLLECTION_PREFIX}_${scope}_${safeKey}`;
}

export interface MemoryIdentityOptions {
	/** 缺省 `user` —— 热注入与写入通道的默认粒度 */
	scope?: MemoryScope;
	/** 覆盖分区键（`repo` 名 / `shared` 等）；缺省取 `subject.user.id` */
	key?: string;
}

/**
 * **唯一构造点**（设计文档 §9-1）。任何地方需要 identity 都必须走这里。
 *
 * 缺 `user.id` 时抛 —— 不做任何默认值兜底。这正是设计要堵的那个坑：
 * 「解析不出身份就静默用 `cli`」会让隔离在纸面上成立、运行时失效（见 §1.1）。
 *
 * P15-104（设计文档 §2.4「方案一」）：构造前先过一遍**哨兵守卫**。放在这里而不是
 * 每个调用点，理由与「只有一个构造点」完全相同 —— 守卫多一个调用点，就多一处会漏。
 * 守卫自身只在多租户下生效，因此单人本地部署的 `cli` 分区照旧可用。
 *
 * 第三个参数 `env` 只服务于守卫的注入与测试，与 `resolveIdentity` 的
 * `env` / `osUser` 同一套做法。设计文档 §2.4 特意提醒的是**不要**把 `source`
 * 加进 identity 的形状里（那会让「身份」这个值承担两种含义）；这里加的是一个
 * 可选的环境参数，`MemoryIdentity` 本身的字段没有任何变化。
 */
export function resolveMemoryIdentity(
	subject: { user: { id: string } },
	opts: MemoryIdentityOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): MemoryIdentity {
	const scope = opts.scope ?? "user";
	const userId = String(subject?.user?.id ?? "").trim();
	if (userId.length === 0) {
		throw new Error("memory/identity: 会话主体缺少 user.id，无法建立隔离边界");
	}
	assertNotSentinelIdentity(userId, env, "建立记忆隔离边界");
	const key = opts.key ?? (scope === "global" ? GLOBAL_MEMORY_KEY : userId);
	const safeKey = sanitizeMemoryKey(key);
	return { scope, key, userId, safeKey, collection: memoryCollection(scope, safeKey) };
}
