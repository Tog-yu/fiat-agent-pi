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
  package.json                  # Pi 依赖：开发期 file: 链接本地 Pi；阶段 7 起切 registry 精确钉版本（见 §2.5）
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

### §2.5 Pi 依赖策略：对标 OpenClaw，从「本地源码链接」切到「registry 钉版本」

**参照物**：OpenClaw v2026.5.27（Pi 仍是核心 runtime 的最后一版，`git tag v2026.5.27`，commit `27ae826f`）。

OpenClaw 的 Pi 用法可拆成三层，逐层判断该不该学：

| 维度 | OpenClaw (v2026.5.27) | fiat-agent-pi 现状 | 改造目标 |
|---|---|---|---|
| Pi 来源 | registry **精确钉版本** `0.75.5`（无 `^`） | `file:../pi/packages/*`（本地 0.80.3，分支 `mydev`，工作区 dirty） | registry **精确钉版本** `0.80.3` |
| Pi 源码是否在场 | 否（黑盒 `dist`） | 是（依赖 sibling `pi/` 仓库） | 否 |
| 宿主层 | 自建 `pi-embedded`：session 生命周期 / provider 错误兜底 / 消息去重 / 图片清洗 / thinking / 事件扇出 / bootstrap context | 散落在 `src/server/diagnosis/sessionRunner.ts` | 内聚为 `src/server/pi-host/`，两条入口共用 |
| 是否改 Pi 内部 | 绝不（549 处 import，零 patch） | 铁律禁止（§9） | **结构性**禁止（源码不在场，改不了） |

**已确认的三个决策**（2026-09-04）：① 钉 **0.80.3**；② **接受**失去 step-debug 进 Pi 源码的能力；③ **接受重写 L1**（放弃 Pi **扩展加载器**，改为内嵌 Pi runtime）。

> ⚠️ **决策③ 口径更正（2026-09-04 晚，复核 OpenClaw 源码后）**：放弃的是**扩展加载器**（目录自动发现 + `pi -e` 热加载），**不是 `ExtensionAPI` 钩子通道**。阶段 8 须**保留 `extensionFactories` 注入通道**，把「循环内钩子」继续做成内建 extension——OpenClaw 自身正是这么做的。详见下方「关键修正·二次」。

**学什么（三层全学）**：

- ✅ **学「依赖纪律」**：精确钉版本、不带 `^`、Pi 源码不入场。收益有四：
  1. 构建可复现，CI 可在无 `../pi` 的干净机器跑；
  2. 顺带消掉 §9 两个既有硬伤——`npm run build` 会回写污染 pi 工作区（29 个已跟踪文件）、本地 pi 源码 `packages/ai` 有 3 个既有类型错误 build 不过；
  3. 让「不改 Pi 核心」从**纪律**升级为**结构约束**（源码不在场，想改也改不了）；
  4. 与 OpenClaw 同构，后续对齐上游心智负担更低。

- ✅ **学「宿主层内聚」**：把宿主职责收进 `src/server/pi-host/`，对标 `pi-embedded`。fiat **已有胚胎**——`diagnosis/sessionRunner.ts` 已在用 `createAgentSessionServices` / `createAgentSessionRuntime` / `SessionManager.inMemory()` 在进程内驱动 Pi，只需抽出并让 **L2 server** 与 **CLI** 两条入口共用。

- ✅ **学「弃用扩展加载器，内嵌 Pi runtime」→ 重写 L1**（决策③，口径见上方更正）。fiat 现有 L1 七个扩展建在 `defineTool` / `ExtensionAPI` + `pi -e` 加载器之上。重写时**必须按性质分两类，不可一刀切**（已逐个实测，见 §3）：
  - **循环内钩子（3 个）→ 保留为「内建 extension」**，走 `extensionFactories` 通道；
  - **纯工具（4 个）→ 改写为「工具模块」**，直接注册进内嵌循环。

