/**
 * P8-38 宿主职责移植（对标 openclaw `pi-embedded` 的宿主文件职责）：
 * 这些职责 Pi 不提供——Pi extension 绑单 session 且 ctx 只读，宿主层（进程级、多会话）
 * 必须自己承担（§2.5 分层依据）。全部为纯函数 / 独立对象，可离线测。
 *
 * 五项职责与挂载点（0.80.3 实测 d.ts）：
 * 1. provider 错误兜底   → `PiHostLoop.runTurnSafe()`：catch prompt 抛错 + 检查
 *                          assistant `stopReason === "error"` 的 `errorMessage`，
 *                          返回结构化结果而非炸进程。
 * 2. 消息去重·清洗       → `sanitizeMessages()`，挂 Agent options 的
 *                          `transformContext`（每轮 LLM 调用前转换，官方挂载点）。
 * 3. thinking·图片       → 清洗**保留** thinking / image block（是 LLM 合法输入）；
 *                          省 token 场景用 `stripImages()` 显式剥图。
 * 4. bootstrap context   → `buildBootstrapContext()`：会话首条环境上下文消息，
 *                          构造 HostLoop 时注入 transcript（配 session 时一并落盘）。
 * 5. 事件扇出            → `fanoutEvents()`：单 `agent.subscribe` 多播给 N 个
 *                          handler，单 handler 抛错不阻断其他（错误隔离）。
 */

import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

/** 读消息的 role / content 的最小结构视图（AgentMessage 联合太宽，按形状窄化） */
type MsgView = { role?: string; content?: unknown };

function contentView(content: unknown): unknown[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string") return content.length > 0 ? [content] : [];
	return Array.isArray(content) ? content : [];
}

function contentIsEmpty(content: unknown): boolean {
	return contentView(content).length === 0;
}

/** content 的稳定序列化（去重比较用；块内键序无关） */
function contentKey(content: unknown): string {
	const blocks = contentView(content);
	return JSON.stringify(blocks.map((b) => (typeof b === "string" ? b : JSON.stringify(sortKeys(b as object)))));
}

function sortKeys(obj: object): object {
	return Object.fromEntries(
		Object.entries(obj as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => [k, v && typeof v === "object" ? sortKeys(v) : v]),
	);
}

export interface SanitizeOptions {
	/** 是否剥除图片 block（省 token；默认保留） */
	stripImages?: boolean;
	/** 是否剥离 thinking block（默认保留——多数 provider 接受） */
	stripThinking?: boolean;
}

/**
 * 消息去重·清洗（对标 pi-embedded 的 transcript 修复）：
 * - 丢弃 content 为空的消息；
 * - 去除**连续重复**的消息（同 role + 同 content，块内键序无关）；
 * - 按选项剥除图片 / thinking block（默认全保留）。
 * 不重排、不改写语义块——append-only 树的路径解析依赖原序。
 */
export function sanitizeMessages(messages: readonly AgentMessage[], options: SanitizeOptions = {}): AgentMessage[] {
	const out: AgentMessage[] = [];
	let lastKey = "";
	for (const msg of messages) {
		const view = msg as MsgView;
		let content = view.content;

		if (options.stripImages || options.stripThinking) {
			const blocks = contentView(content);
			if (blocks.length > 0 && !blocks.every((b) => typeof b === "string")) {
				const filtered = (blocks as Array<{ type?: string }>).filter((b) => {
					if (typeof b === "string") return true;
					if (options.stripImages && b?.type === "image") return false;
					if (options.stripThinking && b?.type === "thinking") return false;
					return true;
				});
				content = filtered;
			}
		}

		if (contentIsEmpty(content)) continue;

		const key = `${view.role ?? ""}|${contentKey(content)}`;
		if (key === lastKey) continue; // 连续重复去重
		lastKey = key;

		out.push(content === view.content ? msg : ({ ...msg, content } as AgentMessage));
	}
	return out;
}

/**
 * bootstrap context：会话首条环境上下文（对标 pi-embedded 的 bootstrap）。
 * 用 user role 承载（LLM 合法输入），内容自述来源避免与用户输入混淆。
 */
export function buildBootstrapContext(input: {
	cwd: string;
	/** ISO 时间；缺省取当前时刻 */
	time?: string;
	/** 追加的自定义上下文行 */
	extra?: string[];
}): AgentMessage {
	const time = input.time ?? new Date().toISOString();
	const lines = [
		"[bootstrap context]",
		`cwd: ${input.cwd}`,
		`time: ${time}`,
		...(input.extra ?? []),
		"(以上为宿主注入的环境上下文，非用户输入)",
	];
	return {
		role: "user",
		content: lines.join("\n"),
	} as AgentMessage;
}

export type AgentEventHandler = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;

/**
 * 事件扇出：单次 `agent.subscribe` 多播给多个 handler。
 * - handler 顺序 await（与 Pi 订阅语义一致）；
 * - 单 handler 抛错**不阻断**其他 handler（错误收集后统一 onError）；
 * - 返回退订函数。
 */
export function fanoutEvents(
	agent: Agent,
	handlers: readonly AgentEventHandler[],
	onError?: (error: unknown, index: number) => void,
): () => void {
	return agent.subscribe(async (event, signal) => {
		for (let i = 0; i < handlers.length; i += 1) {
			try {
				await handlers[i](event, signal);
			} catch (error) {
				onError?.(error, i);
			}
		}
	});
}
