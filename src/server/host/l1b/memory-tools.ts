/**
 * memory-tools —— L1b「检索跨会话记忆」工具（P15-96 / §15.3 第二轨 + §15.11）。
 *
 * **P9-40 契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`。
 *
 * 本模块是**整个阶段 15 里唯一会进模型手上的记忆入口**，而且是只读的。它的安全性
 * 不靠提示词、也不靠权限策略 —— 靠**形状**：
 *
 *   ① **schema 里没有 `scope` / `key`**（硬约束 3）。模型既看不到、也改不了隔离边界；
 *      它连「指定另一个分区」的表达方式都不存在。
 *   ② 分区来自 `deps.channel` —— 一个由组合根用 `MemoryIdentity` 闭包好的对象
 *      （`MemoryStoreBridge.readChannel()`）。**那个对象上没有 `write` / `forget`**
 *      （硬约束 12），所以「让模型写记忆」这件事在这条链上无从表达。
 *   ③ 返回体里**不含 `collection`**：分区名里带 `userId`，回显给模型等于把
 *      「这次会话属于哪个用户」写进对话记录（契约 9 的同一考虑）。
 *
 * ### 三条「怎么把话说清楚」的决定（都是给模型的）
 *
 * 记忆检索有三种「什么都没有」的形态，**它们的正确反应完全不同**，所以输出必须区分：
 *
 * | 形态 | 模型该怎么理解 | 输出 |
 * |---|---|---|
 * | 有命中 | 这是用户的历史偏好 / 项目约定 | 逐条列出，**带 id** |
 * | 空 + 未降级 | 「确实没有相关记忆」，可以正常回答 | 明说「没有匹配」 |
 * | `degraded` | **检索挂了，不代表没有记忆** | 明说「暂不可用」+ 不要据此否定用户 |
 *
 * 第二、三行混在一起是这一层最容易犯的错：模型看到空结果会顺势说「你之前没提过」，
 * 而事实是 RAG 挂了。所以 `degraded` 要**出现在工具输出里**，不能只进宿主日志。
 *
 * ### 为什么返回 id 而不是 omit 它
 *
 * `id` 是可撤销性的入口（硬约束 10）：用户说「那条记忆不对」时，模型能把 id 说出来，
 * 人用 `fiat memory forget <id>` 就撤掉了。不给 id 的检索结果只能被读、不能被纠正 ——
 * 而「不能撤销的记忆库不能上线」是本阶段的硬约束。
 *
 * 权限：本工具不写权限逻辑。注册进主会话时仍受闸门①（`allowedTools` 谓词）约束 ——
 * `memory_search` 在 `tool_policies.yaml` 有对应条目（`policyToolName` 会剥 `fiat_` 前缀），
 * 角色无权则不注册（模型看不到，比「看到了但被拒」更省）。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { MemoryReadChannel, MemorySearchOutcome } from "../../memory/store.ts";
import type { MemoryKind } from "../../memory/types.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

/** 注册名（`policyToolName` 会剥掉 `fiat_` → `memory_search`） */
export const MEMORY_SEARCH_TOOL = "fiat_memory_search";

/** 四类 kind 的枚举（工具 schema 与提示词共用一份） */
const KIND_VALUES: readonly MemoryKind[] = ["user", "feedback", "project", "reference"];

