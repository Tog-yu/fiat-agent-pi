/**
 * memory/types —— 阶段 15 长期记忆的**契约层**（P15-92）。纯类型 + 缺省常量，零 Pi 依赖、零 IO。
 *
 * 依据：`DEV_SPEC.md` §15.6（数据模型）+ §15.12（配置）+ §15.16（跨仓库契约表）。
 *
 * ### 本文件同时是两套命名的**唯一交界处**
 *
 * 设计文档 §5.3 与 RAG 侧 `DEV_SPEC.md` 阶段 J 的接口形态是 **snake_case**
 * （`score_type` / `created_at` / `entry_id` / `not_found` —— 因为对端是 Python），
 * 而 fiat 内部一律 **camelCase**。两套名字的转换**只在 `store.ts` 一处发生**
 * （入参与出参都在那儿；本文件只声明转换后的形状）。
 *
 * 这与 `evolution/config.ts` 的既定口径同源：「配置面用 snake_case，类型面用
 * camelCase，转换只在这一个文件里做」。散着转换会让「加一个字段要改 N 处」，
 * 而漏改一处就是**静默丢字段** —— 契约 5 的 `scope` / `key` / `degraded` 缺失
 * 恰恰是这类失败，且后果是隔离校验与熔断器一起失效。
 *
 * P15-95 实现期更正：本文件初稿的 `MemoryStoreResult.partialFailure` 写成了
 * `{ failed: string[]; detail?: string }`，而 RAG 侧实际返回的是
 * `dense_ok` / `sparse_ok` / `errors`（`MemoryStoreResult.to_dict()`）——
 * 已按对端实际形态对齐。**契约表没有规定这一条**，而它正是「一个字段猜错就静默
 * 丢掉半写状态」的位置，所以按对端代码改，不按初稿改（见 `DEV_SPEC.md` §15.17-⑧）。
 */

// =====================================================================================
// §1 域类型（fiat 内部命名；`DEV_SPEC.md` §15.6）
// =====================================================================================

/**
 * 四类记忆（§15.5，tog 于 2026-09-23 拍板）。
 *
 * ⚠️ 初稿的 `performance` **已撤销** —— 它想表达的「实现口径」整体归入 `feedback`，
 * 因为这类记忆的成因几乎都是一次具体的纠正或确认，而不是孤立的偏好陈述。
 *
 * 四类不是按「内容主题」切，而是按「**这条记忆是关于谁的、被什么触发的**」切。
 * 归类飘移的代价不是"分类不整齐"，而是**按 kind 过滤失效 + 热注入段塞错东西**。
 */
export type MemoryKind = "user" | "feedback" | "project" | "reference";

/**
 * 隔离粒度（`DEV_SPEC.md:859`）。**决定隔离边界，由 L2 注入，永不进 schema。**
 *
 * 本类型原先定义在 `memory/identity.ts`（A 期），P15-92 起**移到这里** ——
 * §15.6 是它的权威出处，`identity.ts` 改为 import + re-export（零运行时变化）。
 * 两份定义会漂移，而漂移的表现是「路径按一个枚举拼、collection 按另一个拼」。
 */
export type MemoryScope = "user" | "repo" | "global";

/**
 * 条目状态（append-only + supersede 的载体，§15.6 约束 2）。
 *
 * - `active`：正常可检索
 * - `superseded`：被新条目替代（**不物理删**，溯源链完整）
 * - `stale`：retention 到期（二期；检索降权而非删除）
 * - `forgotten`：`mark_forgotten` 模式留下的痕迹（物理删模式下不会出现）
 */
export type MemoryStatus = "active" | "superseded" | "stale" | "forgotten";

/** 触发来源（进 `evidence`，回答「这条记忆是怎么来的」） */
export type MemoryTrigger = "correction" | "session_end" | "manual";

/** 溯源（硬约束 10：没有溯源就不能撤销，不能撤销的记忆库不能上线） */
export interface MemoryEvidence {
	/** 触发写入的**主**会话 id（不是 fork 的临时 id） */
	sessionId: string;
	/** 写入时的分区属主（`MemoryIdentity.userId`） */
	userId: string;
	/** 写入时刻（ISO 串） */
	createdAt: string;
	trigger: MemoryTrigger;
}

/** 一条长期记忆（`DEV_SPEC.md` §15.6，字段不改） */
export interface MemoryEntry {
	/** 条目 id。**本侧按幂等键生成、定长 `m_<32hex>`**（契约 2/3） */
	id: string;
	scope: MemoryScope;
	/** scope 内的分区键（L2 注入；已 sanitize） */
	key: string;
	kind: MemoryKind;
	/** 单条正文。**硬上限 `config.write.maxTextChars`（缺省 300）**，超限拒写不截断（契约 4） */
	text: string;
	evidence: MemoryEvidence;
	/** 0~1，LLM 自评 + 代码下限校验（`< minConfidence` 直接丢弃） */
	confidence: number;
	/** 本条替代了哪些旧条目（旧条目标 `superseded`，**不物理删**） */
	supersedes: string[];
	/** 仅 `kind="user"` 且由晋升产出时存在（晋升链，见 §15.5） */
	promotedFrom?: string[];
	status: MemoryStatus;
	/** 检索侧异步回写（二期） */
	lastUsedAt?: string;
	usedCount: number;
}

