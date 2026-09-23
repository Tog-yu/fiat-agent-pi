/**
 * 全链路追踪契约（阶段 14 / P14-82）—— 纯类型 + 缺省配置，零 Pi 依赖、零三方依赖。
 *
 * 设计口径（DEV_SPEC 阶段 14）：
 *   - 与 `audit/client.ts` / `eval/sink.ts` / `policy/client.ts` 完全同构：**接口 + 三实现 + 工厂注入**。
 *     Noop（`enabled=false`，零网络）/ InMemory（测试断言）/ HttpOtlp（真实上报）。
 *   - **Langfuse 无独立 trace 实体：根 span 即 trace**。因此 `TraceContext` 里带
 *     `rootSpanId` + `traceAttributes`，由 tracer 负责把 trace 级属性**下发到每一个 span**
 *     （官方明确：要按 userId / sessionId / tags 过滤，必须传播到全部 span，不能只放根 span）。
 *   - 时间戳一律用**纳秒字符串**：OTLP/JSON 规范里 uint64 用 string 承载，JS number 精度不够。
 *   - `TraceSpan` 是**已完结**的 span（start + end 都在）。OTLP 没有 update 事件，
 *     span 一次成型——所以"开始 span"是内存态，只有 `end()` 才入队。
 */

/**
 * 入口类型：决定采样档位 + trace tags 的第一位。
 *
 * `memory` 是阶段 15（P15-97）新增的：记忆提取 fork 与评审 fork 一样**独立成一条 trace**
 * （它是一次完整的 LLM 会话，塞进主会话的 trace 会让「这轮用户请求花了多少」被提取污染）。
 * 与 `evolution` 分开而不是复用，因为两者的**成本归属**完全不同：
 * 「自进化花了多少钱」与「记忆提取花了多少钱」是两个要分别回答的问题。
 */
export type TraceKind = "chat" | "gateway" | "diagnose" | "ci" | "evolution" | "memory";

/** OTLP span kind（内部阶段 / 上游调用 / 被调用 / 生产者 / 消费者） */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** OTLP span status */
export type SpanStatus = "unset" | "ok" | "error";

/** Langfuse observation level（OTLP 无此概念，走 `langfuse.observation.level` 扩展属性） */
export type SpanLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

/**
 * 内容采集档位（脱敏硬约束）：
 *   - `off`      —— payload 里**一个业务文本都没有**（只留结构、计数、时间）
 *   - `redacted` —— 缺省。与审计 / 评测同一份口径：只留键 + 短标量 + 长文本截断 + 嵌套以 `<type>` 占位
 *   - `full`     —— 需显式配置；`redact_keys` 命中的键在**三种模式下都一律遮罩**
 */
export type CaptureContent = "off" | "redacted" | "full";

/**
 * OTLP attribute 值：四类标量 + 字符串数组（对应 OTLP 的 arrayValue of stringValue）。
 * 数组刻意用可变 `string[]`（不是 `readonly string[]`）：`Array.isArray` 的类型谓词是
 * `arg is any[]`，readonly 数组不在其射程内，联合类型收窄会漏——编码器里会直接报类型错。
 */
export type AttributeValue = string | number | boolean | string[];

/** 已完结的 span（tracer 内部维护开始态，`end()` 时成型并交给 client） */
export interface TraceSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: SpanKind;
	/** 纳秒字符串（OTLP uint64 → string） */
	startNs: string;
	endNs: string;
	attributes: Record<string, AttributeValue>;
	status: SpanStatus;
	statusMessage?: string;
}

/** 开一条 trace（= 开根 span）的入参 */
export interface TraceOptions {
	/** 根 span 名，同时是 Langfuse 里的 trace name（如 `fiat.turn` / `fiat.alert.handle`） */
	name: string;
	kind: TraceKind;
	/** → `langfuse.session.id`（多轮聚合的钩子） */
	sessionId?: string;
	/** → `langfuse.user.id` */
	userId?: string;
	/** → `langfuse.trace.metadata.role` */
	role?: string;
	/** → `langfuse.trace.metadata.environment` */
	environment?: string;
	/** 追加在 tags 尾部（`[kind, environment, role, ...extraTags]`，空值自动剔除） */
	extraTags?: readonly string[];
	/** → `langfuse.trace.metadata.<key>` */
	metadata?: Record<string, AttributeValue>;
	/** 覆盖根 span 起始时间（测试确定性用） */
	startMs?: number;
}

/**
 * 一次 trace 的共享上下文。**采样结论在这里**：`sampled === false` 时所有 span 直接丢弃。
 * 采样只在根做一次、子 span 跟随——per-span 采样会把 trace 采成半棵树。
 */
