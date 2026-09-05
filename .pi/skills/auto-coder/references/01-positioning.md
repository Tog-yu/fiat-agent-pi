## 1. 定位

`fiat-agent` = 面向法币业务的内部 Agent，基于 **Pi Agent Runtime** 二次开发。

三层，Pi 核心零改动：

```text
L2  Fiat Platform      自研：Auth/RBAC · Approval · Audit · Workflow · PG · Fastify
L1  Fiat Extension     自研：3 内建 extension（permission-gate · audit-hook · model-router）+ 4 工具模块（mcp-rag · fiat-tools · job-apply · alert-fanout）
L0  Pi Runtime         复用：agent-loop · context · compaction · session tree · 4 种模式
```

**L1 是内建扩展 + 工具模块（编译期注入 / 直接注册进内嵌循环），L2 是后端服务，两码事。**

| | L1 扩展 | L2 平台 |
|---|---|---|
| 形态 | 内建 extension（extensionFactories 注入）+ 工具模块（注册进内嵌循环），跑在 Pi 进程里 | 独立后端服务 |
| 数据库 | 没有 | PostgreSQL + Redis |
| 说了算 | **不能** | 能 |
| 类比 | 前台服务员 | 后台财务 + 风控 + 审计 |

必须分开的理由：L1 跑在 LLM 那一侧，权限判定放那儿可能被 prompt 注入影响；TUI 场景下 L1 在用户机器上、权限数据在服务器上。**判定必须放在 LLM 够不着的那一侧。**

---

