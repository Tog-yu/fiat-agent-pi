## 3. L1 扩展实现清单

| 扩展 | 职责 | 优先级 |
|---|---|---|
| `permission-gate` | 工具调用拦截 + collection 覆写 | P0 |
| `mcp-rag` | MCP client 桥，注册 `mcp_rag.*` 工具 | P0 |
| `fiat-tools` | 业务工具集 | P0 |
| `model-router` | 按任务类型选模型 | P1 |
| `audit-hook` | 把轨迹推给 L2 Audit | P1 |

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

