/**
 * memory/store —— 记忆的**唯一写入通道** + 检索/遗忘桥（P15-95 / §15.7 + §15.9 + §15.16）。
 *
 * 设计文档把这个模块叫「存储桥」，但它承担的其实是**边界**职责：它是 fiat 侧
 * 唯一与 RAG 记忆工具对话的地方，因此下面四件事都必须在**这一个文件里**发生，
 * 而不是散在调用方：
 *
 *   ① **snake_case ↔ camelCase 的唯一转换点**（`wire` 小节）。散着转换 =
 *      「加一个字段要改 N 处」，而漏改一处就是静默丢字段 —— 契约 5 的
 *      `scope` / `key` / `degraded` 缺失恰恰是这类失败。
 *   ② **`scope` / `key` 的唯一注入点**。调用方（含 P15-96 的工具）**不传**
 *      partition —— 它们只拿到一个已经绑好身份的通道对象（见 §3）。
 *   ③ **第 ③ 道隔离防线：后置校验**。返回体里的 `scope` / `key` 必须与闭包身份
 *      逐字相等，不等即丢弃 + 记 `isolation_violation`，**不抛**（硬约束 15）。
 *   ④ **降级与熔断的落点**。检索失败返回空结果（永不抛），并驱动 P15-106 的断路器。
 *
 * ### 为什么不复用 `host/l1b/mcp-rag.ts` 的 `createMcpRagTools`
 *
 * 那个桥的产品是 `HostTool[]` —— **工具会进模型的手**。而记忆的写入通道绝不能被
 * 包装成工具（硬约束 1：主会话零写记忆能力）。共用一个 client 实例时，隔离依赖
 * 「代码永不把写方法包装成 HostTool」这条**纪律**；纪律会被人改掉，而下面这条不会：
 *
 * > 记忆桥持有**两个独立 client**（`#read` / `#write`），且 `#write` 是 JS 私有字段。
 * > 会话侧拿到的是 `readChannel()` 的返回值 —— 一个只暴露 `search` 的对象字面量。
 * > **会话侧手上根本没有那个 client 对象**（硬约束 12）。
 *
 * 这是设计文档 §3-L3 的口径：隔离要**结构性**，不要靠「记得别那么做」。
 *
 * ### 两个客户端的连接是**独立**降级的
 *
 * RAG server 起不来时，读侧降级为空结果、写侧报 `failed` —— 两者互不牵连。
 * 用一个 `connected` 布尔量表示整体状态会让「读挂了、写还在」变成「整体不可用」，
 * 那正好是最常见的半故障形态（stdio 子进程被 OOM 杀掉后重启中）。
 */

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withTimeout } from "../evolution/reviewer.ts";
import { redact } from "../evolution/slice.ts";
import type { McpClientLike, RagStatus } from "../host/l1b/mcp-rag.ts";
import type { McpCallResult } from "../host/l1b/mcp-rag-content.ts";
import { textSummary } from "../host/l1b/mcp-rag-content.ts";
import { createTransport, type RagMcpConfig } from "../host/l1b/mcp-rag-transport.ts";
import { LANGFUSE_KEYS, OBS_TYPE } from "../tracing/otlp.ts";
import { resolveTracing, type TracingSource } from "../tracing/types.ts";
import { auditMemoryForget, auditMemoryWrite, type MemoryAuditContext } from "./audit.ts";
import { type CircuitSnapshot, MemoryCircuitBreaker } from "./circuit.ts";
import type { MemoryExtractionPort, MemoryWritePlan, MemoryWriteReport } from "./extractor.ts";
import type { MemoryIdentity } from "./identity.ts";
import { validateCandidate } from "./policy.ts";
import {
	MEMORY_ENTRY_ID_PATTERN,
	type MemoryConfig,
	type MemoryEntry,
	type MemoryForgetResult,
	type MemoryHit,
	type MemoryKind,
	type MemoryScope,
	type MemoryStatus,
	type MemoryStoreResult,
} from "./types.ts";