export interface TraceContext {
	traceId: string;
	rootSpanId: string;
	name: string;
	sampled: boolean;
	/** trace 级属性，由 tracer 下发到每个 span */
	traceAttributes: Record<string, AttributeValue>;
	/**
	 * `toolCallId → tool spanId` 注册表（trace-hook 在 `tool_call` 时写入、工具收口时删除）。
	 *
	 * 存在的理由：L1b 工具模块（如 `mcp-rag` 的 `callTool`）在 **execute 内部**发起下游调用，
	 * 那时它只有 `toolCallId`，不知道自己的 tool span id。没有这张表，MCP span 只能挂在
	 * trace 根上，「tool → mcp」这层嵌套就丢了，而「RAG 慢在哪一跳」正需要它。
	 *
	 * 用**显式的 trace 级注册表**而不是"当前 span"环境变量：并行诊断下会有 N 个视角同时跑，
	 * 环境态会被互相踩；toolCallId 每次调用唯一，天然并发安全。
	 */
	toolSpans?: Map<string, string>;
}

/** 开一个子 span 的入参 */
export interface SpanOptions {
	/** 父 span id；缺省挂根 span */
	parentSpanId?: string;
	kind?: SpanKind;
	attributes?: Record<string, AttributeValue>;
	/** 覆盖起始时间（测试确定性用） */
	startMs?: number;
}

/** token 用量（`gen_ai.usage.*` / `langfuse.observation.usage_details` 的来源） */
export interface TokenUsage {
	input: number;
	output: number;
	total?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
}

/** span 句柄：可变属性 + 幂等 `end()` */
export interface SpanHandle {
	readonly traceId: string;
	readonly spanId: string;
	setAttribute(key: string, value: AttributeValue): void;
	/** → `langfuse.observation.input`（按 `capture_content` 脱敏后序列化） */
	setInput(value: unknown): void;
	/** → `langfuse.observation.output` */
	setOutput(value: unknown): void;
	/** → `gen_ai.request.model` / `gen_ai.system` */
	setModel(model: string, provider?: string): void;
	/** → `gen_ai.usage.*` + `langfuse.observation.usage_details` */
	setUsage(usage: TokenUsage): void;
	/** → `langfuse.observation.level` */
	setLevel(level: SpanLevel): void;
	/** → OTLP `status`；`error` 同时把 level 抬到 ERROR（除非已显式设过） */
	setStatus(status: SpanStatus, message?: string): void;
	/** 幂等：重复调用只生效一次 */
	end(endMs?: number): void;
}

export interface Tracer {
	readonly enabled: boolean;
	startTrace(opts: TraceOptions): TraceContext;
	/**
	 * 开**根 span**（无父）。根 span = Langfuse 里的 trace 本体，
	 * 由入口层持有：`PiHostLoop.runTurn`（`fiat.turn`）/ gateway（`fiat.alert.handle`）。
	 */
	startRootSpan(ctx: TraceContext, opts?: Omit<SpanOptions, "parentSpanId">): SpanHandle;
	/** 开子 span；父缺省为根 span */
	startSpan(ctx: TraceContext, name: string, opts?: SpanOptions): SpanHandle;
	/** 便利函数：回调抛错 → 自动记 error + level=ERROR 后 rethrow（追踪绝不吞业务异常） */
	withSpan<T>(ctx: TraceContext, name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T> | T): Promise<T>;
	/** 立即冲刷待发队列（进程退出 / SIGINT 用） */
	flush(): Promise<void>;
	/** 冲刷 + 取消防抖定时器（不再产生新上报） */
	shutdown(): Promise<void>;
}

/**
 * 装配用的追踪句柄：`tracer` + **本次 trace 的上下文**。
 *
 * 刻意打包成一个对象而不是散成两个可选参数：宿主（`PiHostLoop` 的根 span）与 L1a 钩子
 * （generation / tool 子 span）**必须共用同一个 `TraceContext`**，否则子 span 会挂到根 id
 * 之外的地方、树直接裂开。打包之后"只传 tracer 忘了传 ctx"这类错在类型层就写不出来。
 */
