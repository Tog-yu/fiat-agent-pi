/**
 * 测试用「假记忆 MCP 服务」（P15-100 的共享装置）。
 *
 * 为什么需要一个**有状态**的假服务，而不是像 `memory-store.test.ts` 那样用一个
 * 脚本化的 respond 回调：
 *
 *   `memory-store.test.ts` 验的是**边界**（入参形态、后置校验、降级）——它关心
 *   「这一次调用发了什么、怎么解读返回体」，所以脚本化回调最合适。
 *
 *   而 P15-100 要验的是**跨两次会话、跨两个用户的行为**：
 *   「A 写的记忆，B 检索不到」「新会话能召回上一次写的」。这类断言要求假服务真的
 *   **记住**写入、并且真的**按 collection 分区**——脚本化回调表达不了「分区」，
 *   而分区恰恰是这三条隔离防线里的第 ① 道（物理隔离）。
 *
 * ### 刻意实现的语义（不是为了好看）
 *
 *   ① **`fiat_memory_<scope>_<key>` 分区**：与 RAG 侧 J 阶段一致。跨分区**永远读不到**
 *      —— 这正是「属主校验靠分区天然提供」（契约 7）的实现基础。
 *   ② **按 `entry_id` 幂等**：同 id 重发覆盖而非追加，让「重试是廉价的正确解」可被验证。
 *   ③ **`supersedes` 标退役**（不物理删），`include_superseded` 控制可见性。
 *   ④ **降级开关** `degrade`：模拟 RAG 挂掉（`isError: true` + 带 payload 的
 *      `degraded: true` —— 与真实对端同一形状，含 payload 这一点很关键）。
 *   ⑤ **越界注入开关** `leakPartition`：故意返回**别的分区**的条目，用来验第 ③ 道防线
 *      （后置校验）在真实桥接上确实会丢弃。这是唯一「假装对端有 bug」的地方，
 *      没有它，第 ③ 道防线就只能靠接线读代码来相信。
 */

import type { McpClientLike, RagMcpConfig } from "../src/server/host/l1b/mcp-rag.ts";
import type { McpCallResult } from "../src/server/host/l1b/mcp-rag-content.ts";
import type { MemoryClientRole } from "../src/server/memory/store.ts";

export interface FakeMemoryEntry {
	id: string;
	kind: string;
	text: string;
	status: string;
	scope: string;
	key: string;
	created_at: string;
	confidence?: number;
	supersedes?: string[];
	promoted_from?: string[];
}

export interface FakeCall {
	role: MemoryClientRole;
	name: string;
	args: Record<string, unknown>;
}

/** 字符 bigram 集合（与 `policy.ts` 的相似度口径同形：确定性、零依赖、对中文有效） */
function bigrams(text: string): Set<string> {
	const s = text.replace(/\s+/g, "").toLowerCase();
	const out = new Set<string>();
	for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
	return out;
}

/** 查询与条目的重合度（>0 才算命中；值本身只用于排序，测试不做精确断言） */
function relevance(query: string, text: string): number {
	const q = bigrams(query);
	if (q.size === 0) return 0;
	let shared = 0;
	for (const g of bigrams(text)) if (q.has(g)) shared += 1;
	return shared;
}

export class FakeMemoryServer {
	/** collection → 条目。**这就是分区本身** —— 键里带 scope + safeKey */
	readonly partitions = new Map<string, FakeMemoryEntry[]>();
	/** 全部调用留痕（断言「模型侧/CLI 侧到底发了什么」） */
	readonly calls: FakeCall[] = [];
	/** connect 失败（模拟 RAG server 起不来） */
	failConnect = false;
	/** 检索降级（`isError: true` + `degraded: true`，**仍带 payload** —— 与真实对端同形状） */
	degrade = false;
	/** 越界注入：检索时把**别的分区**的条目也塞进返回体（假装对端有 bug / 被改坏） */
	leakPartition = false;
	/** 让某次调用抛错（模拟超时 / transport 中断） */
	failNextWith: { tool: string; message: string } | undefined;

	readonly clientFactory = (_cfg: RagMcpConfig, role: MemoryClientRole): McpClientLike => ({
		connect: async () => {
			if (this.failConnect) throw new Error("fake: 记忆服务 connect 失败");
		},
		listTools: async () => ({ tools: [] }),
		callTool: async (req) => this.#dispatch(role, req.name, req.arguments ?? {}),
		close: async () => {},
	});

	/** 直接用某分区的条目（测试准备 / 断言） */
	seed(scope: string, key: string, entry: Partial<FakeMemoryEntry> & { text: string }): FakeMemoryEntry {
		const list = this.partitions.get(collectionOf(scope, key)) ?? [];
		const full: FakeMemoryEntry = {
			id: `m_${"0".repeat(32)}`,
			kind: "user",
			status: "active",
			scope,
			key,
			created_at: "2026-09-23T00:00:00.000Z",
			...entry,
		};
		list.push(full);
		this.partitions.set(collectionOf(scope, key), list);
		return full;
	}

	/** 某分区当前可见（active）的条目 */
	active(scope: string, key: string): FakeMemoryEntry[] {
		return (this.partitions.get(collectionOf(scope, key)) ?? []).filter((e) => e.status === "active");
	}

	/** 该分区**是否出现过**某个 id（含已退役 —— 用来验 append-only 不物理删） */
	has(scope: string, key: string, id: string): boolean {
		return (this.partitions.get(collectionOf(scope, key)) ?? []).some((e) => e.id === id);
	}

