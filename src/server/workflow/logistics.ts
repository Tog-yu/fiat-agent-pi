/**
 * 物流 dry-run 业务层（P4-17 / P4-18）。
 *
 * 纯函数、无 IO、不改数据：parse → validate（必填字段 / 状态合法性）。
 */

export interface LogisticsRow {
	shipmentId: string;
	carrier: string;
	status: string;
	eta: string;
}

export type LogisticsSeverity = "warn" | "error";

export interface LogisticsIssue {
	shipmentId: string;
	field: string;
	message: string;
	severity: LogisticsSeverity;
}

const VALID_STATUSES = new Set(["created", "picked", "in_transit", "delivered", "returned", "exception"]);

/** 解析 CSV/TSV 物流表格 */
export function parseLogisticsCsv(text: string, format?: string): LogisticsRow[] {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length < 2) return [];
	const sep = format === "tsv" ? "\t" : ",";
	const header = lines[0].split(sep).map((h) => h.trim());
	const idx = (name: string) => header.indexOf(name);
	const [s, c, st, e] = [idx("shipment_id"), idx("carrier"), idx("status"), idx("eta")];
	if (s < 0 || c < 0 || st < 0 || e < 0) {
		throw new Error(`物流表格缺少必需列（需 shipment_id,carrier,status,eta），实际: ${header.join(",")}`);
	}
	return lines.slice(1).map((line) => {
		const cols = line.split(sep);
		return { shipmentId: cols[s], carrier: cols[c], status: cols[st], eta: cols[e] };
	});
}

/** 校验：必填字段 + 状态合法性；返回问题清单（error 级阻断后续变更计划） */
export function validateLogistics(rows: LogisticsRow[]): LogisticsIssue[] {
	const issues: LogisticsIssue[] = [];
	for (const r of rows) {
		if (!r.shipmentId)
			issues.push({ shipmentId: r.shipmentId || "?", field: "shipment_id", message: "运单号缺失", severity: "error" });
		if (!r.carrier)
			issues.push({ shipmentId: r.shipmentId, field: "carrier", message: "承运商缺失", severity: "error" });
		if (!VALID_STATUSES.has(r.status)) {
			issues.push({
				shipmentId: r.shipmentId,
				field: "status",
				message: `非法状态: ${r.status}（允许: ${[...VALID_STATUSES].join(",")}）`,
				severity: "error",
			});
		}
		if (r.status === "delivered" && !r.eta) {
			issues.push({ shipmentId: r.shipmentId, field: "eta", message: "已送达但缺 ETA", severity: "warn" });
		}
	}
	return issues;
}
