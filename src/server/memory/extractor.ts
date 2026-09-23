/**
 * memory/extractor —— 轮末提取 fork 的编排（P15-94 / §15.8 + §15.11）。
 *
 * 与 `evolution/reviewer.ts` 是**同一套骨架**（刻意的：两处 fork 的纪律必须一致，
 * 各写一套必然有一处少一条）：
 *
 *   | 阶段 12 评审 fork          | 阶段 15 提取 fork（本文件）        |
 *   |---------------------------|-----------------------------------|
 *   | `HostSession.inMemory`    | 同（由组合根保证，见 chat.ts）      |
 *   | 工具白名单：只给 propose  | 工具白名单：**只给 `fiat_memory_submit`** |
 *   | 60s 超时 → 记 `timeout`   | 45s 超时 → 记 `timeout`（提取比反思轻） |
 *   | 递归防护：fork 不挂 trigger | 递归防护：fork 不挂 extractor（`isPrimary=false` 再兜一道） |
 *   | **永不抛**                | 同                                 |
 *   | 全量留痕（`fiat_evolution_run`） | 全量留痕（结果对象 + 审计/span，见 P15-98） |
 *
 * 本模块**零 Pi 依赖、零 IO**：`runFork` 是注入的（生产 = `PiHostLoop` + `HostSession.inMemory`，
 * 测试 = faux 直接往 sink 塞候选），落盘走注入的 `port`。这与 `reviewer.ts` 的口径一致 ——
 * 于是「提取逻辑」可以在没有 Pi 运行时的情况下被穷举测试。
 *
 * ### 本文件只做编排，判定全部下沉到 policy.ts
 *
 * 顺序即管线（每一步都是确定性代码，除了 fork 本身）：
 *
 *   shouldExtract（§15.8 触发表）
 *     → 脱敏切片（复用 evolution/slice.ts）
 *     → 起 fork（白名单只有 submit 工具）
 *     → candidate 形态归一化（submit.ts 的 sink）
 *     → validateCandidate（禁写三形态 + 长度 + 置信度 + kind）
 *     → 幂等去重（同 id 即 no-op）
 *     → pickSuperseded（只对 user/project/reference）
 *     → pickPromotions（feedback 攒够阈值 → 提炼一条 user）
 *     → port.write（P15-95 的写入通道）
 *
 * ### 「永不抛」不是风格问题
 *
 * 它是旁路：用户已经拿到回复了。提取失败的正确表现是「日志里多一行 + 结果对象里
 * 一个 status」，不是「抛出去把 CLI 打崩」。与 `EvolutionService.afterTurn` 同源。
 * 唯一**故意**会抛的地方在更上游（`resolveMemoryIdentity` 的哨兵守卫）—— 那属于
 * 「配置错了」，宁可起不来也不要带着假隔离跑。
 */

import { randomUUID } from "node:crypto";
import { withTimeout } from "../evolution/reviewer.ts";
import { buildSanitizedSlice } from "../evolution/slice.ts";
import type { MemoryIdentity } from "./identity.ts";
import {
	type CandidateRejection,
	detectKindDrift,
	type KindDrift,
	type MemoryToolStep,
	memoryEntryId,
	type PromotionPlan,
	pickPromotions,
	pickSuperseded,
	type SignalHit,
	shouldExtract,
	signalFingerprint,
	type TriggerDecision,
	validateCandidate,
} from "./policy.ts";
import { renderExtractPrompt } from "./prompts.ts";
import { createCandidateSink, type MemoryCandidateSink } from "./submit.ts";
import {
	MEMORY_PROMPT_VERSION,
	type MemoryCandidate,
	type MemoryConfig,
	type MemoryEntry,
	type MemoryTrigger,
} from "./types.ts";

/** fork 输入：组合根据此装配一个 inMemory 子会话（白名单 = `[createMemorySubmitTool(sink)]`） */
export interface ExtractForkInput {
	prompt: string;
	systemPrompt: string;
	/** 候选收集口：fork 里那个 submit 工具往这里写 */
	sink: MemoryCandidateSink;
	/** 留痕上下文（sessionId / userId / 触发原因），进 span 与审计 */
	context: { sessionId: string; userId: string; trigger: MemoryTrigger };
}

/** 一条待写入的记忆 + 它要一并顶掉的旧条目 */
export interface MemoryWriteItem {
	entry: MemoryEntry;
	/** 契约 6：fiat 判定「哪条被替代」，RAG 只执行 `update_metadata(status="superseded")` */
	supersedes: string[];
}

export interface MemoryWritePlan {
	items: MemoryWriteItem[];
}

