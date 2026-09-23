/**
 * fiat memory —— 记忆维护命令的能力层（P15-99 / `DEV_SPEC.md` §15.13）。
 *
 * 与 `cli/skills.ts`（`createSkillOps`）同一形状：**CLI 不含业务逻辑**，
 * 这里只把 `MemoryStoreBridge` 与配置包成一个「命令能用的接口」，命令本身
 * （`cli/index.ts` 的 `cmdMemory`）只做参数校验与渲染。
 *
 * ### 为什么这个文件必须存在，而不是让 `cmdMemory` 直接用桥
 *
 * 三条，都是「少一层就会长歪」的地方：
 *
 *   ① **惰性构造 + 按分区缓存**。`MemoryStoreBridge` 构造时要一个
 *      `MemoryIdentity`，而 `resolveMemoryIdentity` 在多租户下**会抛**。
 *      如果 entry 里当场构造，`fiat memory stats`（恰好是排查身份问题的命令）
 *      会在打印任何东西之前先挂掉。能力层把「可能抛」关进 `stats()` 的 try 里。
 *   ② **`stats` 必须零网络、零副作用**。它只用已发生的事实（配置 / 连接结果 /
 *      熔断计数），不主动 connect —— 与 `fiat trace status` 同一条纪律。
 *   ③ **退化语义在 CLI 侧收口**。`桥.search()` 降级时返回**空结果 + degraded**，
 *      这是对的（会话不该因为 RAG 挂掉而失败）；但 `forget` 在关记忆时返回
 *      `notFound = ids` 会被人读成「本分区没这些 id」—— **那是错的**。所以
 *      本层把「关着还调用 forget」升级成显式报错。
 *
 * ### 零 Pi 依赖
 *
 * 本文件只 import `memory/*` 与 `host/l1b/mcp-rag-transport.ts` —— 两者都不碰
 * Pi 运行时（`memory/` 整目录已核实：`@earendil-works` 命名空间一次都不出现）。
 * 因此 `fiat memory` 不要求 `FIAT_MODEL`，也不需要 Pi 的 dist。
 * ⚠️ 反例：`host/l1b/memory-tools.ts` **是** Pi 依赖的（它要 `defineTool`），
 * 那正是「渲染逻辑不能让 CLI 复用工具模块」的原因 —— 只能各写一份读者不同的措辞。
 * （这条「零 Pi」由 `test/cli-memory.test.ts` 的 §6 源码级断言锁住。）
 */

import type { McpClientLike } from "../host/l1b/mcp-rag.ts";
import { type RagMcpConfig, ragConfigFromEnv } from "../host/l1b/mcp-rag-transport.ts";
import { DEFAULT_MEMORY_CONFIG_PATH, loadMemoryConfig } from "../memory/config.ts";
import type { MemoryIdentity } from "../memory/identity.ts";
import { type MemoryClientRole, type MemoryLog, type MemorySearchOutcome, MemoryStoreBridge } from "../memory/store.ts";
import type { MemoryConfig, MemoryForgetResult, MemoryKind, MemoryScope } from "../memory/types.ts";
import type { MemoryStats } from "./commands.ts";

/** `memory_forget` 的两种模式（RAG 侧 J6 的取值，**单一事实源在这里**） */
export const MEMORY_FORGET_MODES = ["delete", "mark_forgotten"] as const;
export type MemoryForgetMode = (typeof MEMORY_FORGET_MODES)[number];

export interface MemoryOpOptions {
	/** 粒度覆盖；缺省 `user`（与热注入 / 写入通道同一缺省） */
	scope?: MemoryScope;
	/** 限定类别；缺省全给 */
	kinds?: readonly MemoryKind[];
	/** 返回条数上限；缺省用 `config.read.defaultTopK` */
	topK?: number;
	/** 连退役条目一起返回（`list` 缺省 true，`search` 缺省 false） */
	includeSuperseded?: boolean;
}

export interface MemoryOpsDeps {
	/** 记忆配置；缺省从 `configPath` 加载 */
	config?: MemoryConfig;
	/** 配置路径（`stats` 展示用：「改了配置没生效」的第一句话） */
	configPath?: string;
	/** RAG transport；缺省 `ragConfigFromEnv()` */
	rag?: RagMcpConfig;
	/**
	 * 身份构造。**允许抛** —— 多租户下解析不出可信身份时正是要抛。
	 *
	 * 收一个 `scope => identity` 的函数而不是现成的 identity，是因为
	 * `--scope` 是运行期参数：`MemoryIdentity` 的构造点是唯一的
	 * （`resolveMemoryIdentity`），而**何时**调用它由命令决定。
	 */
	identity: (scope: MemoryScope) => MemoryIdentity;
	/** 注入 MCP client 工厂（测试 mock；生产走真实 SDK） */
	clientFactory?: (cfg: RagMcpConfig, role: MemoryClientRole) => McpClientLike;
	/** 日志口；缺省写 stderr（CLI 的输出面是 stdout，日志不该混进去） */
	log?: MemoryLog;
}

export interface MemoryOps {
	/**
	 * 状态报告。**同步、零网络、永不抛**。
	 *
	 * 身份解析失败不是「抛」，而是报告里的一个字段 —— 见顶部 ①。
	 */
	stats(scope?: MemoryScope): MemoryStats;
	/** 维护视角：按探针列举本分区（**缺省含退役条目**） */
	list(probe: string, opts?: MemoryOpOptions): Promise<MemorySearchOutcome>;
	/** 排序视角：按相关度检索（**只含可检索条目**） */
	search(query: string, opts?: MemoryOpOptions): Promise<MemorySearchOutcome>;
	/** 撤销（人触发）。关记忆 / 非法 id / 写通道不可用 → **抛**，不伪装成「找不到」 */
	forget(
		ids: readonly string[],
		opts?: Omit<MemoryOpOptions, "kinds" | "topK" | "includeSuperseded"> & { mode?: MemoryForgetMode },
	): Promise<MemoryForgetResult>;
	/** 关掉所有已建的桥；**永不抛** */
	close(): Promise<void>;
}

