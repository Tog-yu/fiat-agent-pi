/**
 * CLI 技能库操作（阶段 12 / P12-71）—— 把 `SkillStore` + `Curator` + 提案快照
 * 暴露成 `fiat skills ...`。
 *
 * 边界与 CLI 的其余部分一致：**这里不含业务逻辑**，只是把 L2 能力接成命令。
 * 三件事值得单独说明：
 *
 * 1. **`rollback` 是人的后门**。自进化只在「评测不达标」时自动回滚；其余情况
 *    （技能写得不对但评测恰好过了 / 人改了主意）必须有一条人工路径。它按
 *    「该技能最近一次落盘前拍的快照」还原——也就是把技能库退回到那次落盘之前。
 * 2. **`pin` 是人 vs 自进化的最终裁量权**。pinned 技能既不被 Curator 归档，
 *    也不会被 `policy.decide` 放行改写（保护清单第 1 条）。
 * 3. **归档是软删**。目录进 `.archive/`，`restore` 随时拿回来；技能库里没有硬删路径。
 */

import type { CuratorResult } from "../evolution/curator.ts";
import { curate } from "../evolution/curator.ts";
import type { ProposalStore } from "../evolution/proposalStore.ts";
import type { SkillMeta, SkillStore } from "../evolution/skillStore.ts";
import type { EvolutionConfig } from "../evolution/types.ts";

export interface SkillOps {
	list: () => SkillMeta[];
	setPinned: (name: string, pinned: boolean) => boolean;
	archive: (name: string) => boolean;
	restore: (name: string) => boolean;
	/** 回滚到该技能最近一次落盘前拍的快照；返回是否成功与一句人话说明 */
	rollback: (name: string) => Promise<{ ok: boolean; message: string }>;
	curate: (reportPath?: string) => CuratorResult;
	/** 已归档目录名（`<name>-<ts>`），供 `restore` 指定具体版本 */
	archivedNames: () => string[];
}

export interface SkillOpsDeps {
	skills: SkillStore;
	proposals: ProposalStore;
	config: EvolutionConfig;
	now?: () => Date;
}

export function createSkillOps(deps: SkillOpsDeps): SkillOps {
	const now = deps.now ?? (() => new Date());

	return {
		list: () => deps.skills.list(),

		setPinned: (name, pinned) => deps.skills.setPinned(name, pinned),

		archive: (name) => deps.skills.archive(name, now().getTime()),

		restore: (name) => deps.skills.restore(name),

		curate: (reportPath) =>
			curate({
				skills: deps.skills,
				config: deps.config,
				now,
				...(reportPath ? { reportPath } : {}),
			}),

		archivedNames: () => deps.skills.archivedNames(),

		async rollback(name) {
			if (!deps.skills.get(name)) return { ok: false, message: `技能不存在：${name}` };
			// 找该技能最近一次「落过盘且拍了快照」的提案
			const history = (await deps.proposals.list({ kind: "skill" }))
				.filter((p) => p.target === name && p.snapshotPath)
				.sort((a, b) => (a.appliedAt ?? a.createdAt).localeCompare(b.appliedAt ?? b.createdAt));
			const last = history.at(-1);
			if (!last?.snapshotPath) {
				return { ok: false, message: `技能 ${name} 没有可用快照（不是自进化落盘的技能？）` };
			}
			try {
				deps.skills.rollback(last.snapshotPath);
			} catch (e) {
				return { ok: false, message: `回滚失败：${e instanceof Error ? e.message : String(e)}` };
			}
			// 顺手把那条提案标 rolled_back，保持提案状态机与磁盘一致（审计留痕由 apply 侧负责）
			last.status = "rolled_back";
			last.rolledBackAt = now().toISOString();
			await deps.proposals.update(last);
			return { ok: true, message: `已回滚 ${name} 到 ${last.snapshotPath}（提案 ${last.proposalId} 标 rolled_back）` };
		},
	};
}
