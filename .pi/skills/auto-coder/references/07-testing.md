## 7. 测试方案

Pi 扩展可**完全离线单测**，不需要真实 API key：

```text
registerFauxProvider()   @earendil-works/pi-ai/compat   假 provider
fauxToolCall(name, args) 构造工具调用响应
SessionManager.inMemory()                               内存会话
DefaultResourceLoader({ extensionFactories: [...] })     直接注入扩展，免磁盘文件
```

参考：`packages/coding-agent/test/agent-session-dynamic-tools.test.ts`。

| 层 | 测什么 | 怎么测 |
|---|---|---|
| 纯函数 | canExecute 判定、金额/状态机规则 | vitest 单测 |
| 扩展 | 工具注册、tool_call 拦截、collection 覆写 | faux provider + inMemory session |
| MCP 桥 | tools/list → 注册、降级路径 | mock MCP client |
| 平台 | API、审批流转、审计写入 | Fastify inject |

---

