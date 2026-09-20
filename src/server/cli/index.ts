/**
 * 业务 CLI 调度层：命令 → L2 能力。
 *
 * 所有外部依赖经 `CliDeps` 注入、IO 经 `CliIo` 注入 —— 因此整条命令链路
 * （含 exit code 与输出内容）都可以离线断言，不需要起真实服务。
 *
 * 边界：CLI 不含业务逻辑。权限看 policies、审计走 AuditReader、审批走 ApprovalService，
 * 与 Web / TUI 入口同源，避免出现「CLI 能绕过闸门」的第二套权限实现。
 */

import type { ApprovalTicketRecord } from "../approval/ticket.ts";
import type { AuditQuery, AuditReader } from "../audit/reader.ts";
import type { ToolPolicy } from "../policy/engine.ts";
import { intFlag, parseArgs } from "./args.ts";
import type { ChatFactory } from "./chat.ts";
import {
	allowedTools,
	HELP,
	renderAudit,
	renderSkills,
	renderTickets,
	renderTools,
	renderTrace,
	type TraceStatus,
} from "./commands.ts";
import type { SkillOps } from "./skills.ts";

export interface DiagnosisInput {
	title: string;
	service?: string;
	window?: string;
	detail?: string;
}

export interface CliDeps {
	policies: Map<string, ToolPolicy>;
	audit: AuditReader;
	listTickets: () => Promise<ApprovalTicketRecord[]>;
	approveTicket: (id: string) => Promise<ApprovalTicketRecord>;
	rejectTicket: (id: string, reason?: string) => Promise<ApprovalTicketRecord>;
	/** 并行告警诊断；未配置模型时为 undefined —— 该命令明确提示，而不是静默失败 */
	diagnose?: (input: DiagnosisInput) => Promise<string>;
	/**
	 * P9-49 入口切换：pi-host 驱动的交互会话（`fiat chat`）。
	 * 未配置 FIAT_MODEL 时为 undefined —— 与 diagnose 同口径明确提示。
	 */
	chat?: ChatFactory;
	/**
	 * 阶段 12 / P12-71：技能库维护（`fiat skills ...`）。
	 * 缺省时该命令明确提示「技能库未配置」，而不是静默成功。
	 */
	skills?: SkillOps;
	/**
	 * 阶段 13 / P13-81：告警 webhook 网关（`fiat gateway`）。
	 * 启动常驻进程并阻塞直至 SIGINT/SIGTERM；缺省时该命令明确提示。
	 */
	gateway?: GatewayLauncher;
	/**
	 * 阶段 14 / P14-89：全链路追踪状态（`fiat trace status`）。
	 * **离线可跑**（零 Pi 依赖、零网络）——这是它存在的意义：排查「链路为什么没数据」
	 * 时不希望再引入一个可能失败的外部依赖。缺省时该命令明确提示。
	 */
	trace?: () => TraceStatus;
}

/** 网关启动器：起 HTTP 服务并阻塞；返回进程退出码 */
export type GatewayLauncher = (opts: { verbose: boolean }) => Promise<number>;

export interface CliIo {
	out: (s: string) => void;
	err: (s: string) => void;
}

/** 返回进程退出码（0 成功 / 1 失败） */
export async function runCli(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
	const { command, positional, flags } = parseArgs(argv);

	if (command === "" || command === "help" || flags.help === "true") {
		io.out(HELP);
		return 0;
	}

	switch (command) {
		case "chat":
			return cmdChat(positional, flags, deps, io);
		case "diagnose":
			return cmdDiagnose(positional, flags, deps, io);
		case "audit":
			return cmdAudit(flags, deps, io);
		case "tickets":
			return cmdTickets(flags, deps, io);
		case "approve":
			return cmdApprove(positional, deps, io);
		case "reject":
			return cmdReject(positional, flags, deps, io);
		case "tools":
			return cmdTools(flags, deps, io);
		case "skills":
			return cmdSkills(positional, flags, deps, io);
		case "gateway":
			return cmdGateway(flags, deps, io);
		case "trace":
			return cmdTrace(positional, deps, io);
		default:
			io.err(`未知命令：${command}\n\n${HELP}`);
			return 1;
	}
}

