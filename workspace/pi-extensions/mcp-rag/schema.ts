/**
 * schema.ts — MCP JSON Schema → TypeBox TSchema。
 *
 * Pi 的工具 schema 最终会被 JSON.stringify 成 JSON Schema 发给 provider，
 * 所以直接把 MCP 的 inputSchema 作为原生 schema 挂到 TUnsafe 上是可行的；
 * 但必须先经一个工具端到端实测（P1-6），再铺开。
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";

/** MCP 规范要求 inputSchema 是 JSON Schema object；防御性兜底为空对象 */
export function mcpSchemaToTypeBox(inputSchema: unknown): TSchema {
	if (
		typeof inputSchema === "object" &&
		inputSchema !== null &&
		(inputSchema as { type?: unknown }).type === "object"
	) {
		// Type.Unsafe 原样保留传入 schema 的属性（type/properties/required…）
		return Type.Unsafe<Record<string, unknown>>(inputSchema as Parameters<typeof Type.Unsafe>[0]);
	}
	return Type.Object({});
}
