/**
 * PolicyClient —— L1 permission-gate 与 L2 之间的接口。
 *
 * 三个实现共用同一个扩展代码（工厂注入模式）：
 *   - LocalPolicyClient：进程内直连策略引擎（Web 场景 / 测试），零网络
 *   - HttpPolicyClient：指向 L2 Fastify 的 HTTP client（TUI 场景；随 L2 服务一起实现）
 *   - 测试 mock
 */

import { type CanExecuteReq, canExecute, loadPolicies, type Verdict } from "./engine.ts";

export interface PolicyClient {
	canExecute(req: CanExecuteReq): Promise<Verdict>;
}

/** 进程内直连：读 tool_policies.yaml 判定，不发请求 */
export class LocalPolicyClient implements PolicyClient {
	readonly #policies: ReturnType<typeof loadPolicies>;

	constructor(policiesPath: string) {
		this.#policies = loadPolicies(policiesPath);
	}

	canExecute(req: CanExecuteReq): Promise<Verdict> {
		return Promise.resolve(canExecute(this.#policies, req));
	}
}