> ⚠️ **关键修正（避免重写走偏）**：OpenClaw 弃用的是**扩展加载器**，**不是 `pi-coding-agent` 这个包**。它在 v2026.5.27 里四个包全用（`agent-core` 216 / `ai` 195 / `coding-agent` 98 / `tui` 23 处 import）。
> 所以 **「直接嵌 agent-core/ai」≠ 能丢掉 coding-agent**——否则会话基础设施要自己重写。各包职责划分（已核实）：
>
> | 包 | OpenClaw 从它取什么 | 角色 |
> |---|---|---|
> | `pi-agent-core` | `Agent`、`runAgentLoop` | **驱动循环**的引擎（内嵌核心） |
> | `pi-coding-agent` | `createCodingTools` / `createReadTool` / `createEditTool` / `createWriteTool`、`SessionManager`、`DefaultResourceLoader`、`SettingsManager`、`parseSessionEntries`、`migrateSessionEntries`、`CURRENT_SESSION_VERSION` | **当库用**：工具工厂 + 会话基础设施（**不用**其扩展加载器） |
> | `pi-ai` | `Type`(TypeBox)、`Api`、`Model` | 模型/Provider 契约 |
>
> **0.80.3 符号可用性已验证**：`Agent` 在 `packages/agent/src/agent.ts:171`、`runAgentLoop` 在 `packages/agent/src/agent-loop.ts:95`，均经 `export *` 从包根导出 ✅；`pi-coding-agent@0.80.3` 的 `SessionManager` / `DefaultResourceLoader` / `SettingsManager` / `parseSessionEntries` / `migrateSessionEntries` / `CURRENT_SESSION_VERSION` / `createReadTool` / `createEditTool` / `createWriteTool` / `createCodingTools` **全部齐全** ✅。
> 注：OpenClaw 用的是 **0.75.5** 的 API 面，与 0.80.3 可能有差异——阶段 8 需以 0.80.3 实际 d.ts 为准对齐。

> ⚠️ **关键修正·二次（2026-09-04 晚）：OpenClaw 并「没有」不用 Pi extension**
>
> 前稿曾写「OpenClaw 不用 Pi 的 extension 机制」，**此结论不准确，此处更正**（原文保留以留痕）。复核 `pi-core` @ `27ae826`（v2026.5.27）源码：OpenClaw 是 **SDK 嵌入为主 + 编程式注入 Pi extension 为辅**，两者都用。它关掉的是**目录自动发现**，不是 extension 机制本身。
>
> **证据**（`src/agents/pi-embedded-runner/`）：
> - `resource-loader.ts`（全文仅 23 行）：`new DefaultResourceLoader({ ...options, ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS })`，其中 `noExtensions / noSkills / noPromptTemplates / noThemes / noContextFiles: true` → **关闭 `~/.pi/agent/extensions/` 与 `.pi/extensions/` 扫描**；但同一处**仍传 `extensionFactories`**。
> - `extensions.ts` 的 `buildEmbeddedExtensionFactories()` 返回 `ExtensionFactory[]`，编译期注入 3 个内建扩展：
>
> | 内建 extension | 位置 | 触发条件 |
> |---|---|---|
> | compaction-safeguard | `agents/pi-hooks/compaction-safeguard.ts` | `compaction.mode === "safeguard"` |
> | context-pruning | `agents/pi-hooks/context-pruning.ts` | 仅 `mode === "cache-ttl"` 且 provider 命中 |
> | tool-result-middleware 桥 | `pi-embedded-runner/extensions.ts` | 总是（挂 `pi.on("tool_result")`，`runtime: "pi"`） |
>
> - SDK 调用点 `run/attempt.ts:2745` `createAgentSession({ cwd, agentDir, authStorage, modelRegistry, model, thinkingLevel, tools, customTools, sessionManager, settingsManager, resourceLoader })`，之后 `session.subscribe()` / `applySystemPromptOverrideToSession()` / `setActiveToolsByName()` / `agent.reset()` 全程 SDK 操控。
>
> **那宿主功能为何仍不能走 Pi extension？因为分层不对**：
>
> | 维度 | Pi extension | OpenClaw 需要的 |
> |---|---|---|
> | 生命周期 | 绑**单个 session**，随 `createAgentSession` 加载、闭包随 session 销毁 | 进程级长驻，须在**任何 session 之前**就跑（长连接、webhook、cron、daemon） |
> | 注册能力 | `registerTool/Command/Shortcut/Flag/Renderer` 等 14 个 | 30+ 个：`registerChannel/Provider/HttpRoute/GatewayMethod/Cli/Service/NodeHostCommand/SecurityAuditCollector` |
> | ctx 可见范围 | 仅 `ui/mode/hasUI/cwd/isProjectTrusted()/sessionManager(只读)/modelRegistry/model/signal` | express app、gateway method 表、secrets、配置树 |
> | 安全模型 | 文档 `extensions.md:110`：「Extensions **run with your full system permissions**」 | 多渠道多会话网关，需激活边界（`activation-planner`）、`manifest-owner-policy`、审批、审计 |
> | 控制方向 | Pi 包住宿主 | **宿主包住 Pi**（session 写锁、abort 传播、token 预算、transcript 修复、trajectory 录制） |
>
> Pi 是**单用户本地 TUI 工具**，「扩展即全权限」成立；OpenClaw 是**多租户网关**，若放任 Pi 扫目录，等于在网关进程里开一个无激活边界、无审计、无法按租户隔离的后门。**不是嫌扩展麻烦，是不能把扩展的加载权交给下层。**
>
> **一句话**：Pi extension = 给 agent 循环装钩子；OpenClaw extension = 给网关装驱动。OpenClaw 是 Pi 的**宿主**，宿主插件只能由宿主提供——下游 SDK 的插件机制管不了上游宿主。
>
> **桥接点**：`api.session.state.registerSessionExtension()`（`plugins/types.ts:2512`）+ `agents/harness/tool-result-middleware.ts` → 凡是能在 Pi 循环内做的，OpenClaw 仍走 Pi extension。

