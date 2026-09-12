/**
 * evolution-trigger —— L1a 内建 extension（阶段 12 / P12-63），自进化循环的**工具迭代计数器**。
 *
 * 为什么必须放在 L1a（§10.4 的关键修正）：
 *   Hermes 的两个计数器都在 agent 内。fiat 内嵌循环下**工具迭代只有循环内可见**
 *   （`turn_end.toolResults`），而**用户轮次只有宿主知道**（`PiHostLoop.runTurn`）。
 *   所以计数器分居两层：本扩展管 `itersSinceSkill`，宿主管 `turnsSinceMemory`，
 *   汇合判定放宿主的 EvolutionService（它还掌握本会话的评审预算）。
 *
 * 计数口径：**本轮有 toolResults 则 +1**（不是 +N）。
 *   `turn_end` 是「一个 LLM 轮结束」，一轮里模型可能并发发起多个工具调用；而对标
 *   Hermes 的 `_iters_since_skill`（迭代数）语义，一次「模型决定用工具」= 一次迭代。
 *   因此按轮计数，不按调用数累加。
 *
 * 生命周期分工：
 *   - `turn_end`  → itersSinceSkill += 1（仅当本轮真的产生了工具结果）
 *   - `agent_end` → 经 deps.onSnapshot 上报（宿主在此刻记下「本 run 的工具迭代数」）
 *
 * fail-safe：**缺省不注册**（factory.ts 组合根控制），现有测试零改动。
 * 与 eval-recorder 完全同构——它也是「没传依赖就不注册」。
 *
 * ⚠️ 递归防护（§10.7 第 5 条）：评审 fork 的会话**绝不注册本扩展**，
 * 且 `reset()` 供宿主在 fork 前后显式归零。否则评审会触发评审。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 计数器快照（宿主在 agent_end 拿到，存进 EvolutionRun.toolSteps） */
export interface EvolutionTriggerSnapshot {
	itersSinceSkill: number;
	/** 本会话观察到的 turn 数（诊断用；与宿主的用户轮次计数不是一回事） */
	turns: number;
}

export interface EvolutionTriggerDeps {
	/** agent_end 上报点：宿主在此刻记下本 run 的工具迭代数 */
	onSnapshot?: (s: EvolutionTriggerSnapshot) => void;
}

/**
 * 触发器句柄：既是 L1a factory（进 `extensionFactories` 数组），
 * 又向宿主暴露 `snapshot()` / `reset()` 两个只读/归零能力。
 * 显式分成两个成员而不是让函数对象带属性——调用点一眼能看出「这里是装配，这里是读取」。
 */
export interface EvolutionTrigger {
	/** L1a 工厂：`(pi: ExtensionAPI) => void`，进 extensionFactories 尾部 */
	factory: (pi: ExtensionAPI) => void;
	/** 当前计数快照（宿主汇合判定用） */
	snapshot: () => EvolutionTriggerSnapshot;
	/** 归零（递归防护 / 新会话复用同一个 trigger 实例时用） */
	reset: () => void;
}

export function createEvolutionTrigger(deps: EvolutionTriggerDeps = {}): EvolutionTrigger {
	let itersSinceSkill = 0;
	let turns = 0;

	const factory = (pi: ExtensionAPI) => {
		pi.on("turn_end", (event) => {
			turns += 1;
			// 只有真的用了工具才算一次「工具迭代」：纯对话轮不推进自进化触发器
			if (event.toolResults.length > 0) itersSinceSkill += 1;
		});

		pi.on("agent_end", () => {
			deps.onSnapshot?.({ itersSinceSkill, turns });
		});
	};

	return {
		factory,
		snapshot: () => ({ itersSinceSkill, turns }),
		reset: () => {
			itersSinceSkill = 0;
			turns = 0;
		},
	};
}
