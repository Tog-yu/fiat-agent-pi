## 4. L2 平台最小集

MVP 只做四件事：**会话工厂、权限判定、审批工单、审计落库**。

**L2 与 Pi 是双向关系，不是单向转发**：

```text
控制面（L2 → Pi）：进程内 SDK，createAgentSession / prompt / subscribe，零网络
数据面（Pi → L2）：工具执行时 HTTP 回调 canExecute / 审批 / 审计
```

Pi 的入口是 `session.prompt(text)`，**不是 HTTP 端点**，所以 L2 只能"驱动"Pi。

**审批链路**（高风险操作不返回 error，返回工单，避免 LLM 重试绕行）：

```text
dry-run → 生成 ticket（pending）→ 推 Lark 审批卡
        → 人点通过 → 签发一次性 token（带过期）
        → fiat_job_apply(ticket_id, token) → L2 再查一次 → 执行 → 写 audit
```

---

