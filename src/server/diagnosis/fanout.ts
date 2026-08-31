/**
 * P6-25 并行 fan-out：并发池 + 单任务超时 + 部分失败聚合。
 *
 * 纯逻辑层：`runOne` 由调用方注入，测试塞假实现即可，无需起真实 AgentSession。
 *
 * 三个关键约束：
 *   - **并发上限**：N 个视角 = N 倍 token 成本，必须限流（默认 4，与 Pi subagent 的并发上限一致）
 *   - **单任务超时**：一个视角卡住不能拖垮整份报告（默认 120s）
 *   - **部分失败照常出报告**：失败/超时在 summary 与报告正文显式标注，
 *     绝不让上层把「没查到」误读成「没问题」
 */

import type { DiagnosisTask } from "./plan.ts";

export type TaskStatus = "ok" | "failed" | "timeout";

export interface TaskOutcome {
	name: string;
	description: string;
	status: TaskStatus;
	/** status === "ok" 时有值 */
	output?: string;
	/** status !== "ok" 时有值 */
	error?: string;
	durationMs: number;
}

export interface FanoutSummary {
	total: number;
	ok: number;
	failed: number;
	timeout: number;
}

export interface FanoutResult {
	/** 按输入顺序排列（并发执行、顺序产出） */
	results: TaskOutcome[];
	summary: FanoutSummary;
}

/** 跑一个视角，返回该视角的结论文本 */
export type RunOne = (task: DiagnosisTask) => Promise<string>;

export interface FanoutOptions {
	tasks: DiagnosisTask[];
	runOne: RunOne;
	concurrency?: number;
	timeoutMs?: number;
	/** 注入时钟，测试可免真实等待 */
	now?: () => number;
	/** 单个视角结束回调（审计 / 进度上报）；失败与超时同样回调 */
	onTaskDone?: (outcome: TaskOutcome) => void;
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 120_000;

class TaskTimeoutError extends Error {
	constructor(taskName: string) {
		super(`task "${taskName}" timed out`);
		this.name = "TaskTimeoutError";
	}
}

async function runOneGuarded(
	task: DiagnosisTask,
	runOne: RunOne,
	timeoutMs: number,
	now: () => number,
): Promise<TaskOutcome> {
	const start = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new TaskTimeoutError(task.name)), timeoutMs);
	});

	const work = runOne(task);
	// 超时后 runOne 仍会在后台跑完；兜住它的 rejection，避免变成 unhandled rejection
	work.catch(() => {});

	try {
		const output = await Promise.race([work, timeout]);
		return {
			name: task.name,
			description: task.description,
			status: "ok",
			output,
			durationMs: now() - start,
		};
	} catch (err) {
		const isTimeout = err instanceof TaskTimeoutError;
		return {
			name: task.name,
			description: task.description,
			status: isTimeout ? "timeout" : "failed",
			error: err instanceof Error ? err.message : String(err),
			durationMs: now() - start,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** 并发跑完所有视角。任一视角失败/超时都不影响其余视角，也不会让整体 reject。 */
export async function runFanout(opts: FanoutOptions): Promise<FanoutResult> {
	const { tasks, runOne, onTaskDone } = opts;
	const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = opts.now ?? Date.now;

	const results: TaskOutcome[] = new Array(tasks.length);
	let cursor = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const index = cursor++;
			const task = tasks[index];
			if (task === undefined) return;
			const outcome = await runOneGuarded(task, runOne, timeoutMs, now);
			results[index] = outcome;
			onTaskDone?.(outcome);
		}
	}

	const workerCount = Math.min(concurrency, tasks.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	return { results, summary: summarize(results) };
}

export function summarize(results: TaskOutcome[]): FanoutSummary {
	let ok = 0;
	let failed = 0;
	let timeout = 0;
	for (const r of results) {
		if (r.status === "ok") ok += 1;
		else if (r.status === "timeout") timeout += 1;
		else failed += 1;
	}
	return { total: results.length, ok, failed, timeout };
}
