## 3. L1 扩展实现清单

**性质列是阶段 9 的分流依据**（2026-09-04 晚实测：统计各扩展的 `pi.on(...)` 事件与 `defineTool` / `registerTool` 定义数）。原表仅列 5 项，此处补齐目录中实际存在的 7 个：

| 扩展 | 职责 | 挂的事件 | 注册工具 | 性质 | 优先级 |
|---|---|---|---|---|---|
| `permission-gate` | 工具调用拦截 + collection 覆写 | `tool_call` | — | **钩子型** → L1a 内建 extension | P0 |
| `audit-hook` | 把轨迹推给 L2 Audit | `tool_result` | — | **钩子型** → L1a | P1 |
| `model-router` | 按任务类型选模型 | `before_agent_start` | — | **钩子型** → L1a | P1 |
| `mcp-rag` | MCP client 桥 | — | `mcp_rag.*` | **工具型** → L1b 工具模块 | P0 |
| `fiat-tools` | 业务工具集 | — | `fiat_cashback_reconcile` | **工具型** → L1b | P0 |
| `job-apply` | 执行已审批工单（P5-20） | — | `fiat_job_apply` | **工具型** → L1b | P0 |
| `alert-fanout` | 并行告警诊断（P6-25） | — | `fiat_alert_diagnosis` | **工具型** → L1b | P1 |

> ⚠️ **不可望文生义**：`alert-fanout` 名字像事件钩子，实测是**纯工具**（零 `pi.on`、单个 `defineTool`）——「fanout」指 L2 侧 `diagnosis/{plan,fanout}.ts` 的并发编排，而 L1 侧只注册 `fiat_alert_diagnosis` 一个工具并渲染报告。分流时以实测性质为准，不以命名为准。

**分流原则**：挂了 `pi.on(...)` 且零工具定义的 → 保留为内建 extension（L1a）；只 `registerTool` 且零事件的 → 改写为工具模块（L1b）。理由见 §2.5「关键修正·二次」——钩子依赖 Pi agent-loop 的既有语义（如 `tool_call` 的 `{ block: true, reason }` 短路回灌），宿主层自研要重造，代价远高于复用。

**签名约定**：Pi 扩展签名固定为 `(pi) => void`，不接收参数；但扩展需要 platform / policy / audit client。统一写成**工厂的工厂**：

```ts
export function createFiatTools(deps: FiatDeps) {
  return (pi: ExtensionAPI) => { /* 注册工具 */ };
}
```

Web 场景注入进程内直连 client（零网络），TUI 场景注入 HTTP client，测试注入 mock。

**工具 schema 是 TypeBox，不是 Pydantic。** 工具集按风险分级，ops 角色看不到 `fiat_job_apply`。

**权限三道闸门**：

| 闸门 | 时机 | 说明 |
|---|---|---|
| ① 会话级工具裁剪 | `createAgentSession({ tools })` | 模型根本看不到 |
| ② `tool_call` block | 调用前 | **回灌 isError 文本，模型可能重试，只是第一道** |
| ③ 服务端 `canExecute` | 执行前最后一查 | **唯一权威** |

---

