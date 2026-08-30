/**
 * 返现 dry-run 业务层（P4-16 / P4-18）。
 *
 * 纯函数、无 IO、不改数据：parse → reconcile → buildChangePlan。
 * 真实 L2 的 HttpFiatClient 调 fiat_cashback_parse / fiat_cashback_reconcile 时，
 * 直接复用这里的逻辑（MVP 用 LocalFiatClient stub，逻辑先就位）。
 */

export interface CashbackRow {
	orderId: string;
	userId: string;
	amount: number;
	currency: string;
}

export interface CashbackSystemRecord {
	orderId: string;
	expectedAmount: number;
	status: string;
}

export type CashbackDiff =
	| { kind: "amount_mismatch"; orderId: string; csvAmount: number; sysAmount: number; delta: number }
	| { kind: "missing_in_system"; orderId: string; csvAmount: number }
	| { kind: "missing_in_csv"; orderId: string; sysAmount: number };

export interface ChangePlan {
	generatedAt: string;
	diffs: CashbackDiff[];
	summary: {
		amountMismatch: number;
		missingInSystem: number;
		missingInCsv: number;
		totalDelta: number;
	};
}

function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

function delimiter(format?: string): string {
	return format === "tsv" ? "\t" : ",";
}

/** 解析 CSV/TSV 为结构化记录；缺字段/金额非法 → 抛错（LLM 不参与字段校验，校验在此） */
export function parseCashbackCsv(text: string, format?: string): CashbackRow[] {
	const lines = splitLines(text);
	if (lines.length < 2) return [];
	const sep = delimiter(format);
	const header = lines[0].split(sep).map((h) => h.trim());
	const idx = (name: string) => header.indexOf(name);
	const [o, u, a, c] = [idx("order_id"), idx("user_id"), idx("amount"), idx("currency")];
	if (o < 0 || u < 0 || a < 0 || c < 0) {
		throw new Error(`返现表格缺少必需列（需 order_id,user_id,amount,currency），实际: ${header.join(",")}`);
	}
	const rows: CashbackRow[] = [];
	for (const line of lines.slice(1)) {
		const cols = line.split(sep);
		const amount = Number.parseFloat(cols[a] ?? "");
		if (!Number.isFinite(amount) || amount < 0) {
			throw new Error(`返现金额非法: order_id=${cols[o]} amount=${cols[a]}`);
		}
		rows.push({ orderId: cols[o], userId: cols[u], amount, currency: cols[c] || "USD" });
	}
	return rows;
}

/** 对账：csv vs 系统记录，产出差异清单（不改数据） */
export function reconcileCashback(csv: CashbackRow[], sys: CashbackSystemRecord[]): CashbackDiff[] {
	const sysMap = new Map(sys.map((r) => [r.orderId, r]));
	const csvMap = new Map(csv.map((r) => [r.orderId, r]));
	const diffs: CashbackDiff[] = [];

	for (const row of csv) {
		const rec = sysMap.get(row.orderId);
		if (!rec) {
			diffs.push({ kind: "missing_in_system", orderId: row.orderId, csvAmount: row.amount });
			continue;
		}
		if (Math.abs(rec.expectedAmount - row.amount) > 1e-9) {
			diffs.push({
				kind: "amount_mismatch",
				orderId: row.orderId,
				csvAmount: row.amount,
				sysAmount: rec.expectedAmount,
				delta: row.amount - rec.expectedAmount,
			});
		}
	}
	for (const rec of sys) {
		if (!csvMap.has(rec.orderId)) {
			diffs.push({ kind: "missing_in_csv", orderId: rec.orderId, sysAmount: rec.expectedAmount });
		}
	}
	return diffs;
}

/** 差异清单 → 变更计划（只读汇总，供人工审批） */
export function buildChangePlan(diffs: CashbackDiff[], generatedAt = new Date().toISOString()): ChangePlan {
	const summary = {
		amountMismatch: 0,
		missingInSystem: 0,
		missingInCsv: 0,
		totalDelta: 0,
	};
	for (const d of diffs) {
		if (d.kind === "amount_mismatch") {
			summary.amountMismatch++;
			summary.totalDelta += d.delta;
		} else if (d.kind === "missing_in_system") {
			summary.missingInSystem++;
			summary.totalDelta += d.csvAmount;
		} else {
			summary.missingInCsv++;
			summary.totalDelta -= d.sysAmount;
		}
	}
	return { generatedAt, diffs, summary };
}
