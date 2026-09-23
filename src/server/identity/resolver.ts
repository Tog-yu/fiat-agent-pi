/**
 * identity/resolver —— 可信身份的解析层（P15-101 / 设计文档 §3-L0）。
 *
 * 为什么要把「读一个环境变量」做成独立模块：因为**身份是隔离方案的钥匙**，而钥匙
 * 缺失或取值错误的失效方式恰恰是最隐蔽的一类 —— 不报错，只让所有人的记忆并进同一个
 * 分区。现状的 `FIAT_USER_ID ?? "cli"` 就是这个坑：多租户下全员变成 `cli`，
 * 隔离在纸面上成立、运行时失效（等价于 mem0「不传 user_id 静默 fallback 到 default」）。
 *
 * 三条规则：
 *
 * 1. **只从可信侧取身份**。优先级：调用方传入的已鉴权身份（服务端从 JWT 解出）>
 *    OS 登录名（显式配置 `FIAT_IDENTITY_SOURCE=os`）> 环境变量。CLI 参数与请求体里的
 *    `user_id` **一律不认** —— 它们与客户端传参等价，都是不可信输入。
 * 2. **多租户禁止静默 fallback**。`FIAT_MEMORY_MULTI_TENANT=1` 时解析不出身份 →
 *    抛 `IdentityUnavailableError`，由入口层拒绝会话。这是刻意选的：宁可起不来，
 *    不要带着「全员共用一个分区」的假隔离跑。
 * 3. **不做权限判定**。本模块只回答「这个 id 是不是可信的」；能不能干什么归闸门③
 *    （`policy/engine.ts`）—— 职责不重叠（与 L0 设计口径一致）。
 *
 * 缺省行为与改造前**逐字节一致**（`FIAT_USER_ID ?? "cli"`）：两个开关都不配时，
 * 现有测试与本地开发零感知。
 *
 * P15-104（设计文档 §2.4）在此加了两条哨兵语义，见 `IDENTITY_SENTINEL`：
 * ① 值层面：`FIAT_USER_ID=cli` 被当作「没配」（多租户下据此拒绝）；
 * ② 边界层面：`assertNotSentinelIdentity()` 供存储边界调用，拒收哨兵身份。
 */

import { userInfo } from "node:os";

/** 身份来源（进审计 / 日志，用于回答「这个 id 是怎么来的」） */
export type IdentitySource = "token" | "os" | "env" | "cli";

export interface ResolvedIdentity {
	id: string;
	source: IdentitySource;
}

/** 多租户模式下解析不出可信身份 —— 入口层据此**拒绝会话**，不是 fallback */
export class IdentityUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityUnavailableError";
	}
}

export interface IdentityResolveInput {
	/**
	 * 调用方**已鉴权**的身份（服务端形态：网关从 JWT 解出后传入，优先级最高）。
	 * 传进来的值被本模块视为可信 —— 因此调用方必须先完成鉴权，且**必须覆盖**
	 * 客户端传入的 id（Dify 的规矩：无条件信任客户端 id 等于猜 id 越好权）。
	 */
	trustedId?: string;
}

/** 多租户开关：置 `1` 打开「解析不出身份就拒绝会话」 */
const MULTI_TENANT_ENV = "FIAT_MEMORY_MULTI_TENANT";
/** 显式身份（单人本地部署的稳定 id） */
const USER_ID_ENV = "FIAT_USER_ID";
/** 取值来源：`env`（缺省）/ `os` */
const SOURCE_ENV = "FIAT_IDENTITY_SOURCE";

/**
 * 哨兵值（P15-104，设计文档 §2.4）：`"cli"` **只表示「没配」**，
 * 不是一个叫 `cli` 的真实用户。
 *
 * 为什么必须能被识别出来：坑不在「有默认值」，而在**默认值一旦被持久化，
 * 就再也无法与真值区分**。`FIAT_USER_ID=cli` 写进 `.env` 之后，它从哨兵
 * 变成了「一个叫 cli 的真身份」，多租户 fail-fast 再也拦不住 —— 整条链上
 * 没有任何一步会报错，只是所有人静默并进同一个分区。
 *
 * 命名参照 hermes 的 `_DEFAULT_USER_ID`（其解析时主动把该值还原成「没配」）。
 */
export const IDENTITY_SENTINEL = "cli";

/** 值层面判定：这个 id 是不是哨兵本身（与来源无关） */
export function isSentinelIdentity(id: string): boolean {
	return id.trim() === IDENTITY_SENTINEL;
}

