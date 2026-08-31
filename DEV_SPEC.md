# fiat-agent DEV SPEC（执行版）

> **定位**：这是 **执行文档**，唯一任务状态源。任务做完直接改这里的 checkbox。
> **设计文档**在 Obsidian：`法币 agent/法币定制 Agent DEV_SPEC（Pi 版）.md`（why / 架构细节 / 骨架代码 / 踩坑清单）。
> 两份有冲突时，以本文档的任务状态为准；设计 rationale 以 Obsidian 那份为准。
>
> 配套架构文档：Obsidian `法币 agent/法币定制 Agent 技术方案.md`（三层架构、选型权衡、L2/Pi 拓扑）。

---

## 1. 定位

`fiat-agent` = 面向法币业务的内部 Agent，基于 **Pi Agent Runtime** 二次开发。

三层，Pi 核心零改动：

```text
L2  Fiat Platform      自研：Auth/RBAC · Approval · Audit · Workflow · PG · Fastify
L1  Fiat Extension     自研：fiat-tools · mcp-rag · permission-gate · model-router · audit-hook
L0  Pi Runtime         复用：agent-loop · context · compaction · session tree · 4 种模式
```

**L1 是插件，L2 是后端服务，两码事。**

| | L1 扩展 | L2 平台 |
|---|---|---|
| 形态 | 插件，跑在 Pi 进程里 | 独立后端服务 |
| 数据库 | 没有 | PostgreSQL + Redis |
| 说了算 | **不能** | 能 |
| 类比 | 前台服务员 | 后台财务 + 风控 + 审计 |

必须分开的理由：L1 跑在 LLM 那一侧，权限判定放那儿可能被 prompt 注入影响；TUI 场景下 L1 在用户机器上、权限数据在服务器上。**判定必须放在 LLM 够不着的那一侧。**

---

## 2. 环境与 workspace

```text
Node >= 22.19        Pi 的 engines 硬要求
pnpm / npm workspace
TypeScript 5.9       Pi 用 tsgo 做类型检查
```

仓库布局（决策：workspace 在仓库内）：

```text
fiat-agent/
  package.json                  # 开发期 file: 依赖本地 Pi；稳定后切 npm 正式版
  workspace/                    # Pi 的 cwd，随仓库走
    AGENTS.md                   # 业务规则 / 术语 / 环境说明（Pi 自动注入上下文）
    .pi/
      settings.json
      extensions -> ../pi-extensions
      skills     -> ../pi-skills
    pi-extensions/
    pi-skills/
  src/server/                   # L2 Fastify 平台服务
  docs/
```

软链命令（写进 `scripts/setup.sh`）：

```bash
cd workspace/.pi && ln -s ../pi-extensions extensions && ln -s ../pi-skills skills
```

开发者入口（决策：MVP 保留 Pi 内置 TUI，不自写 CLI）：

```bash
cd fiat-agent/workspace && pi -e ./pi-extensions/index.ts
```

**硬约束：不在 Pi fork 里改任何一行核心代码。** 遇到缺口优先用 extension 解决，解决不了就在 L2 层绕开。

---

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

## 6. 数据流

**RAG 问答**：用户输入 → `before_agent_start`（选模型 + 注入 system prompt）→ `mcp_rag_query` → `tool_call` 校验 L0 + 覆写 collection → MCP callTool → 解析引用 → 写审计 → 生成带引用的回答。

**返现对账 → 审批**：解析（L3）→ 对账 dry-run（L3）→ 规则引擎算差异 → `apply` 触发 L4 → 返回工单（`isError: false`，不重试）→ Lark 审批 → token → `fiat_job_apply` → 服务端再校验 → 执行 → 审计。

---

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

## 8. 分阶段任务清单

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。

改 checkbox 就是改进度。跑 `node .pi/skills/auto-coder/scripts/sync_spec.mjs --force` 可重新生成 references 与进度摘要。

### 阶段 0：跑通骨架（验收：`pi -e` 能起，能问一句答一句）

- [x] P0-1 建 `fiat-agent-pi/` 仓库（TS 版，与已完成的 Python 版并存），`file:` 依赖本地 Pi，迁入 `config/*.yaml`
- [x] P0-2 `workspace/` + `AGENTS.md` + `.pi/` 软链
- [x] P0-5 装依赖并打通运行时：确认 `npm install --ignore-scripts --legacy-peer-deps` 后能 `import` Pi（运行时走 `tsconfig.runtime.json` → `pi/packages/*/src`；类型检查走各包 `dist/*.d.ts`，由本地 `tsgo -p tsconfig.build.json --emitDeclarationOnly --noEmitOnError false` 生成，gitignored，不动源码）
- [x] P0-3 写一个 hello 级扩展，`pi -e` 验证加载链路
- [x] P0-4 用 faux provider 跑一条会话单测

### 阶段 1：RAG 问答（验收：能带引用回答法币业务问题）