export interface MemoryWriteReport {
	/** 成功落库的 entry id */
	stored: string[];
	/** 实际被标为 superseded 的旧 id */
	superseded: string[];
	/** 单条失败（写入是幂等的，调用方可用同一 entry id 重试） */
	failed: Array<{ id: string; error: string }>;
}

/**
 * 读写端口（P15-95 的 `store.ts` 实现它）。
 *
 * 为什么读也要走端口：`supersede` 与「晋升」两个判定都需要**同分区已有的 active 条目**，
 * 而那是跨会话数据、必须来自存储。判定本身仍是纯函数（`pickSuperseded` / `pickPromotions`），
 * 这里只负责把「已有条目」取来 —— 与阶段 12「policy 纯函数、service 负责取数」同构。
 */
export interface MemoryExtractionPort {
	/**
	 * 取同分区的已有条目。
	 *
	 * `probe` 是**本轮候选文本**拼成的探针串。RAG 侧没有 list 工具（`memory_search`
	 * 必须给 `query`），因此这是「按相似度取邻域」而不是全量列举 —— 而 supersede
	 * 与晋升本来就只看**相似**的旧条目（P15-95 实现期决策，见 `DEV_SPEC.md` §15.17-⑨）。
	 * 缺省实现把它当可选参数；给了就传，不给就退化成空邻域。
	 */
	listActive(identity: MemoryIdentity, probe?: string): Promise<readonly MemoryEntry[]>;
	write(plan: MemoryWritePlan, identity: MemoryIdentity): Promise<MemoryWriteReport>;
}

export type ExtractionStatus = "ok" | "empty_slice" | "timeout" | "error";

/**
 * 触发原因 → wire `MemoryTrigger`（`evidence.trigger`，RAG 侧 `memory_store` 的枚举）。
 *
 * ⚠️ **跨仓库契约的一处不精确，故意留着**：`TriggerDecision` 有三条运行路径
 * （`correction_signal` / `session_end` / `min_turns`），而对端 `evidence.trigger`
 * 只认三个取值（`correction` / `session_end` / `manual`）。三对三里 `min_turns`
 * **没有忠实的对应物**（它既不是用户纠正、也不是会话结束；`manual` 本意是「人手工触发」）。
 *
 * 为什么把 `min_turns` 映射成 `manual` 而不是发一个更贴切的新值：
 * `memory_store` 的 `inputSchema` 对 `evidence.trigger` 是**枚举**，而 MCP SDK 会在
 * 派发前用 jsonschema 校验入参（`server.py` 的 `validate_input`）—— 发 `"min_turns"`
 * 会得到一个纯文本的 `Input validation error`，**handler 根本不会跑**，整个写入静默失败。
 * 相比之下 `manual` 只是审计标签不够精确，而 `evidence` **从不参与任何判定**。
 *
 * 取舍已记入 `DEV_SPEC.md` §15.17-⑨；若二期要与 RAG 侧对齐，正确做法是在对端枚举里
 * 增加 `scheduled`（跨仓库改动，得两边一起走契约表）。
 */
export function mapTriggerReason(reason: Extract<TriggerDecision, { kind: "run" }>["reason"]): MemoryTrigger {
	if (reason === "correction_signal") return "correction";
	if (reason === "session_end") return "session_end";
	return "manual"; // min_turns
}

/** 被策略拒收的一条（**只留原因与截断摘要，不留全文** —— 硬约束 6） */
export interface RejectedCandidate {
	reason: CandidateRejection;
	detail?: string;
	excerpt: string;
}

export interface MemoryExtractionResult {
	status: ExtractionStatus;
	/** 触发原因：`correction_signal` / `min_turns` / `session_end` */
	triggerReason: string;
	signal: SignalHit | null;
	/** 模型提交的候选条数（含被拒的） */
	candidates: number;
	/** 通过全部校验、且不是重复条目的新条目 id */
	acceptedIds: string[];
	rejected: RejectedCandidate[];
	/** 幂等去重掉的条数（同一事实重复提取 —— 正常现象，不是错误） */
	duplicates: number;
	drift: KindDrift[];
	promotions: PromotionPlan[];
	/** 实际落盘报告；未注入 port 时为 undefined（dry-run） */
	written?: MemoryWriteReport;
	/** status 非 ok/empty_slice 时的原因 */
	error?: string;
	promptVersion: string;
	startedAt: string;
	finishedAt?: string;
}