export interface TracingWiring {
	tracer: Tracer;
	trace: TraceContext;
	/**
	 * 本会话的**默认父 span**（缺省 = trace 根）。
	 *
	 * 为什么需要它：并行诊断的每个视角是一个**独立子会话**（自己的 `PiHostLoop` + 自己的
	 * trace-hook），但必须挂在**同一条 trace** 的 `fiat.fanout.angle` 之下。做法是给子会话
	 * 的 wiring 钉一个 `parentSpanId`，子会话里所有顶层 span（`fiat.turn` / generation / tool）
	 * 就都长在那根视角树枝上——而不是各自另开 trace（那样「一条告警 → 5 个视角」会碎成 6 条）。
	 *
	 * 注意：**不能**靠给子会话重新 `startTrace` 实现嵌套——那会生成新的 traceId。
	 */
	parentSpanId?: string;
	/**
	 * **本轮宿主 span**（`fiat.turn`）的 id —— 由 `PiHostLoop.runTurn` 开轮时写入、收口时清除；
	 * L1a trace-hook 读它，把本轮的 generation / tool span 挂进**这一轮**之下。
	 *
	 * 为什么需要这个槽：`fiat.turn` 由**宿主**创建（「一次用户轮」的边界只有宿主知道，Pi 的
	 * 事件里没有这个事件），而 `fiat.llm.turn` 由 **L1a trace-hook** 在 `turn_start` 创建。
	 * 钩子若只认 `parentSpanId ?? trace.rootSpanId`，两个 span 会变成**兄弟**，而根入口恰好
	 * 看不出问题 —— `startRootSpan` 复用 `startTrace` 预留的 id，于是 generation 的父
	 * （rootSpanId）**正好等于** `fiat.turn` 的 id（侥幸命中）。子会话没这个侥幸：
	 * `fiat.turn` 是新 id、父是视角 span，generation 就挂到视角上了，
	 * DEV_SPEC 阶段 14 的「angle → turn → generation」塌成「angle → {turn, generation}」。
	 *
	 * 为什么挂在 wiring 上、而不是 `TraceContext` 上：`TraceContext` 是**整条 trace 共享**的
	 * （蜂群 N 个视角共用同一个 `ctx`），写进去会被并行视角互相踩 —— 同 `toolSpans` 用 Map
	 * 而不用单值字段的理由。`TracingWiring` 是**会话级**的（每个视角一个、chat 每轮一个），
	 * 才是「本轮是谁」的正确作用域。
	 */
	turnSpanId?: string;
}

/**
 * 追踪接线的**取值器**：一个固定的 `TracingWiring`，或一个每次现取的函数。
 *
 * 为什么需要「函数」这一形态 —— `fiat chat` 的语义是「**一轮用户输入 = 一条 trace**」，
 * 多轮只靠 `langfuse.session.id` 聚合（见 `host/loop.ts` 的 `perTurnTracing`）。但会话构建
 * （`buildSession`）发生在**任何一轮开始之前**，而闸门③判定 / 工单落地 / MCP 一跳都发生在
 * **某一轮之内**——它们必须知道「此刻是哪条 trace」。
 *
 * 若这些采集点只收固定 wiring，chat 就只能二选一，两个都错：
 *   - 传构建时的 wiring → 多轮复用同一个预留根 spanId，同一条 trace 里出现多个同 id 根 span
 *   - 干脆不传 → 闸门③ / 工单 / MCP 一跳全部丢 span
 * 所以统一收「取值器」，**在调用那一刻**取当前轮次的接线。固定的 wiring 是取值器的退化形态
 * （`typeof === "function"` 可判别），两种入口共用同一条代码路径。
 */
export type TracingSource = TracingWiring | (() => TracingWiring | undefined);

/** 取值器求值：关追踪 / 未采样 / 尚未开始任何一轮 → undefined（调用点用 `?.` 短路） */
export function resolveTracing(source: TracingSource | undefined): TracingWiring | undefined {
	return typeof source === "function" ? source() : source;
}

export interface TracingBatchConfig {
	maxQueue: number;
	maxBatch: number;
	flushIntervalMs: number;
	maxRetries: number;
	timeoutMs: number;
}

export interface TracingConfig {
	/** 缺省 false —— 关时零网络、零定时器、现有行为零变化（fail-safe 惯例） */
	enabled: boolean;
	provider: "langfuse";
	/** OTLP/HTTP traces 端点（**不是** `/api/public/ingestion`，那个已弃用） */
	endpoint: string;
	/** 只存**环境变量名**，密钥值永不落配置文件 */
	publicKeyEnv: string;
	secretKeyEnv: string;
	/** Langfuse 要求带上才能实时可见（不带则 UI 延迟最长 10 分钟） */
	ingestionVersion: string;
	serviceName: string;
	captureContent: CaptureContent;
	/** 命中的键在**任何档位**下都遮成 `[redacted]` */
	redactKeys: readonly string[];
	sampleRate: Record<TraceKind, number>;
	batch: TracingBatchConfig;
}

export const DEFAULT_TRACING_CONFIG: TracingConfig = {
	enabled: false,
	provider: "langfuse",
	endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
	publicKeyEnv: "LANGFUSE_PUBLIC_KEY",
	secretKeyEnv: "LANGFUSE_SECRET_KEY",
	ingestionVersion: "4",
	serviceName: "fiat-agent",
	captureContent: "redacted",
	redactKeys: ["prompt", "password", "token", "api_key", "id_card", "bank_card", "card_no"],
	sampleRate: { chat: 1, gateway: 1, diagnose: 1, ci: 1, evolution: 1, memory: 1 },
	batch: { maxQueue: 2048, maxBatch: 64, flushIntervalMs: 2000, maxRetries: 2, timeoutMs: 5000 },
};
