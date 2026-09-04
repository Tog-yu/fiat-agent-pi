/**
 * P8-37 L1a 白名单入口：对标 openclaw `pi-embedded-runner/extensions.ts` 的
 * `buildEmbeddedExtensionFactories()`。
 *
 * 职责：集中持有「编译期注入的内建 extension 工厂」白名单。阶段 9 把
 * permission-gate / audit-hook / model-router 改写为内建 extension 后，在此装配；
 * 现阶段为透传 + 防呆（非函数剔除），保证「白名单之外的 factory 进不来」。
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function buildEmbeddedExtensionFactories(factories: readonly ExtensionFactory[]): ExtensionFactory[] {
	const result: ExtensionFactory[] = [];
	for (const factory of factories) {
		if (typeof factory !== "function") {
			throw new Error("buildEmbeddedExtensionFactories: factory must be a function");
		}
		result.push(factory);
	}
	return result;
}