/**
 * P9-49 入口切换：`fiat chat` —— pi-host 内嵌循环驱动的交互会话。
 *
 * 单参数模式（CI / 脚本友好）：`fiat chat "查一下返现规则"` 跑一轮即退出；
 * 交互模式（无参数）：REPL，exit / quit 退出，空行跳过。
 * `--session <path>` 继续既有会话文件。
 */
async function cmdChat(
	positional: readonly string[],
	_flags: Record<string, string>,
	deps: CliDeps,
	io: CliIo,
): Promise<number> {
	if (!deps.chat) {
		io.err("未配置模型：chat 需要起内嵌会话，请设置 FIAT_MODEL=provider/model 及对应密钥。");
		return 1;
	}
	const subject = {
		user: { id: process.env.FIAT_USER_ID ?? "cli", role: process.env.FIAT_ROLE ?? "ops" },
		environment: process.env.FIAT_ENV ?? "dev",
	};

	let session: Awaited<ReturnType<NonNullable<CliDeps["chat"]>>>;
	try {
		session = await deps.chat(subject, `chat-${Date.now()}`);
	} catch (e) {
		io.err(`会话启动失败：${errText(e)}`);
		return 1;
	}
	io.out(`会话 ${session.sessionId} 已就绪（${subject.user.role}@${subject.environment}）。exit 退出。`);

	try {
		const oneShot = positional.join(" ").trim();
		if (oneShot) {
			const r = await session.turn(oneShot);
			io.out(r.ok ? r.reply : `出错：${r.error ?? "未知错误"}`);
			return r.ok ? 0 : 1;
		}

		// 交互 REPL：readline 从 stdin 逐行读
		const readline = await import("node:readline/promises");
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		for (;;) {
			const line = (await rl.question("> ")).trim();
			if (line === "exit" || line === "quit") break;
			if (line === "") continue;
			const r = await session.turn(line);
			if (r.ok) {
				io.out(r.reply);
			} else {
				io.out(`出错：${r.error ?? "未知错误"}`);
			}
		}
		rl.close();
		return 0;
	} finally {
		session.dispose();
	}
}

async function cmdDiagnose(
	positional: readonly string[],
	flags: Record<string, string>,
	deps: CliDeps,
	io: CliIo,
): Promise<number> {
	// 允许不加引号的多词标题：`fiat diagnose 支付网关 5xx 突增`
	const title = positional.join(" ").trim();
	if (title === "") {
		io.err("用法：fiat diagnose <告警标题> [--service X] [--window Y] [--detail Z]");
		return 1;
	}
	if (!deps.diagnose) {
		io.err("未配置模型：并行诊断需要起子会话，请设置 FIAT_MODEL=provider/model 及对应密钥。");
		return 1;
	}

	const input: DiagnosisInput = { title };
	if (flags.service) input.service = flags.service;
	if (flags.window) input.window = flags.window;
	if (flags.detail) input.detail = flags.detail;

	try {
		io.out(await deps.diagnose(input));
		return 0;
	} catch (e) {
		io.err(`诊断失败：${errText(e)}`);
		return 1;
	}
}

async function cmdAudit(flags: Record<string, string>, deps: CliDeps, io: CliIo): Promise<number> {
	const q: AuditQuery = { limit: intFlag(flags, "limit", 20) };
	if (flags.tool) q.tool = flags.tool;
	if (flags.outcome) q.outcome = flags.outcome;
	if (flags.user) q.userId = flags.user;
	if (flags.env) q.environment = flags.env;
	if (flags.session) q.sessionId = flags.session;

	io.out(renderAudit(await deps.audit.query(q)));
	return 0;
}

async function cmdTickets(flags: Record<string, string>, deps: CliDeps, io: CliIo): Promise<number> {
	const all = await deps.listTickets();
	const status = flags.status;
	const rows = status ? all.filter((t) => t.status === status) : all;
	io.out(renderTickets(rows));
	return 0;
}

async function cmdApprove(positional: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
	const id = positional[0];
	if (!id) {
		io.err("用法：fiat approve <ticket_id>");
		return 1;
	}
	try {
		const t = await deps.approveTicket(id);
		io.out(`已通过：${t.ticketId} → ${t.status}`);
		return 0;
	} catch (e) {
		io.err(`通过失败：${errText(e)}`);
		return 1;
	}
}