**改造后分层**（`pi-host` 新增；**L1 按性质拆成两层**）：

```text
L2  Fiat Platform    Fastify: Auth/RBAC · Approval · Audit · Workflow · PG
    pi-host (新增)    ← 对标 pi-embedded：驱动 Agent/runAgentLoop · 工具注册通道
                        · 会话生命周期 · provider 错误兜底 · 消息去重/清洗
                        · thinking/图片 · 事件扇出 · bootstrap context
                        · 【新增】extensionFactories 通道（内建钩子注入）
L1a Fiat Hooks       ← 【更正】保留为「内建 extension」，走 extensionFactories
                        permission-gate(tool_call) · audit-hook(tool_result)
                        · model-router(before_agent_start)
L1b Fiat Tools       ← 改写为「工具模块」，直接注册进内嵌循环
                        mcp-rag · fiat-tools · job-apply · alert-fanout
L0  Pi Runtime       复用（黑盒，不改）：
                      pi-agent-core@0.80.3   → Agent · runAgentLoop（驱动循环）
                      pi-coding-agent@0.80.3 → SessionManager · DefaultResourceLoader
                                               · SettingsManager · session entry
                                               parse/migrate · create*Tool（当库用）
                                               · ExtensionAPI/ExtensionFactory（钩子通道）
                      pi-ai@0.80.3           → Type(TypeBox) · Api · Model
```

**三道闸门在新架构下的落点**（权限语义不变，只换实现载体）：

| 闸门 | 现状（extension 机制） | 改造后（内嵌机制） |
|---|---|---|
| ① 会话级工具裁剪 | `createAgentSession({ tools })` | `pi-host` 建循环时传入裁剪后的工具集 |
| ② 调用前拦截 | `tool_call` block | **【更正】内建 extension 的 `tool_call` 钩子**（走 `extensionFactories` 通道），**不是** pi-host 自研钩子 |
| ③ 服务端 `canExecute` | L2 Fastify | **不变**（本就在 L2，与扩展机制无关） |

