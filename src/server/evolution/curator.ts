/**
 * curator —— 技能库维护侧（阶段 12 / P12-71，§10.1 第 6 条）。
 *
 * Hermes 的 Curator 是 2019 行、含单次 LLM 审查、idle 触发（7 天间隔 + 2 小时空闲）。
 * fiat 只抄它的**确定性骨架**，不抄 LLM 审查那一段，理由有二：
 *
 * 1. **质量判断已经归评测闸门了**（§10.10）。Curator 再做一次 LLM 审查 = 两套质量标准，
 *    而且意见冲突时没有仲裁者。Hermes 需要 LLM 审查，恰恰是因为它没有判分器。
 * 2. **时间衰减只该做「清理」，不该做「评价」**。时间不说明技能对不对，只说明它还用不用。
 *    所以这里只有状态机：`active → stale(30d) → archived(90d)`，删掉判断，只留事实。
 *
 * 状态机的三个纪律：
 *   - **确定性**：不给随机、不给 LLM、不给网络。给定技能库与当前时间，输出唯一。
 *   - **pinned 豁免**：`pin` 是人给的免死金牌（对齐 Hermes 的保护清单）。pinned 技能
 *     既不 stale 也不 archive——这是人 vs 自进化的最终裁量权。
 *   - **archived 是软删**：目录移进 `.archive/`，`restore` 能拿回来。永远不硬删。
 *
 * 时间基准取 `last_used_at ?? created_at`：从没被读过的新技能按「创建时间」算年龄，
 * 否则一个刚落的技能会因为「没人用」立刻被判 stale。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SkillStore } from "./skillStore.ts";
import type { EvolutionConfig } from "./types.ts";

export interface CuratorDeps {
	skills: SkillStore;
	config: EvolutionConfig;
	now?: () => Date;
	/** 可选：把本次运行的人类可读报告写到这个路径（对齐 Hermes 的 `REPORT.md`） */
	reportPath?: string;
}

export interface CuratorResult {
	/** 本次被标 stale 的技能（含原本已是 stale 的？——不含，只记本次新迁移的） */
	staled: string[];
	archived: string[];
	/** 被 pin 保护而跳过的 */
	pinned: string[];
	/** 人类可读报告（也可直接写文件） */
	report: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 跑一次维护。**幂等**：同一时刻跑两次，第二次不产生任何迁移（幂等是能放进 cron 的前提）。
 */
export function curate(deps: CuratorDeps): CuratorResult {
	const now = deps.now ?? (() => new Date());
	const nowMs = now().getTime();
	const staleMs = deps.config.staleAfterDays * DAY_MS;
	const archiveMs = deps.config.archiveAfterDays * DAY_MS;

	const staled: string[] = [];
	const archived: string[] = [];
	const pinned: string[] = [];

	const rows: string[] = [];
	// list() 已把 archived 排除在外，所以这里只需要处理 active / stale
	for (const skill of deps.skills.list()) {
		// 时间基准：用过就按最后使用时间，没用过就按创建时间（否则新技能会因为「没人用」秒变 stale）
		const basis = skill.lastUsedAt ?? (Date.parse(skill.createdAt || "") || nowMs);
		const idleDays = Math.floor((nowMs - basis) / DAY_MS);

		if (skill.pinned) {
			pinned.push(skill.name);
			rows.push(`| ${skill.name} | ${skill.state} | ${idleDays}d | — | pinned，豁免 |`);
			continue;
		}

		// 先判归档再判 stale：跨过两个阈值时应该一步到位归档，而不是先 stale 再等下次归档
		if (nowMs - basis > archiveMs && deps.skills.archive(skill.name, nowMs)) {
			archived.push(skill.name);
			rows.push(
				`| ${skill.name} | ${skill.state} | ${idleDays}d | archived | 超过 ${deps.config.archiveAfterDays} 天未使用 |`,
			);
			continue;
		}
		if (nowMs - basis > staleMs && skill.state !== "stale" && deps.skills.setState(skill.name, "stale")) {
			staled.push(skill.name);
			rows.push(`| ${skill.name} | active | ${idleDays}d | stale | 超过 ${deps.config.staleAfterDays} 天未使用 |`);
			continue;
		}
		rows.push(`| ${skill.name} | ${skill.state} | ${idleDays}d | — | 保留 |`);
	}

	const report = [
		`# 技能库维护报告`,
		"",
		`- 运行时间：${now().toISOString()}`,
		`- 阈值：stale > ${deps.config.staleAfterDays}d，archived > ${deps.config.archiveAfterDays}d`,
		`- 结果：stale ${staled.length} / archived ${archived.length} / pinned 豁免 ${pinned.length}`,
		"",
		"| 技能 | 原状态 | 闲置 | 本次动作 | 说明 |",
		"|---|---|---|---|---|",
		...(rows.length > 0 ? rows : ["| （技能库为空） | — | — | — | — |"]),
		"",
		"> 归档是**软删**：目录移进 `.archive/`，用 `fiat skills restore <name>` 可恢复。",
		"> 自进化**不会**因时间删除任何东西的正文——只有人能 `fiat skills rollback`。",
	].join("\n");

	if (deps.reportPath) {
		mkdirSync(dirname(deps.reportPath), { recursive: true });
		writeFileSync(deps.reportPath, `${report}\n`, "utf-8");
	}

	return { staled, archived, pinned, report };
}