async function cmdReject(
	positional: readonly string[],
	flags: Record<string, string>,
	deps: CliDeps,
	io: CliIo,
): Promise<number> {
	const id = positional[0];
	if (!id) {
		io.err("用法：fiat reject <ticket_id> [--reason X]");
		return 1;
	}
	try {
		const t = await deps.rejectTicket(id, flags.reason);
		io.out(`已驳回：${t.ticketId} → ${t.status}`);
		return 0;
	} catch (e) {
		io.err(`驳回失败：${errText(e)}`);
		return 1;
	}
}

async function cmdTools(flags: Record<string, string>, deps: CliDeps, io: CliIo): Promise<number> {
	const role = flags.role ?? "ops";
	const env = flags.env ?? "dev";
	io.out(renderTools(allowedTools(deps.policies, role, env)));
	return 0;
}

/**
 * 阶段 12 / P12-71：`fiat skills <子命令>`。
 * 全部离线可用（技能库在 workspace/pi-skills，不依赖模型 / Pi 运行时）。
 */
async function cmdSkills(
	positional: readonly string[],
	flags: Record<string, string>,
	deps: CliDeps,
	io: CliIo,
): Promise<number> {
	const ops = deps.skills;
	if (!ops) {
		io.err("技能库未配置：skills 需要 workspace/pi-skills 目录。");
		return 1;
	}
	const sub = positional[0] ?? "list";
	const name = positional[1];

	switch (sub) {
		case "list": {
			io.out(renderSkills(ops.list()));
			return 0;
		}
		case "curate": {
			io.out(ops.curate(flags.report).report);
			if (flags.report) io.out(`报告已写入：${flags.report}`);
			return 0;
		}
		case "pin":
		case "unpin": {
			if (!name) {
				io.err(`用法：fiat skills ${sub} <name>`);
				return 1;
			}
			const pinned = sub === "pin";
			if (!ops.setPinned(name, pinned)) {
				io.err(`技能不存在：${name}`);
				return 1;
			}
			io.out(`${name} → ${pinned ? "pinned（豁免 Curator，自进化不可改写）" : "unpinned"}`);
			return 0;
		}
		case "archive": {
			if (!name) {
				io.err("用法：fiat skills archive <name>");
				return 1;
			}
			if (!ops.archive(name)) {
				io.err(`归档失败（技能不存在或已 pinned）：${name}`);
				return 1;
			}
			io.out(`已归档（软删，可 restore）：${name}`);
			return 0;
		}
		case "restore": {
			if (!name) {
				io.err("用法：fiat skills restore <name>");
				return 1;
			}
			if (!ops.restore(name)) {
				io.err(`恢复失败（没有归档记录）：${name}`);
				return 1;
			}
			io.out(`已恢复：${name}`);
			return 0;
		}
		case "rollback": {
			if (!name) {
				io.err("用法：fiat skills rollback <name>");
				return 1;
			}
			const r = await ops.rollback(name);
			if (!r.ok) {
				io.err(r.message);
				return 1;
			}
			io.out(r.message);
			return 0;
		}
		default:
			io.err(`未知子命令：skills ${sub}\n\n可用：list / curate / pin / unpin / archive / restore / rollback`);
			return 1;
	}
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * 阶段 14 / P14-89：`fiat trace status` —— 追踪链路自检。
 * 只读本地配置 + 进程内计数，**不打网络**（离线命令的既有纪律）。
 */
function cmdTrace(positional: readonly string[], deps: CliDeps, io: CliIo): number {
	const sub = positional[0] ?? "status";
	if (sub !== "status") {
		io.err(`未知子命令：trace ${sub}\n\n可用：status`);
		return 1;
	}
	if (!deps.trace) {
		io.err("追踪未接入：CLI 启动时未装配追踪组件。");
		return 1;
	}
	io.out(renderTrace(deps.trace()));
	return 0;
}

/**
 * 阶段 13 / P13-81：`fiat gateway` —— 常驻 webhook 网关。
 * 前台跑（daemonize 不做，DEV_SPEC 阶段 13）；SIGINT/SIGTERM 优雅退出。
 */
async function cmdGateway(flags: Record<string, string>, deps: CliDeps, io: CliIo): Promise<number> {
	if (!deps.gateway) {
		io.err("网关未配置：gateway 需要 config/gateway.yaml（含 token）与 FIAT_MODEL（自动诊断）。");
		return 1;
	}
	try {
		return await deps.gateway({ verbose: flags.verbose === "true" });
	} catch (e) {
		io.err(`网关启动失败：${errText(e)}`);
		return 1;
	}
}
