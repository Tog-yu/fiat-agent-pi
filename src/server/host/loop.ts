/**
 * P8-34 pi-host 最小内嵌循环：用 `pi-agent-core` 的 `Agent` 自建宿主，
 * 跑通「问一句答一句」，对标 openclaw `pi-embedded` 最小骨架。
 *
 * 设计口径（与阶段 8 铁律一致）：
 * - 不依赖 `createAgentSession` / 扩展加载器——那是阶段 8 要替换的路径。这里直接拿
 *   `Agent` + `streamSimple` 驱动单轮，是 pi-embedded 的等价最小骨架。
 * - `streamFn` 由调用方注入（真实 provider 或 faux），auth 经 `getApiKey` 解析后透传给
 *   `streamSimple` 的 `apiKey`（Pi 的 `StreamOptions.apiKey`）。
 * - 工具通道（L1b / P8-36）与钩子通道（L1a / P8-37）后续挂载：本模块预留 `tools` 注入点
 *   （写 `agent.state.tools`），最小循环先不挂任何工具。
 * - 会话基础设施（P8-35）：传入 `session: HostSession` 则构造时恢复历史 transcript
 *   （`session.messages()`）、每轮 `runTurn` 后把增量 `syncDelta` 落盘；传入 `resources:
 *   HostResources` 则系统提示词优先取 `resources.systemPrompt`。两者均取自 `pi-coding-agent`
 *   当库用，不依赖扩展加载器。
 *
 * 运行：`Agent` 是有状态包装；`prompt(text)` 跑完一轮，`state.messages` 取回复。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { HostResources } from "./resources.ts";
import type { HostSession } from "./session.ts";

/** provider 名 → API key；缺省读 `process.env[${PROVIDER}_API_KEY]` */
export type ApiKeyResolver = (provider: string) => string | undefined;

export interface HostLoopOptions {
	/** 当前轮要用的模型（含 provider / api）；写入 `AgentState.model` */
	model: Model<Api>;
	/** provider → apiKey；缺省读环境变量 */
	getApiKey?: ApiKeyResolver;
	/** 系统提示词（写入 `AgentState.systemPrompt`） */
	systemPrompt?: string;
	/** 会话 ID（审计 / 可观测） */
	sessionId?: string;
	/**
	 * 工具集（L1b / P8-36 挂载点）。最小循环可留空；
	 * 赋值即写 `agent.state.tools`，模型当轮可见。
	 */
	tools?: Array<unknown>;
	/**
	 * 会话句柄（P8-35）。传入则：构造时用 `session.messages()` 恢复历史 transcript，
	 * 每轮 `runTurn` 后把新增消息 `syncDelta` 落盘。不传则为纯内存会话。
	 */
	session?: HostSession;
	/**
	 * 宿主资源（P8-35）。传入则：系统提示词优先取 `resources.systemPrompt`。
	 * （model 仍由本 options 的 `model` 显式传——解析 `Model<Api>` 需要 ModelRegistry，
	 * 留待宿主层；`resources.model` getter 为后续预留。）
	 */
	resources?: HostResources;
}

/** 取最后一条 assistant 消息的文本作为该轮回复 */
export function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		const text = textOf(msg.content);
		if (text) return text;
	}
	return "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const part = item as { type?: string; text?: string } | undefined;
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * pi-host 最小循环宿主。对标 openclaw `pi-embedded` 的 `Agent` 直驱骨架：
 * 一个 `Agent` 实例 + 注入的 `streamFn`，每轮 `prompt(text)` 完成「问一句答一句」。
 */
export class PiHostLoop {
	readonly agent: Agent;
	private readonly resolveKey: ApiKeyResolver;
	private readonly hostSession?: HostSession;

	constructor(opts: HostLoopOptions) {
		this.resolveKey = opts.getApiKey ?? ((p) => process.env[`${p.toUpperCase()}_API_KEY`]);
		this.hostSession = opts.session;

		// streamFn：把当前 model 与透传的 options 交给 streamSimple，并补上 apiKey。
		// Agent 在每轮调用时把 state.model 作为第一个参数传入，因此这里拿到的就是当前模型。
		const streamFn = (
			model: Model<Api>,
			context: Parameters<typeof streamSimple>[1],
			options?: Parameters<typeof streamSimple>[2],
		) => streamSimple(model, context, { ...options, apiKey: this.resolveKey(model.provider) });

		// 系统提示词优先级：显式 systemPrompt > resources.systemPrompt > 空。
		// 恢复历史 transcript：有 session 则取 session.messages()，否则空。
		const systemPrompt = opts.systemPrompt ?? opts.resources?.systemPrompt ?? "";
		const initialMessages = opts.session ? opts.session.messages() : [];

		this.agent = new Agent({
			streamFn,
			sessionId: opts.sessionId,
			initialState: {
				model: opts.model,
				systemPrompt,
				messages: initialMessages,
			},
		});

		if (opts.tools) this.agent.state.tools = opts.tools as never;
	}

	/** 跑一轮：把 userText 作为 user 消息发起，返回最后一条 assistant 文本 */
	async runTurn(userText: string): Promise<string> {
		await this.agent.prompt(userText);
		const all = this.agent.state.messages;
		// 每轮把 agent 新增的消息增量落盘（线性追加语义）。
		if (this.hostSession) {
			this.hostSession.syncDelta(all.slice(this.hostSession.persistedMessageCount));
		}
		return lastAssistantText(all);
	}

	/** 当前完整 transcript */
	get messages(): readonly unknown[] {
		return this.agent.state.messages;
	}

	/** 清空会话（保留 model / systemPrompt） */
	reset(): void {
		this.agent.reset();
	}
}