/**
 * 边界层面拒收哨兵身份（P15-104，设计文档 §2.4「方案一」）。
 *
 * 与 `isSentinelIdentity` 的分工：那个是纯判据，这个是**守卫**，放在存储边界
 * 之前。只在多租户下生效 —— 单人本地部署里 `cli` 就是本人，拒它没有意义
 * （那样会把「本地开发」这条路径一起堵死）。
 *
 * 为什么连 `trustedId` / OS 登录名也要过这一关：多租户下三者都叫 `cli` 时
 * 无法区分「哨兵」与「真有个用户叫 cli」，而这种歧义正是 §2.4 要消灭的东西。
 * 宁可让运维显式改一个 id，也不要让隔离在「看起来配好了」的状态下失效。
 */
export function assertNotSentinelIdentity(
	id: string,
	env: NodeJS.ProcessEnv = process.env,
	context = "记忆写入",
): void {
	if (!isMultiTenantMemory(env)) return;
	if (!isSentinelIdentity(id)) return;
	throw new IdentityUnavailableError(
		`${context}拒收哨兵身份 ${JSON.stringify(IDENTITY_SENTINEL)}：多租户模式（${MULTI_TENANT_ENV}=1）下` +
			`它被视为「未配置」，不是一个真实身份。默认值被持久化后无法与真值区分，` +
			`继续放行会让所有调用方并进同一个分区且不报错。请提供一个真实 id。`,
	);
}

/** 多租户模式（缺省关 = 本地单人部署，行为与改造前一致） */
export function isMultiTenantMemory(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[MULTI_TENANT_ENV] === "1";
}

/**
 * 解析当前进程的会话身份。
 *
 * `env` / `osUser` 可注入只为测试 —— 生产一律用默认值（`process.env` / `os.userInfo`）。
 * 把 `os.userInfo()` 做成参数是因为它在容器 / 无 passwd 条目的环境里会抛。
 */
export function resolveIdentity(
	input: IdentityResolveInput = {},
	env: NodeJS.ProcessEnv = process.env,
	osUser: () => string = defaultOsUser,
): ResolvedIdentity {
	const trusted = input.trustedId?.trim();
	if (trusted) return { id: trusted, source: "token" };

	const multiTenant = isMultiTenantMemory(env);
	const preferOs = (env[SOURCE_ENV] ?? "").trim() === "os";

	if (preferOs) {
		const name = osUser().trim();
		if (name) return { id: name, source: "os" };
		// 显式要求 OS 身份却拿不到：多租户下直接拒绝，不猜、也不回落到环境变量
		if (multiTenant) {
			throw new IdentityUnavailableError(
				`${SOURCE_ENV}=os 但取不到 OS 登录名；多租户模式（${MULTI_TENANT_ENV}=1）下拒绝会话。`,
			);
		}
	}

	const fromEnv = (env[USER_ID_ENV] ?? "").trim();
	// P15-104（设计文档 §2.4「方案二」）：哨兵值**在值层面**就被当作「没配」。
	// 多租户下据此拒绝（下方分支），单人本地部署下与改造前的 `?? "cli"` 完全等价
	// —— 因为回落到哨兵本身就返回同一个值，逐字节一致。
	if (isSentinelIdentity(fromEnv)) {
		if (multiTenant) {
			throw new IdentityUnavailableError(
				`${USER_ID_ENV}=${IDENTITY_SENTINEL} 被视为「未配置」：${IDENTITY_SENTINEL} 是哨兵值，` +
					`不是一个真实身份。多租户模式（${MULTI_TENANT_ENV}=1）下请显式配置真实 id，` +
					"或置 FIAT_IDENTITY_SOURCE=os / 由入口传入已鉴权身份。",
			);
		}
	} else if (fromEnv) {
		return { id: fromEnv, source: "env" };
	}

	if (multiTenant) {
		throw new IdentityUnavailableError(
			`多租户模式（${MULTI_TENANT_ENV}=1）下未提供可信身份：请设置 ${USER_ID_ENV}、` +
				`或置 ${SOURCE_ENV}=os、或由入口传入已鉴权身份。拒绝 fallback 到 "cli"。`,
		);
	}

	// 单人本地部署：保持改造前行为（等价于 `FIAT_USER_ID ?? "cli"`）
	return { id: IDENTITY_SENTINEL, source: "cli" };
}

function defaultOsUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}
