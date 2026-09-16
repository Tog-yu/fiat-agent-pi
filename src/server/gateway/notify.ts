/**
 * 告警通知通道（阶段 13 / P13-80）—— 对齐 approval/lark.ts 的双实现模式。
 *
 *   - LocalAlertNotifier：测试 / 本地，确定性 messageId，零网络
 *   - HttpAlertNotifier：真实 L2 HTTP 调用（生产注入 baseUrl + token）
 *
 * 网关只依赖 AlertNotifier 接口（types.ts）；诊断报告 / 摘要卡 / 节流通知
 * 统一走这一个出口。P0 附审批提示由 runner 组装进 notice.text，本层不判断。
 */

import type { AlertNotice, AlertNotifier } from "./types.ts";

export class LocalAlertNotifier implements AlertNotifier {
	readonly #sent: AlertNotice[] = [];

	async send(notice: AlertNotice): Promise<{ messageId: string }> {
		this.#sent.push(notice);
		return { messageId: `notice-${notice.kind}-${notice.fingerprint.slice(0, 8)}-${this.#sent.length}` };
	}

	/** 测试断言用 */
	get sent(): readonly AlertNotice[] {
		return this.#sent;
	}
}

/** 真实 L2 后端：HTTP 调用。L2 未建时也能编译，运行时按 baseUrl 注入。 */
export class HttpAlertNotifier implements AlertNotifier {
	readonly #baseUrl: string;
	readonly #getToken: () => string;

	constructor(baseUrl: string, getToken: () => string) {
		this.#baseUrl = baseUrl;
		this.#getToken = getToken;
	}

	async send(notice: AlertNotice): Promise<{ messageId: string }> {
		const res = await fetch(`${this.#baseUrl.replace(/\/$/, "")}/lark/alert/notice`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.#getToken()}`,
			},
			body: JSON.stringify(notice),
		});
		const body = (await res.json().catch(() => ({}))) as { messageId?: string };
		if (!res.ok) throw new Error(`Lark alert notice 返回 ${res.status}`);
		return { messageId: body.messageId ?? `notice-${notice.kind}` };
	}
}