export interface MemoryToolsDeps {
	/** **只读**通道（`MemoryStoreBridge.readChannel()`）。类型上没有写方法 —— 隔离是结构性的 */
	channel: MemoryReadChannel;
	/** 闸门①谓词；缺省不过滤 */
	allowedTools?: (registeredToolName: string) => boolean;
	/**
	 * 失败 / 越界只记日志（缺省静默；正文永不落日志）
	 *
	 * ⚠️ 刻意**没有** `defaultTopK`：缺省条数由 `config.memory.read.defaultTopK` 决定，
	 * 而那份配置已经在 `store.ts` 手上。再从这里传一个就等于同一个值有两个说法，
	 * 而两个说法迟早不一致（§15.16 契约 1 的同一条道理）。
	 */
	log?: (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;
}

export function createMemoryTools(deps: MemoryToolsDeps): HostTool[] {
	if (deps.allowedTools && !deps.allowedTools(MEMORY_SEARCH_TOOL)) return [];

	return [
		hostToolFromDefinition(
			defineTool({
				name: MEMORY_SEARCH_TOOL,
				label: "Fiat Memory Search",
				description:
					"检索**跨会话**的长期记忆（用户偏好 / 过往纠正 / 项目决策 / 外部系统指针）。" +
					"分区由宿主按当前身份自动限定，无需也无法指定范围。" +
					"回答「我上次是不是说过」「这个项目之前定了什么」这类问题前先调它。" +
					"注意：如果结果里说明检索不可用（degraded），不要据此断定用户没说过 —— 那是检索故障。",
				promptSnippet: "检索跨会话长期记忆：fiat_memory_search(query, kinds?, top_k?)。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "自然语言查询，描述你想要的记忆内容" },
						kinds: {
							type: "array",
							items: { type: "string", enum: [...KIND_VALUES] },
							description:
								"可选：限定记忆类别。user=关于人的长期事实；feedback=过往纠正或已确认的偏好；" +
								"project=项目目标/决策/约束；reference=外部系统或权威位置指针。",
						},
						top_k: {
							type: "integer",
							minimum: 1,
							maximum: 20,
							description: "可选：返回条数上限（缺省用服务端配置）",
						},
					},
					required: ["query"],
					// ⚠️ 此处**永不**出现 scope / key / collection / user_id（硬约束 3 + 7）。
					//    它们由 `deps.channel` 闭包注入 —— 模型连表达「换个分区」的语法都没有。
				},
				async execute(_toolCallId, params) {
					const { query, kinds, top_k } = params as {
						query: string;
						kinds?: MemoryKind[];
						top_k?: number;
					};

					const outcome = await deps.channel.search(query, {
						...(kinds && kinds.length > 0 ? { kinds } : {}),
						...(typeof top_k === "number" ? { topK: top_k } : {}),
					});

					if (outcome.isolationViolations.length > 0) {
						// 宿主侧事故，**不告诉模型**：说「有 N 条被丢弃」等于邀请它想办法看见那 N 条。
						// 留痕由 store.ts 以 error 级别打（那里有违规明细），这里只做一次汇总。
						deps.log?.("error", `记忆检索丢弃了 ${outcome.isolationViolations.length} 条越界结果`, {
							count: outcome.isolationViolations.length,
						});
					}

					return {
						content: [{ type: "text" as const, text: renderOutcome(outcome, query) }],
						// details 只放「结构性事实」，**不放正文**（硬约束 6：正文不进审计 / span）。
						// ids 放进来是为了让宿主的 trace 能对上「模型引用了哪条」。
						details: {
							memorySearch: {
								count: outcome.count,
								degraded: outcome.degraded,
								ids: outcome.hits.map((h) => h.id),
								kinds: outcome.hits.map((h) => h.kind),
							},
						},
					};
				},
			}),
		),
	];
}

/**
 * 把检索结果渲染成给模型看的文本。
 *
 * 纯函数（导出以便单测穷举三种形态的措辞 —— 这三种形态的**区别**正是本工具的
 * 主要价值，值得有测试钉住）。
 */
export function renderOutcome(outcome: MemorySearchOutcome, query: string): string {
	if (outcome.degraded) {
		// 「不可用」与「没有」必须说得不一样 —— 否则模型会把故障当成用户的沉默
		const why = outcome.error ? `（原因：${outcome.error}）` : "";
		return (
			`跨会话记忆检索**暂不可用**${why}。\n` +
			`这不代表用户没说过相关的事 —— 只是这次没能查出来。` +
			`请按「没有额外记忆」正常回答，不要据此否定用户的说法。`
		);
	}

	if (outcome.hits.length === 0) {
		// 回显查询词：空结果最常见的成因是 query 写偏了，模型自己能看出来
		return `没有找到匹配的跨会话记忆（查询：${clip(query)}）。`;
	}

	const lines = outcome.hits.map((h) => `- [${h.kind}] \`${h.id}\` ${h.text}`);
	return [
		`找到 ${outcome.hits.length} 条跨会话记忆（按相关度排序）：`,
		...lines,
		"",
		"引用或纠错时请带上上面的 id（形如 `m_…`）；用户在 CLI 里可用它撤销某条记忆。",
		// score 的语义必须说清楚：RRF 融合分**不是**置信度也不是百分比（§15.7 的 ⚠️）
		"（分数为检索融合分，仅供排序参考，不代表记忆的可靠程度。）",
	].join("\n");
}

/** 回显用截断（查询词可能很长，但不该把工具输出撑大） */
function clip(text: string, max = 60): string {
	const t = (text ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}