/**
 * LLM 在提取 fork 里**能产出的全部字段** —— 注意**没有 `id` / `scope` / `key`**。
 *
 * 这是 §15.14 硬约束 3 的类型级落地：隔离标识不是「提示词要求模型别写」，
 * 而是**结构上不存在**。模型既看不到、也改不了隔离边界。
 *
 * 同样没有 `status` / `supersedes` / `promotedFrom`：这三个是**代码判定**的产物
 * （`policy.ts` 的 supersede 与晋升链），不是模型的自我声明。
 */
export interface MemoryCandidate {
	kind: MemoryKind;
	text: string;
	confidence: number;
	/** 为什么值得记（供审计摘要，**不进记忆库**） */
	reason: string;
}

// =====================================================================================
// §2 跨仓库 wire 类型（RAG 侧返回体，snake_case 已在本文件内转为 camelCase 字段名）
// =====================================================================================

/**
 * 分数语义（RAG `score_type`）。
 *
 * ⚠️ **必须原样透传给模型，且不得参与任何判定**。缺省不加 reranker 时 `score` 是
 * **RRF 融合分**（`Σ 1/(k+rank)`，值域与相似度无关）。不标明语义，模型会把
 * 「分数 0.82」当置信度解读 —— 这个坑在 `DEV_SPEC.md` §15.7 已点出。
 *
 * 类型写成 `string`（而不是联合）：它是**边界上的对端实现细节**，
 * 用联合收紧只会在 RAG 侧新增取值时**静默丢字段**。已知取值见下面两个常量。
 */
export type MemoryScoreType = string;

/** 缺省（不加 reranker）的 `score_type` */
export const MEMORY_SCORE_RRF_FUSION = "rrf_fusion";

/** 一条检索命中（契约 5：`hits[]` 的元素形态） */
export interface MemoryHit {
	id: string;
	kind: MemoryKind;
	text: string;
	score: number;
	/** 分数语义，见 `MemoryScoreType` */
	scoreType: MemoryScoreType;
	status: MemoryStatus;
	/** **后置校验（第 ③ 道防线）要拿它和闭包身份比对** —— 因此必须在返回体里，不能只躺在 metadata 里 */
	scope: MemoryScope;
	key: string;
	createdAt: string;
}

/** `memory_search` 返回体（契约 5） */
export interface MemorySearchResult {
	hits: MemoryHit[];
	/** RAG 侧拼出来的 collection（回显，**输出不是输入**） */
	collection: string;
	count: number;
	/**
	 * 检索失败降级的标志。**「空结果」与「检索挂了」必须可区分** ——
	 * 否则无法判断「真的没记忆」还是「RAG 不可用」，熔断器（P15-106）就无从触发。
	 */
	degraded: boolean;
	/** `degraded=true` 时的原因 */
	error?: string;
}

/** `memory_store` 返回体（J4.1） */
export interface MemoryStoreResult {
	stored: string;
	collection: string;
	superseded: string[];
	/**
	 * 部分失败明细（契约：双写不做两阶段提交，向量成功 / BM25 失败时返回部分成功）。
	 *
	 * ⚠️ RAG 侧这一组字段**只在与 `stored` 同一份 payload 里出现**，且整条响应
	 * 带 `isError=true`（`memory_store.py` 末尾：`failure(RuntimeError(...), payload=payload)`）。
	 * 因此 `store.ts` **不能**看到 `isError` 就抛 —— 得先把 payload 解出来。
	 * 有值时调用方应**用同一个 `entry_id` 重试**（写入幂等，重试是廉价的正确解）。
	 */
	partialFailure?: {
		/** dense（向量）那半是否落库 */
		denseOk: boolean;
		/** sparse（BM25）那半是否落库 */
		sparseOk: boolean;
		/** 失败原因（对端 `errors`） */
		errors: string[];
	};
}

/** `memory_forget` 返回体（J6） */
export interface MemoryForgetResult {
	forgotten: number;
	/** 不在本分区 / 不存在的 id —— 属主校验靠分区天然提供（契约 7） */
	notFound: string[];
	collection: string;
	/** 对端回显的执行模式（`delete` / `mark_forgotten`）—— 审计要能区分「真删」与「打标」 */
	mode?: string;
}

/**
 * 条目 id 形态（契约 3）：**必须定长 `m_` + 32 hex**。
 *
 * 为什么定长是硬要求而不是风格问题：RAG 侧 `remove_document` 按**前缀**匹配删除
 * （`bm25_indexer.py:394`）。变长 id 会出现「`m_abc` 是 `m_abcd` 的前缀」→
 * **误删他人条目**。两个生成点（`policy.ts` 算幂等键、`store.ts` 校验入参）共用这一份。
 */