export interface MemoryExtractorDeps {
	config: MemoryConfig;
	/** 隔离边界（唯一构造点 `resolveMemoryIdentity` 的产物） */
	identity: MemoryIdentity;
	/** **主**会话 id（不是 fork 的临时 id） */
	sessionId: string;
	/**
	 * 触发原因 → wire `MemoryTrigger` 的映射（缺省 `mapTriggerReason`）。
	 *
	 * ⚠️ **刻意不是构造时固定的一个值**：一次会话可以因纠正信号、轮次达标、会话结束
	 * 三种原因各触发一次，而 `evidence.trigger` 要回答的是「**这一条**记忆是怎么来的」。
	 * 固定值会让审计里所有条目长得一样，溯源链就白建了。
	 *
	 * 覆盖点留给测试与未来（例如二期加了 `scheduled` 取值）。
	 */
	triggerFor?: (reason: Extract<TriggerDecision, { kind: "run" }>["reason"]) => MemoryTrigger;
	/** 起一个 fork 会话并跑完一轮；**生产 = PiHostLoop + HostSession.inMemory** */
	runFork: (input: ExtractForkInput) => Promise<string>;
	/** 当前主会话 transcript（脱敏切片的输入） */
	transcript: () => readonly unknown[];
	/**
	 * 写入/读取端口。**缺省 undefined = 只算不写（dry-run）** —— 便于本地观察
	 * 「这一轮会记什么」，与 `EvolutionService` 的 `applyPort` 缺省语义同旨。
	 */
	port?: MemoryExtractionPort;
	/** fork 超时（缺省 config.extract.timeoutMs = 45s） */
	timeoutMs?: number;
	/** 切片轮数（缺省 config.extract.sliceTurns） */
	sliceTurns?: number;
	/** 失败只记日志（缺省静默） */
	log?: (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;
	/** 结果回调（挂 span / 审计用；P15-98） */
	onResult?: (result: MemoryExtractionResult) => void;
	/** 注入式依赖，便于确定性测试 */
	now?: () => Date;
	genId?: () => string;
}

/** `afterTurn` 的入参（宿主在轮末给出本轮可观测到的信息） */
export interface AfterTurnInput {
	/** 本轮用户原文 */
	userText: string;
	/** 本轮工具步（L1a 收集的失败→成功序列） */
	toolSteps?: readonly MemoryToolStep[];
	/** 是否处于会话结束的兜底时刻 */
	atSessionEnd?: boolean;
}

export class MemoryExtractor {
	private readonly deps: MemoryExtractorDeps;
	private turns = 0;
	private runs = 0;
	/** 已触发过的信号指纹（本会话内去重） */
	private readonly signalHashes: string[] = [];

	constructor(deps: MemoryExtractorDeps) {
		this.deps = deps;
	}

	/**
	 * 用户轮次 +1。由宿主轮次钩子驱动（与 `EvolutionService.noteUserTurn` 同一位置口径：
	 * 用户轮次只有宿主知道）。
	 */
	noteUserTurn(): void {
		this.turns += 1;
	}

	/** 预算快照（测试 / 可观测） */
	snapshot(): { turns: number; runs: number; signalHashes: number } {
		return { turns: this.turns, runs: this.runs, signalHashes: this.signalHashes.length };
	}

	/** 纯判定：现在该不该起 fork？无副作用（可安全地在任意时刻调用） */
	shouldExtract(input: AfterTurnInput): TriggerDecision {
		return shouldExtract({
			userText: input.userText,
			turns: this.turns,
			runs: this.runs,
			...(input.toolSteps ? { toolSteps: input.toolSteps } : {}),
			...(input.atSessionEnd ? { atSessionEnd: true } : {}),
			recentSignalHashes: this.signalHashes,
			config: this.deps.config,
		});
	}