/** 日志口（与 `MemoryExtractor` 同一形状；缺省静默） */
export type MemoryLog = (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;

// =====================================================================================
// §1 端口类型
// =====================================================================================

/**
 * 检索通道 —— **会话侧能拿到的全部**（P15-96 的工具只持这个）。
 *
 * 刻意只有一个方法：没有 `write` / `forget`，也没有 `scope` / `key` 入参。
 * 把 `MemoryStoreBridge` 整个交给工具模块也能跑，但那等于把写客户端的引用
 * 塞进模型工具的作用域里 —— 类型的窄化在这里就是隔离本身。
 */
export interface MemoryReadChannel {
	/**
	 * 检索本分区的记忆。**永不抛**：
	 *   - 身份未被绑定 / 记忆未启用 → `degraded` 空结果
	 *   - 断路器打开 / 超时 / 传输错误 / 对端 `degraded=true` → `degraded` 空结果
	 *   - 检索到**别人**的条目 → 丢弃 + 记 `isolationViolations`，**不抛**
	 */
	search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchOutcome>;
	/** 断路器快照（状态面 / 测试断言） */
	circuit(): CircuitSnapshot;
	/** 本通道绑定的分区名。**仅供审计 / 状态展示** —— 绝不要放进工具输出（契约 9） */
	readonly collection: string;
}

export interface MemorySearchOptions {
	/** 限定 kind（缺省全给） */
	kinds?: readonly MemoryKind[];
	topK?: number;
	/** 调试开关：连退役条目一起返回（缺省 false） */
	includeSuperseded?: boolean;
}

/** 检索结果（fiat 侧形态；`degraded` 与「空结果」是两个不同的东西） */
export interface MemorySearchOutcome {
	hits: MemoryHit[];
	/** 对端回显的 collection（**输出不是输入**；审计用，别给模型） */
	collection: string;
	/** 通过后置校验、留在结果里的条数（= `hits.length`，留字段是为了措辞清晰） */
	count: number;
	/** true = 这条结果是**降级产物**，不代表「没有记忆」 */
	degraded: boolean;
	/** `degraded=true` 的原因（人话，供状态面 / 日志） */
	error?: string;
	/** 被第 ③ 道防线丢弃的条目（记 id + 原因；**这就是隔离违规的证据**） */
	isolationViolations: Array<{ id: string; reason: string }>;
}

/** 客户端角色 —— 工厂据此区分「读通道」与「写通道」的 mock */
export type MemoryClientRole = "read" | "write";

/**
 * 通道连接状态（P15-99 的 `fiat memory stats` 要它）。
 *
 * `idle` 与 `unavailable` 是**两件不同的事**，这正是它值得单独一个枚举的原因：
 *   - `idle` = 「还没人用过」，连接是惰性的，所以**不代表有问题**；
 *   - `unavailable` = 「尝试过，失败了」。
 * 用 `connected: boolean` 表示会把两者压成同一个 `false`，于是「一次都没用过」
 * 看起来像「连不上」—— 而 `stats` 存在的意义恰恰是回答「为什么没数据」。
 */
export type MemoryChannelState = "idle" | "ready" | "unavailable";

/** 桥的状态快照（`fiat memory stats`；**零网络**，不触发任何连接） */
export interface MemoryBridgeStatus {
	/** 记忆总开关（`FIAT_MEMORY` / `config/memory.yaml`） */
	enabled: boolean;
	scope: MemoryScope;
	/** 原始分区键（审计 / 展示用；**不参与任何拼接**） */
	key: string;
	/** `fiat_memory_<scope>_<safeKey>`（人肉核对时最直接的线索） */
	collection: string;
	read: MemoryChannelState;
	write: MemoryChannelState;
	circuit: CircuitSnapshot;
}

export interface MemoryStoreBridgeDeps {
	/** RAG transport 配置（与 `host/l1b/mcp-rag.ts` 同一份 `RagMcpConfig`） */
	rag: RagMcpConfig;
	/** 记忆配置（长度上限 / 置信度下限 / 默认 top_k / kinds） */
	memory: MemoryConfig;
	/** 隔离边界。**构造时绑定**：通道对象因此无法被指向别的分区（硬约束 3） */
	identity: MemoryIdentity;
	/**
	 * 客户端工厂。**会被调用两次**（`role: "read"` / `"write"`）——
	 * 测试靠 role 区分 mock；靠调用顺序区分是脆的。
	 */
	clientFactory?: (cfg: RagMcpConfig, role: MemoryClientRole) => McpClientLike;
	/** 检索侧断路器（P15-106）。缺省自建一个（阈值/冷却用缺省值） */
	circuit?: MemoryCircuitBreaker;
	/** 状态回调（与 `RagStatus` 合并展示：`unavailable` / `circuit_open` / `ready`） */
	onStatus?: (status: RagStatus, detail: string) => void;
	/** 阶段 14：检索 / 写入各出一个 span。**缺省不开**（零开销） */
	tracing?: TracingSource;
	/**
	 * 阶段 15（P15-98）：审计双写。**缺省 undefined = 不记**（现有测试零改动）。
	 *
	 * 为什么在这里而不在调用方：写入的**真实结果**（成功 / 半写 / 被前置校验拒）只有
	 * 本模块知道，而在调用方记会退化成「记了一次尝试」而不是「记了一次事实」。
	 */
	audit?: MemoryAuditContext;
	/** `callTool` 超时；缺省取 `rag.timeoutMs`，再缺省 30s */
	timeoutMs?: number;
	log?: MemoryLog;
	now?: () => Date;
}

// =====================================================================================
// §2 wire 边界（本文件是**唯一**转换点）
// =====================================================================================

/** 对端 `evidence` 的 snake_case 形态 */
interface WireEvidence {
	session_id: string;
	user_id: string;
	created_at: string;
	trigger: string;
}

/** 对端 `hits[]` 元素（`MemoryHit.to_dict()`） */
interface WireHit {
	id?: unknown;
	kind?: unknown;
	text?: unknown;
	score?: unknown;
	score_type?: unknown;
	status?: unknown;
	scope?: unknown;
	key?: unknown;
	created_at?: unknown;
}

interface WireSearchPayload {
	hits?: unknown;
	collection?: unknown;
	count?: unknown;
	degraded?: unknown;
	error?: unknown;
}

interface WireStorePayload {
	stored?: unknown;
	collection?: unknown;
	superseded?: unknown;
	dense_ok?: unknown;
	sparse_ok?: unknown;
	errors?: unknown;
	/** 错误信封（`failure()` 的 `error` / `error_type` 会盖在 payload 之上） */
	error?: unknown;
	error_type?: unknown;
}

interface WireForgetPayload {
	forgotten?: unknown;
	not_found?: unknown;
	collection?: unknown;
	mode?: unknown;
	error?: unknown;
	error_type?: unknown;
}

/** 一次 `callTool` 的解析结果：**即使 `isError` 也要试着解 payload** */
interface ParsedCall {
	/** 解析出的 JSON（解析不出 / 非对象 → null） */
	payload: Record<string, unknown> | null;
	/** 原始文本（错误摘要 / 留给日志） */
	text: string;
	isError: boolean;
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** wire → 域（`MemoryHit`）。字段缺失**不补默认值**：后置校验靠的就是「原样比较」 */
function toHit(raw: WireHit): MemoryHit {
	return {
		id: asString(raw.id),
		kind: asString(raw.kind) as MemoryKind,
		text: asString(raw.text),
		score: asNumber(raw.score),
		scoreType: asString(raw.score_type, "unknown"),
		status: asString(raw.status) as MemoryStatus,
		scope: asString(raw.scope) as MemoryScope,
		key: asString(raw.key),
		createdAt: asString(raw.created_at),
	};
}

/** wire → 域（`MemoryEntry`）。`inferSupersedes` 由调用方从 `superseded` 反查（对端不回传条目正文） */
function toEntry(hit: MemoryHit, identity: MemoryIdentity): MemoryEntry {
	return {
		id: hit.id,
		scope: hit.scope ?? identity.scope,
		key: hit.key,
		kind: hit.kind,
		text: hit.text,
		// 对端不回传 evidence（摘要级返回体）；用占位值 —— supersede / 晋升判定只看
		// `id` / `text` / `kind` / `status`，不看 evidence（见 policy.ts 的两个判定）
		evidence: { sessionId: "", userId: identity.userId, createdAt: hit.createdAt, trigger: "correction" },
		confidence: 0,
		supersedes: [],
		status: hit.status,
		usedCount: 0,
	};
}

// =====================================================================================
// §3 桥本体
// =====================================================================================

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 审计用的正文指纹（sha256 前 16 位）。
 *
 * 取**原始 `entry.text`**（不是二次脱敏后的）：同一条记忆的 `hash` 要与幂等键
 * （`sha256(scope+key+kind+归一化 text)`）算在同一份材料上，否则「比对是不是同一条」
 * 会在「脱敏改动过正文」的边上不一致。这也让 hash 成为一个**稳定**的核对锚点。
 */
function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 后置校验（第 ③ 道防线）：返回体里的 `scope` / `key` 必须与闭包身份**逐字相等**。
 *
 * 三条刻意的严格：
 *   ① **空值即拒**（fail-closed）。`scope` / `key` 缺失正是契约 5 点名的失效形态 ——
 *      那时无从比对，「无从比对」的安全解是丢弃，不是放行。
 *   ② **不做大小写折叠**。我们传的 `safeKey` 已由 `sanitizeMemoryKey` 小写化，
 *      对端只做透传。折叠比较会掩盖「对端改了我们的 key」这个事实。
 *   ③ 导出成纯函数：P15-96 的工具侧也要复用它（同一份判据，不要两处写）。
 */
export function assertOwned(hit: { scope?: string; key?: string }, identity: MemoryIdentity): string | null {
	if (!hit.scope || !hit.key) return "返回体缺少 scope/key，无法比对（fail-closed）";
	if (hit.scope !== identity.scope) return `scope 越界：期望 ${identity.scope}，实际 ${hit.scope}`;
	if (hit.key !== identity.safeKey) return `key 越界：期望 ${identity.safeKey}，实际 ${hit.key}`;
	return null;
}

export class MemoryStoreBridge implements MemoryExtractionPort {
	readonly #deps: MemoryStoreBridgeDeps;
	readonly #identity: MemoryIdentity;
	/** **写通道**：私有字段。`readChannel()` 的返回值里没有它 —— 这就是结构性隔离 */
	#write?: McpClientLike;
	#read?: McpClientLike;
	#connectRead?: Promise<boolean>;
	#connectWrite?: Promise<boolean>;
	#readChannel?: MemoryReadChannel;
	/** 检索侧断路器（deps 注入或惰性自建） */
	#circuit?: MemoryCircuitBreaker;
	/** 连接结果留痕（`stats` 用）。`idle` 的语义见 `MemoryChannelState`。 */
	#readState: MemoryChannelState = "idle";
	#writeState: MemoryChannelState = "idle";

	constructor(deps: MemoryStoreBridgeDeps) {
		this.#deps = deps;
		this.#identity = deps.identity;
		this.#circuit = deps.circuit;
	}

	get identity(): MemoryIdentity {
		return this.#identity;
	}

	private get timeoutMs(): number {
		return this.#deps.timeoutMs ?? this.#deps.rag.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private log(level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>): void {
		this.#deps.log?.(level, message, { ...detail, collection: this.#identity.collection });
	}

	// ---------------------------------------------------------------------------------
	// 连接（读写独立降级）
	// ---------------------------------------------------------------------------------

	private client(role: MemoryClientRole): McpClientLike {
		if (this.#deps.clientFactory) return this.#deps.clientFactory(this.#deps.rag, role);
		const client = new Client({ name: `fiat-memory-${role}`, version: "0.0.1" });
		const transport = createTransport(this.#deps.rag);
		return {
			connect: () => client.connect(transport),
			listTools: () => client.listTools(),
			callTool: async (req) => (await client.callTool(req)) as McpCallResult,
			close: () => client.close(),
		};
	}

	/** 惰性连接读通道。返回是否可用；**永不抛** */
	private ensureRead(): Promise<boolean> {
		if (!this.#connectRead) {
			this.#connectRead = (async () => {
				try {
					this.#read = this.client("read");
					await this.#read.connect();
					this.#readState = "ready";
					this.#deps.onStatus?.("ready", "记忆读通道已连接");
					return true;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.#readState = "unavailable";
					this.#deps.onStatus?.("unavailable", `记忆读通道 connect 失败: ${msg}`);
					this.log("warn", `记忆读通道不可用：${msg}`);
					return false;
				}
			})();
		}
		return this.#connectRead;
	}

	/** 惰性连接写通道。返回是否可用；**永不抛** */
	private ensureWrite(): Promise<boolean> {
		if (!this.#connectWrite) {
			this.#connectWrite = (async () => {
				try {
					this.#write = this.client("write");
					await this.#write.connect();
					this.#writeState = "ready";
					return true;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.#writeState = "unavailable";
					this.log("warn", `记忆写通道不可用：${msg}`);
					return false;
				}
			})();
		}
		return this.#connectWrite;
	}

	async close(): Promise<void> {
		const closers = [this.#read, this.#write].map(async (c) => {
			try {
				await c?.close();
			} catch {
				// 关闭失败不影响退出（对齐 `mcp-rag.ts`：不把拆除失败升级成错误）
			}
		});
		await Promise.all(closers);
	}

	// ---------------------------------------------------------------------------------
	// 调用（一个地方做「超时 + payload 提取」）
	// ---------------------------------------------------------------------------------

	/**
	 * 调一次工具。
	 *
	 * ⚠️ **`isError` 不等于「没有 payload」**（P15-95 实现期最要紧的一处）：
	 * RAG 侧的三条降级路径都是「`isError=True` + 带 payload」——
	 *   - `memory_search` 的 `degraded=true`（`failure(RuntimeError, payload=payload)`）
	 *   - `memory_store` 的部分写（`dense_ok` / `sparse_ok` / `errors`）
	 *   - 各类错误的 `error` / `error_type` 信封
	 * 看到 `isError` 就抛会让熔断器拿不到 `degraded`、让半写状态变成「写失败」，
	 * 于是**两个最重要的信号一起丢失**。所以这里一律先解 payload，再交给调用方判。
	 */
	private async call(client: McpClientLike, name: string, args: Record<string, unknown>): Promise<ParsedCall> {
		const result = await withTimeout(
			client.callTool({ name, arguments: args }),
			this.timeoutMs,
			`记忆 MCP ${name} 超时（${this.timeoutMs}ms）`,
		);
		const text = textSummary(result.content);
		let payload: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			payload = null; // 非 JSON（SDK 层的 schema 报错就是纯文本）
		}
		return { payload, text, isError: result.isError === true };
	}

	/** span 开合的小工具（缺省不开追踪时是 no-op） */
	private span(op: "search" | "write", tool: string) {
		const wiring = resolveTracing(this.#deps.tracing);
		if (!wiring || wiring.trace.sampled !== true) return undefined;
		const span = wiring.tracer.startSpan(wiring.trace, `fiat.memory.${op}`, {
			kind: "client",
			attributes: { [LANGFUSE_KEYS.obsType]: OBS_TYPE.span, "fiat.mcp.tool": tool },
		});
		return span;
	}

	// ---------------------------------------------------------------------------------
	// 读：检索（P15-96 的工具走后门进来的就是这里）
	// ---------------------------------------------------------------------------------

	/**
	 * 会话侧唯一的入口。**永不抛**。返回的 `degraded` 与 `isolationViolations`
	 * 就是状态面要的两个信号。
	 */
	readChannel(): MemoryReadChannel {
		if (!this.#readChannel) {
			this.#readChannel = {
				collection: this.#identity.collection,
				circuit: () => this.circuit().snapshot(),
				search: (query, opts) => this.search(query, opts),
			};
		}
		return this.#readChannel;
	}

	circuit(): MemoryCircuitBreaker {
		// 缺省自建一个（P15-106），并把状态回调接上 —— 否则熔断打开时状态面是静默的
		this.#circuit ??= new MemoryCircuitBreaker({ onStatus: this.#deps.onStatus, log: this.#deps.log });
		return this.#circuit;
	}

	/**
	 * 状态快照（P15-99 的 `fiat memory stats`）。**零网络**：
	 * 只读已发生的连接结果，**不触发**惰性连接 —— 一个「诊断为什么不工作」的命令
	 * 如果自己先去连一次，它就变成了另一个可能失败的东西（同 `fiat trace status` 口径）。
	 *
	 * `circuit()` 走的是自建路径，因此这里调它**会**建立一个断路器对象；那是纯内存的
	 * 零开销动作，且它本来就是本模块的常驻字段。
	 */
	status(): MemoryBridgeStatus {
		return {
			enabled: this.#deps.memory.enabled,
			scope: this.#identity.scope,
			key: this.#identity.key,
			collection: this.#identity.collection,
			read: this.#readState,
			write: this.#writeState,
			circuit: this.circuit().snapshot(),
		};
	}

	async search(query: string, opts: MemorySearchOptions = {}): Promise<MemorySearchOutcome> {
		const empty = (degraded: boolean, error?: string): MemorySearchOutcome => ({
			hits: [],
			collection: this.#identity.collection,
			count: 0,
			degraded,
			...(error ? { error } : {}),
			isolationViolations: [],
		});

		if (!this.#deps.memory.enabled) return empty(true, "记忆未启用（FIAT_MEMORY 未开）");

		const breaker = this.circuit();
		if (!breaker.allow()) {
			// 熔断期内**立刻**返回空 —— 这才是「降级」，否则每次仍要撞 30s 超时
			return empty(true, `记忆检索已熔断（连续失败，冷却中），本次直接返回空结果`);
		}

		if (!(await this.ensureRead())) {
			breaker.recordFailure("读通道不可用");
			return empty(true, "记忆读通道不可用（connect 失败）");
		}

		const span = this.span("search", "memory_search");
		span?.setInput({ query, kinds: opts.kinds ?? this.#deps.memory.read.hotKinds });
		let parsed: ParsedCall;
		try {
			parsed = await this.call(this.#requireRead(), "memory_search", {
				query,
				// 契约 1：**只给 scope + key，不给 collection**；拼 collection 是 RAG 的职责
				scope: this.#identity.scope,
				key: this.#identity.safeKey,
				...(opts.kinds ? { kinds: [...opts.kinds] } : {}),
				top_k: opts.topK ?? this.#deps.memory.read.defaultTopK,
				...(opts.includeSuperseded ? { include_superseded: true } : {}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			breaker.recordFailure(msg);
			span?.setStatus("error", msg);
			span?.end();
			return empty(true, `记忆检索失败：${msg}`);
		}

		const payload = parsed.payload as WireSearchPayload | null;
		if (!payload) {
			breaker.recordFailure(parsed.text.slice(0, 120));
			span?.setStatus("error", "无法解析 memory_search 返回体");
			span?.end();
			return empty(true, `记忆检索失败：返回体无法解析（${parsed.text.slice(0, 120)}）`);
		}
		if (payload.degraded === true) {
			// 对端自己判定降级 —— 这就是熔断器的触发信号（契约 5 第 ③ 条）
			const msg = asString(payload.error, "对端报告 degraded");
			breaker.recordFailure(msg);
			span?.setStatus("error", `degraded: ${msg}`);
			span?.end();
			return empty(true, `记忆存储不可用（degraded）：${msg}`);
		}
		if (parsed.isError) {
			const msg = asString(payload.error, parsed.text.slice(0, 120));
			breaker.recordFailure(msg);
			span?.setStatus("error", msg);
			span?.end();
			return empty(true, `记忆检索失败：${msg}`);
		}

		breaker.recordSuccess();

		// ── 第 ③ 道防线：后置校验。**不匹配即丢弃，不抛**（硬约束 15）──
		const rawHits = Array.isArray(payload.hits) ? (payload.hits as WireHit[]) : [];
		const hits: MemoryHit[] = [];
		const isolationViolations: Array<{ id: string; reason: string }> = [];
		for (const raw of rawHits) {
			const hit = toHit(raw);
			const violation = assertOwned(hit, this.#identity);
			if (violation) {
				isolationViolations.push({ id: hit.id, reason: violation });
				continue;
			}
			hits.push(hit);
		}
		if (isolationViolations.length > 0) {
			// 这是**隔离违规的证据**，必须以 error 级别留痕 —— 静默丢弃等于把事故藏起来
			this.log("error", `记忆检索发现 ${isolationViolations.length} 条越界结果，已丢弃`, {
				violations: isolationViolations,
			});
		}

		span?.setOutput({ count: hits.length, violations: isolationViolations.length });
		span?.setStatus("ok");
		span?.end();

		return {
			hits,
			collection: asString(payload.collection, this.#identity.collection),
			count: hits.length,
			degraded: false,
			isolationViolations,
		};
	}

	#requireRead(): McpClientLike {
		if (!this.#read) throw new Error("memory/store: 读通道未连接");
		return this.#read;
	}

	// ---------------------------------------------------------------------------------
	// 写：实现 `MemoryExtractionPort`
	// ---------------------------------------------------------------------------------

	/**
	 * 供 supersede / 晋升判定取「同分区已有条目」。
	 *
	 * ⚠️ RAG 侧**没有 list 工具**（`memory_search` 必须给 `query`），所以这里用
	 * 「本轮候选文本」当**探针**做一次近邻召回，而不是全量列举。这不是将就：
	 * supersede 与晋升的语义本来就只看**相似**的旧条目 —— 一条无关的旧记忆
	 * 既不会被顶替，也不该进同一个族。代价是「相似度阈值以下的旧条目看不见」，
	 * 而那正是阈值要表达的意思。
	 *
	 * 对端未回传 `evidence` / `confidence`（摘要级返回体），因此这里的 `MemoryEntry`
	 * 是**判定用的最小形状**：两个判定都只看 `id` / `text` / `kind` / `status`。
	 * 失败一律返回空数组（判定退化为「没有旧条目」= 不 supersede、不晋升），
	 * **绝不抛** —— 读不到旧条目不该让本轮提取整体失败。
	 */
	async listActive(identity: MemoryIdentity, probe?: string): Promise<readonly MemoryEntry[]> {
		if (!probe || probe.trim().length === 0) return [];
		const outcome = await this.search(probe, {
			// 判定要看全部四类：`feedback` 不 supersede 但参与晋升聚类
			kinds: undefined,
			topK: this.#probeTopK(),
		});
		if (outcome.degraded) {
			this.log("warn", "记忆旧条目读取降级为空（本轮不 supersede、不晋升）", { error: outcome.error });
			return [];
		}
		return outcome.hits.map((h) => toEntry(h, identity));
	}

	#probeTopK(): number {
		// 判定用的召回面比展示用的 top_k 宽一些（缺省 5 → 探针 20），否则
		// 「已有 3 条同族 feedback」可能因为第 3 条排在 top-5 之外而永远凑不齐
		return Math.max(this.#deps.memory.read.defaultTopK, 20);
	}

	/**
	 * 逐条写入（**顺序**，不并发）。
	 *
	 * 为什么顺序：一次提取最多 `write.maxPerRun`（缺省 5）条，并发省下的时间
	 * 抵不上它带来的代价 —— 部分失败时「哪条成功了」会变得难归因，而这正是
	 * 双写不做两阶段提交后唯一能依靠的信息。
	 *
	 * **不发任何 throw 给「策略性」失败**（id 形态 / 长度 / 置信度 / 越界）——
	 * 它们逐条记进 `failed`，让其余条目照常落库。只有传输层错误才抛。
	 */
	async write(plan: MemoryWritePlan, identity: MemoryIdentity): Promise<MemoryWriteReport> {
		const report: MemoryWriteReport = { stored: [], superseded: [], failed: [] };
		if (plan.items.length === 0) return report;

		if (!(await this.ensureWrite())) {
			for (const item of plan.items)
				report.failed.push({ id: item.entry.id, error: "记忆写通道不可用（connect 失败）" });
			return report;
		}
		const client = this.#requireWrite();

		for (const item of plan.items) {
			const entry = item.entry;
			// 单条收口：**所有**终结分支都过这里，保证「审计条数 = 计划条数」
			// （漏记一条失败会让「为什么这条没写进去」变成查不到的事）。
			//
			// **await 而不是 fire-and-forget**：审计与写入是两条独立的异步链，
			// 不 await 的话「进程在两者之间退出」会留下「写了但没有审计记录」的窗口 ——
			// 而那条记录恰恰是合规意义上的**证据**。代价是每条约一次往返（单次最多 5 条）。
			// 审计自身**永不抛**（见 `memory/audit.ts`），所以 await 不会把写入拖垮。
			const note = async (ok: boolean, reason?: string): Promise<void> => {
				if (!this.#deps.audit) return;
				await auditMemoryWrite(this.#deps.audit, entry, hashOf(entry.text), {
					ok,
					...(reason ? { reason } : {}),
				});
			};

			// ① 单条自检：这几条若有违背，说明**上游拼错了 entry**，不是对端的问题
			const local = this.#preflight(entry, identity, item.supersedes);
			if (local) {
				report.failed.push({ id: entry.id, error: local });
				this.log("error", `记忆写入被本地前置校验拒绝：${local}`, { id: entry.id, kind: entry.kind });
				await note(false, local);
				continue;
			}

			// ② 二次脱敏。**正常是 no-op**（`validateCandidate` 已把命中敏感形态的候选整条拒了），
			//    所以「脱敏改动了正文」是一个**值得告警的信号**：说明有人绕过了候选校验。
			const safe = redact(entry.text);
			if (safe !== entry.text) {
				this.log("warn", "记忆写入的正文被二次脱敏 —— 说明候选校验被绕过，已按脱敏后正文写入", {
					id: entry.id,
					kind: entry.kind,
				});
			}

			const span = this.span("write", "memory_store");
			span?.setInput({ id: entry.id, kind: entry.kind, length: safe.length, supersedes: item.supersedes.length });
			let parsed: ParsedCall;
			try {
				parsed = await this.call(client, "memory_store", this.#storeArgs(entry, safe, identity, item.supersedes));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				span?.setStatus("error", msg);
				span?.end();
				report.failed.push({ id: entry.id, error: msg }); // 传输错误：重试是正确解（写入幂等）
				await note(false, msg);
				continue;
			}

			const payload = parsed.payload as WireStorePayload | null;
			if (payload && (payload.dense_ok === false || payload.sparse_ok === false)) {
				// 半写：**诚实答案是「重试」**，不是「已存」。同一个 entry_id 重发即自愈
				const errors = asStringArray(payload.errors).join("; ");
				const msg = `半写（dense_ok=${String(payload.dense_ok)} sparse_ok=${String(payload.sparse_ok)}）：${errors}`;
				span?.setStatus("error", msg);
				span?.end();
				report.failed.push({ id: entry.id, error: msg });
				await note(false, msg);
				continue;
			}
			if (parsed.isError || !payload || typeof payload.stored !== "string") {
				const msg = parsed.isError
					? asString(payload?.error, parsed.text.slice(0, 160))
					: "memory_store 返回体缺少 stored";
				span?.setStatus("error", msg);
				span?.end();
				report.failed.push({ id: entry.id, error: msg });
				await note(false, msg);
				continue;
			}

			report.stored.push(payload.stored);
			for (const old of asStringArray(payload.superseded)) {
				if (!report.superseded.includes(old)) report.superseded.push(old);
			}
			span?.setOutput({ stored: payload.stored, superseded: asStringArray(payload.superseded).length });
			span?.setStatus("ok");
			span?.end();
			await note(true);
		}

		return report;
	}

	#requireWrite(): McpClientLike {
		if (!this.#write) throw new Error("memory/store: 写通道未连接");
		return this.#write;
	}

	/**
	 * 写入前的本地前置校验。**这是「写入口唯一」的另一半**（§15.9-1）：
	 * 只有本模块能写，而本模块只接受过校验的 `MemoryEntry`。
	 *
	 * 与 `policy.ts` 的分工：`validateCandidate` 判的是**模型产出的候选**（含
	 * 禁写三形态正则）；这里判的是**已经装配好的 entry 的形状与边界**。两者
	 * 有一处重叠（长度），刻意保留 —— 长度是契约 4 的硬要求，而在写入口再查一次
	 * 的成本是零，收益是「上游改了长度口径也拦得住」。
	 */
	#preflight(entry: MemoryEntry, identity: MemoryIdentity, supersedes: readonly string[]): string | null {
		if (!MEMORY_ENTRY_ID_PATTERN.test(entry.id)) {
			return `entry id 形态非法（必须 ${MEMORY_ENTRY_ID_PATTERN.source}）：${entry.id}`;
		}
		// 越界写入：构造上不该发生（identity 是唯一构造点且 kind 不改 scope），
		// 但**写入口是最后一道**，这里放过等于把「上游拼错」变成「写进别人分区」
		if (entry.scope !== identity.scope || entry.key !== identity.key) {
			return `entry 分区与绑定身份不一致（越界写入已拦截）：entry=${entry.scope}/${entry.key} identity=${identity.scope}/${identity.key}`;
		}
		const verdict = validateCandidate(
			{ kind: entry.kind, text: entry.text, confidence: entry.confidence, reason: "write" },
			this.#deps.memory,
		);
		if (!verdict.accepted) return `候选校验未通过：${verdict.reason}${verdict.detail ? `（${verdict.detail}）` : ""}`;
		for (const id of supersedes) {
			if (!MEMORY_ENTRY_ID_PATTERN.test(id)) return `supersedes 含非法 id（契约 3）：${id}`;
		}
		return null;
	}

	/** entry → `memory_store` 入参（**唯一一处 snake_case 出参拼装**） */
	#storeArgs(
		entry: MemoryEntry,
		text: string,
		identity: MemoryIdentity,
		supersedes: readonly string[],
	): Record<string, unknown> {
		const evidence: WireEvidence = {
			session_id: entry.evidence.sessionId,
			user_id: entry.evidence.userId,
			created_at: entry.evidence.createdAt,
			trigger: entry.evidence.trigger,
		};
		return {
			// 契约 1：只给 scope + key
			scope: identity.scope,
			key: identity.safeKey,
			kind: entry.kind,
			text,
			// 契约 2：id 由本侧生成（幂等键）。**定长**由 `#preflight` 保证（契约 3）
			entry_id: entry.id,
			status: "active",
			confidence: entry.confidence,
			evidence,
			...(supersedes.length > 0 ? { supersedes: [...supersedes] } : {}),
			...(entry.promotedFrom && entry.promotedFrom.length > 0 ? { promoted_from: [...entry.promotedFrom] } : {}),
		};
	}

	// ---------------------------------------------------------------------------------
	// 撤销（CLI / 人触发；**不注册给任何会话**）
	// ---------------------------------------------------------------------------------

	/**
	 * 撤销记忆。属主校验**靠 RAG 侧的 collection 分区天然提供**（契约 7）——
	 * 本侧只传自己的 `entry_id`，对端在指定分区里找不到即记 `not_found`。
	 *
	 * 为什么不传 owner 字段去比对：多一个漏点（忘了比 / 比错字段 / 字段可被改），
	 * 而**分区不可能「忘」**。
	 */
	async forget(ids: readonly string[], opts: { mode?: "delete" | "mark_forgotten" } = {}): Promise<MemoryForgetResult> {
		const notFound = [...ids];
		if (ids.length === 0 || !this.#deps.memory.enabled) {
			return { forgotten: 0, notFound, collection: this.#identity.collection };
		}
		// id 形态在**本侧**先过一遍：形态非法是调用方的 bug，不该伪装成「找不到」
		const bad = ids.filter((id) => !MEMORY_ENTRY_ID_PATTERN.test(id));
		if (bad.length > 0) {
			throw new Error(`memory/store: forget 收到非法 id（契约 3）：${bad.join(", ")}`);
		}
		if (!(await this.ensureWrite())) {
			throw new Error("memory/store: 记忆写通道不可用，无法执行 forget");
		}

		const mode = opts.mode ?? "delete";
		const parsed = await this.call(this.#requireWrite(), "memory_forget", {
			scope: this.#identity.scope,
			key: this.#identity.safeKey,
			entry_ids: [...ids],
			mode,
		});
		const payload = parsed.payload as WireForgetPayload | null;
		if (parsed.isError || !payload) {
			const msg = payload ? asString(payload.error, parsed.text.slice(0, 160)) : "memory_forget 返回体无法解析";
			throw new Error(`memory/store: forget 失败：${msg}`);
		}
		const result: MemoryForgetResult = {
			forgotten: asNumber(payload.forgotten),
			notFound: asStringArray(payload.not_found),
			collection: asString(payload.collection, this.#identity.collection),
			mode: asString(payload.mode, mode),
		};
		// 审计双写：遗忘是**人触发的动作**，它比写入更需要留痕（「谁在什么时候撤掉了什么」）
		if (this.#deps.audit) await auditMemoryForget(this.#deps.audit, result, ids);
		return result;
	}

	/** 回显一条写入结果（CLI `fiat memory` 展示用；不改状态） */
	static formatStoreResult(r: MemoryStoreResult): string {
		const tail = r.partialFailure
			? ` · 半写（dense=${r.partialFailure.denseOk} sparse=${r.partialFailure.sparseOk}）`
			: "";
		return `${r.stored} → ${r.collection} · superseded=${r.superseded.length}${tail}`;
	}
}
