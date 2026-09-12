/**
 * skill-tools —— L1b「按需读技能正文」工具（阶段 12 / P12-65）。
 *
 * **P9-40 契约**（工具模块）：去掉 `ExtensionAPI` 依赖，工厂直接返回 `HostTool[]`。
 *
 * 这是索引注入的配套：systemPrompt 里只有一行行索引，模型真要按某个技能执行时，
 * 用 `fiat_skill_view` 把正文（或技能目录内的支持文件）拉进上下文。
 *
 * 只读工具，天然可放在**主会话与评审 fork 两侧**（fork 同样需要读技能来判断
 * 「该改已有技能还是新建」）。因此本模块与 propose-tools（只进 fork）分开：
 * 一个可共享，一个必须隔离。
 *
 * 权限：本工具不写权限逻辑。注册进主会话时仍受闸门①（allowedTools 谓词）约束——
 * `skill_view` 在 tool_policies.yaml 里有对应条目，角色无权则不注册。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../../evolution/skillStore.ts";
import type { HostTool } from "../tools.ts";
import { hostToolFromDefinition } from "../tools.ts";

export const SKILL_VIEW_TOOL = "fiat_skill_view";

export interface SkillToolsDeps {
	store: SkillStore;
	/** 闸门①谓词；缺省不过滤 */
	allowedTools?: (registeredToolName: string) => boolean;
	/** 每次读取记一次使用遥测（Curator 的时间衰减靠它）；缺省记 */
	recordUsage?: boolean;
}

export function createSkillTools(deps: SkillToolsDeps): HostTool[] {
	if (deps.allowedTools && !deps.allowedTools(SKILL_VIEW_TOOL)) return [];

	return [
		hostToolFromDefinition(
			defineTool({
				name: SKILL_VIEW_TOOL,
				label: "Fiat Skill View",
				description:
					"读取一个技能的正文（或技能目录内的支持文件）。技能索引在系统提示词末尾；不确定用哪个技能时先看索引再调用本工具。",
				promptSnippet: "读取技能正文：fiat_skill_view(name, file_path?)。",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", description: "技能名（索引里的 slug，如 cashback-reconcile）" },
						file_path: {
							type: "string",
							description: "可选：技能目录内的支持文件相对路径（如 references/faq.md）；缺省读 SKILL.md 正文",
						},
					},
					required: ["name"],
				},
				async execute(_toolCallId, params) {
					const { name, file_path } = params as { name: string; file_path?: string };
					const text = deps.store.read(name, file_path);
					if (text === null) {
						// 未命中不抛错：回一张「可用技能清单」，让模型自己纠偏（比空错误更有信息量）
						const available = deps.store
							.list()
							.map((s) => s.name)
							.join(", ");
						return {
							content: [
								{ type: "text" as const, text: `技能 ${name} 不存在或文件不可读。可用技能：${available || "（无）"}` },
							],
							details: { skillView: name, found: false, filePath: file_path },
						};
					}
					if (deps.recordUsage !== false) deps.store.recordUsage(name);
					return {
						content: [{ type: "text" as const, text }],
						details: { skillView: name, found: true, filePath: file_path ?? "SKILL.md" },
					};
				},
			}),
		),
	];
}