/** 端点的人话（**token 永不出现** —— `tokenEnv` 只报变量名，不报值） */
function describeEndpoint(cfg: RagMcpConfig): string {
	if (cfg.transport === "http") {
		const token = cfg.tokenEnv ? `（token 取自 ${cfg.tokenEnv}）` : "（无 token）";
		return `http: ${cfg.url ?? "(未配置 url)"}${token}`;
	}
	const cmd = [cfg.command ?? "python3", ...(cfg.args ?? ["-m", "src.mcp_server.server"])].join(" ");
	return `stdio: ${cmd}${cfg.cwd ? `（cwd ${cfg.cwd}）` : ""}`;
}

/**
 * 组装记忆维护能力。
 *
 * **构造本身不做任何 IO**（不读网络、不 connect）；`stats()` 也不例外。
 * 真正的外部动作只发生在 `list` / `search` / `forget` 里，且都经
 * `MemoryStoreBridge` 的惰性连接与熔断。
 */
export function createMemoryOps(deps: MemoryOpsDeps): MemoryOps {
	const configPath = deps.configPath ?? DEFAULT_MEMORY_CONFIG_PATH;
	const config = deps.config ?? loadMemoryConfig(configPath);
	const rag = deps.rag ?? ragConfigFromEnv();
	const log: MemoryLog =
		deps.log ??
		((level, message, detail) => {
			process.stderr.write(`[memory:${level}] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
		});

	/**
	 * 已建的桥，**按 collection 缓存**。
	 *
	 * 用 collection 而不是 scope 作键：`repo` 与 `user` 可能落在不同分区，
	 * 而同一个 collection 必然对应同一个分区 —— 这正是「拼法只有一处」的收益
	 * （`memoryCollection()` 是唯一拼法，这里直接拿它的产物当身份）。
	 */
	const bridges = new Map<string, MemoryStoreBridge>();

	const bridgeFor = (scope: MemoryScope): MemoryStoreBridge => {
		const identity = deps.identity(scope);
		const existing = bridges.get(identity.collection);
		if (existing) return existing;
		const created = new MemoryStoreBridge({
			rag,
			memory: config,
			identity,
			...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}),
			log,
		});
		bridges.set(identity.collection, created);
		return created;
	};

	/** 三个数据命令共用的参数拼装（**只在这里**把可选参数翻成 store 的形态） */
	const searchOpts = (opts: MemoryOpOptions, includeSuperseded: boolean) => ({
		...(opts.kinds && opts.kinds.length > 0 ? { kinds: opts.kinds } : {}),
		...(typeof opts.topK === "number" && opts.topK > 0 ? { topK: opts.topK } : {}),
		includeSuperseded,
	});

	return {
		stats(scope = "user"): MemoryStats {
			const base: MemoryStats = {
				enabled: config.enabled,
				config,
				configPath,
				endpoint: describeEndpoint(rag),
			};
			// 关记忆时**连身份都不去解析**：关着就没有分区要报，而「关着但没配身份」
			// 报出来会让人以为身份出了问题（其实是开关没开）。
			if (!config.enabled) return base;
			try {
				const bridge = bridgeFor(scope);
				const status = bridge.status();
				return {
					...base,
					identity: {
						scope: status.scope,
						key: status.key,
						collection: status.collection,
						userId: bridge.identity.userId,
					},
					channels: { read: status.read, write: status.write },
					circuit: status.circuit,
				};
			} catch (e) {
				// 身份解析失败 / 分区键非法 —— 这是**报告内容**，不是命令失败（见顶部 ①）
				return { ...base, identityError: e instanceof Error ? e.message : String(e) };
			}
		},

		async list(probe, opts = {}) {
			// 维护视角缺省**含**退役条目：排查「这条记忆怎么不见了」时，
			// 看到它 `superseded` 就是答案本身。
			return bridgeFor(opts.scope ?? "user").search(probe, searchOpts(opts, opts.includeSuperseded ?? true));
		},

		async search(query, opts = {}) {
			// 排序视角缺省只给可检索条目 —— 与模型侧 `fiat_memory_search` 同口径，
			// 否则「CLI 能查到、模型查不到」会成为排查时的第一个假象。
			return bridgeFor(opts.scope ?? "user").search(query, searchOpts(opts, opts.includeSuperseded ?? false));
		},

		async forget(ids, opts = {}) {
			// ⚠️ 关记忆时**不能**走桥的早退分支：桥会返回 `{forgotten: 0, notFound: ids}`，
			// 渲染出来是「未在本分区找到这几条」—— 而真相是「根本不会去删」。
			// 撤销是**不可逆动作**，语义错报的代价比一条报错高得多。
			if (!config.enabled) {
				throw new Error("记忆未启用（FIAT_MEMORY 未开），未执行任何撤销");
			}
			return bridgeFor(opts.scope ?? "user").forget(ids, opts.mode ? { mode: opts.mode } : {});
		},

		async close(): Promise<void> {
			// 拆除失败不影响退出（与 `MemoryStoreBridge.close()` 同口径：不把拆除升级成错误）
			await Promise.all(
				[...bridges.values()].map((b) =>
					b.close().catch(() => {
						/* 拆除失败无需上报 */
					}),
				),
			);
			bridges.clear();
		},
	};
}
