/**
 * P8-35 会话基础设施离线自测（faux provider，无网络）。
 *
 * 覆盖：
 * 1. `HostSession` 落盘 + 重开：user/assistant 消息跨实例往返一致。
 * 2. `continueRecent`：最近会话可 resume，历史消息保留。
 * 3. `parseAndMigrate` + `CURRENT_SESSION_VERSION`：原始 JSONL 解析、迁移、版本校验。
 * 4. `PiHostLoop` 接入 `HostSession`：每轮增量自动落盘，重开后 `initialState.messages` 恢复。
 * 5. `HostResources`：关闭目录自动发现 + 注入 systemPrompt 生效（L1a 资源层前置）。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { PiHostLoop } from "../src/server/host/loop.ts";
import { HostResources } from "../src/server/host/resources.ts";
import { HostSession } from "../src/server/host/session.ts";

const tmpDirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-host-session-"));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("P8-35 HostSession 落盘 + 重开", () => {
	it("user/assistant 消息跨实例往返一致", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const sessionDir = join(dir, "sessions");

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("你好，我是助手。")]);
		const model = faux.getModel();

		// 第一轮：创建会话 + 跑一轮
		const s1 = HostSession.create(cwd, sessionDir);
		const loop1 = new PiHostLoop({ model, session: s1 });
		const reply1 = await loop1.runTurn("你是谁？");
		expect(reply1).toContain("助手");
		expect(s1.isPersisted).toBe(true);
		const sessionFile = s1.file;
		expect(sessionFile && existsSync(sessionFile)).toBe(true);

		faux.unregister();

		// 第二轮：用同一文件重开，历史应恢复
		if (!sessionFile) throw new Error("session file should exist after first turn");
		const reopened = HostSession.open(sessionFile, sessionDir);
		const loaded = reopened.messages();
		expect(loaded.length).toBe(2); // user + assistant
		expect((loaded[0] as { role: string }).role).toBe("user");
		expect((loaded[1] as { role: string }).role).toBe("assistant");

		// 重开后的会话可继续追加
		const faux2 = registerFauxProvider();
		faux2.setResponses([fauxAssistantMessage("继续回答。")]);
		const loop2 = new PiHostLoop({ model: faux2.getModel(), session: reopened });
		const reply2 = await loop2.runTurn("再问一次");
		expect(reply2).toContain("继续");
		expect(reopened.messages().length).toBe(4); // 2 历史 + 1 user + 1 assistant
		faux2.unregister();
	});

	it("continueRecent 恢复最近会话", async () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const sessionDir = join(dir, "sessions");

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("第一轮回复。")]);
		const s1 = HostSession.create(cwd, sessionDir);
		const loop1 = new PiHostLoop({ model: faux.getModel(), session: s1 });
		await loop1.runTurn("hi");
		faux.unregister();

		// 同一 cwd 下 continueRecent 应 reopen 刚才的会话
		const resumed = HostSession.continueRecent(cwd, sessionDir);
		expect(resumed.messages().length).toBe(2);
		expect(resumed.id).toBe(s1.id);
	});

	it("inMemory 会话不落盘", () => {
		const s = HostSession.inMemory("/tmp/fake-cwd");
		expect(s.isPersisted).toBe(false);
		expect(s.file).toBeUndefined();
		expect(HostSession.currentSessionVersion).toBeGreaterThanOrEqual(1);
	});
});

describe("P8-35 parseAndMigrate + 版本校验", () => {
	it("解析原始 JSONL 并迁移到 CURRENT_SESSION_VERSION", () => {
		// 一段最小 session 文件内容：header + 一条 user message
		const content = [
			JSON.stringify({
				type: "session",
				version: 1,
				id: "abc",
				timestamp: new Date().toISOString(),
				cwd: "/x",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello" },
			}),
		].join("\n");

		const entries = HostSession.parseAndMigrate(content);
		expect(entries.length).toBe(2);
		const header = entries[0] as { type: string; version?: number };
		expect(header.type).toBe("session");
		// migrateSessionEntries 会把旧 version 修到 CURRENT_SESSION_VERSION
		expect(header.version).toBe(HostSession.currentSessionVersion);
	});
});

describe("P8-35 HostResources（关闭自动发现 + 注入 systemPrompt）", () => {
	it("构造不报错，systemPrompt 来自注入，extensions 通道可用", () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		mkdtempSync(agentDir); // 确保目录存在，避免资源加载器探测失败

		const res = new HostResources({
			cwd,
			agentDir,
			systemPrompt: "你是一个测试助手。",
			noDiscovery: true,
		});
		expect(res.systemPrompt).toBe("你是一个测试助手。");
		// noDiscovery 时不应从目录自动发现 extension；getExtensions 不抛错即视为接管成功
		expect(() => res.extensions).not.toThrow();
	});

	it("systemPrompt 经 resources 注入 PiHostLoop", () => {
		const dir = tmp();
		const cwd = join(dir, "proj");
		const agentDir = join(dir, "agent");
		mkdtempSync(agentDir);

		const res = new HostResources({ cwd, agentDir, systemPrompt: "注入的系统提示词。" });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const loop = new PiHostLoop({ model: faux.getModel(), resources: res });
		// 构造后 AgentState.systemPrompt 应取到注入值
		expect(loop.agent.state.systemPrompt).toBe("注入的系统提示词。");
		faux.unregister();
	});
});