> **为何闸门② 走 extension 而非 pi-host 自研**：`{ block: true, reason }` 的短路语义由 Pi 的 agent-loop 实现——reason 被转成 `isError: true` 的 tool result 回灌模型（见 `workspace/pi-extensions/permission-gate/index.ts:5-6` 注释：block 会短路，故本扩展须自落一条 `outcome="blocked"` 审计）。宿主层自研需重造**事件分发 + 短路回灌 + tool_result 改写**三件事；走 `extensionFactories` 则免费复用 Pi 既有语义。这正是 OpenClaw 保留该通道、并把 tool-result-middleware 做成内建 extension 的同一理由。

**版本策略**（决策①，已确认）：钉 **0.80.3**——与当前本地源码 1:1 对齐，切换后**零行为变化**，是纯粹的「依赖解析方式」变更，风险最低。**不顺手升 0.84.4**（npm latest）：0.x 语义下 minor 可能含 breaking，且 OpenClaw 自身仍停在 0.75.5，说明上游节奏不稳。升级单独立项，走「钉版本 → 跑测试 → 再 bump」。

**关键代价**（决策②，已确认接受）：`@earendil-works/pi-*` 发布包 `files: ["dist"]`，`dist` 内只有 `.js` + `.d.ts` + `.d.ts.map`，**无 `.js.map`、无 `.ts` 源码** → 切 registry 后**无法 step-debug 进 Pi 源码**。
→ 缓解：提供 `dev:pi-local` / `dev:pi-registry` 一键切换脚本，深挖 Pi 内部行为时临时切回本地源码链接，用完切回。

**阶段 7 验收标准**：在**没有** `../pi` 兄弟目录的干净机器上 `npm ci && npm test` 全绿（此阶段仍是 extension 机制，架构未变，故现有 `pi -e` 与 L2 diagnosis 两条路径须都能起会话）。
**阶段 8–9 验收标准**：阶段 0–6 的全部验收标准，在新架构（内嵌循环 + 工具模块）下重跑通过。

---

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
- [x] P6-25 多 agent 并行告警诊断
- [x] P6-26 业务 CLI（Web Console 按决策不做；离线命令零依赖可跑，diagnose 仅在配置 FIAT_MODEL 时经动态 import 加载 Pi）
- [x] P6-27 Pi harness 迁移跟进 → 评估 `PostgresSessionRepo`（结论：当前不可注入 coding-agent 会话路径，保持 JSONL 轨迹 + PG 业务/审计混合存储；预留 drop-in 设计与接入 seam，见 `docs/P6-27-postgres-session-repo.md`）

### 阶段 7：Pi 依赖 registry 化（架构不变，extension 机制仍在）

验收：无 `../pi` 的干净机器 `npm ci && npm test` 全绿
设计依据见 §2.5。本阶段**只改依赖解析方式，不动架构**，是低风险可独立交付的一步。

- [x] P7-28 **前置验证**：npm 安装 `@earendil-works/pi-{agent-core,ai,coding-agent}@0.80.3` 成功；复核 `Agent` / `runAgentLoop` / `SessionManager` / `DefaultResourceLoader` / `SettingsManager` 等符号在 0.80.3 的 d.ts 中均在（本地 dist 已核实，装完再复核一次）→ ✅ 2026-09-04 临时目录实测：三包安装成功（`pi-coding-agent@0.80.3` 版本核实）；`coding-agent` 10 符号、`agent-core` 的 `Agent`/`runAgentLoop` 全在；`pi-ai` 的 `Type` 经 typebox re-export、`Api`(types.d.ts:14)/`Model`(types.d.ts:567) 均在
- [x] P7-29 **依赖切换**：`package.json` 4 条 `file:../pi/packages/*` → 精确版本 `0.80.3`（不带 `^`）。`pi-agent-core` 虽当前零直接引用但**保留**（阶段 8 驱动循环要用）；`pi-tui` 依「是否保留 TUI 入口」决定去留
- [x] P7-30 **删 paths**：移除 `tsconfig.runtime.json`（→`*/src`）与 `tsconfig.json`（→`*/dist`）里全部指向本地 pi 的 paths（各 4 条）
- [x] P7-31 **调试开关**：加 `dev:pi-local` / `dev:pi-registry` 一键切换脚本（深挖 Pi 内部时临时切回本地源码链接，用完切回）
- [x] P7-32 **回归**：**无 sibling `pi/`** 的干净环境跑通 CI；阶段 0–6 验收标准重跑（本阶段架构未变，应全绿）
- [x] P7-33 **升级节奏制度化**：把「钉版本 → 跑测试 → 再 bump」写进 §9，Pi 版本 bump 为独立任务而非顺手升级

