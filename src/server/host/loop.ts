/**
 * P8-34 pi-host 最小内嵌循环：用 `pi-agent-core` 的 `Agent` 自建宿主，
 * 跑通「问一句答一句」，对标 openclaw `pi-embedded` 最小骨架。
 *
 * 设计口径（与阶段 8 铁律一致）：
 * - 不依赖 `createAgentSession` / 扩展加载器——那是阶段 8 要替换的路径。这里直接拿
 *   `Agent` + `streamSimple` 驱动单轮，是 pi-embedded 的等价最小骨架。
 * - `streamFn` 由调用方注入（真实 provider 或 faux），auth 经 `getApiKey` 解析后透传给
 *   `streamSimple` 的 `apiKey`（Pi 的 `StreamOptions.apiKey`）。
 * - 工具通道（L1b / P8-36）：`tools` 经 `registerTools` 写 `agent.state.tools`，模型当轮
 *   可见、由 Agent 循环本地执行；钩子通道（L1a / P8-37）后续经 Agent options 的
 *   `beforeToolCall` / `extensionFactories` 挂载。
 * - 会话基础设施（P8-35）：传入 `session: HostSession` 则构造时恢复历史 transcript
 *   （`session.messages()`）、每轮 `runTurn` 后把增量 `syncDelta` 落盘；传入 `resources:
 *   HostResources` 则系统提示词优先取 `resources.systemPrompt`。两者均取自 `pi-coding-agent`
 *   当库用，不依赖扩展加载器。
 *
 * 运行：`Agent` 是有状态包装；`prompt(text)` 跑完一轮，`state.messages` 取回复。
 */

import type {
	AfterToolCallContext,
	AfterToolCallResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { SanitizeOptions } from "./duties.ts";
import { buildBootstrapContext, sanitizeMessages } from "./duties.ts";
import type { HostResources } from "./resources.ts";
import type { HostSession } from "./session.ts";
import { type HostTool, registerTools } from "./tools.ts";

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
	 * 工具集（L1b / P8-36 通道）。可留空；
	 * 经 `registerTools` 写 `agent.state.tools`，模型当轮可见、由 Agent 循环本地执行。
	 * 拦截/审计不在此处——闸门② 走 L1a（P8-37），canExecute 在 L2。
	 */
	tools?: HostTool[];
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
	/**
	 * 工具调用前钩子（L1a / P8-37 桥接点，承载闸门②）。
	 * 由 `bridgeAgentHooks(runner).beforeToolCall` 产出——extension `tool_call` 钩子的
	 * `{block, reason}` 与此返回形状一致，直通。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/**
	 * 工具结果钩子（L1a / P8-37 桥接点，audit-hook 用）。
	 * 由 `bridgeAgentHooks(runner).afterToolCall` 产出。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/**
	 * 每轮开始前钩子（L1a / P10-50 桥接点，model-router 用）。
	 * 由 `bridgeAgentHooks(runner).beforeAgentStart` 产出——每轮 `runTurn` 前触发
	 * `before_agent_start` 事件，路由决策经 `pi.setModel` 副作用生效。
	 */
	beforeAgentStart?: (prompt: string) => Promise<void>;
	/**
	 * 消息去重·清洗（P8-38）。传入则挂 Agent `transformContext`——每轮 LLM 调用前
	 * 跑 `sanitizeMessages`（丢弃空消息 / 连续重复去重 / 按选项剥图·剥 thinking）。
	 * 不改 transcript 本体，只清洗发给 LLM 的视图。
	 */
	sanitize?: boolean | SanitizeOptions;
	/**
	 * bootstrap context（P8-38）。传入 cwd 等则在构造时生成环境上下文消息，
	 * 追加在恢复的历史之后、任何用户输入之前；配 session 时一并落盘。
	 */
	bootstrap?: { cwd: string; time?: string; extra?: string[] };
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
	private readonly beforeAgentStart?: (prompt: string) => Promise<void>;

	constructor(opts: HostLoopOptions) {
		this.resolveKey = opts.getApiKey ?? ((p) => process.env[`${p.toUpperCase()}_API_KEY`]);
		this.hostSession = opts.session;
		this.beforeAgentStart = opts.beforeAgentStart;

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
		const recovered = opts.session ? opts.session.messages() : [];
		// bootstrap context（P8-38）：构造时生成环境上下文，排在恢复历史之后。
		// 新 session 下它属于「未落盘增量」，首轮 syncDelta 一并落盘；resume 场景已在
		// session.messages() 里，不会重复注入。
		const initialMessages = opts.bootstrap ? [...recovered, buildBootstrapContext(opts.bootstrap)] : recovered;

		// 消息清洗（P8-38）：挂官方 transformContext——只清洗 LLM 视图，不动 transcript。
		const sanitizeOptions = opts.sanitize === true ? {} : (opts.sanitize ?? undefined);

		this.agent = new Agent({
			streamFn,
			sessionId: opts.sessionId,
			initialState: {
				model: opts.model,
				systemPrompt,
				messages: initialMessages,
			},
			// L1a 钩子桥接点（P8-37）：由 bridgeAgentHooks(runner) 产出后透传。
			beforeToolCall: opts.beforeToolCall,
			afterToolCall: opts.afterToolCall,
			transformContext: sanitizeOptions
				? (messages) => Promise.resolve(sanitizeMessages(messages, sanitizeOptions))
				: undefined,
		});

		if (opts.tools) registerTools(this.agent, opts.tools);
	}

	/** 跑一轮：把 userText 作为 user 消息发起，返回最后一条 assistant 文本 */
	async runTurn(userText: string): Promise<string> {
		// model-router 桥接点（P10-50）：每轮开始前触发 before_agent_start，
		// 路由决策经 pi.setModel 改写 state.model，本轮 LLM 调用即用新模型。
		await this.beforeAgentStart?.(userText);
		await this.agent.prompt(userText);
		const all = this.agent.state.messages;
		// 每轮把 agent 新增的消息增量落盘（线性追加语义）。
		if (this.hostSession) {
			this.hostSession.syncDelta(all.slice(this.hostSession.persistedMessageCount));
		}
		return lastAssistantText(all);
	}

	/**
	 * provider 错误兜底（P8-38）：跑一轮但**不抛**——provider 流失败（prompt 抛错）或
	 * assistant 以 `stopReason:"error"` 结束时，返回结构化错误而非炸进程。
	 * 宿主（L2）据此决定重试 / 降级 / 告警；对齐 pi-embedded 的 provider 错误兜底职责。
	 */
	async runTurnSafe(
		userText: string,
	): Promise<{ ok: true; reply: string } | { ok: false; reply: string; error: string }> {
		try {
			const reply = await this.runTurn(userText);
			// prompt 未抛 ≠ 成功：faux / 真实 provider 可能返回 stopReason "error"。
			const last = this.agent.state.messages.at(-1) as
				| { role?: string; stopReason?: string; errorMessage?: string }
				| undefined;
			if (last?.role === "assistant" && last.stopReason === "error") {
				const error = last.errorMessage || "provider returned error stopReason";
				return { ok: false, reply, error };
			}
			return { ok: true, reply };
		} catch (error) {
			return { ok: false, reply: "", error: error instanceof Error ? error.message : String(error) };
		}
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
