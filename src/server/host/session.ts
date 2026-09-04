/**
 * P8-35 会话基础设施：把 `pi-coding-agent` 的会话管理能力当库接入 pi-host。
 *
 * 设计口径（与阶段 8 铁律一致）：
 * - 阶段 8 弃用的是**扩展加载器**，不是 `pi-coding-agent` 这个包。会话的「落盘 / 恢复 /
 *   迁移 / 版本管理」本就是 `SessionManager` 的职责，直接当库用即可，无需自己造轮子。
 * - `HostSession` 是 `SessionManager` 的薄包装：
 *   - 四种打开方式对齐 Pi 自身：`create` / `open` / `continueRecent` / `inMemory`。
 *   - `messages()` 走 `buildSessionContext()` —— 它会做树遍历、compaction 解析、branch
 *     跟随，吐出喂给 LLM 的 `AgentMessage[]`（类型与 `AgentState.messages` 完全一致）。
 *   - `syncDelta()` 把 agent 本轮新增的消息增量追加为当前 leaf 的子节点，自动推进 leaf。
 * - 显式接入 `parseSessionEntries` + `migrateSessionEntries` + `CURRENT_SESSION_VERSION`：
 *   原始 JSONL 内容先 `parse` 再 `migrate`（旧格式迁移到 `CURRENT_SESSION_VERSION`），
 *   这是「resume 一个历史会话文件」的底层原语，也供宿主做会话导入/导出。
 *
 * 注意：`SessionManager` 的会话是 append-only 树，分支靠移动 leaf 指针实现，不修改历史。
 * 最小循环（P8-34/35）是线性追加，每轮 delta = 新增的 user + assistant 两条。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { FileEntry, SessionContext, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
	CURRENT_SESSION_VERSION,
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/** 打开会话的四种方式（对齐 Pi 自身的 SessionManager 工厂方法） */
export type SessionMode = "create" | "open" | "continueRecent" | "inMemory";

export interface HostSessionOpenOptions {
	cwd: string;
	/** 会话文件目录；缺省用 Pi 默认（~/.pi/agent/sessions/<encoded-cwd>/） */
	sessionDir?: string;
	/** open 模式下的文件路径 */
	path?: string;
	/** create / inMemory 模式下的可选 id / parentSession（fork 用） */
	id?: string;
	parentSession?: string;
	/** open 模式下覆盖 cwd（resume 到另一个工作目录时用） */
	cwdOverride?: string;
}

/**
 * pi-host 的会话句柄。包装 `SessionManager`，对接 `Agent` 的 transcript。
 */
export class HostSession {
	readonly manager: SessionManager;
	/** 已落盘的消息条数（线性追加语义下 = 当前 leaf 前的消息数） */
	private persistedCount = 0;

	private constructor(manager: SessionManager) {
		this.manager = manager;
		// 载入历史会话时，已落盘条数 = 恢复出的 LLM 消息数。
		this.persistedCount = manager.buildSessionContext().messages.length;
	}

	static create(cwd: string, sessionDir?: string, options?: { id?: string; parentSession?: string }): HostSession {
		return new HostSession(SessionManager.create(cwd, sessionDir, options));
	}

	static open(path: string, sessionDir?: string, cwdOverride?: string): HostSession {
		return new HostSession(SessionManager.open(path, sessionDir, cwdOverride));
	}

	static continueRecent(cwd: string, sessionDir?: string): HostSession {
		return new HostSession(SessionManager.continueRecent(cwd, sessionDir));
	}

	static inMemory(cwd?: string, options?: { id?: string; parentSession?: string }): HostSession {
		return new HostSession(SessionManager.inMemory(cwd, options));
	}

	/** 当前已恢复/载入的 LLM 消息列表（含 compaction / branch 解析） */
	messages(): AgentMessage[] {
		return this.manager.buildSessionContext().messages;
	}

	/**
	 * 把 agent 本轮新增的消息增量落盘。
	 * `manager` 内部维护树结构，线性追加即作为当前 leaf 的子节点；branch 时改 leaf 指针即可。
	 */
	syncDelta(delta: readonly AgentMessage[]): void {
		for (const m of delta) this.manager.appendMessage(m as Message);
		this.persistedCount += delta.length;
	}

	get persistedMessageCount(): number {
		return this.persistedCount;
	}
	get id(): string {
		return this.manager.getSessionId();
	}
	get file(): string | undefined {
		return this.manager.getSessionFile();
	}
	get cwd(): string {
		return this.manager.getCwd();
	}
	get isPersisted(): boolean {
		return this.manager.isPersisted();
	}
	get header(): SessionHeader | null {
		return this.manager.getHeader();
	}
	get sessionContext(): SessionContext {
		return this.manager.buildSessionContext();
	}

	/**
	 * 解析并迁移一段原始 JSONL 会话内容。
	 * 显式接入 `parseSessionEntries` + `migrateSessionEntries`，并校验 `CURRENT_SESSION_VERSION`。
	 * 返回 `FileEntry[]`（含 session header + 各 entry）。
	 */
	static parseAndMigrate(content: string): FileEntry[] {
		const entries = parseSessionEntries(content);
		migrateSessionEntries(entries);
		return entries;
	}

	/** 当前 Pi 会话格式版本（会话基础设施的版本号常量） */
	static get currentSessionVersion(): number {
		return CURRENT_SESSION_VERSION;
	}
}