### 阶段 8：pi-host 内嵌宿主层（对标 pi-embedded）

验收：pi-host 能驱动完整会话，工具可注册、可拦截
本阶段**弃用扩展加载器**（目录自动发现 + `pi -e`），改用 `pi-agent-core` 的 `Agent` / `runAgentLoop` 自建宿主。

> ⚠️ **口径**：弃用的是**加载器**，**不是 `ExtensionAPI`**。本阶段须同时打通**两条通道**：
> - **L1a 钩子通道** = `extensionFactories`（内建 extension，编译期注入、受控白名单）
> - **L1b 工具通道** = 直接注册进内嵌循环（工具模块）
>
> 对标 OpenClaw `pi-embedded-runner/resource-loader.ts`：`DefaultResourceLoader` 传 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true` 关闭自动发现，但**仍传 `extensionFactories`**。依据见 §2.5「关键修正·二次」。

- [x] P8-34 **最小循环**：用 `Agent` / `runAgentLoop` 驱动最小循环，跑通「问一句答一句」（对标 openclaw `pi-embedded` 最小骨架）
- [x] P8-35 **会话基础设施**：接入 `SessionManager` / `parseSessionEntries` / `migrateSessionEntries` / `CURRENT_SESSION_VERSION` / `DefaultResourceLoader` / `SettingsManager`（取自 `pi-coding-agent`，**当库用**）
- [x] P8-36 **工具注册通道（L1b）**：替代扩展加载器，把工具**直接**注册进内嵌循环（承载 4 个工具型扩展）
- [x] P8-37 **钩子通道（L1a）**：**【更正】** 不实现 pi-host 自研 before-tool-call 钩子，改为打通 `extensionFactories` 注入通道（对标 `pi-embedded-runner/extensions.ts` 的 `buildEmbeddedExtensionFactories()`），承载闸门② 与 3 个钩子型扩展
- [x] P8-38 **宿主职责移植**：provider 错误兜底 / 消息去重·清洗 / thinking·图片 / bootstrap context / 事件扇出（逐项对标 `pi-embedded` 文件职责）
- [x] P8-39 **版本差异对齐**：以 0.80.3 实际 d.ts 为准，核对与 OpenClaw 所用 0.75.5 的 API 差异并落表
- [ ] P8-40 **关闭自动发现 + 通道自测**：`DefaultResourceLoader` 显式传 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true`；自测「编译期注入的 extension 生效、外部目录 extension 不生效」

### 阶段 9：L1 重写（7 个 Pi 扩展 → 3 个内建 extension + 4 个工具模块）

验收：阶段 0–6 的全部验收标准，在新架构下重跑通过
依赖阶段 8 完成。**按性质分流，不可一刀切全部改写为工具模块**（实测依据见 §3）：

- **L1a 内建 extension（3 个，走 `extensionFactories`）**：`permission-gate` / `audit-hook` / `model-router`
- **L1b 工具模块（4 个，直接注册进循环）**：`mcp-rag` / `fiat-tools` / `job-apply` / `alert-fanout`

- [ ] P9-40 定**两类**新契约：① 内建 extension 契约（`ExtensionFactory`，**保留** `(pi) => void` 签名，仅换装配方式：目录发现 → 编译期注入）；② 工具模块契约（去掉 `ExtensionAPI` 依赖，直接暴露工具定义）
- [ ] P9-41 `permission-gate` → **L1a** 内建 extension（`tool_call` 钩子，承载闸门②）
- [ ] P9-42 `mcp-rag` → **L1b** 工具模块
- [ ] P9-43 `fiat-tools` → **L1b** 工具模块
- [ ] P9-44 `audit-hook` → **L1a** 内建 extension（`tool_result` 钩子）
- [ ] P9-45 `model-router` → **L1a** 内建 extension（`before_agent_start` 钩子）
- [ ] P9-46 `job-apply` → **L1b** 工具模块
- [ ] P9-47 `alert-fanout` → **L1b** 工具模块（**注意**：名字像钩子，实测零 `pi.on`、单个 `defineTool`，是纯工具，见 §3）
- [ ] P9-48 **三道闸门重跑**：① 会话级裁剪 ② 内建 extension 的 `tool_call` 拦截 ③ 服务端 `canExecute`（③ 在 L2，不受影响）
- [ ] P9-49 **入口切换**：`pi -e` → 自研 CLI/TUI（由 `pi-host` 驱动）；`workspace/pi-extensions/` 归档保留不删