export const MEMORY_ENTRY_ID_PATTERN = /^m_[0-9a-f]{32}$/;

/**
 * kind → 默认 scope 的映射（设计文档 §4.3）。
 *
 * ⚠️ 这张表是**代码的分支，不是提示词的建议**：LLM 只产 `kind`，
 * `scope` / `key` 由这张表 + `MemoryIdentity` 决定（§15 硬约束 3）。
 *
 * `reference` 的默认落点是 `repo`（仓库内权威位置居多，如 `config/tool_policies.yaml`）；
 * 需要 `global`（跨仓库的外部系统指针，如「Bug tracker 在 Linear」）时**由代码显式
 * 指定 `{ scope: "global" }`**，绝不交给模型判断。
 */
export const KIND_DEFAULT_SCOPE: Readonly<Record<MemoryKind, MemoryScope>> = {
	user: "user",
	feedback: "user",
	project: "repo",
	reference: "repo",
};

/** 全部 kind（提示词 / 校验 / 测试的单一事实源） */
export const MEMORY_KINDS: readonly MemoryKind[] = ["user", "feedback", "project", "reference"];

/** 全部 scope */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "repo", "global"];

// =====================================================================================
// §3 配置（`config/memory.yaml` 的反序列化目标，§15.12）
// =====================================================================================

export interface MemoryConfig {
	/** 总开关：`FIAT_MEMORY`。**缺省 false** —— 关时零网络、零定时器、零行为变化 */
	enabled: boolean;
	trigger: {
		/** 确定性正则命中即触发（零 LLM 预筛） */
		onCorrectionSignal: boolean;
		/** 或累计用户轮次达标（缺省 3） */
		minTurns: number;
		/** 会话结束兜底跑一次 */
		atSessionEnd: boolean;
		/** 单会话最多跑几次提取 **fork**（注意：与「落几条」是两回事） */
		maxRunsPerSession: number;
	};
	extract: {
		/** 提取 fork 超时（45s；比评审 60s 短 —— 提取比反思轻） */
		timeoutMs: number;
		/** 与 evolution 同口径，复用 `slice.ts` */
		sliceTurns: number;
	};
	write: {
		/** 低于此值直接丢弃，不落库 */
		minConfidence: number;
		/**
		 * 单条记忆长度硬上限。
		 * ⚠️ **必须与 RAG 侧 `config/settings.yaml` 的 `memory.write.max_text_chars` 一致**
		 * （契约 8）：不一致会出现「fiat 认为合法、RAG 拒写」——最难查的那类静默失败。
		 * 两侧各有一条断言测试锁住自己的值。
		 */
		maxTextChars: number;
		/** 单次提取最多落几条（防「一次写 50 条」） */
		maxPerRun: number;
	};
	promote: {
		/** 同向 `feedback` 累计达此数 → 提炼为一条 `user`（§15.5 晋升链） */
		promotionThreshold: number;
		/** 同族判定用的文本相似度下限 */
		similarityFloor: number;
	};
	read: {
		/** 热注入段条数上限（会话首轮算一次后**冻结**） */
		hotInjectionMaxEntries: number;
		hotInjectionMaxChars: number;
		defaultTopK: number;
		/** 只有这两类进热注入（其余走工具检索） */
		hotKinds: MemoryKind[];
	};
	retention: {
		/** 二期：到期标 `stale` + 检索降权，不物理删 */
		referenceTtlDays: number;
		projectTtlDays: number;
	};
}

/**
 * 缺省配置（对齐 §15.12 的设计值）。
 *
 * `config/memory.yaml` 缺失 / 字段缺省时用它 —— 与 `DEFAULT_EVOLUTION_CONFIG`
 * 同源的 fail-safe：记忆是**旁路**能力，配置写错不该让主链路的 chat 起不来。
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	enabled: false,
	trigger: { onCorrectionSignal: true, minTurns: 3, atSessionEnd: true, maxRunsPerSession: 2 },
	extract: { timeoutMs: 45_000, sliceTurns: 12 },
	write: { minConfidence: 0.6, maxTextChars: 300, maxPerRun: 5 },
	promote: { promotionThreshold: 3, similarityFloor: 0.82 },
	read: {
		hotInjectionMaxEntries: 8,
		hotInjectionMaxChars: 400,
		defaultTopK: 5,
		hotKinds: ["user", "feedback"],
	},
	retention: { referenceTtlDays: 90, projectTtlDays: 180 },
};

/** 提示词版本（提示词改动后可回溯某批记忆是谁生成的；与 `EVOLUTION_PROMPT_VERSION` 同旨） */
export const MEMORY_PROMPT_VERSION = "fiat-mem-v1";
