## 6. 数据流

**RAG 问答**：用户输入 → `before_agent_start`（选模型 + 注入 system prompt）→ `mcp_rag_query` → `tool_call` 校验 L0 + 覆写 collection → MCP callTool → 解析引用 → 写审计 → 生成带引用的回答。

**返现对账 → 审批**：解析（L3）→ 对账 dry-run（L3）→ 规则引擎算差异 → `apply` 触发 L4 → 返回工单（`isError: false`，不重试）→ Lark 审批 → token → `fiat_job_apply` → 服务端再校验 → 执行 → 审计。

---