### 阶段 10（之后）

- [ ] P10-50 清理**扩展加载器**残留（`pi -e` 与 `.pi/extensions` 目录扫描引用归零）
  - ⚠️ **【更正】** 目标**不是**把 `ExtensionAPI` / `defineTool` 引用归零：L1a 内建 extension 仍需 `ExtensionAPI`；工具模块仍可用 `defineTool` 生成工具定义（它只是 TypeBox schema 工厂，与加载器无关）。要归零的是**加载器**，不是**钩子 API**（依据 §2.5「关键修正·二次」）
- [ ] P10-51 文档同步：`AGENTS.md`、Obsidian 技术方案、以及本文 §1/§3 中 L1 的描述
- [ ] P10-52 评估是否进一步**内化** `agent-core`（对标 OpenClaw v2026.5.28 的做法），作为长期选项单独立项

---

## 9. 约束与踩坑

**铁律**：

1. 不改 Pi 核心（`packages/*/src`）一行代码。
2. 不把权限判定只放在 `tool_call` block —— 它只是第一道。
3. 高风险操作不返回 error，返回工单。
4. LLM 不参与金额计算、状态机判断、字段校验。

**版本纪律**（Pi 依赖）：

1. Pi 依赖一律**精确钉版本**，禁止带 `^` / `~` 浮动。当前钉 `0.80.3`（与本地 `../pi` 源码 1:1 对齐，零行为变化）。
2. **升级 Pi 版本 = 独立任务**，口诀「钉版本 → 跑测试 → 再 bump」：先在 `package.json` 钉新版本号，再重跑 `npm run check` + `npm test`（含阶段 0–6 全部验收），全绿后才算完成；不顺手升级。
3. npm `latest` 可能已高于 `0.80.3`（如 `0.84.4`），但 `0.x` 语义下 minor 即可能含 breaking，OpenClaw 自身也停在 `0.75.5`——**不假设「本地 = 最新」**，升级单独立项走上面流程。
4. 切回本地源码深挖 Pi 内部时，用 `npm run dev:pi-local` / `dev:pi-registry` 一键切换（见 §2.5 / P7-31），用完立刻切回 registry。

**0.80.3 vs OpenClaw 0.75.5 API 差异对照**（P8-39 落表；两列均为**本地源码实测**，非推测——OpenClaw 侧读 `~/Desktop/project/openclaw`（四包钉 0.75.5），0.80.3 侧读 node_modules d.ts + 运行时实测）：

