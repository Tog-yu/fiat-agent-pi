## 5. 配置设计

```yaml
mcp_servers:
  rag:
    transport: stdio            # MVP；切 http 只改这一行
    cwd: ../MODULAR-RAG-MCP-SERVER
    command: python
    args: ["-m", "src.mcp_server.server"]
    # transport: http
    # url: http://rag-mcp.internal:8000/mcp
    # token_env: FIAT_RAG_MCP_TOKEN

models:
  routes:
    rag_qa: fiat-gateway/lite
    alert_diagnosis: fiat-gateway/pro
    cashback_reconcile: fiat-gateway/structured
```

**RAG MCP transport**：目标是 streamable-http，MVP 先 stdio（配置一行切换）。理由见技术方案的 transport 章节——RAG server 的重型资源是**进程级单例**，多会话 stdio = N 份索引。

---