- [x] P1-5 `mcp-rag` extension + stdio transport
- [x] P1-6 **先只接一个工具跑通 `Type.Unsafe` 转换**，再铺开三个
- [x] P1-7 降级与错误表实现
- [x] P1-8 `mcp_rag.*` 三个工具注册 + promptSnippet

### 阶段 2：权限与审计（验收：ops 角色看不到也调不动生产写工具）

- [x] P2-9 `permission-gate` + L2 `canExecute`
- [x] P2-10 `session-factory` 按角色裁剪工具集
- [x] P2-11 `audit-hook` + PG 审计表
- [x] P2-12 三道闸门的集成测试

### 阶段 3：告警与测试环境（验收：能查日志、能建测试账号）

- [x] P3-13 `fiat_es_search_logs` / `fiat_db_query_*` / `fiat_lark_send`
- [x] P3-14 `fiat_test_*` 测试环境工具
- [x] P3-15 告警诊断 skill

### 阶段 4：返现与物流 dry-run（验收：生成差异清单与变更计划，不改数据）

- [x] P4-16 `fiat_cashback_parse` / `fiat_cashback_reconcile`
- [x] P4-17 `fiat_logistics_parse` / `fiat_logistics_validate`
- [x] P4-18 L2 workflow 状态机 + 规则引擎

### 阶段 5：审批与生产写（验收：完整走通 dry-run → 工单 → 审批 → 执行 → 审计）

- [x] P5-19 approval ticket + 一次性 token + 幂等键
- [x] P5-20 `fiat_job_apply`
- [x] P5-21 Lark 审批卡片
- [x] P5-22 审计后台

### 阶段 6（之后）

- [x] P6-23 RAG server 补 streamable-http 入口 → 配置切 http
- [x] P6-24 `model-router`
- [ ] P6-25 多 agent 并行告警诊断
- [ ] P6-26 业务 CLI / Web Console
- [ ] P6-27 Pi harness 迁移跟进 → 评估 `PostgresSessionRepo`

---

## 9. 约束与踩坑

**铁律**：

1. 不改 Pi 核心（`packages/*/src`）一行代码。
2. 不把权限判定只放在 `tool_call` block —— 它只是第一道。
3. 高风险操作不返回 error，返回工单。
4. LLM 不参与金额计算、状态机判断、字段校验。

**踩坑**：

| 坑 | 说明 | 处置 |
|---|---|---|
| `block` 不是抛异常 | 回灌 `isError` 文本，模型看得到并可能重试 | 服务端 `canExecute` 才是边界 |
| `before_agent_start` 的 systemPrompt 只管一轮 | `agent-session.ts:1154`，finally 里清空 | 每轮重算 |
| stdout 污染 | stdio 下 server 的 stdout 只能走 JSON-RPC | `stderr: "pipe"` |
| 重型资源每进程一份 | RAG server 的 `_tool_instance` 是进程级单例 | 多会话切 http |
| 扩展路径只递归一层 | `loader.ts:614` | 目录保持扁平 |
| Pi 内置工具默认启用 | read/bash/edit/write | 务必传 `noTools: "builtin"` |
| `agentDir` 默认 `~/.pi/agent` | 与个人 Pi 配置混杂 | 显式传独立 `agentDir` |
| **`npm install` 必加 `--legacy-peer-deps`** | npm 10.9.7 解析 vitest 4.1.9 的可选 peer deps 时崩溃（`Cannot read properties of null (reading 'edgesOut')`，堆栈指向 `#loadPeerSet`） | 安装命令固定为 `npm install --ignore-scripts --legacy-peer-deps` |
| **跑 `npm run build` 会污染 pi 工作区** | build 的 `generate-models` 步骤从 OpenRouter 拉最新模型列表并**回写** `packages/ai/src/**/*.models.ts`（实测改写 **29 个**已跟踪文件） | 非必要不 build。恢复必须用精确路径：`git diff --name-only -- packages/ai/src/ \| while IFS= read -r f; do git checkout -- "$f"; done`。**切勿 `git checkout .`** —— 恢复期间实测有另一个 pi session 正在改 `packages/coding-agent/src/core/extensions/types.ts`，无差别恢复会毁掉别人的工作 |
| **本地 pi 源码 build 不过** | `packages/ai` 有 3 个既有类型错误（cloudflare-ai-gateway.ts:18、opencode-go.ts:8、opencode.models.ts:804），非我们引入 | 开发期绕开 dist，用 tsx + tsconfig paths 直连源码 |

**Git 纪律**（多 pi session 并行时尤其重要）：

1. 禁止 `git add -A` / `git add .` / `git add -u`，只 `git add <明确路径>`。
2. 禁止 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `--no-verify`。
3. 只提交本会话改的文件，提交前跑 `git status` 确认。
4. 提交格式：`{feat,fix,docs,chore,test,refactor}[(scope)]: <msg>`，带任务 ID。
