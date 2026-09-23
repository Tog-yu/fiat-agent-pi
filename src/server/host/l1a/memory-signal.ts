/**
 * memory-signal —— L1a 内建 extension（阶段 15 / P15-97），**循环内**的工具步收集器。
 *
 * 为什么必须放在 L1a（与阶段 12 的 `evolution-trigger` 同一个理由）：
 * §15.8 的纠正信号有两半 ——
 *
 *   - **文本信号**（「不对」「以后都…」）在**用户原文**里 → 宿主看得到
 *     （`PiHostLoop.runTurn` 拿得到 `userText`）；
 *   - **重试信号**（同一工具先失败后成功）只在**循环内**可见
 *     （`turn_end.toolResults`）→ 只有扩展钩子看得到。
 *
 * 本模块只做一件事：**把 `turn_end` 的工具步攒下来**。判定不在这里 ——
 * 「失败后重试成功算不算纠正信号」由 `memory/policy.ts` 的 `detectRetrySignal`
 * 回答，本模块连正则都没有。这与阶段 12 的分工完全同构：
 * `evolution-trigger` 只数迭代数，「该不该评审」由 `EvolutionService` 判。
 *
 * ### 为什么不在这里判「被权限拒绝的失败不算失败」
 *
 * 诱人（`trace-hook` / `eval-recorder` 都有一份 `BLOCKED_PATTERN`），但**不做**：
 *
 *   ① 那会把同一批判据复制到第三处（前两处已经各有一份，见 `DEV_SPEC.md` §15.17-③
 *      对「两套正则必然一处紧一处松」的记录）；
 *   ② 「被拒后换路子成功」**本来就是**「原做法不对」的证据，只是主语的指代不同；
 *   ③ **代价有界**：这个信号只是让宿主多起一次提取 fork（`maxRunsPerSession` 缺省 2），
 *      最终能不能落库还要过 LLM 提取 + `validateCandidate` 两道。
 *
 * ### fail-safe
 *
 * **缺省不注册**（`factory.ts` 组合根控制）：不传 `onTurnSteps` 与 `onAgentEnd` 时
 * 本扩展仍会被注册，但什么都不做 —— 而组合根本来就只在 `FIAT_MEMORY` 打开时才注册它。
 * 关记忆路径上零行为变化（硬约束 7）。
 *
 * ⚠️ 递归防护：提取 fork 的会话**绝不注册本扩展**（fork 是别处单独装配的，
 * 走不到组合根这条路），且 `reset()` 供宿主在 fork 前后显式归零。否则提取会触发提取。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryToolStep } from "../../memory/policy.ts";

export interface MemorySignalSnapshot {
	/** 本会话观察到的 turn 数（诊断用；与宿主用户轮次计数不是一回事） */
	turns: number;
	/** 累计收集到的工具步数 */
	steps: number;
	/** 其中 isError 的条数 */
	errors: number;
	/** agent_end 触发次数（Pi 语义：每次 run 结束各一次，**不是**会话结束） */
	agentEnds: number;
}

export interface MemorySignalDeps {
	/**
	 * 每轮结束上报**本轮新增**的工具步（宿主可实时消费）。
	 * 宿主也可以不传它、改用 `takeSteps()` 取 —— 两条路走的是同一个缓冲。
	 */
	onTurnSteps?: (steps: readonly MemoryToolStep[]) => void;
	/** agent_end 上报（诊断；**不要**把它当「会话结束」用，见 `MemorySignalSnapshot.agentEnds`） */
	onAgentEnd?: () => void;
}

/**
 * 信号句柄：既是 L1a factory（进 `extensionFactories` 数组），
 * 又向宿主暴露 `takeSteps()` / `reset()`。与 `EvolutionTrigger` 同一形状 ——
 * 调用点一眼能看出「这里是装配，这里是读取」。
 */
export interface MemorySignal {
	factory: (pi: ExtensionAPI) => void;
	/**
	 * 取走自上次取走以来累积的工具步（**取走即清空**）。
	 * 宿主在 `agent.prompt()` 返回后调 —— 此刻本用户轮的所有 `turn_end` 都已触发。
	 */
	takeSteps: () => readonly MemoryToolStep[];
	/** 归零（递归防护 / 新会话复用同一个实例时用） */
	reset: () => void;
	snapshot: () => MemorySignalSnapshot;
}

export function createMemorySignal(deps: MemorySignalDeps = {}): MemorySignal {
	let buffer: MemoryToolStep[] = [];
	let turns = 0;
	let total = 0;
	let errors = 0;
	let agentEnds = 0;

	const factory = (pi: ExtensionAPI) => {
		pi.on("turn_end", (event) => {
			turns += 1;
			const fresh: MemoryToolStep[] = [];
			for (const tr of event.toolResults ?? []) {
				// 只取 tool 名 + isError 两个字段：判定只需要「哪个工具失败了」，
				// 而 `content` 里可能是业务数据 —— 正文绝不进缓冲（硬约束 6 的同一条道理）。
				const step: MemoryToolStep = { tool: tr.toolName, isError: tr.isError === true };
				buffer.push(step);
				fresh.push(step);
				total += 1;
				if (step.isError) errors += 1;
			}
			if (fresh.length > 0) deps.onTurnSteps?.(fresh);
		});

		pi.on("agent_end", () => {
			agentEnds += 1;
			deps.onAgentEnd?.();
		});
	};

	return {
		factory,
		takeSteps: () => {
			const out = buffer;
			buffer = [];
			return out;
		},
		reset: () => {
			buffer = [];
			turns = 0;
			total = 0;
			errors = 0;
			agentEnds = 0;
		},
		snapshot: () => ({ turns, steps: total, errors, agentEnds }),
	};
}