| API 点 | OpenClaw @ 0.75.5 | 本仓 @ 0.80.3 实测 | 差异与处置 |
|---|---|---|---|
| 驱动层级 | `createAgentSession` 高层 SDK 为主（`run/attempt.ts:2746`、`compact.ts:1124`）；`Agent`/`runAgentLoop` 仅 import 少量 | **`Agent` 直驱**（`host/loop.ts`），弃用 `createAgentSession` 路径 | 有意分歧（§2.5 决策）。`createAgentSession` 在 0.80.3 包根仍存在，未删，仅我们不用 |
| `DefaultResourceLoader` 选项 | `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles + extensionFactories`，用 `satisfies Partial<DefaultResourceLoaderInit>` 锁形（`resource-loader.ts` 全文 23 行） | 选项**同名同形全兼容** ✅ | 无差异；我们额外实测 `getSystemPrompt()` **不回显**注入的 `systemPrompt` 选项（关自动发现时为空）→ 宿主自存注入值（`HostResources`） |
| `ExtensionFactory` 签名 | `(pi) => void \| Promise<void>`（`extensions.ts` 内建扩展同签名） | 同签名 ✅ | 无差异；L1a 三扩展照此签名改写（P9-41/44/45） |
| extension 钩子执行器 | **不显式实例化 `ExtensionRunner`**——桥以 factory 形式交给 `createAgentSession` 内部跑 | **显式 `new ExtensionRunner(...)`** + `emitToolCall`/`emitToolResult` 桥接 Agent options | 架构必差异：直驱路线没有 SDK 内部 runner，须自建（实测无需 `bindCore` 即可 emit，钩子不碰 `ctx.actions` 时） |
| `tool_result` 钩子事件 | 把 rawEvent 当 `unknown` 防御式解析（`recordFromUnknown`） | 强类型 `ToolResultEvent`；**实测被 block 的工具不发 tool_result 事件** | 0.80.3 类型更严；block 工具的审计须记在 `tool_call` 钩子内（audit-hook 注意） |
| 会话基础设施 | `SessionManager`(20 处) / `CURRENT_SESSION_VERSION`(12 处) / `parseSessionEntries` / `migrateSessionEntries` | 全部存在 ✅，`CURRENT_SESSION_VERSION = 3`；另有 0.75.5 未列的 `inMemory`/`forkFrom`/`listAll`/`buildSessionContext` | 无差异；`buildSessionContext().messages` 与 `AgentState.messages` 类型直通（`AgentMessage[]`） |
| `create*Tool` 工具工厂 | `createReadTool`/`createEditTool`/`createWriteTool`/`createCodingTools` | 包根仍在 ✅（`sdk.ts`） | 我们暂未用（宿主工具自建 `AgentTool`）；阶段 9 若需 Pi 内置工具语义可直接取 |
| `ModelRegistry` / `AuthStorage` | 经 authStorage 构造 | `ModelRegistry.inMemory(AuthStorage.inMemory())` ✅ | inMemory 轻量构造可用，宿主自持不读个人配置 |
| `Settings` 类型导出 | OpenClaw 未直接 import（用 `SettingsManager` getter） | **包根未导出 `Settings` 类型**；用 `Parameters<typeof SettingsManager.inMemory>[0]` 规避 | 0.80.3 实测口径；勿写 `import type { Settings }` |
| `TSchema` 来源 | —（OpenClaw 未直接用） | **`typebox`@1.1.38**（非 `@sinclair/typebox`；pi 传递依赖被提升至顶层可 import） | `AgentTool` 泛型约束来源；升级 Pi 时须连带核对 |
| `Agent.prompt` 返回值 | —（OpenClaw 走 SDK session.prompt） | **`Promise<void>`**（非 event stream）；provider 失败**不抛**，走 `stopReason:"error"` + `errorMessage` | 兜底必须双查（catch + stopReason），见 `runTurnSafe`（P8-38 实测） |
| 测试面 | OpenClaw 自建 mock | `pi-ai/compat` 提供 faux provider：`registerFauxProvider` / `fauxAssistantMessage` / `fauxToolCall`（`stopReason:"toolUse"`）/ `FauxResponseFactory`（按 callCount 分步） | 全链路工具循环可离线脚本化（P8-36/37 测试即此写法） |