	/**
	 * 一轮结束后：判定 → 起 fork → 校验 → 算写入计划 → 落库。**永不抛。**
	 * 返回 null = 本轮没触发（低于阈值 / 预算用尽 / 开关关）。
	 */
	async afterTurn(input: AfterTurnInput): Promise<MemoryExtractionResult | null> {
		const startedAt = (this.deps.now ?? (() => new Date()))().toISOString();
		const verdict = this.shouldExtract(input);
		if (verdict.kind === "skip") {
			if (verdict.reason === "budget_exhausted") {
				this.deps.log?.("warn", `本会话记忆提取预算已用尽（${this.runs} 次），跳过`, {
					sessionId: this.deps.sessionId,
				});
			}
			return null;
		}

		// 触发即占预算、清零轮次计数（递归防护 / 防止每轮都触发）——与阶段 12 同处置
		this.runs += 1;
		this.turns = 0;
		if (verdict.signal) this.signalHashes.push(signalFingerprint(verdict.signal, input.userText));

		// **本轮**的触发来源（不是构造时固定值）：它进 `evidence.trigger`，是溯源的一部分
		const trigger = (this.deps.triggerFor ?? mapTriggerReason)(verdict.reason);

		const base: MemoryExtractionResult = {
			status: "ok",
			triggerReason: verdict.reason,
			signal: verdict.signal ?? null,
			candidates: 0,
			acceptedIds: [],
			rejected: [],
			duplicates: 0,
			drift: [],
			promotions: [],
			promptVersion: MEMORY_PROMPT_VERSION,
			startedAt,
		};

		try {
			// #3 脱敏后回放（复用阶段 12 的切片器：只留 user 摘要 / 工具名 / isError / 输出摘要）
			// 切片为空 = 没有可回放的内容（新会话 / 纯对话轮）→ **不起 fork**（省一次 LLM 调用）
			const slice = buildSanitizedSlice(this.deps.transcript(), {
				turns: this.deps.sliceTurns ?? this.deps.config.extract.sliceTurns,
			});
			if (slice.length === 0) return this.finish({ ...base, status: "empty_slice" });

			const sink = createCandidateSink(this.deps.config.write.maxPerRun);
			const prompt = renderExtractPrompt({
				slice,
				signal: verdict.signal ?? null,
				trigger: verdict.reason,
				config: this.deps.config,
			});

			try {
				await withTimeout(
					this.deps.runFork({
						prompt,
						systemPrompt: prompt,
						sink,
						context: { sessionId: this.deps.sessionId, userId: this.deps.identity.userId, trigger },
					}),
					this.deps.timeoutMs ?? this.deps.config.extract.timeoutMs,
					`记忆提取 fork 超时（${this.deps.timeoutMs ?? this.deps.config.extract.timeoutMs}ms）`,
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				const status: ExtractionStatus = /超时/.test(message) ? "timeout" : "error";
				this.deps.log?.(status === "timeout" ? "warn" : "error", `记忆提取 fork 未正常结束：${message}`, {
					sessionId: this.deps.sessionId,
				});
				// sink 里可能已经有部分候选（超时是「放弃等待」而非「中断」）——
				// 这一批**仍然采用**：它们已经过完整校验，丢掉等于白跑一次 fork
				return this.finish({
					...(await this.plan(sink.candidates, base, verdict, trigger)),
					status,
					error: message,
				});
			}

			return this.finish(await this.plan(sink.candidates, base, verdict, trigger));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.deps.log?.("error", `记忆提取编排失败：${message}`, { sessionId: this.deps.sessionId });
			return this.finish({ ...base, status: "error", error: message });
		}
	}

	/** 校验 + 幂等去重 + supersede + 晋升 → 写入计划 */
	private async plan(
		candidates: readonly MemoryCandidate[],
		base: MemoryExtractionResult,
		verdict: Extract<TriggerDecision, { kind: "run" }>,
		trigger: MemoryTrigger,
	): Promise<MemoryExtractionResult> {
		const { config, identity } = this.deps;
		const now = this.deps.now ?? (() => new Date());
		const createdAt = now().toISOString();

		const existing = this.deps.port ? await this.deps.port.listActive(identity, buildProbe(candidates)) : [];
		const existingIds = new Set(existing.map((e) => e.id));

		const accepted: MemoryEntry[] = [];
		const rejected: RejectedCandidate[] = [];
		const drift: KindDrift[] = [];
		let duplicates = 0;

		for (const candidate of candidates) {
			const verdictOne = validateCandidate(candidate, config);
			if (!verdictOne.accepted) {
				rejected.push({
					reason: verdictOne.reason as CandidateRejection,
					...(verdictOne.detail ? { detail: verdictOne.detail } : {}),
					excerpt: truncate(candidate.text),
				});
				continue;
			}
			// ⑦ 归类漂移：纠正信号命中但产出别的 kind → 记告警，**不拒**
			const d = detectKindDrift(verdict.signal ?? null, candidate);
			if (d) {
				drift.push(d);
				this.deps.log?.("warn", `记忆归类漂移：${d.detail}`, { sessionId: this.deps.sessionId });
			}

			// 隔离边界来自 identity，**kind 不改变 scope**（见 §15.17-⑦）
			const text = candidate.text.trim();
			const id = memoryEntryId({ scope: identity.scope, key: identity.key, kind: candidate.kind, text });
			if (existingIds.has(id)) {
				duplicates += 1; // 幂等：同一事实重复提取不产生新条目
				continue;
			}
			const entry: MemoryEntry = {
				id,
				scope: identity.scope,
				key: identity.key,
				kind: candidate.kind,
				text,
				evidence: { sessionId: this.deps.sessionId, userId: identity.userId, createdAt, trigger },
				confidence: candidate.confidence,
				supersedes: [],
				status: "active",
				usedCount: 0,
			};
			// ⑤ supersede（只对 user/project/reference；feedback 要累积，见 §15.17-①）
			const supersedes = pickSuperseded(entry, existing, config.promote.similarityFloor);
			entry.supersedes = supersedes;
			accepted.push(entry);
		}

		// ⑥ 晋升：feedback 攒够阈值 → 提炼一条 user，同族 feedback 全标 superseded
		const promotions = pickPromotions([...existing, ...accepted], config);
		const promotionEntries: MemoryWriteItem[] = [];
		for (const p of promotions) {
			if (p.text.trim().length === 0) continue; // 全被锚点剥空 → 跳过（不写一条空记忆）
			const id = memoryEntryId({ scope: identity.scope, key: identity.key, kind: "user", text: p.text });
			if (existingIds.has(id)) continue;
			promotionEntries.push({
				entry: {
					id,
					scope: identity.scope,
					key: identity.key,
					kind: "user",
					text: p.text,
					evidence: {
						sessionId: this.deps.sessionId,
						userId: identity.userId,
						createdAt,
						trigger,
					},
					confidence: 1,
					// supersedes 是「给 RAG 侧的指令」（契约 6），promotedFrom 是溯源链 —— 两者同批 id
					supersedes: p.memberIds,
					promotedFrom: p.memberIds,
					status: "active",
					usedCount: 0,
				},
				supersedes: p.memberIds,
			});
		}

		const result: MemoryExtractionResult = {
			...base,
			candidates: candidates.length,
			acceptedIds: [...accepted.map((e) => e.id), ...promotionEntries.map((i) => i.entry.id)],
			rejected,
			duplicates,
			drift,
			promotions,
		};

		if (!this.deps.port) return result; // dry-run：只算不写

		const plan: MemoryWritePlan = {
			items: [...accepted.map((entry) => ({ entry, supersedes: entry.supersedes })), ...promotionEntries],
		};
		if (plan.items.length === 0) return result;

		try {
			const written = await this.deps.port.write(plan, identity);
			return { ...result, written };
		} catch (e) {
			// 写入失败：**不影响已产出的计划**（结果对象里仍能看到 acceptedIds），只记日志
			const message = e instanceof Error ? e.message : String(e);
			this.deps.log?.("error", `记忆写入失败：${message}`, { sessionId: this.deps.sessionId });
			return {
				...result,
				written: { stored: [], superseded: [], failed: plan.items.map((i) => ({ id: i.entry.id, error: message })) },
			};
		}
	}

	/** 收口：补 finishedAt + 调 onResult（留痕）。onResult 自身抛错也不外溢。 */
	private finish(result: MemoryExtractionResult): MemoryExtractionResult {
		const withEnd: MemoryExtractionResult = {
			...result,
			finishedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
		};
		try {
			this.deps.onResult?.(withEnd);
		} catch (e) {
			this.deps.log?.("error", `记忆提取留痕回调失败：${e instanceof Error ? e.message : String(e)}`);
		}
		return withEnd;
	}

	/** 暴露 genId 以便调用方装配 fork 时复用同一套注入（测试确定性） */
	genId(): string {
		return (this.deps.genId ?? randomUUID)();
	}
}

/** 截断到 24 字（拒收摘要用；**绝不把正文落日志**） */
function truncate(s: string, n = 24): string {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 把本轮候选拼成「相似度探针」（见 `MemoryExtractionPort.listActive` 的说明）。
 *
 * 用**全部**候选而不是「已通过校验的」：探针只影响召回邻域，而 supersede 与晋升
 * 的判定各自还会再跑一遍自己的纯函数。少召回一条相似旧条目 = 少顶掉一条过时记忆，
 * 这个代价比「多取几条无关条目」（纯函数自会判掉）更大，所以宁可宽一点。
 *
 * 上限 600 字：探针是**查询**不是文档，再长只会抬高 embedding 成本、
 * 并把语义稀释成一锅杂烩（多主题拼接会退化成「和所有东西都稍微像」）。
 */
function buildProbe(candidates: readonly MemoryCandidate[], maxChars = 600): string {
	const parts: string[] = [];
	for (const c of candidates) {
		const t = (c?.text ?? "").replace(/\s+/g, " ").trim();
		if (t.length > 0) parts.push(t);
	}
	const joined = parts.join("\n");
	return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
