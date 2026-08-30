/**
 * Lark 审批卡片 client（阶段 5 / P5-21）。
 *
 * 审批链路里 requestApply 推一张卡片到 Lark；审批人点「通过」后，L2 侧回调
 * ApprovalService.approve（真实 L2 由 Lark 事件订阅触发，本仓库不内置 HTTP 订阅，
 * 但 approve 方法已就绪，接上 Lark 事件处理器即可）。
 *
 * 两个实现共用同一扩展代码（工厂注入）：
 *   - LocalLarkClient：测试 / 本地验证，返回确定性 messageId，零网络
 *   - HttpLarkClient：真实 L2 HTTP 调用（POST /lark/approval/card）
 */

export interface LarkApprovalCard {
	ticketId: string;
	title: string;
	/** 变更计划摘要（让审批人看到要改什么） */
	summary: string;
}

export interface LarkClient {
	sendApprovalCard(card: LarkApprovalCard): Promise<{ messageId: string }>;
}

export class LocalLarkClient implements LarkClient {
	async sendApprovalCard(card: LarkApprovalCard): Promise<{ messageId: string }> {
		// 确定性，便于单测断言
		return { messageId: `lark-${card.ticketId}` };
	}
}

/** 真实 L2 后端：HTTP 调用。L2 未建时也能编译，运行时按 baseUrl 注入即可。 */
export class HttpLarkClient implements LarkClient {
	private readonly baseUrl: string;
	private readonly getToken: () => string;

	constructor(baseUrl: string, getToken: () => string) {
		this.baseUrl = baseUrl;
		this.getToken = getToken;
	}

	async sendApprovalCard(card: LarkApprovalCard): Promise<{ messageId: string }> {
		const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/lark/approval/card`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.getToken()}`,
			},
			body: JSON.stringify(card),
		});
		const body = (await res.json().catch(() => ({}))) as { messageId?: string };
		if (!res.ok) throw new Error(`Lark card 返回 ${res.status}`);
		return { messageId: body.messageId ?? `lark-${card.ticketId}` };
	}
}