> 表中「OpenClaw 未直接用 / 未直接 import」为 grep 全仓 import 面的结论（`pi-agent-core` 实际只取 `StreamFn`/`AgentToolResult`/`AgentToolUpdateCallback`/`runAgentLoop`/`Agent`/`AgentMessage`/`AfterToolCallContext`；`pi-coding-agent` import 频次前八：`SessionManager`/`CURRENT_SESSION_VERSION`/`ModelRegistry`/`ExtensionContext`/`createReadTool`/`DefaultResourceLoader`/`SettingsManager`/`SessionHeader`，不分 type/value）。**OpenClaw 全仓零 `ExtensionRunner` import**（已单独确认）。升级 Pi 版本时先重跑本表的核对（含 faux / typebox / Settings 导出口径）。

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
| **Pi 发布包无法 step-debug** | `@earendil-works/pi-*` 的 `files: ["dist"]`，`dist` 内只有 `.js` + `.d.ts` + `.d.ts.map`，**无 `.js.map`、无 `.ts` 源码**（`.d.ts.map` 只服务于类型跳转，与运行时调试无关） | 切 registry 后无法 step into Pi 源码。深挖 Pi 内部行为时用 `dev:pi-local` 临时切回本地源码链接 |
| **本地 pi 与 npm 版本已分叉** | 本地 `pi/` 是分支 `mydev` @ `0.80.3` 且工作区 dirty；npm 已发布 43 版，latest 为 `0.84.4`（本地反而落后） | 切 registry 时钉 **0.80.3** 与现状对齐，升级单独立项；不要假设「本地 = 最新」 |
| **`pi-agent-core` / `pi-tui` 声明但零引用** | 全仓（src/workspace/test/scripts）直接引用数均为 **0**；实际只用 `pi-coding-agent`(24) 与 `pi-ai`(16) | **不要删 `pi-agent-core`**——阶段 8 内嵌循环要用它的 `Agent` / `runAgentLoop`，须显式声明（它不只是 `coding-agent` 的传递依赖）；`pi-tui` 依是否保留 TUI 入口决定 |
| **OpenClaw 用的是 0.75.5 的 API 面，别照抄** | OpenClaw 从 `pi-agent-core` 只取 `Agent` / `runAgentLoop`；从 `pi-coding-agent` 取 `SessionManager` / `DefaultResourceLoader` / `SettingsManager` / `parseSessionEntries` / `migrateSessionEntries` / `create*Tool`、**`ExtensionAPI`/`ExtensionFactory`**——**它弃用的只是扩展加载器，不是这个包**（四个包全用：216/195/98/23 处 import） | 阶段 8 以 **0.80.3** 实际 d.ts 为准，勿照搬 0.75.5 写法。已验证 `Agent`(`packages/agent/src/agent.ts:171`)、`runAgentLoop`(`packages/agent/src/agent-loop.ts:95`) 在 0.80.3 均存在 ✅ |
| **「OpenClaw 不用 Pi extension」是误判** | 前稿据此写过「不用 extension 机制」，**此处更正**。实测 `pi-core` @ `27ae826`：它关掉的只是**目录自动发现**（`resource-loader.ts` 的 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true`），但仍经 `extensionFactories` 编译期注入 3 个内建 extension | 阶段 8 **保留 `extensionFactories` 通道**（P8-37/P8-40）。钩子型扩展不要改写为工具模块，否则要自造事件分发 + 短路回灌 + tool_result 改写 |
| **扩展性质不可望文生义** | `alert-fanout` 名字像事件钩子，实测**零 `pi.on`、单个 `defineTool`**，是纯工具——「fanout」指 L2 `diagnosis/{plan,fanout}.ts` 的并发编排，L1 侧只注册 `fiat_alert_diagnosis` 并渲染报告 | 分流以**实测**为准：统计 `pi.on(...)` 事件数与 `defineTool` 定义数（见 §3 表），不以命名为准 |
| **宿主级功能塞不进 Pi extension** | Pi extension 绑**单个 session** 生命周期，ctx 只有 `ui/mode/cwd/sessionManager(只读)/modelRegistry/signal`；无 HTTP 路由、无长驻服务、无渠道抽象；文档明写「run with your full system permissions」 | 长连接 / webhook / cron / 密钥 / 租户隔离 / 审批审计一律放宿主层（L2 `pi-host`）。这不是「嫌扩展麻烦」，是不能把**扩展的加载权**交给下层 |

**Git 纪律**（多 pi session 并行时尤其重要）：

1. 禁止 `git add -A` / `git add .` / `git add -u`，只 `git add <明确路径>`。
2. 禁止 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `--no-verify`。
3. 只提交本会话改的文件，提交前跑 `git status` 确认。
4. 提交格式：`{feat,fix,docs,chore,test,refactor}[(scope)]: <msg>`，带任务 ID。
