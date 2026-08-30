/**
 * 变更工作流状态机（P4-18）—— dry-run → 变更计划 → 审批 → 执行，全程不改数据直到 apply。
 *
 * 这是 L2 业务层的「流程护栏」：状态转移只能沿白名单走，非法跳变（如 planned 直接 done）
 * 被拒绝。审批（approved）是人工/Lark 卡点，由 P5 的工单驱动；本状态机只负责流转合法性。
 *
 * LLM 不参与状态机判断（铁律 4）——转移是否合法是纯函数查表，不交给模型。
 */

export type WorkflowPhase =
	| "idle"
	| "parsing"
	| "reconciling"
	| "planned"
	| "approved"
	| "applying"
	| "done"
	| "rejected";

const TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
	idle: ["parsing"],
	parsing: ["reconciling", "rejected"],
	reconciling: ["planned", "rejected"],
	planned: ["approved", "rejected"], // 审批门：planned → approved 需工单（P5）
	approved: ["applying"],
	applying: ["done", "rejected"],
	done: [],
	rejected: [],
};

export function canTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
	return TRANSITIONS[from].includes(to);
}

export class WorkflowMachine {
	phase: WorkflowPhase = "idle";

	/** 尝试转移；非法返回 false 且不改变 phase */
	transition(to: WorkflowPhase): boolean {
		if (!canTransition(this.phase, to)) return false;
		this.phase = to;
		return true;
	}

	/** 便捷：dry-run 全流程（parse→reconcile→plan），停在 planned 等待审批 */
	runDryRun(): boolean {
		return this.transition("parsing") && this.transition("reconciling") && this.transition("planned");
	}

	get isTerminal(): boolean {
		return this.phase === "done" || this.phase === "rejected";
	}
}