	/** 最后一次调用的入参 */
	lastArgs(): Record<string, unknown> {
		return this.calls[this.calls.length - 1]?.args ?? {};
	}

	/** 指定工具的全部调用 */
	callsOf(name: string): Record<string, unknown>[] {
		return this.calls.filter((c) => c.name === name).map((c) => c.args);
	}

	#dispatch(role: MemoryClientRole, name: string, args: Record<string, unknown>): McpCallResult {
		this.calls.push({ role, name, args });
		if (this.failNextWith?.tool === name) {
			const message = this.failNextWith.message;
			this.failNextWith = undefined;
			throw new Error(message);
		}
		if (name === "memory_search") return this.#search(args);
		if (name === "memory_store") return this.#store(args);
		if (name === "memory_forget") return this.#forget(args);
		return text(`fake: 未知工具 ${name}`, true);
	}

	#search(args: Record<string, unknown>): McpCallResult {
		const scope = String(args.scope ?? "");
		const key = String(args.key ?? "");
		const collection = collectionOf(scope, key);
		if (this.degrade) {
			// ⚠️ 与真实对端一致：降级**也带 payload**（`store.ts` 的 `call()` 靠这一点
			//    才能既看到 degraded 又拿到 collection）
			return json({ hits: [], collection, count: 0, degraded: true, error: "fake: 记忆服务降级" }, true);
		}

		const query = String(args.query ?? "");
		const includeSuperseded = args.include_superseded === true;
		const kinds = args.kinds as string[] | undefined;

		// 主分区 + （越界注入时）其他分区 —— 后者专门喂给第 ③ 道防线
		const pools: FakeMemoryEntry[] = [...(this.partitions.get(collection) ?? [])];
		if (this.leakPartition) {
			for (const [name, list] of this.partitions) {
				if (name !== collection) pools.push(...list);
			}
		}

		const hits = pools
			.filter((e) => includeSuperseded || e.status === "active")
			.filter((e) => !kinds || kinds.includes(e.kind))
			.map((e) => ({ entry: e, score: relevance(query, e.text) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
			.slice(0, typeof args.top_k === "number" ? args.top_k : 10)
			.map((x) => ({
				id: x.entry.id,
				kind: x.entry.kind,
				text: x.entry.text,
				score: x.score,
				score_type: "rrf_fusion",
				status: x.entry.status,
				// 回显**条目自己的** scope/key（不是入参的）—— 越界注入时这两个字段
				// 正是后置校验与请求不一致的证据
				scope: x.entry.scope,
				key: x.entry.key,
				created_at: x.entry.created_at,
			}));
		return json({ hits, collection, count: hits.length, degraded: false });
	}

	#store(args: Record<string, unknown>): McpCallResult {
		const scope = String(args.scope ?? "");
		const key = String(args.key ?? "");
		const collection = collectionOf(scope, key);
		const id = String(args.entry_id ?? "");
		const list = this.partitions.get(collection) ?? [];

		const superseded: string[] = [];
		for (const old of (args.supersedes as string[] | undefined) ?? []) {
			const target = list.find((e) => e.id === old);
			if (target) {
				target.status = "superseded";
				superseded.push(old);
			}
		}

		// 幂等：同 entry_id 覆盖（重试是廉价的正确解）
		const existing = list.findIndex((e) => e.id === id);
		const entry: FakeMemoryEntry = {
			id,
			kind: String(args.kind ?? "user"),
			text: String(args.text ?? ""),
			status: String(args.status ?? "active"),
			scope,
			key,
			created_at: String(
				(args.evidence as { created_at?: string } | undefined)?.created_at ?? "2026-09-23T00:00:00.000Z",
			),
			confidence: typeof args.confidence === "number" ? args.confidence : undefined,
			...(args.supersedes ? { supersedes: args.supersedes as string[] } : {}),
			...(args.promoted_from ? { promoted_from: args.promoted_from as string[] } : {}),
		};
		if (existing >= 0) list[existing] = entry;
		else list.push(entry);
		this.partitions.set(collection, list);
		return json({ stored: id, collection, superseded });
	}

	#forget(args: Record<string, unknown>): McpCallResult {
		const scope = String(args.scope ?? "");
		const key = String(args.key ?? "");
		const collection = collectionOf(scope, key);
		const mode = String(args.mode ?? "delete");
		const ids = (args.entry_ids as string[] | undefined) ?? [];
		const list = this.partitions.get(collection) ?? [];

		let forgotten = 0;
		const notFound: string[] = [];
		for (const id of ids) {
			const idx = list.findIndex((e) => e.id === id);
			if (idx < 0) {
				notFound.push(id);
				continue;
			}
			if (mode === "mark_forgotten") list[idx].status = "forgotten";
			else list.splice(idx, 1);
			forgotten += 1;
		}
		this.partitions.set(collection, list);
		return json({ forgotten, not_found: notFound, collection, mode });
	}
}

/** 与 RAG 侧一致的分区命名（测试里也只用这一处拼 —— 两处拼法会漂移） */
export function collectionOf(scope: string, key: string): string {
	return `fiat_memory_${scope}_${key}`;
}

function json(payload: Record<string, unknown>, isError = false): McpCallResult {
	return text(JSON.stringify(payload), isError);
}

function text(body: string, isError = false): McpCallResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}
