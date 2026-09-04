/**
 * P8-35 宿主资源层：把 `SettingsManager` + `DefaultResourceLoader` 当库接入 pi-host。
 *
 * 设计口径（与阶段 8 铁律一致）：
 * - 阶段 8 弃用的是**扩展加载器（目录自动发现 + `pi -e`）**，不是资源/设置这套库。
 *   宿主仍需要「设置（模型选择等）」与「资源加载（系统提示词 / 内建 extension）」能力，
 *   只是加载方式从目录自动发现改为**编译期注入**。
 * - `DefaultResourceLoader` 显式传 `noExtensions / noSkills / noPromptTemplates / noThemes /
 *   noContextFiles: true` —— 即关闭目录自动发现，但**仍传 `extensionFactories`**（L1a 通道，
 *   对标 openclaw `pi-embedded` 的 `buildEmbeddedExtensionFactories()`）。这是 P8-37 / P8-40 的
 *   前置基础：编译期注入的 extension 生效，外部目录 extension 不生效。
 * - `SettingsManager` 用 `inMemory`：宿主自己的模型/设置由 L2 显式下发，不读写 `~/.pi`
 *   的个人配置（避免与用户个人 Pi 混杂，呼应踩坑表 `agentDir` 默认 `~/.pi/agent`）。
 *
 * 集成点：
 * - `systemPrompt` 由宿主注入优先（`HostResources.systemPrompt` 透出），喂给 `AgentState.systemPrompt`。
 * - `model` 从 settings 读出 `{ provider, modelId }`，供宿主用 `ModelRegistry` 解析成 `Model<Api>`
 *   （P8-35 不强制接管 model，model 仍由 `PiHostLoop` 显式传；此 getter 为后续预留）。
 */

import type { ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

/** `SettingsManager.inMemory` 的 settings 入参类型（包未导出 `Settings` 类型，用 Parameters 推断） */
type InMemorySettings = Parameters<typeof SettingsManager.inMemory>[0];

export interface HostResourcesOptions {
	/** 工作目录（写入资源加载器的 cwd） */
	cwd: string;
	/** 独立的 agent 目录（避免与个人 Pi 配置混杂） */
	agentDir: string;
	/** 注入的系统提示词（宿主注入优先，经 `HostResources.systemPrompt` 透出） */
	systemPrompt?: string;
	/** 设置覆盖（模型选择等）；不传则用空 in-memory 设置 */
	settings?: InMemorySettings;
	/**
	 * 关闭目录自动发现（阶段 8 铁律：弃用扩展加载器，但保留 extensionFactories 通道）。
	 * 默认 true —— 即「编译期注入、外部目录不自动发现」。
	 */
	noDiscovery?: boolean;
	/** 编译期注入的内建 extension（L1a / P8-37 挂载点） */
	extensionFactories?: ExtensionFactory[];
}

/**
 * pi-host 的资源/设置句柄。
 */
export class HostResources {
	readonly settingsManager: SettingsManager;
	readonly loader: DefaultResourceLoader;
	/** 宿主显式注入的系统提示词（优先于资源加载器从文件发现的值） */
	private readonly injectedSystemPrompt?: string;

	constructor(opts: HostResourcesOptions) {
		const noDiscovery = opts.noDiscovery ?? true;
		this.injectedSystemPrompt = opts.systemPrompt;

		this.settingsManager = SettingsManager.inMemory(opts.settings);
		this.loader = new DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			settingsManager: this.settingsManager,
			systemPrompt: opts.systemPrompt,
			noExtensions: noDiscovery,
			noSkills: noDiscovery,
			noPromptTemplates: noDiscovery,
			noThemes: noDiscovery,
			noContextFiles: noDiscovery,
			extensionFactories: opts.extensionFactories,
		});
	}

	/**
	 * 系统提示词：宿主注入的优先；否则取资源加载器从文件发现的值。
	 * 注意 `DefaultResourceLoader.getSystemPrompt()` 返回的是「从文件发现」的提示词，
	 * 与构造时传入的 `systemPrompt` 选项是两回事——关闭自动发现时后者不回显，故宿主以
	 * 注入值为准。
	 */
	get systemPrompt(): string | undefined {
		return this.injectedSystemPrompt ?? this.loader.getSystemPrompt();
	}

	/** 编译期注入 / 发现的 extension 结果（L1a 通道产物） */
	get extensions(): LoadExtensionsResult {
		return this.loader.getExtensions();
	}

	/** 当前设置选中的模型（宿主据此解析成 `Model<Api>`） */
	get model(): { provider: string; modelId: string } | undefined {
		const provider = this.settingsManager.getDefaultProvider();
		const modelId = this.settingsManager.getDefaultModel();
		return provider && modelId ? { provider, modelId } : undefined;
	}
}
