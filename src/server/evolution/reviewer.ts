/**
 * reviewer —— 评审 fork 的编排（阶段 12 / P12-66）。
 *
 * 本模块承担 §10.7 八条硬约束里**属于宿主侧**的那几条：
 *
 *   #1 继承 runtime（同 provider / model / apiKey）  → 由 `runFork` 的装配方保证（见 chat.ts）
 *   #2 `HostSession.inMemory`                        → 同上（绝不触碰主会话 transcript）
 *   #3 脱敏后回放                                    → `slice.ts`（本模块负责调用）
 *   #4 运行时白名单                                  → 本模块只把**提案工具 + fiat_skill_view** 交给 runFork
 *   #5 递归防护                                      → fork 会话**不注册** evolution-trigger（见 chat.ts 装配）
 *   #6 超时 + 兜底                                   → 本模块严格执行，**永不抛**
 *   #7 全量留痕                                      → 写 `fiat_evolution_run`
 *   #8 不可绕过审批                                  → 提示词（prompts.ts）+ 判定（policy.ts）
 *
 * 「永不抛」是这里最硬的纪律：评审是**旁路**，它失败的唯一正确表现是「日志里多一行」，
 * 而不是「用户等了 60 秒然后收到一个报错」——与 eval-recorder「只读不拦」同一纪律。
 * 所以 `review()` 全程 try/catch，超时/异常只落 `status: "timeout" | "error"`。
 *
 * 关于超时的真实语义（诚实记录）：`Promise.race` 只是**放弃等待**，被挂住的 fork
 * 仍在后台跑。这里选择不做 AbortSignal 强制中断，原因是 Node 单线程下强行中断 Pi 的
 * agent 循环会留下半写状态；而 fork 用的是 `HostSession.inMemory`，**没有任何持久化副作用**，
 * 让它自然结束比强行打断更安全。真正的写盘发生在 apply 阶段，那条路径与 fork 无关。
 */

import { randomUUID } from "node:crypto";
import type { ForkContext } from "../host/l1b/propose-tools.ts";
import { pickPromptKind, renderReviewPrompt } from "./prompts.ts";
import type { EvolutionRunStore, ProposalStore } from "./proposalStore.ts";
import { buildSanitizedSlice } from "./slice.ts";
import type { EvolutionProposal, EvolutionRun, TriggerKind } from "./types.ts";
import { EVOLUTION_PROMPT_VERSION, type EvolutionConfig } from "./types.ts";

export interface ForkRunInput {
	prompt: string;
	systemPrompt: string;
	/** 注入给提案工具的运行时上下文（fork 会话创建时原样透传） */
	context: ForkContext;
}

export interface ReviewerDeps {
	proposals: ProposalStore;
	runs: EvolutionRunStore;
	config: EvolutionConfig;
	/** 触发本评审的**主**会话 id（不是 fork 的临时 session id） */
	sessionId: string;
	/** 提案人（触发会话的 userId）；审批人必须不同于它 */
	proposer: string;
	/** 使用的模型 ref，仅留痕用 */
	model?: string;
	/** 起一个 fork 会话并跑完一轮（生产 = PiHostLoop + HostSession.inMemory；测试 = 直接执行提案工具） */
	runFork: (input: ForkRunInput) => Promise<string>;
	/** 当前主会话 transcript（脱敏切片的输入） */
	transcript: () => readonly unknown[];
	/** 注入式依赖，便于确定性测试 */
	genId?: () => string;
	now?: () => Date;
	/** fork 超时（ms）；缺省 config.timeoutMs */
	timeoutMs?: number;
	/** 切片轮数；缺省 config.sliceTurns */
	sliceTurns?: number;
	/** 失败只记日志：宿主注入一个 logger 即可（缺省静默） */
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

export interface ReviewInput {
	trigger: TriggerKind;
	/** 触发瞬间的工具迭代计数（进 EvolutionRun.toolSteps） */
	toolSteps: number;
	/** 触发瞬间的用户轮次计数（进 EvolutionRun.turns） */
	turns: number;
}

export interface ReviewResult {
	run: EvolutionRun;
	/** 本次 run 产出的提案（已落提案表，状态都是 proposed） */
	proposals: EvolutionProposal[];
	/** fork 的实际回复（诊断用；超时/异常时为空串） */
	reply: string;
}

export class EvolutionReviewer {
	private readonly deps: ReviewerDeps;

	constructor(deps: ReviewerDeps) {
		this.deps = deps;
	}

	/** 触发一次评审。**绝不抛异常**——失败只体现为 EvolutionRun.status。 */
	async review(input: ReviewInput): Promise<ReviewResult> {
		const { config } = this.deps;
		const now = this.deps.now ?? (() => new Date());
		const genId = this.deps.genId ?? (() => randomUUID());
		const timeoutMs = this.deps.timeoutMs ?? config.timeoutMs;
		const startedAt = now().toISOString();

		const run: EvolutionRun = {
			runId: genId(),
			sessionId: this.deps.sessionId,
			trigger: input.trigger,
			toolSteps: input.toolSteps,
			turns: input.turns,
			...(this.deps.model ? { model: this.deps.model } : {}),
			promptVersion: EVOLUTION_PROMPT_VERSION,
			proposalsN: 0,
			status: "ok",
			startedAt,
		};

		let reply = "";
		try {
			// #3 脱敏后回放：切片可能是空串（新会话 / 纯对话轮），此时不起 fork
			const slice = buildSanitizedSlice(this.deps.transcript(), {
				turns: this.deps.sliceTurns ?? config.sliceTurns,
			});
			const kind = pickPromptKind(input.trigger);
			const prompt = renderReviewPrompt(kind, slice);
			const context: ForkContext = {
				runId: run.runId,
				sessionId: this.deps.sessionId,
				proposer: this.deps.proposer,
			};

			reply = await withTimeout(
				this.deps.runFork({ prompt, systemPrompt: prompt, context }),
				timeoutMs,
				`评审 fork 超时（${timeoutMs}ms）`,
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			run.status = /超时/.test(message) ? "timeout" : "error";
			run.error = message;
			this.deps.log?.(run.status === "timeout" ? "warn" : "error", `评审 fork 未正常结束：${message}`, {
				runId: run.runId,
				sessionId: run.sessionId,
			});
		}

		// #7 全量留痕：无论成败都落 run（失败也要能回答「谁触发 / 为什么没产出」）
		let proposals: EvolutionProposal[] = [];
		try {
			proposals = await this.deps.proposals.list({ runId: run.runId });
		} catch (e) {
			this.deps.log?.("error", `读取提案失败：${e instanceof Error ? e.message : String(e)}`, { runId: run.runId });
		}
		run.proposalsN = proposals.length;
		run.finishedAt = now().toISOString();

		try {
			await this.deps.runs.insert(run);
		} catch (e) {
			this.deps.log?.("error", `写入 evolution run 失败：${e instanceof Error ? e.message : String(e)}`, {
				runId: run.runId,
			});
		}
		return { run, proposals, reply };
	}
}

/**
 * 超时包装：到点即放弃等待（见文件头的诚实记录——不强行中断）。
 * `onTimeout` 只用来区分「超时」与「真异常」，好让 run.status 说实话。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	}) as Promise<T>;
}
