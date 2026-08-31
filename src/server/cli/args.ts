/**
 * 业务 CLI 参数解析（纯函数，可离线测）。
 *
 * 约定：`fiat <command> [positional...] [--flag value | --flag=value]`
 *   - 第一个裸词是 command，其余是 positional
 *   - `--k v` 与 `--k=v` 都支持；`--k` 后无值（或后接另一个 `-` 开头）则记为 "true"
 *   - 未识别的短选项（`-x`）忽略，不因拼错就整条命令失败
 */

export interface ParsedArgs {
	command: string;
	/** command 之后的裸词 */
	positional: string[];
	flags: Record<string, string>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	let command = "";

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === undefined) continue;

		if (token.startsWith("--")) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				flags[body.slice(0, eq)] = body.slice(eq + 1);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				flags[body] = next;
				i += 1;
			} else {
				flags[body] = "true";
			}
			continue;
		}

		if (token === "-h") {
			flags.help = "true";
			continue;
		}
		if (token.startsWith("-")) continue;

		if (command === "") command = token;
		else positional.push(token);
	}

	return { command, positional, flags };
}

/** 取整数 flag，非法或缺失时回退默认值（不让一个拼错的参数把命令搞崩） */
export function intFlag(flags: Record<string, string>, key: string, fallback: number): number {
	const raw = flags[key];
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}
