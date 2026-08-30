/**
 * FiatToolClient —— fiat 业务工具的执行后端（L2 Fiat Platform）。
 *
 * 两个实现共用同一扩展代码（工厂注入）：
 *   - LocalFiatClient：测试 / 本地验证，零依赖，返回确定性 stub（含输入回显，便于断言）
 *   - HttpFiatClient：真实 L2 HTTP 调用（POST /tools/{name}），bearer token 由 L2 签发
 *
 * 工具执行在服务端：permission-gate（②）已裁决是否放行，本 client 只负责「实际打 L2」。
 * 高风险工具（如 cashback_submit）的真实写操作须由 L2 校验一次性 token（P5），此处不碰。
 */

export type FiatContentBlock = { type: "text"; text: string };

export interface FiatToolResult {
	content: FiatContentBlock[];
}

export interface FiatToolClient {
	/** 只读 / dry-run 工具执行 */
	execute(tool: string, input: Record<string, unknown>): Promise<FiatToolResult>;
	/** 高风险写操作：仅在审批通过后由 ApprovalService.apply 调用（P5-20） */
	applyTool(tool: string, input: Record<string, unknown>): Promise<FiatToolResult>;
}

/** 本地 stub：确定性返回，输入原样回显，便于单测断言工具真的被调到、参数没被改。 */
export class LocalFiatClient implements FiatToolClient {
	async execute(tool: string, input: Record<string, unknown>): Promise<FiatToolResult> {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ tool, ok: true, echo: input, _stub: "LocalFiatClient" }),
				},
			],
		};
	}

	async applyTool(tool: string, input: Record<string, unknown>): Promise<FiatToolResult> {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ tool, applied: true, echo: input, _stub: "LocalFiatClient" }),
				},
			],
		};
	}
}

/** 真实 L2 后端：HTTP 调用。L2 未建时也能编译，运行时按 baseUrl 注入即可。 */
export class HttpFiatClient implements FiatToolClient {
	private readonly baseUrl: string;
	private readonly getToken: () => string;

	constructor(baseUrl: string, getToken: () => string) {
		this.baseUrl = baseUrl;
		this.getToken = getToken;
	}

	async execute(tool: string, input: Record<string, unknown>): Promise<FiatToolResult> {
		return this.#post(`/tools/${tool}`, input);
	}

	async applyTool(tool: string, input: Record<string, unknown>): Promise<FiatToolResult> {
		return this.#post(`/tools/${tool}/apply`, input);
	}

	async #post(path: string, input: Record<string, unknown>): Promise<FiatToolResult> {
		const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.getToken()}`,
			},
			body: JSON.stringify(input),
		});
		const body = (await res.json().catch(() => ({}))) as { content?: FiatContentBlock[]; detail?: string };
		if (!res.ok) {
			throw new Error(`L2 ${path} 返回 ${res.status}: ${body.detail ?? JSON.stringify(body)}`);
		}
		return {
			content: body.content ?? [{ type: "text", text: JSON.stringify(body) }],
		};
	}
}
