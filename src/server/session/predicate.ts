/**
 * 闸门①纯函数：根据 policies 计算「角色 + 环境」允许的工具名谓词。
 *
 * 独立成文件是为了打破与 factory.ts（组合根，静态引入 alert-fanout 等 Pi 扩展）
 * 的耦合 —— 让不依赖 Pi 运行时环境的调用方（如业务 CLI 离线命令）也能用这道谓词，
 * 而不必加载整条 factory 链。SessionSubject 用 type-only 引入，运行时被擦除。
 */

import { policyToolName, type ToolPolicy } from "../policy/engine.ts";
import type { SessionSubject } from "./factory.ts";

export function allowedToolPredicate(
	policies: Map<string, ToolPolicy>,
	subject: SessionSubject,
): (registeredToolName: string) => boolean {
	return (registeredToolName: string) => {
		const policy = policies.get(policyToolName(registeredToolName));
		if (!policy) return false;
		return (
			policy.allowed_roles.includes(subject.user.role) && policy.allowed_environments.includes(subject.environment)
		);
	};
}
