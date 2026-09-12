/**
 * caseRunner —— 评测闸门的「跑分器」（阶段 12 / P12-70 的执行端）。
 *
 * 为什么单独抽一层：`verify.ts` 需要的是「给定 case id，返回一个分数」这一个函数。
 * 而真正跑一个 case 要起完整会话（`buildSession` + `setupEmbeddedExtensions` +
 * `PiHostLoop`）——那是 **Pi 运行时**的事。让 `evolution/` 目录去 import Pi 会破坏
 * 它「纯逻辑、可离线测」的定位（该目录除 host 层外零 Pi 依赖）。
 *
 * 所以这里只做编排：**跑一次 case → 从 sink 取记录 → 用 `aggregate` 算总分**。
 * 会话怎么建由组合根注入（`makeRunner`），因此测试可以注入 faux。
 *
 * ⚠️ 与 CI 用的是**同一套**判分逻辑（`eval/aggregate.ts`）：如果这里另算一套分，
 * 「评测通过」就会被两套口径各说各话——那等于没有准入门槛。
 */

import { aggregate } from "../eval/aggregate.ts";
import type { EvalSink } from "../eval/sink.ts";
import type { EvalCase } from "../eval/types.ts";

export interface CaseRunSession {
	/** 跑这个 case 的提示词 */
	run: () => Promise<void>;
	/** 取回本 case 的 sink（组合根注入；缺省与 run 同一个实例） */
	sink: EvalSink;
}

export interface CaseRunnerDeps {
	/** case 集（`loadEvalCases` 产物）——人写锚点，只读 */
	cases: readonly EvalCase[];
	/** 建一个「跑这个 case」的会话；由组合根提供（需要 Pi 运行时） */
	makeRunner: (evalCase: EvalCase, sink: EvalSink) => Promise<CaseRunSession>;
	log?: (level: "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

/**
 * 返回 `runCase(caseId) => score | undefined`。
 * 拿不到分数（case 不存在 / 会话建不起来 / 没产出 run）一律返回 undefined——
 * `verify.ts` 据此**不做回滚**（评测环境抖动不该让好技能被删掉）。
 */
export function createCaseRunner(deps: CaseRunnerDeps): (caseId: string) => Promise<number | undefined> {
	return async (caseId) => {
		const evalCase = deps.cases.find((c) => c.id === caseId);
		if (!evalCase) {
			deps.log?.("warn", `评测 case 不存在：${caseId}`);
			return undefined;
		}
		try {
			const session = await deps.makeRunner(evalCase, new (await loadInMemorySink())());
			await session.run();
			const records = session.sink.entries?.() ?? [];
			const record = records.at(-1);
			if (!record) {
				deps.log?.("warn", `case ${caseId} 没有产出评测记录`, { caseId });
				return undefined;
			}
			// 与 CI 同源判分：final = Σ(v×w)/Σw，outcome 一票否决
			return aggregate([...record.scores], evalCase).finalScore;
		} catch (e) {
			deps.log?.("warn", `跑 case ${caseId} 失败：${e instanceof Error ? e.message : String(e)}`, { caseId });
			return undefined;
		}
	};
}

/** `InMemoryEvalSink` 是零依赖实现，动态 import 只是为了让本模块的静态依赖保持最小 */
async function loadInMemorySink(): Promise<typeof import("../eval/sink.ts").InMemoryEvalSink> {
	const mod = await import("../eval/sink.ts");
	return mod.InMemoryEvalSink;
}
