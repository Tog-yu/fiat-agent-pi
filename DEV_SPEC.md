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
L1  Fiat Extension     自研：4 内建 extension（permission-gate · audit-hook · model-router · eval-recorder）
                            + 4 工具模块（mcp-rag · fiat-tools · job-apply · alert-fanout）
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
      skills     -> ../pi-skills          # 仅保留 skills 软链（P9-49 起 extensions 软链归档）
    pi-skills/                                # 原 pi-extensions 归档于 workspace/pi-extensions/（只读快照，不随 L1 演进）
  src/server/                   # L2 Fastify 平台服务
  docs/
```

软链命令（写进 `scripts/setup.sh`；P9-49 起 extensions 软链归档，仅保留 skills）：

```bash
cd workspace/.pi && ln -sfn ../pi-skills skills
```

开发者入口（**P9-49 已切换**：`pi -e` 扩展加载器路径归档 → 自研 CLI，由 pi-host 内嵌循环驱动）：

```bash
npm run cli                                    # fiat <command>
npm run cli -- chat "查一下返现规则"             # 内嵌会话单轮问答（装配链 src/server/cli/chat.ts）
npm run cli -- chat                            # 交互 REPL（exit 退出）
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
                        · eval-recorder(turn_start/turn_end/agent_end, 阶段 11)
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
| `eval-recorder` | 三层评测采集（阶段 11） | `turn_start` / `turn_end` / `agent_end` | — | **钩子型** → L1a | P1（阶段 11） |
| `mcp-rag` | MCP client 桥 | — | `mcp_rag.*` | **工具型** → L1b 工具模块 | P0 |
| `fiat-tools` | 业务工具集 | — | `fiat_cashback_reconcile` | **工具型** → L1b | P0 |
| `job-apply` | 执行已审批工单（P5-20） | — | `fiat_job_apply` | **工具型** → L1b | P0 |
| `alert-fanout` | 并行告警诊断（P6-25） | — | `fiat_alert_diagnosis` | **工具型** → L1b | P1 |

> ⚠️ **不可望文生义**：`alert-fanout` 名字像事件钩子，实测是**纯工具**（零 `pi.on`、单个 `defineTool`）——「fanout」指 L2 侧 `diagnosis/{plan,fanout}.ts` 的并发编排，而 L1 侧只注册 `fiat_alert_diagnosis` 一个工具并渲染报告。分流时以实测性质为准，不以命名为准。

**分流原则**：挂了 `pi.on(...)` 且零工具定义的 → 保留为内建 extension（L1a）；只 `registerTool` 且零事件的 → 改写为工具模块（L1b）。理由见 §2.5「关键修正·二次」——钩子依赖 Pi agent-loop 的既有语义（如 `tool_call` 的 `{ block: true, reason }` 短路回灌），宿主层自研要重造，代价远高于复用。

**两套契约（P9-40 定）**：

- **L1a 内建 extension**（钩子型：permission-gate / audit-hook / model-router / eval-recorder）：保留 Pi `ExtensionFactory` 签名 `(pi) => void`，经 `extensionFactories` **编译期注入**（不再走目录发现 / `pi -e`）；钩子用 `pi.on("tool_call" | "tool_result" | "before_agent_start" | "turn_start" | "turn_end" | "agent_end", ...)` 实现拦截 / 审计 / 模型路由 / 评测采集。
- **L1b 工具模块**（工具型：mcp-rag / fiat-tools / job-apply / alert-fanout）：**去掉 `ExtensionAPI` 依赖**，工厂直接返回 `HostTool[]`（如 `createFiatTools(deps): HostTool[]`），由宿主经 `registerTools` 直接注册进内嵌循环。

两类工厂均为「工厂的工厂」：`createXxx(deps)` 返回 `(pi) => void` 或 `HostTool[]`，client 由入口注入——Web 场景注入进程内直连 client（零网络），TUI 场景注入 HTTP client，测试注入 mock。

**工具 schema 是 TypeBox，不是 Pydantic。** 工具集按风险分级，ops 角色看不到 `fiat_job_apply`。

**权限三道闸门**：

| 闸门 | 时机 | 说明 |
|---|---|---|
| ① 会话级工具裁剪 | `buildSession(subject, { toolFilter })`（内嵌循环，等价原 `createAgentSession({ tools })`） | 模型根本看不到 |
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
- [x] P8-40 **关闭自动发现 + 通道自测**：`DefaultResourceLoader` 显式传 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true`；自测「编译期注入的 extension 生效、外部目录 extension 不生效」

### 阶段 9：L1 重写（7 个 Pi 扩展 → 3 个内建 extension + 4 个工具模块）

验收：阶段 0–6 的全部验收标准，在新架构下重跑通过
依赖阶段 8 完成。**按性质分流，不可一刀切全部改写为工具模块**（实测依据见 §3）：

- **L1a 内建 extension（3 个，走 `extensionFactories`）**：`permission-gate` / `audit-hook` / `model-router`
- **L1b 工具模块（4 个，直接注册进循环）**：`mcp-rag` / `fiat-tools` / `job-apply` / `alert-fanout`

- [x] P9-40 定**两类**新契约：① 内建 extension 契约（`ExtensionFactory`，**保留** `(pi) => void` 签名，仅换装配方式：目录发现 → 编译期注入）；② 工具模块契约（去掉 `ExtensionAPI` 依赖，直接暴露工具定义）
- [x] P9-41 `permission-gate` → **L1a** 内建 extension（`tool_call` 钩子，承载闸门②）
- [x] P9-42 `mcp-rag` → **L1b** 工具模块
- [x] P9-43 `fiat-tools` → **L1b** 工具模块
- [x] P9-44 `audit-hook` → **L1a** 内建 extension（`tool_result` 钩子）
- [x] P9-45 `model-router` → **L1a** 内建 extension（`before_agent_start` 钩子）
- [x] P9-46 `job-apply` → **L1b** 工具模块
- [x] P9-47 `alert-fanout` → **L1b** 工具模块（**注意**：名字像钩子，实测零 `pi.on`、单个 `defineTool`，是纯工具，见 §3）
- [x] P9-48 **三道闸门重跑**：① 会话级裁剪 ② 内建 extension 的 `tool_call` 拦截 ③ 服务端 `canExecute`（③ 在 L2，不受影响）
- [x] P9-49 **入口切换**：`pi -e` → 自研 CLI/TUI（由 `pi-host` 驱动）；`workspace/pi-extensions/` 归档保留不删

### 阶段 10（之后）

- [x] P10-50 清理**扩展加载器**残留（`pi -e` 与 `.pi/extensions` 目录扫描引用归零）
  - ⚠️ **【更正】** 目标**不是**把 `ExtensionAPI` / `defineTool` 引用归零：L1a 内建 extension 仍需 `ExtensionAPI`；工具模块仍可用 `defineTool` 生成工具定义（它只是 TypeBox schema 工厂，与加载器无关）。要归零的是**加载器**，不是**钩子 API**（依据 §2.5「关键修正·二次」）
- [x] P10-51 文档同步：`AGENTS.md`、Obsidian 技术方案、以及本文 §1/§3 中 L1 的描述
- [x] P10-52 评估是否进一步**内化** `agent-core`（对标 OpenClaw v2026.5.28 的做法），作为长期选项单独立项
  - 结论：不立即内化，单独立项为长期 backlog（详见 `docs/P10-52-internalize-agent-core.md`）。**口径更正**：OpenClaw 自身也用 registry 钉版本黑盒、并不 vendor Pi 源码，故「对标 OpenClaw」实为反对内化的论据；当前三道闸门已走 `extensionFactories`、无 loop-kernel 级 patch 硬需求。

### 阶段 11：三层评测（结果 / 轨迹 / 单步）

验收：CI 内 faux 驱动跑通「结果 + 轨迹（部分分）+ 单步」三维度评分与 pass 判定；在线采集（eval-recorder → sink）链路就绪；评测链路**只读不拦**，不触碰三道闸门语义。
设计依据：Obsidian `agent问题笔记/fiat-agent-pi-三层评测设计方案.md`（采集边界 / 三种轨迹匹配模式 / 表结构 / 与闸门边界）。

**核心设计（一句话版）**：
- pi 无 eval 层，原料齐全（JSONL 树轨迹 / 事件流 / faux provider），判定逻辑自建。
- 三层评测：**结果层**（outcome，确定性判定为主，一票否决）、**轨迹层**（trajectory，LCP 前缀 + 路标子序列 + 硬约束，给部分分）、**单步层**（first_step，首工具命中，`any_of` 多解）。
- 采集：L1a 扩展 `eval-recorder`（挂在闸门之后，只读不拦）；判定：纯逻辑包 `src/server/eval/`（零 Pi 依赖）；存储：三张表（run / step / score），**与 `fiat_audit_log` 分离**（审计是合规事实，评测是可重算实验数据）。
- 期望序列不写死完整顺序：`milestones`（路标，2~4 个必经点）+ `first_step.any_of`（多解）+ `forbid`（硬约束，出现即 0）+ `max_steps`。
- LLM 在评测链只有两个合法位置：冷启动生成 case（产出进 case 不进评分链路）、rubric 判定主观维度（低权重、可关）。明确禁止「跑完让 LLM 看轨迹打分」。

**⚠️ 采集口径更正（2026-09-06，对照 0.80.3 源码实测）**：设计方案 §2 原设想 `tool_call`/`tool_result` 钩子采集每步。实测 `ExtensionRunner.emitToolCall` **对被 block 的调用短路返回**（runner.js:639-657），且被 block 不产生 `tool_result`（P8-39 已实测）→ eval-recorder 若排在 factories 尾部，收不到被闸门②拦截调用的 `tool_call`。**修正采集面**：改用 `turn_start` / `turn_end` / `agent_end` 三个生命周期事件——`turn_end` 携带本轮完整 `toolResults`（含 isError 回灌结果，被 block 的调用也在其中，天然含 `blocked` 信号）；`agent_end` 携带完整 messages（outcome 判定输入）。这样 eval-recorder 不再依赖 `tool_call`/`tool_result` 顺序，与 audit-hook（tool_result 面采集）职责正交：**audit 记「每次调用」，eval 记「每轮轨迹」**。

**与三道闸门的边界（硬约束，来自设计方案 §6）**：
1. eval-recorder 挂在闸门之后，只订阅不改写、不返回 block——评测永远不能影响执行。
2. 评测不绕过审批：高风险 case 期望 `ticket_created` 终态 + 后续 `fiat_job_apply`，而不是直接执行成功。
3. 评测数据 `input` 脱敏：沿用审计红线，只存参数键与必要值，不落 prompt 全文 / 业务敏感字段。
4. 子会话（P6-25）recorder 传 `parentRunId`，否则多体轨迹散成孤儿 run。
5. CI 里跑真实 `tool_policies.yaml`，绝不放宽——「为了让评测通过而放宽权限」是最容易的作弊路径。

**打分公式（设计方案 §9.3，替代纯 LCP 版本）**：

```text
constraint 违反（forbid 命中 / 必须项缺失 / 超 max_steps）→ trajectory = 0
否则 trajectory = 0.6 × milestone_coverage
                + 0.4 × prefix_coverage（未配置 strict prefix 时该权重并入 milestone）
                − 0.10 × blocked_n
                − 0.02 × max(0, steps − max_steps)
final_score = Σ(value_i × weight_i) / Σ(weight_i)
passed      = final_score ≥ case.threshold 且 outcome 维度必须 = 1（结果维度一票否决）
first_step  = 1 if 实际首工具 ∈ any_of else 0
```

- [x] P11-53 **eval 纯逻辑 types + outcome grader**：`src/server/eval/types.ts`（`EvalCase` / `RunTrace` / `StepRecord` / `Score` / `TrajectoryExpectation`）+ `src/server/eval/outcome.ts`（终态判定 `terminalOf`：`answered` / `ticket_created` / `applied`；`requiresApproval` 校验必须出现 `fiat_job_apply`；`stopReason error/aborted` → 0 分）
- [x] P11-54 **轨迹打分**：`src/server/eval/trajectory.ts`——LCP 前缀匹配（部分分来源）、路标子序列相对顺序校验、forbid/max_steps 硬约束、blocked/超步惩罚、按上方公式合成
- [x] P11-55 **单步打分 + 汇总**：`src/server/eval/first-step.ts`（`any_of` 首工具命中）+ `src/server/eval/aggregate.ts`（加权汇总 + `passed` 判定：outcome 一票否决）
- [x] P11-56 **case 配置加载**：`config/eval_cases.yaml`（首个 case：alert-diagnose-prod，含 terminal / requires_approval / first_step.any_of / milestones / forbid / max_steps / threshold）+ `src/server/eval/cases.ts` 加载与校验（缺 terminal / threshold 的 case 拒绝加载）
- [x] P11-57 **InMemoryEvalSink**：`src/server/eval/sink.ts`——`EvalSink` 接口（`writeRun`）+ `InMemoryEvalSink`（零依赖，测试断言用）；run / step / score 结构与设计方案 §3 三张表字段一一对应
- [x] P11-58 **eval-recorder L1a 扩展**：`src/server/host/l1a/eval-recorder.ts`——订阅 `turn_start` / `turn_end` / `agent_end`，从 `turn_end.toolResults` 提取 step（tool / isError / blocked 推断 / durationMs），`agent_end` 时组装 `RunTrace` 写 sink；factory 尾部追加进 `buildSession` 的 factories（不插队，位置契约：`[gate, audit, modelRouter, ...evalRecorder?]`）；`SessionFactoryOptions` 加可选 `evalSink?: EvalSink` + `parentRunId?: string`，**缺省不注册（fail-safe，现有测试零改动）**
- [x] P11-59 **宿主事件扇出补齐**：`src/server/host/loop.ts` / `extensions.ts`——`PiHostLoop` 订阅 `Agent.subscribe()`，把 `turn_start` / `turn_end` / `agent_end` 经 `runner.emit(...)` 扇出给 extension 钩子（P8-38 遗留职责，eval-recorder 的前置）；不改 Pi 核心
- [x] P11-60 **三层评测集成测试**：`test/eval-outcome.test.ts` / `test/eval-trajectory.test.ts` / `test/eval-first-step.test.ts`（纯逻辑直接断言）+ `test/eval-recorder.test.ts`（faux provider 驱动完整会话：闸门② block 场景 → step.blocked=true；正常场景 → 全链路 score 落 InMemoryEvalSink、pass 判定生效）
- [x] P11-61 **CI case 闭环**：跑真实 `config/tool_policies.yaml`（不放宽）+ stub Lark/Fiat client，`cashback-reconcile-approval` case 全链路出分 ≥ threshold（含 viewer 越权场景：gate ①裁剪后猜名调用 → not found 记 blocked + outcome 一票否决）；同步 `npm run check` 全绿
  - ⚠️ 验收注记（2026-09-07）：「全量 vitest 全绿」达成 **196/199**——3 个失败（`cli-chat.test.ts` ×2、`host-duties.test.ts` ×1）为 **5s 超时**，经 git worktree 干净基线（HEAD `6d685a5`，移除本阶段全部改动后重跑同组测试）复现同样 3 失败，确认是**既有环境问题**（vitest forks worker 在本机负载下的启动/执行超时），与阶段 11 改动无关。全量跑时 vitest worker 报 `Failed to start forks worker ... Timeout waiting for worker to respond`；单独分批重跑这些文件时部分可过，属 flaky。后续可作为独立任务（调 `testTimeout` / 改 `pool: "threads"`）处理，不阻塞本阶段。

### 阶段 12：自进化循环（轮末反思 → 提案 → 审批 → 评测准入）

验收：faux 驱动一场会话，工具迭代达标后**轮末**触发评审 fork；fork 的**白名单外工具被运行时拒绝**、且 fork **不再触发评审**（递归防护）；产出提案落 `fiat_evolution_proposal`；`dev` 自动落盘（含 tar.gz 快照）、`staging/prod` 落审批工单；落盘技能在 CI 跑对应 eval case，分数低于基线**自动 rollback**；`npm run check` + `npm test` 全绿（新增 evolution 用例）。

设计依据：Obsidian `法币 agent/法币定制 Agent DEV_SPEC（Pi 版）.md` **§10 自进化循环**（含流程图 `fiat-agent-pi-自进化闭环.svg`）。
一句话口径：**Hermes 是「想到就写」，fiat 是「先提案、再审批、后验证」** —— fork 只有提案工具，落盘与判定都在 L2 确定性代码。

- [x] P12-62 **契约与配置**：`src/server/evolution/types.ts`（`EvolutionProposal` / `EvolutionRun` / `TriggerKind` / `Decision`）+ `config/evolution.yaml`（`intervalIters: 10` / `intervalTurns: 10` / `maxRunsPerSession: 3` / `timeoutMs: 60000` / `autoApplyDev: true` / `roleFactsEnabled: false`）
- [x] P12-63 **触发器 L1a**：`src/server/host/l1a/evolution-trigger.ts` —— 订阅 `turn_end`（本轮有 `toolResults` 则 `itersSinceSkill += 1`）与 `agent_end`（`snapshot()` 上报）；**缺省不注册（fail-safe，现有测试零改动）**；factory 尾部追加，位置契约 `[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?]`
- [x] P12-64 **技能库存储**：`src/server/evolution/skillStore.ts` —— 扫描 `workspace/pi-skills/*/SKILL.md`（**扁平一层**，对齐踩坑表「扩展路径只递归一层」）/ 解析 frontmatter / 读正文 / 原子写 / 归档 / `.origin.json`（`agent` \| `human`）/ `.usage.json` 遥测 / `applyProposal` 前 tar.gz 快照 + `rollback`
- [x] P12-65 **候选注入**：技能索引（name + ≤60 字 description + when_to_use）追加进 `HostResources.systemPrompt` **末尾**（按 name 稳定排序，避免每轮打掉 prefix cache）；L1b 工具 `fiat_skill_view(name, file_path?)` 按需读正文
- [x] P12-66 **评审 fork**：`src/server/evolution/reviewer.ts` —— `HostSession.inMemory` + **脱敏切片**（近 12 轮：user 摘要 / 工具名 / isError / 输出摘要）+ 继承 runtime（同模型命中同一 prefix cache）+ 两个计数器置 0 + 60s 超时 + 失败只记日志（**永不阻塞回复**）
- [x] P12-67 **提案工具（L1b，只在 fork 会话注册）**：`fiat_skill_propose` / `fiat_memory_propose` / `fiat_role_facts_propose` → **只写 `ProposalStore`，不落盘**；配合运行时白名单，生产写工具（`fiat_job_apply` / `fiat_cashback_reconcile`）一律不在
- [x] P12-68 **落盘判定**：`src/server/evolution/policy.ts`（纯函数，**零 Pi 依赖**）—— 保护清单 / 脱敏扫描 / 技能规范（缺 when_to_use、description > 60 字）/ 重复检测（slug 冲突 + 相似度 > 0.85）→ `auto_apply` \| `needs_approval` \| `reject`；并把 §10.8 三条禁令做成**正则兜底**
- [x] P12-69 **审批桥与落盘**：复用 `ApprovalService` + Lark 卡片（**审批人 = oncall/ops 且非提案人**）→ `applyProposal`（原子写 + 快照 + `fiat_evolution_*` 与 `fiat_audit_log` **双写**）；幂等键 = `hash(target + 归一化正文)`
- [x] P12-70 **评测闸门**：落盘技能按 `verified_by.case_id` 关联 `config/eval_cases.yaml`；跑对应 case，score < 基线 → 自动 rollback + 标 `stale`；通过则把 `verified_by {case_id, score, verified_at}` 回写 SKILL.md
- [x] P12-71 **Curator（维护侧，可独立延后）**：确定性状态机 `active → stale(30d) → archived(90d)` + `pin` 保护 + CLI `fiat skills list / pin / archive / restore / rollback`
- [x] P12-72 **测试与文档**：`test/evolution-trigger.test.ts`（计数与触发阈值）/ `evolution-policy.test.ts`（纯函数分支全覆盖）/ `evolution-reviewer.test.ts`（faux 驱动：白名单拦截 + 递归防护 + 提案落库 + 超时兜底）/ `evolution-apply.test.ts`（dev 自动落盘 + 审批路径 + rollback）；同步 `AGENTS.md` 与设计文档 §10
  - ✅ 验收注记（2026-09-12）：新建 16 个源文件（`src/server/evolution/` 13 个 + `host/l1a/evolution-trigger.ts` + `host/l1b/{skill-tools,propose-tools}.ts` + `cli/skills.ts`，另 `config/evolution.yaml`），改动 9 个既有文件（`host/loop.ts` / `session/factory.ts` / `audit/client.ts` / `config/tool_policies.yaml` / `cli/{commands,index,chat,entry}.ts`）。
  - 📐 **相对原任务清单的两处增量**（实现时发现必要，非计划外扩张）：
    1. **判定规则从 4 类扩到 11 条**（`DecisionRule`）：原清单只有「保护清单 / 脱敏 / 技能规范 / 重复」，实际还需 `role_facts_disabled`（第三路默认关）、`spec_violation`（缺 `when_to_use`）、`env_approval`（非 dev 强制人审）、`self_approval`（审批人 = 提案人）等分支，否则 `role_facts_enabled: false` 与「审批人非提案人」两条硬约束落不了地。
    2. **测试文件 4 → 6**：原列 4 个，实际加 `evolution-skillstore.test.ts`（25 个，能力 / 防护 / 确定性）与 `cli.test.ts` 追加 7 个。补这两个是因为 skillStore 是**唯一落盘出口**，CLI 是运维实际入口，都值得独立覆盖。
  - 🐛 **测试暴露并修掉的 2 个真实缺陷**（这是本阶段最有价值的产出，靠写测试才浮出来）：
    - **① 落盘即「已验证」**：`upsertSkill` 原本写入 `verified_by {case_id, score: 0, verified_at: now}`。后果是**刚落盘的技能分数为 0 却被判为「已验证」**，在索引里排进 verified 组，直接绕过 P12-70 的评测准入。修复为**锚点与凭证分离**：落盘只写 `case_id`（锚点），`score` / `verified_at` 只有评测通过才由 `setVerified()` 回写；所有「是否 verified」的判定统一改为 `score !== undefined`。含义是「内容一改，旧的验证结论就失效」——这正是我们要的语义。
    - **② rollback 回滚不干净**：`rollback()` 原本只 `tar -xzf` 解包。tar **只覆盖/新增、不删除**，于是回滚一个**新技能**（快照里本就没有它）时目录留在原地——状态标成 `rolled_back`，磁盘上却还躺着一个不该存在的技能，评测判它不达标但文件没被清掉。修复为**先清空再解包**（保留 `.backups` / `.origin.json` / `.usage.json` 三类维护侧状态），`snapshot()` 同步排除这三项。因为精确回滚是「不达标自动 rollback」这条链路的最后一道保险，脏回滚比不回滚更危险。
  - 验收结果：`npm run check` → `Checked 110 files. No fixes applied.`；`npm test` → **34 files / 299 tests 全绿**（阶段 11 基线为 29 文件 / 204 用例，本阶段净增 5 文件 / 95 用例）。文档侧已同步 `workspace/AGENTS.md`（新增「自进化循环（默认关闭）」一节 + 工具命名 + 禁写锚点）与本设计文档 §10。

**阶段 12 硬约束（实现时不得破）**：

1. 评审 fork **不给写能力**：只有 `*_propose` + 只读工具。
2. 落盘判定与写文件**都在 L2 确定性代码**，LLM 只产出候选文本。
3. 自进化**不写** `AGENTS.md` / `tool_policies.yaml` / `eval_cases.yaml`（人写锚点，只读）。
4. `workspace/memory/` 只作**提示层**：不得成为金额 / 状态机 / 字段校验的第二规则源。
5. 不做个人画像（第三路按 `role` 聚合且默认关）。
6. **不打开 Pi 的 skills 通道**（`noSkills` 保持 `true`），索引 / 正文 / 写入全自研。
7. 每次评审与落盘都留痕：`fiat_evolution_run` / `fiat_evolution_proposal` + `fiat_audit_log` 双写。

### 阶段 13：告警 webhook 网关（gateway 常驻进程 + hooks 端点，参考 OpenClaw）

> 方向确认于 2026-09-16。触发背景：目前告警只能**人肉从 CLI 带进来**（`fiat diagnose <标题>`，cli/commands.ts:83）或模型在会话内自调 `fiat_alert_diagnosis` 工具——`AlertInput`（diagnosis/plan.ts:17）只有 `title/service/window/detail` 4 个自然语言字段，**没有告警平台推送链路**，也没有常驻进程与 HTTP 服务（`src/` 全仓无 `listen()`）。本阶段补上「告警平台 → webhook → 常驻网关 → 自动诊断 → Lark 回推」这条自动链路。

验收：`fiat gateway` 起常驻进程（仅 loopback），告警平台（或 curl 模拟）`POST /hooks/alert` 带 Bearer token 推一条告警 → 网关鉴权、按 fingerprint 去重落库 → 按 severity 分级：P0/P1 自动起 AgentSession 跑并行诊断（同三道闸门、同审计链）→ 报告经 Lark 回推值班群；P2+ 只落库摘要等人触发；重复推送（同 fingerprint 未恢复）不重复诊断；token 错误 / payload 非法返回 4xx 且不影响主进程；`npm run check` + `npm test` 全绿（新增 gateway 用例）。

设计依据：OpenClaw gateway hooks 设计（`openclaw/docs/gateway/index.md`「Runtime model」单端口常驻进程 + `openclaw/docs/automation/cron-jobs.md`「Webhooks」：`hooks.enabled + token` 鉴权、`POST /hooks/agent` 起 isolated turn、`hooks.mappings` 把任意 payload 转成动作、安全边界）。对应关系：openclaw 的 gateway ≈ 本阶段 `fiat gateway` 进程；`/hooks/agent` ≈ `POST /hooks/alert` + 诊断执行链；`hooks.mappings` ≈ payload 适配层（各告警平台字段不同，转换集中在 L2 确定性代码，不进 LLM）。

一句话口径：**网关只做「收、验、存、派」四件确定性的事，诊断逻辑一行不写**——payload 转 `AlertInput` 后复用既有 `diagnosisPlan()` / `runFanout()` / `renderReport()` 纯函数链，闸门与审计天然同链（踩坑表「宿主级功能塞不进 Pi extension」：HTTP / webhook / 密钥一律放宿主层 L2）。

- [x] P13-73 **契约与配置**：`src/server/gateway/types.ts`（`AlertEnvelope`：`alert_id` / `fingerprint` / `severity: "P0"|"P1"|"P2"|"P3"` / `fired_at` / `status: "firing"|"resolved"` / `source` / `alert: AlertInput`——**AlertInput 本体保持 4 字段不动**，它是给模型看的压缩视图，结构化字段只在信封与持久化层）+ `config/gateway.yaml`（`port` / `bind: "loopback"` / `token`（独立 hook token，**不复用其他凭据**）/ `autoDiagnoseSeverities: ["P0","P1"]` / `dedupeTtlMinutes` / `maxInflightPerService`）
- [x] P13-74 **HTTP 服务骨架**：`src/server/gateway/server.ts` —— `node:http` 起服务（**零新依赖**，对齐 CLI「纯 Node、零新依赖」惯例），仅 loopback bind；请求体大小上限（如 64KB）+ 超时；进程级错误隔离：单请求异常不影响主监听
- [x] P13-75 **hooks 端点与鉴权**：`POST /hooks/alert` —— Bearer token 恒定时间比对（防时序侧信道）；token 缺失/错误 → 401，payload 非法（schema 校验）→ 400；健康检查 `GET /healthz`；**query string 里传 token 一律拒绝**（对齐 openclaw 口径）
- [x] P13-76 **payload 适配层（mapping）**：`src/server/gateway/adapters.ts` —— 各告警平台 payload → `AlertEnvelope` 的纯函数转换器；首版先实现一个通用 JSON 适配器（字段映射表驱动，config 里可配 `titleField` / `serviceField` 等），后续按接入的平台（Prometheus Alertmanager / 灯塔 / 自研）逐个加；转换失败明确报错不猜字段。**fingerprint 生成规则**（适配层职责，纯函数）：平台自带 fingerprint/dedup 键（如 Alertmanager 的 `fingerprint`）则**透传**；否则本地算 `sha256(source + "|" + alertName + "|" + service + "|" + sorted(labels_json))` —— 刻意**不含 timestamp / 实例 ip / 计数值**，保证「同一条告警的重试与重复通知」哈希一致，而「换了实例/换了的标签集」是不同指纹。**severity 归一化**：severity 由告警平台判定、随 payload 传入，网关**只做映射不判断**（critical/fatal→P0、error/high→P1、warn→P2、info→P3 映射表可配）；payload 缺 severity 或映射表未命中 → 一律降级 P2（宁可少自动诊断，不可误触发）
- [x] P13-77 **幂等与持久化**：`src/server/gateway/store.ts` —— SQLite 表 `fiat_alert_event`（`id` / `fingerprint` / `status` / `severity` / `envelope_json` / `diagnosis_session_id?` / `created_at` / `last_seen_at` / `last_diagnosis_at?`）；幂等判定（store 层纯查询 + 插入/更新，**单进程内用 SQLite 串行性兜底，不加分布式锁**）：`SELECT ... WHERE fingerprint = ? AND status = 'firing'` 命中 → 只 `UPDATE last_seen_at = now`（若 `severity` 比现存**升级**则视为新事件重新诊断，降级只记不改）；未命中 → INSERT + 触发下游分级。`resolved` 推送 → `status='resolved'` 关闭活跃告警；`dedupeTtlMinutes` 兜底：firing 超过该时长无后续推送 → 视为过期（平台丢了 resolved），状态改 `stale`，此后同 fingerprint 再来按新事件处理。表结构与会话存储同库（复用既有 SQLite 栈）
- [x] P13-78 **severity 分级策略**：`src/server/gateway/policy.ts`（纯函数，零 Pi 依赖）—— P0/P1 → 自动起诊断；P2/P3 → 只落库 + Lark 发摘要卡（带「让 Agent 诊断」的触发指引，人回一句即可唤起）。**限流（防告警风暴）逻辑**：per-service **inflight 计数器**（进程内 `Map<service, number>`，诊断开始 +1、结束（成功/失败/超时）-1）+ 有界等待队列；新告警到闸：`inflight < maxInflightPerService` → 立即诊断；`≥ max` 且队列未满 → 入队（**同 fingerprint 的等待期内新推送合并去重**）；队列满 → 事件标 `throttled` 落库 + 汇总后 Lark 节流通知（**绝不静默丢弃**）。选 inflight 计数而非固定速率窗口的原因：诊断单次耗时波动大（fan-out 多视角子会话），按「同时在跑几个」限才能守住 token 预算，速率窗口挡不住长耗时堆积
- [x] P13-79 **诊断执行链**：`src/server/gateway/runner.ts` —— `AlertEnvelope.alert` → 复用 `src/server/session/factory.ts` 起独立 AgentSession（角色/env 取配置，缺省 ops/prod 只读口径）→ 组装诊断 prompt（含信封结构化信息：severity / fired_at / 原文 detail）→ 模型走 `fiat_alert_diagnosis`（或直接调 `diagnosisPlan` + `runFanout`，实现时按子会话工具注册口径二选一，**不改 plan/fanout 纯函数**）→ `renderReport()` 出报告 → 回写 `diagnosis_session_id`
- [x] P13-80 **Lark 回推**：复用 `fiat_lark_send` 既有通道把报告卡发值班群；P0 附审批提示（若诊断建议含写操作，指引走 `approve/reject` 工单流，网关**绝不直接执行写**）
- [x] P13-81 **CLI 与测试**：`fiat gateway`（启动常驻进程，前台跑，daemonize 不做）/ `fiat gateway status`；测试 `test/gateway-server.test.ts`（鉴权 / 4xx / 体积上限）、`gateway-store.test.ts`（fingerprint 幂等 / resolved 闭环）、`gateway-policy.test.ts`（分级 / 限流纯函数分支）、`gateway-e2e.test.ts`（curl 模拟推送 → stub Lark → 断言落库与诊断触发，模型层用 faux provider）；同步 `workspace/AGENTS.md` 工具清单与本节

**阶段 13 硬约束（实现时不得破）**：

1. 网关进程**不持模型凭据以外的新权限面**：诊断走既有三道闸门（角色谓词 / 策略引擎 / 审计），与 chat 同一套实现，不出现第二套权限。
2. hook token 独立配置，不复用网关/模型/审批任何既有 token；仅 loopback bind，要暴露给告警平台须经 reverse proxy（文档注明，不做内建 TLS）。
3. `AlertInput` 4 字段契约不动；结构化字段只存在于 `AlertEnvelope` 与 `fiat_alert_event`。
4. 网关对诊断子会话**只有编排权**：拆视角、聚合、报告全部复用 `diagnosis/{plan,fanout}.ts`；不做「网关版简化诊断」。
5. 写操作零例外走工单：网关链路里任何环节都不直接执行 L3+ 工具。
6. 告警风暴防护是硬需求：fingerprint 去重 + severity 分级 + inflight 限流三者缺一不可，缺省全开。

### 阶段 14：Langfuse 全链路追踪（一条执行链路 = 一条 trace，OTLP/HTTP）

> 方向确认于 2026-09-20。触发背景：现有可观测面是**三张彼此不连通的网**——`fiat_audit_log` 记「每次工具调用」（只追加、面向合规追责）、`fiat_eval_*` 三表记「每轮轨迹」（面向离线重算）、`GatewayEvent` 只活在网关进程内存里。**没有任何一层能回答「这一次用户请求 / 这一条告警，从头到尾发生了什么、慢在哪、token 花在哪、被哪道闸门拦下」**：审计里看不到 LLM 轮次与 token，评测里看不到审批工单与蜂群诊断，网关事件流出了进程就没了。本阶段补上「一条执行链路 = 一条 trace」的**纵向视图**，并把 chat / diagnose / gateway / 评测 / 进化五种入口收进同一套 span 语义。

验收：`tracing.enabled: true` 时——① `fiat chat` 跑一轮，本地 stub OTLP 端点收到 **1 个 OTLP/HTTP JSON 批次**：`traceId` 唯一、span 树闭合（每个 `parentSpanId` 都能追到根）、根 span 名 `fiat.turn`，其下至少 1 个 `generation`（带 `gen_ai.request.model` + `langfuse.observation.usage_details`）与 N 个 `tool` 子 span（`mcp_rag_*` 之下还有 `fiat.mcp.call`）；② **闸门② block 的工具仍然出 span**（`fiat.gate.tool_call="block"`、`langfuse.observation.level=WARNING`）；③ `fiat gateway` 推一条 P0 告警 → **同一条 trace** 下挂 N 个视角 span + 各自子会话的 generation 链（parent 指向 alert 根 span，不是新建 trace）；④ `tracing.enabled: false`（缺省）→ 零网络调用、零定时器、零行为变化、现有测试全绿。`npm run check` + `npm test` 全绿（新增 tracing 用例）。

设计依据：Langfuse 官方 OpenTelemetry 接入文档（`langfuse.com/integrations/native/opentelemetry`：端点 / Basic Auth / `x-langfuse-ingestion-version` 头 / `langfuse.*` 属性映射表）+ Langfuse OpenAPI 对 `/api/public/ingestion` 的弃用标注（`deprecated: true`，「2026-11-16 起 Langfuse Cloud 只接受 `score-create`，其余类型一律拒绝」）。

**关键决策 A：必须走 OTLP，不能用 Langfuse 的 batch ingestion API。**

| 传输 | 端点与形状 | 结论 |
|---|---|---|
| Langfuse batch ingestion（v2） | `POST /api/public/ingestion`，body `{batch:[{id,type,timestamp,body}]}`，`type ∈ trace-create / span-create / generation-create / span-update / ...` | ❌ 官方已标 **deprecated**；Cloud 自 **2026-11-16** 起只接受 `score-create`。今天（2026-09-20）照它落地 = 两个月后必坏 |
| **OTLP over HTTP（JSON）** | `POST {host}/api/public/otel/v1/traces`，`Content-Type: application/json`，`Authorization: Basic base64(pk:sk)` + **`x-langfuse-ingestion-version: 4`** | ✅ 官方指定迁移路径；JSON 编码即可，**零新依赖** |

`x-langfuse-ingestion-version: 4` **不是可选项**：不带它数据走 v4 之前的兼容路径，UI 里最长延迟 10 分钟才可见。

**关键决策 B：自研极简 exporter，不引官方 `langfuse` SDK。**

| | 官方 `langfuse` Node SDK | 自研 OTLP exporter（本阶段） |
|---|---|---|
| 依赖面 | 拖进 `@opentelemetry/{api,sdk-trace-node,exporter-trace-otlp-http,resources,semantic-conventions}` 一整棵树 | **零新依赖**（原生 `fetch`），与阶段 13「纯 Node、零新依赖」同一口径 |
| 我们要的 span 语义 | 自动埋点是 HTTP/DB/框架级，**闸门 / 工单 / 蜂群 / 进化一个都盖不到**——业务 span 照样全部手写 | 同样手写，工作量一致 |
| 离线可测性 | 要 mock OTel exporter 内部结构 | 注入 `TracingClient` 接口：`InMemoryTracingClient` 断言 + 本地 stub HTTP server 直收 payload |
| 代价 | — | 放弃 OTel 生态的 auto-instrumentation / Sampler / BatchSpanProcessor；自研有界队列 + 背压 + 重试（约 120 行） |

结论：**自研**。与 `AuditClient` / `EvalSink` / `PolicyClient` 完全同构——接口 + `Noop` / `InMemory` / `Http` 三实现，工厂注入。

**Span 语义（Langfuse 数据模型映射）**：Langfuse 无独立 trace 实体，**根 span 即 trace**。trace 级属性必须下发到**每一个** span（官方明确：要按 userId / sessionId / tags 过滤，必须传播到全部 span，不能只放根 span）：

| 我们的语义 | OTLP 属性 | 落成 Langfuse |
|---|---|---|
| 根 span 名 | span `name` | trace name |
| 会话（多轮聚合） | `langfuse.session.id` = sessionId | Session 分组 |
| 用户 / 角色 / 环境 | `langfuse.user.id` + `langfuse.trace.metadata.{role,environment}` | 过滤维度 |
| 入口类型 | `langfuse.trace.tags` = `["chat"\|"gateway"\|"diagnose"\|"ci"\|"evolution", env, role]` | Tags |
| LLM 轮 | `langfuse.observation.type="generation"` + `gen_ai.operation.name="chat"` + `gen_ai.request.model` + `gen_ai.usage.*` + `langfuse.observation.usage_details`(JSON) | Generation（token / cost 面板） |
| 工具调用 | `langfuse.observation.type="tool"` | Tool |
| 闸门 / 工单 / MCP / 蜂群 | `langfuse.observation.type="span"`（缺省） | Span |
| 错误 / 被拦 | `langfuse.observation.level` = `ERROR` / `WARNING` + OTLP `status.code=2` | 高亮 |

Span 名用**点分层级**（`fiat.turn` / `fiat.llm.turn` / `fiat.tool` / `fiat.mcp.call` / `fiat.gate.*` / `fiat.ticket.*` / `fiat.fanout.angle` / `fiat.alert.*` / `fiat.evolution.review`），一眼看出链路阶段。

**Span 树（两个典型入口）**：

```text
fiat.turn                     ← 根（= trace）；sessionId / userId / role / environment / tags
├─ fiat.gate.build            闸门①：按角色+环境裁剪工具集（注册 N / 裁剪 M）
├─ fiat.llm.turn #1           generation：model / tokens / stopReason
│   ├─ fiat.tool mcp_rag_query_knowledge_hub          tool
│   │   └─ fiat.mcp.call      MCP callTool（transport / 耗时）
│   └─ fiat.tool fiat_cashback_reconcile              tool
├─ fiat.llm.turn #2           generation（被拦工具的回灌结果在这一轮收口）
│   └─ fiat.tool <blocked>    tool, level=WARNING, fiat.gate.tool_call="block"
├─ fiat.gate.can_execute      闸门③：唯一权威判定〔实做挂在本轮，见下「偏差二」〕
└─ fiat.ticket.create         工单落地（pending，含幂等键）〔实做挂在本轮，见下「偏差二」〕
```

> 原设计曾把 `fiat.gate.can_execute` / `fiat.ticket.create` 画在 `fiat.tool fiat_cashback_reconcile`
> 之下（"工具 → 它的闸门判定 / 工单"）。**实做落在 `fiat.turn` 这一层**，原因见下方「偏差二」——
> 树形仍闭合（`parentSpanId` 全部可追到根），只是这两类 span 比设计浅一层。
> `fiat.ticket.apply` 同理：人点卡片触发时通常已不在某一轮之内，挂在本轮 / 会话默认父上。

```text
fiat.alert.handle             ← 根（= trace）；tags=[gateway, P0]；metadata={fingerprint, source}
├─ fiat.alert.dedupe          幂等判定（命中 → 提前收口 deduped）
├─ fiat.alert.classify        severity 分级（纯函数）
└─ fiat.fanout.angle × N      并行诊断：**子 span，不是新 trace**（parent = alert 根）
    └─ fiat.turn              子会话完整子链路（同 fiat.turn 结构）
```

> ⚠️ **实做偏差（2026-09-20，P14-89 落地时确认）**：原设计与本文档曾列 `fiat.alert.queue`
> （inflight 限流 admit / queued / throttled）作为第三段子 span，**实现时未落地**。
> 原因不是遗漏而是**限流判定当前根本不存在**：阶段 13 的 `InflightGate` 只被 `GatewayServer`
> 持有（`server.ts` 的 `void inflight;` + 注释「由 runner 层消费」），而 `gateway/runner.ts`
> 的 `AlertGateway` 从未接过 gate、也没调用过 `tryAcquire` ——
> 于是 `AlertEventRecord.throttledCount` 永远为 0、`nextQueuedAfterRelease` 无调用点。
> 给一个**不发生的事件**补 span 是造假，故本轮不补。等限流真正接进 runner（阶段 13 遗留项，
> 属于行为变更、需单独立项）时，在同一位置补 `fiat.alert.queue` 即可，采集层无需改动。

> ⚠️ **实做偏差二（2026-09-20，P14-90 联调时确认）**：`fiat.gate.can_execute` 与 `fiat.ticket.*`
> **挂在本轮（`fiat.turn`）之下，而不是设计图里的 `fiat.tool` 之下**。两个都是硬原因、不是懒：
>
> 1. **闸门③ 必然先于工具 span 存在**。`fiat.tool` 由 L1a trace-hook 在 `tool_call` 里开；
>    而 `canExecute` 是 **permission-gate 在同一个 `tool_call` 里、排在 trace-hook 之前**调用的
>    （工厂顺序 `[gate, audit, modelRouter, …, traceHook]`，"闸门必须最先"是硬约束）。
>    于是 `trace.toolSpans` 注册表里**还没有**这条 toolCallId —— 查也是空手，只能挂本轮。
> 2. **`CanExecuteReq` 本身不带 `toolCallId`**（`policy/engine.ts` 只有 `user/tool/environment/input`）。
>    要按 toolCallId 找父 span，就得给这个**纯函数**的入参加字段——而 `engine.ts` 的价值正是
>    「零依赖纯函数、被 20+ 测试直接断言」，为一个 span 的层级去动它是本末倒置。
>
> 落到本轮是**保守且正确**的选择：归属仍在「这一轮」内，`fiat.tool.name` 属性照旧落在
> span 上，按工具过滤不受影响；只有"工具 → 闸门"这层视觉嵌套没了。
> 若将来确实要这层嵌套，正确做法是**把 toolCallId 一路透传**（`BeforeToolCallContext` 里有
> `toolCallId`）——属于接口变更，单独立项，不要顺手塞进采集层。

> ⚠️ **实做偏差三（2026-09-20，P14-90 联调时修复的真实缺陷）**：`fiat.llm.turn` 一度
> 与 `fiat.turn` 成了**兄弟**（父都是 `wiring.parentSpanId`），即 `angle → {turn, generation}`，
> 与设计图「angle → turn → generation」不符；根入口侥幸看不出——`startRootSpan` 复用
> `startTrace` 预留的 id，generation 的父（`rootSpanId`）**正好等于** `fiat.turn` 的 spanId。
> 修法：`TracingWiring` 增 `turnSpanId`，`PiHostLoop.runTurn` 开轮时登记、收口时清空，
> trace-hook 以它为父（退化顺序 `turnSpanId ?? parentSpanId ?? rootSpanId`）。
> 为什么是 wiring 而不是 `TraceContext`：后者**整条 trace 共享**（蜂群 N 个视角同一个 ctx），
> 写进去会被并行视角互相踩；wiring 是会话级的（每视角一个、chat 每轮一个）。
> 同类修正：`fiat.gate.can_execute` / `fiat.ticket.*` 原本缺省的父是 `ctx.rootSpanId`，
> 在蜂群场景会**直接挂到告警根**、跳出视角树枝；现统一改走 `turnSpanId ?? parentSpanId ?? rootSpanId`。
>
> 这三类父归属（本轮 / 会话默认 / 根兜底）与「`fiat.tool` → `fiat.mcp.call`」这一跳的覆盖见
> `test/tracing-l2.test.ts`（闸门③ 装饰器 + 工单，**零 Pi 依赖、毫秒级**）与
> `test/mcp-rag.test.ts` 用例 ④（faux + 真实 trace-hook，钉住 `trace.toolSpans` 注册表契约）。

> ⚠️ **验收口径说明（2026-09-20，P14-90 收尾时补记）**：P14-90 要求的「`npm test` 全绿」在**本机
> 默认隔离模式**（`vitest --run`，`isolate: true`）跑不出干净的绿——不是测试有问题，是**冷加载成本**：
> 43 个测试文件每一个都要独立 import 一遍本地 Pi TS 源码（vitest 别名指向 `../pi/packages/*/src`），
> 实测 ~150s/文件；4 个 worker 并行时 `import` 累计近 7000s，CPU 互相争抢会把「用例体内动态 import」
> 或「磁盘 IO 密集」的用例顶穿 5s 默认超时。
>
> 本机两条可用跑法（都已验证）：
>
> - `npx vitest --run --no-isolate --maxWorkers=1` —— **推荐**：模块图只付一次导入、零争抢，
>   全量 375 用例数分钟跑完；
> - `npx vitest --run --no-isolate --maxWorkers=4` —— 更快，但会出现**争抢假红**，必须隔离复跑甄别，
>   别把它当真失败。
>
> 顺带收拾了三处**环境脆弱**（断言一字未改，只挪成本 / 加余量）：`host-duties.test.ts` 把用例体内的
> `await import("host/session.ts")` 提到文件级（那笔冷加载被算进用例耗时，实测 51s）；
> `cli-chat.test.ts` ×2、`evolution-skillstore.test.ts` ×1 给显式超时。
> 另修一处**与阶段 14 无关的既有 bug**：`evolution-apply.test.ts` 的记忆落盘断言写死了日期
> `2026-09-12` 却没注入时钟（文件名取真实日期）→ 只在当天能绿。

**蜂群必须挂同一棵 trace**：`diagnosis/{plan,fanout}.ts` 是多视角并行；若每个子会话各开一条 trace，Langfuse 里「一条告警 → 5 个视角 → 37 次工具调用」会碎成 6 条互不相关的 trace，「哪条链路慢、哪个视角在烧 token」直接看不出来。实现上 `fanout` 只多传一个 `parentSpanId`——与评测侧 `parentRunId` 同构。

**采集点（不改 Pi 核心，全部复用既有通道）**：

| 层 | 落点 | 产出 span |
|---|---|---|
| L1a（新增） | `host/l1a/trace-hook.ts`：`turn_start` / `turn_end` + 桥接的 `tool_call` / `tool_result` | `fiat.llm.turn`（generation）、`fiat.tool` |
| 宿主 | `host/loop.ts` 的 `runTurn` / `runTurnSafe` | `fiat.turn`（根）、provider 错误 → span status |
| 组合根 | `session/factory.ts` 注入 tracer + 尾追 trace-hook + 装饰 policyClient | `fiat.gate.build`、`fiat.gate.can_execute` |
| L2 | `policy/client.ts` 装饰器 · `approval/ticket.ts` · `host/l1b/mcp-rag.ts` · `diagnosis/*` | `fiat.gate.can_execute`、`fiat.ticket.*`、`fiat.mcp.call`、`fiat.fanout.angle` |
| 入口 | `gateway/runner.ts` · `cli/chat.ts` | `fiat.alert.*`、根 span 生命周期与 flush |

**⚠️ 被 block 的工具也要出 span（已知坑的正确用法）**：`ExtensionRunner.emitToolCall` 对 block 请求**短路返回**（runner.js:639-657），排在 factories 尾部的 trace-hook 收不到被拦调用的 `tool_call`；且被拦不产生 `tool_result`。这与阶段 11 eval-recorder 踩的是同一个坑，但**处置不同**——eval 干脆不走 `tool_call`，trace **两者都要**：

1. `tool_call` 钩子 → 开 span（此刻已知 args；「能开到」本身就等价于 `fiat.gate.tool_call="allow"`）；
2. `tool_result` 钩子 → 关 span（补结果 / isError / 耗时）；
3. `turn_end.toolResults` → **对账补齐**：凡出现在本轮 toolResults 中、却没有对应已开 span 的调用，就是被闸门②拦下的——补一条瞬时 span 并标 `fiat.gate.tool_call="block"` + `level=WARNING`。

第 3 步是**对账**而非兜底：它同时解决「模型猜名调用被闸门①裁掉的工具 → `Tool x not found`」这类越权尝试在 trace 里隐形的问题——**被拦的尝试和成功的调用一样值得被看见**。

**采样 / 背压 / 脱敏（三条硬约束的实现口径）**：

- **采样**：per 入口类型 `sample_rate`（chat 可降；gateway / ci 保持 1.0——告警与评测链路必须全采）。采样决策在**根 span 做一次**，子 span 跟随；不做 per-span 采样，否则 trace 会碎成半棵树。
- **背压**：有界队列（`max_queue`），满则**丢最旧**并累加 `dropped`；批次 `max_batch` + `flush_interval_ms` 定时刷（定时器必须 `unref()`，**不许把进程钉住**），进程结束 / `SIGINT` 显式 `flush()`。上报失败**只重试 `max_retries` 次、只记计数、绝不抛**。
- **脱敏**：`capture_content: "off" | "redacted" | "full"`，**缺省 `redacted`**：`input` / `output` 走与审计 / 评测**同一份口径**（只留键 + 短标量 + 长文本截断 + 嵌套以 `<type>` 占位）；`off` 时 payload 里**一个业务文本都没有**；`full` 需显式配置，且 `redact_keys` 命中的键（`prompt` / `token` / `api_key` / 卡号证件号类）在**三种模式下都一律遮成 `[redacted]`**。

**配置（人写锚点，与 `tool_policies.yaml` 同级；`enabled` 缺省 false）**：

```yaml
# config/tracing.yaml（阶段 14 / P14-82）
tracing:
  enabled: ${FIAT_TRACING_ENABLED:-false}   # 缺省关；关时零网络、零定时器、零行为变化
  provider: langfuse
  endpoint: ${LANGFUSE_OTLP_ENDPOINT:-https://cloud.langfuse.com/api/public/otel/v1/traces}
  public_key_env: LANGFUSE_PUBLIC_KEY       # 只存**环境变量名**，密钥值永不落到配置文件
  secret_key_env: LANGFUSE_SECRET_KEY
  ingestion_version: "4"                    # 必须带：不带则 UI 延迟最长 10 分钟
  service_name: fiat-agent
  capture_content: redacted                 # off | redacted | full
  redact_keys: [prompt, password, token, api_key, id_card, bank_card, card_no]
  sample_rate: { chat: 1.0, gateway: 1.0, diagnose: 1.0, ci: 1.0, evolution: 1.0 }
  batch:
    max_queue: 2048
    max_batch: 64
    flush_interval_ms: 2000
    max_retries: 2
    timeout_ms: 5000
```

- [x] P14-82 **契约与配置**：`src/server/tracing/types.ts`（`TracingConfig` / `TraceKind` / `SpanKind` / `TraceSpan`（`traceId` / `spanId` / `parentSpanId?` / `name` / `kind` / `startNs` / `endNs` / `attributes` / `status` / `level`）/ `AttributeValue` 联合类型 / `TraceContext`（一次 trace 的共享上下文：`traceId` + 根 `spanId` + 采样结论 + trace 级属性）/ `Tracer` 接口）+ `src/server/tracing/config.ts`（`loadTracingConfig(path?)`：读 yaml + `${VAR:-default}` 插值 + 校验——`enabled=true` 而公钥/密钥环境变量缺失 → **fail-fast 抛错**（同 gateway token 口径，不静默降级成「追踪悄悄不工作」）；`capture_content` 非法值 / `sample_rate` 越界 → 拒绝；`DEFAULT_TRACING_CONFIG` 使 `enabled=false`）+ `config/tracing.yaml`
- [x] P14-83 **OTLP 编码器（纯函数，零依赖）**：`src/server/tracing/ids.ts`（`randomTraceId()` 32 hex / `randomSpanId()` 16 hex / `msToNanos` / `hexId` 校验）+ `src/server/tracing/otlp.ts`（`encodeOtlp(spans, ctx, cfg)` → `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }`：`startTimeUnixNano` 字符串、`attributes` → `{key, value:{stringValue|intValue|doubleValue|boolValue|arrayValue}}`、`langfuse.*` 属性映射、**trace 级属性下发到每个 span**、`gen_ai.*` 语义约定（`gen_ai.operation.name="chat"` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`）、`status.code` 与 `langfuse.observation.level` 对应、脱敏函数 `redact(value, mode, keys)` 三档 + `redact_keys` 一律遮罩）
- [x] P14-84 **TracingClient 三实现 + 批处理队列**：`src/server/tracing/client.ts` —— `TracingClient` 接口（`send(spans)` / `flush()` / `shutdown()` / `stats()`）+ `NoopTracingClient`（`enabled=false`，**零网络零定时器**）/ `InMemoryTracingClient`（测试断言，与 `InMemoryAuditClient` 同构）/ `HttpOtlpTracingClient`（原生 `fetch` + `AbortSignal.timeout`；Basic auth `Buffer.from(pk + ":" + sk).toString("base64")`；必带 `x-langfuse-ingestion-version`；有界队列丢最旧 + `max_batch` + `flush_interval_ms` 定时器 `unref()` + 重试 + `dropped` 计数；**任何失败都不抛**）
- [x] P14-85 **Tracer 与 span 构建器**：`src/server/tracing/tracer.ts` —— `createTracer(cfg, client)`：`startTrace({name, kind, sessionId, userId, role, environment, metadata})` → `TraceContext`（生成 traceId + 根 spanId、按 `sample_rate[kind]` 采样，允许注入 `random` 保证测试确定性）；`startSpan(ctx, name, opts)` → `SpanHandle`（`setAttribute` / `setInput` / `setOutput` / `setModel` / `setUsage` / `setLevel` / `setStatus` / `end()`，`end()` 幂等）；`withSpan(ctx, name, opts, fn)`（异常自动 `recordError` 后 rethrow）；`shutdown()`（flush + 取消防抖定时器）；**span 仅在 `end()` 时入队**（OTLP 无 update 事件，一次成型）
- [x] P14-86 **L1a trace-hook**：`src/server/host/l1a/trace-hook.ts` —— `turn_start` 开 `fiat.llm.turn`（generation）/ `turn_end` 关 span + `gen_ai.usage.*`（取自 `event.message.usage`）+ **对账补 blocked tool span** / `tool_call` 开 `fiat.tool` / `tool_result` 关 span（isError → ERROR）；**尾部追加、只读不拦、缺省不注册**；位置契约更新为 `[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?, ...traceHook?]`
- [x] P14-87 **宿主与组合根接线**：`PiHostLoop` 新增可选 `tracer` + `trace: TraceContext`（`runTurn` 开/关根 span `fiat.turn`，`runTurnSafe` 把 provider 错误写 span status/level）；`buildSession` 新增 `tracer?` → ① 开 `fiat.gate.build` span（记录角色 / 环境 / 注册工具数）② 尾部追加 trace-hook ③ 用装饰器包 `policyClient` 产出 `fiat.gate.can_execute` span；`SessionFactoryResult` 透出 `tracer`
- [x] P14-88 **L2 全链路子 span**：`approval/ticket.ts` 新增可选 `tracer`（`fiat.ticket.create` / `fiat.ticket.approve` / `fiat.ticket.apply` 三处，含幂等键与 token 校验结论）；`host/l1b/mcp-rag.ts` 的 `callTool` 外包 `fiat.mcp.call` span（transport / 耗时 / isError）；`diagnosis/fanout.ts` + `sessionRunner.ts` 透传父 span（每视角一个 `fiat.fanout.angle` span，**挂同一 trace**），子会话用该 span 作父
- [x] P14-89 **gateway / evolution / CLI 接线**：`gateway/runner.ts` 在 `handleAlert` 开根 span `fiat.alert.handle`（tags=`[gateway, severity]`、metadata=`{fingerprint, source}`）+ dedupe / classify / queue 三段子 span，诊断派发把该 `TraceContext` 透传给 `diagnose()` 使蜂群挂同一棵树；`cli/chat.ts` 装配 tracer 并把 `TraceContext` 交给 `PiHostLoop`；evolution 评审 fork 开独立 trace（`fiat.evolution.review` + metadata `parentSessionId`）；`cli/index.ts` 新增 `fiat trace status`（打印 enabled / endpoint / 队列与丢弃计数，**离线零 Pi 依赖**）；`shutdown` 在 `fiat chat` 结束与 gateway `SIGINT` 时显式 flush；同步 `workspace/AGENTS.md`
- [x] P14-90 **测试与验收**：`test/tracing-otlp.test.ts`（纯函数：traceId 32 hex / spanId 16 hex / nanos 合法 / `langfuse.*` + `gen_ai.*` 映射 / **trace 级属性出现在每个 span** / 脱敏三档 + `redact_keys` 遮罩）+ `test/tracing-client.test.ts`（本地 stub HTTP server 收包：Basic auth 头与 `x-langfuse-ingestion-version` 正确、批次大小、定时 flush、**队列满丢最旧且计数**、上报失败只重试不抛、`enabled=false` 零请求）+ `test/tracing-hook.test.ts`（faux provider 驱动完整会话：根 span + N 个 generation + tool span **树闭合**；**闸门② block 场景仍出 span 且 level=WARNING**）+ `test/tracing-e2e.test.ts`（gateway 推一条 P0 → 同一 `traceId` 下 alert 根 + N 个视角 span + 子会话 generation 链）；`npm run check` + `npm test` 全绿

**阶段 14 硬约束（实现时不得破）**：

1. **追踪只读不拦**：trace-hook 只订阅、绝不返回 `block`、绝不改写 `event.input` / `content`——与 eval-recorder 同一条底线（唯一合法副作用是 span 入队，且发生在 `end()` 之后）。
2. **追踪永不进主链路的失败路径**：`TracingClient` 的任何方法都不得抛；队列满 / 网络错只记计数。**观测系统挂掉不能把业务挂掉。**
3. **缺省关**：`tracing.enabled: false` 走 `NoopTracingClient`，零网络、零定时器、现有测试零改动（fail-safe 惯例，同 `evalSink` / `evolution`）。
4. **密钥只以环境变量名出现**：`config/tracing.yaml` 只写 `*_env`，不写值；`enabled=true` 而变量缺失 → 启动即失败（fail-fast）。
5. **不改 Pi 核心、不改错误语义**：OTLP span 是**旁路**，`Agent` / `ExtensionRunner` / 三道闸门的运行时行为一字不动。
6. **必须走 OTLP**（`/api/public/otel/v1/traces`）；**禁止**回到 `/api/public/ingestion` 的 batch 事件（官方已弃用，2026-11-16 起只收 `score-create`）。
7. **trace 级属性下发到每个 span**（官方明确要求），否则 Langfuse 里按 userId / sessionId / tags 过滤会漏。
8. **蜂群挂同一棵 trace**：`fanout` 透传 `parentSpanId`，不许给子会话各开新 trace。

---

### 阶段 15：跨会话长期记忆（RAG 检索式，参考 Claude Code）

> 方向确认于 2026-09-23。触发背景：阶段 12 的「记忆」只有本地 md 文件（`workspace/memory/YYYY-MM-DD.md`，`evolution/memoryStore.ts:73`），**无检索、无分类、无 scope 隔离**；读取靠 `MemoryStore.recentFacts(maxDays=3, maxChars=1200)`（`memoryStore.ts:106`）**全量注入近 3 天**。三条硬伤：
>
> 1. **召回靠时间窗而非相关性**——三个月前澄清的返现口径，今天再问，它不在「最近 3 天」里，模型根本看不到。记忆越久越没用。
> 2. **每轮都在改 systemPrompt**——按天文件随对话增长，注入文本每轮都变 → **prefix cache 每轮打掉**，与 P12-65「按 name 稳定排序、避免打掉 prefix cache」的初衷自相矛盾。
> 3. **无分类 / 无 scope**——用户偏好、对 AI 的纠正、项目计划、外部指针混在同一条流水里；也没有 per-user 边界（多租户问询时无法回答"我的偏好会不会被同事看到"）。
>
> 本阶段补上「**跨会话、按需检索、分类隔离**」的长期记忆，并把写入侧做成**确定性代码说了算**的链路。

验收：`FIAT_MEMORY=1` 时——① 一场会话里出现「以后都用 X 而不是 Y」这类纠正 → 轮末异步 fork 产出候选 → **确定性落库**到 RAG（向量 + BM25 双索引），主会话**零阻塞、零写工具可见**；② 新会话提问时模型经 `fiat_memory_search` 召回到那条记忆，并在回答里带 id 引用；③ `user` scope 记忆**跨 user 检索不到**（隔离测试为必测项）；④ 写入前一律脱敏（PII 正则兜底）、写入/遗忘**审计双写但正文不入审计、不入 span**；⑤ `FIAT_MEMORY` 未设（缺省）→ 零网络、零行为变化、现有测试零改动。`npm run check` + `npm test` 全绿（新增 memory 用例）。

设计依据（**均为官方文档实读，非推测**）：
- Claude Code 官方 memory 文档（`code.claude.com/docs/en/memory`）：CLAUDE.md（人写，managed / user / project / local 四层，启动时自宽到窄加载）+ auto memory（Claude 自写，per-repository、跨 worktree 共享，**每次会话只加载前 200 行或 25KB**）；以及最关键的一句官方定调——**「Claude 把它们当 context，不是强制配置；要真正阻断一个动作必须用 PreToolUse hook」**。
- Anthropic memory tool 规范（`platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool`）：`memory_20250818` 提供 `/memories` 目录 + 6 个命令（`view`/`create`/`str_replace`/`insert`/`delete`/`rename`），**handler 由客户端实现**（存储后端自选），且**路径穿越防护是强制项**（拒绝 `/memories` 之外的一切路径）。
- 本仓既有同构物：阶段 12 的 fork 八条硬约束（`evolution/reviewer.ts` 文件头）、`evolution/slice.ts:64` 的 `redact()` 二次脱敏、`evolution/policy.ts` 的「**提示词是劝、正则才是拦**」双轨。

---

#### 15.1 关键决策 A：学 Claude Code 的一半，另一半明确不学

| 维度 | Claude Code | 本阶段 | 为什么不一样 |
|---|---|---|---|
| 人写锚点 | CLAUDE.md 四层（managed / user / project / local）+ `.claude/rules/` 按路径限定 | **已有**：`workspace/AGENTS.md` + `config/*.yaml`（P10-51 / 各阶段人写锚点） | 同构，不重复造 |
| 机器写记忆 | auto memory（per-repo，本地文件） | RAG（向量 + BM25），**带 scope** | 要跨工作区边界；要按相关性召回；要 per-user 隔离 |
| 读取方式 | **全量注入**（前 200 行 / 25KB） | **工具按需检索**为主 + 少量热注入 | 注入式没有"相关性"概念；记忆上千条后 25KB 只能装下最新的，等于回到时间窗 |
| 存储后端 | 本地文件（`.memdir` / `/memories`） | RAG MCP（现有 server，**只加 3 个工具**） | 复用已有 hybrid search + RRF + rerank，**零新建检索栈** |
| 写入时机/发起方 | 会话中**模型自己**调 `create` | **轮末异步 fork**，模型只产候选，落库在 L2 | 见决策 B（持久化注入面） |
| 定位 | 「context，不是强制配置」 | 「**记忆不是规则源**」（阶段 12 铁律 4 沿用） | 官方定调与我们的铁律同向，可交叉引用 |

**一句话**：Claude Code 的记忆是「**文件 + 全量注入**」，我们的是「**RAG + 检索 + 隔离**」；它证明了两件事——① 机器自写记忆这条路走得通；② 记忆必须明确「只是 context」，否则会与真实权限配置混淆。第二点直接支撑我们的铁律。

#### 15.2 关键决策 B：写入侧**不给主会话任何写工具**

「在会话中让模型自己 `create` 记忆文件」（Claude Code / Anthropic memory tool 的做法）在本项目**不可接受**，三条理由：

1. **持久化注入面**：写进去的内容在**以后每一次**会话都会被读回并进上下文。一次被 prompt injection 诱导的写入，影响面是「此后所有会话」，而不是「这一次」——比 `tool_call` block 那类「只在当轮生效」的风险高一个量级。
2. **主会话污染**：写记忆需要"刚发生了什么"的上下文，等于把主 transcript 再喂一遍做二次加工，token 与注意力都被占；而主会话的职责是回答用户。
3. **归类不可信**：让模型自己决定「这条是 user 还是 project」，等于把 **scope 判定（决定谁能看到）交给 LLM**——scope 是隔离边界，必须代码说了算。

所以链路是（与阶段 12 完全同构，「LLM 只产候选，代码决定落盘」）：

```text
主会话（只读记忆，工具表里没有写工具）
   │  onUserTurn（host/loop.ts:254，已有钩子，零新增）
   ▼
L2 确定性预筛（纯函数，零 LLM）            ← 新增 memory/policy.ts
   │  信号检测 / 长度上限 / 敏感扫描 / 与权威三源重复检测
   ▼
轮末 fork（HostSession.inMemory、白名单只给 submit 工具、超时、递归防护、永不抛）  ← 新增 memory/extractor.ts
   │  产出**结构化 JSON**（kind + text + evidence），不是自由文本
   ▼
L2 确定性落库（schema 校验 → 脱敏 → supersede 判定 → 调 MCP）  ← 新增 memory/store.ts
   │  memory_store（RAG 侧新增 MCP 工具）→ 向量 + BM25 双写
   ▼
审计双写 + trace span（**正文不入审计、不入 span**）
```

> **LLM 只回答「值不值得记、记什么」，不回答「写到哪、能不能写、给谁看」。**

#### 15.3 关键决策 C：检索侧双轨——热注入一小段，其余全走工具

要求里的主轨「MCP 注册为工具、模型自主判断是否调用」**采纳**。但只做这一轨会留着 15.0 的第 2 条硬伤（每轮 systemPrompt 变、prefix cache 全废），所以补一轨：

| 轨 | 内容 | 进 systemPrompt？ | prefix cache | 谁决定 |
|---|---|---|---|---|
| **热**（稳定偏好段） | 仅 `user` / `feedback` 两类、高置信、未 `superseded`、长度受限的前 N 条（`user` 为主，`feedback` 按最近优先；已晋升的浓缩 `user` 优先于同族 `feedback`，见 15.5） | 是，但**只在会话首轮算一次、全会话冻结** | **保住**（同一会话内字节不变） | 代码确定性筛选 |
| **冷**（工具检索） | `reference` / `project` 及全部历史条目 | 否 | 零影响 | **模型自主调用** |

「**会话级冻结**」是关键：现有 `recentFacts()` 每轮重算 → 每轮 systemPrompt 变 → cache 全废。把热注入定稿在会话创建时（`HostResources.systemPrompt`，`host/resources.ts:79`），记忆与 cache 就不再互斥。

#### 15.4 关键决策 D：记忆与 RAG 知识库**物理隔离**（不同 collection）

RAG 知识库是**权威事实源**（人维护、只读、带引用）；记忆是**派生层**（机器写、可撤销、无权威性）。若混在同一 collection：

- 一条 3 个月前机器写的过时口径，会与权威文档在同一个 hybrid search 里**同权竞争**；
- 且**没人能分辨哪条是权威**——检索结果里两者长得一样。

因此：
- 知识库 collection 现状不动（`knowledge_hub` 等）；
- 记忆 collection：`fiat_memory_<scope>_<key>`（如 `fiat_memory_user_u_1024`、`fiat_memory_repo_fiat-agent-pi`）；
- **检索结果不合并**：`fiat_memory_search` 只搜记忆 collection，`mcp_rag_query_*` 只搜知识库。两个工具在提示词里分工写明——「事实依据查知识库，历史澄清查记忆」。

#### 15.5 四类记忆的口径：`user` / `feedback` / `project` / `reference`

> **本节分类口径由 tog 于 2026-09-23 拍板**，取代初稿的 `user / project / reference / performance` 四分法。**`performance` 这个名字撤销**——它原本是想表达「实现口径」（如「循环用 `for` 不用迭代器」），在新口径下这类记忆**整体归入 `feedback`**：因为它们的成因几乎都是一次具体的纠正或确认，而不是孤立的偏好陈述。

四类不是按「内容主题」切的，而是按「**这条记忆是关于谁的、被什么触发的**」切。归类飘移的代价不是"分类不整齐"，而是**按 kind 过滤失效 + 热注入段塞错东西**，所以每类都必须有一条 LLM 能照做的判定线、并配一个反例。

| kind | 定义 | 判定线（LLM 照着选） | 例子（tog 给定口径） | 典型 scope | 时效 |
|---|---|---|---|---|---|
| `user` | 用户角色、偏好、技能水平 | 关于**人的稳态事实**，**无**「上一轮 / 这次」的时间锚点 | 「偏好函数式风格」；「是后端工程师」；「tog 要结论先行，后跟分层表格」 | `user` | 长期 |
| `feedback` | 用户对 AI 的**纠正与确认** | 含**一次交互事件**：我（AI）做了 X → 用户要求 Y / 认可 Y | 「上次用 `forEach` 被要求改成 `map`」；「回答别铺太长，只要 bullet 式条目」 | `user`（绑定仓库时 `repo`） | 长期（晋升后 supersede） |
| `project` | 项目目标、决策、截止日期 | 是**计划 / 承诺**，含方向或期限 | 「Q3 要迁移到 TypeScript」；「fiat-agent 从 Python+LangGraph 迁到 Pi（TS）」 | `repo` | 中期（`projectTtlDays`） |
| `reference` | **外部系统指针** | 回答「**什么在哪儿**」：外部系统入口，或仓库内权威位置 | 「Bug tracker 在 Linear：xxx」；「工具策略权威是 `config/tool_policies.yaml`」 | `repo` / `global` | 中期（**最易过时**） |

**`user` vs `feedback` 怎么切**（新口径下唯一需要切的一刀，比原 `user`↔`performance` 好切——原始描述里那两类的边界是真重叠，这两类是「结论 vs 证据」，天然可分）：

| 判据 | `user` | `feedback` |
|---|---|---|
| 有没有**事件锚点** | 无（稳态陈述） | 有（「上次」「这次」「你刚才」） |
| 宾语是不是**我（AI）的一次输出** | 不是 | 一定是 |
| 例 | 「偏好函数式风格」 | 「上次用 `forEach` 被要求改成 `map`」 |

> 同一件事可以**两条并存**：`feedback` 是证据（带会话溯源），`user` 是结论（可被热注入）。这不是重复，是 15.6 的幂等键与 supersede 机制要处理的正规形态。

**`feedback` → `user` 的晋升**（⭐ 设计补充，**已拍板（tog，2026-09-23 本轮）** —— 撤销 `performance` 后必须有它，否则「跨项目通用口径」无处安放）：

`performance` 撤销后，「循环用 `for` 不用迭代器」这类**浓缩偏好**若只靠 `feedback` 承载，热注入段会被十条「改 map」「别用 forEach」灌满——而它们**其实是同一件事**。所以定一条晋升链：

| 阶段 | 形态 | 落点 |
|---|---|---|
| 单次纠正 / 确认 | `feedback`（带事件锚点 + `evidence`） | 工具检索可召回 |
| 同向 ≥ `promotionThreshold`（缺省 3）次，且语义相近 | **代码判定**通过 → 新写一条 `user`（提炼式、去事件锚点），同族 `feedback` 全部标 `superseded` | 热注入主内容 |

> 晋升是**确定性判定**：`policy.ts` 按 `sha256(scope + key + kind + 归一化 text)` 聚类 + 文本相似度阈值，**不让 LLM 再判一次**——与 15.2「LLM 只产候选，代码决定落盘」同一口径。旧 `feedback` 只标 `superseded` 不物理删，溯源链完整。

> ⚠️ **`reference` 是最危险的一类**：外部系统会换（Linear → Jira）、仓库内位置会重构。它必须带 TTL + `stale` 标记，且**进回答前要能溯源到具体会话**——模型引用一条过时的 `reference` 比不引用更糟。

#### 15.6 数据模型

```ts
// src/server/memory/types.ts（草案）
export type MemoryKind = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "user" | "repo" | "global";   // 决定隔离边界，由 L2 注入
export type MemoryStatus = "active" | "superseded" | "stale" | "forgotten";

export interface MemoryEntry {
  id: string;                 // 记忆条目 id（RAG 侧生成，全局唯一）
  scope: MemoryScope;
  key: string;                // scope 内的分区键：user → userId；repo → repo 名；global → "shared"
  kind: MemoryKind;
  text: string;               // 单条正文（**硬上限，缺省 300 字**）
  evidence: {                 // 溯源：可撤销的前提
    sessionId: string; userId: string; createdAt: string; trigger: "correction" | "session_end" | "manual";
  };
  confidence: number;         // 0~1，LLM 自评 + 代码下限校验（< minConfidence 直接丢弃）
  supersedes: string[];       // 本条替代了哪些旧条目（旧条目标 superseded，**不物理删**）
  promotedFrom?: string[];    // 仅 kind="user"：由哪些 feedback 晋升而来（晋升链，见 15.5）
  status: MemoryStatus;
  lastUsedAt?: string; usedCount: number;   // 检索侧异步回写（二期）
}

/** LLM 在 fork 里能产出的**全部**字段——注意没有 scope / key */
export interface MemoryCandidate {
  kind: MemoryKind;
  text: string;
  confidence: number;
  reason: string;             // 为什么值得记（供审计摘要，不进记忆库）
}
```

**三条结构性约束**：
1. `scope` / `key` **不在** `MemoryCandidate` 里——LLM 产出中没有隔离字段，由 L2 按主会话 subject 注入（`session/factory.ts:50` 的 `SessionSubject`）。
2. **append-only + supersede**：不物理删（除 `forget` 的合法调用），新条目标 `supersedes`，旧条目标 `superseded`。检索时过滤 `superseded`——这从机制上消灭「两条互相矛盾的 active 记忆」。
3. **幂等键** = `sha256(scope + key + kind + 归一化 text)`。同一事实重复提取不产生新条目（与阶段 12 `applyProposal` 幂等键 `hash(target + 归一化正文)` 同口径）。

#### 15.7 存储：不是"向量 **或** BM25"，是**双写**

原始描述说「通过 RAG 转化为向量，**或者**通过 BM25 转换为倒排索引」——实际 RAG server 是 **hybrid**，两者**同时**写：

| 侧 | 环节 | 现有落点（`MODULAR-RAG-MCP-SERVER`） |
|---|---|---|
| dense 向量 | 编码 + upsert | `src/ingestion/embedding/dense_encoder.py` → `src/ingestion/storage/vector_upserter.py` |
| sparse 倒排 | BM25 建索引 | `src/ingestion/embedding/sparse_encoder.py` → `src/ingestion/storage/bm25_indexer.py` |
| 召回融合 | dense + sparse → RRF | `src/core/query_engine/hybrid_search.py` + `fusion.py`（+ 可选 `reranker.py`） |

**结论：不需要新写检索栈**，只要给 ingestion pipeline 加一条「memory 写入入口」，并在检索时把 collection 限定到 `fiat_memory_*`。

RAG 侧需新增 **3 个 MCP 工具**（当前 3 个工具全是只读：`query_knowledge_hub` / `list_collections` / `get_document_summary`，见 `src/mcp_server/tools/`）：

```python
# memory_store —— 写（只由 L2 确定性代码调用，不注册给任何会话）
{ "scope": "user|repo|global", "key": str, "kind": str, "text": str,
  "evidence": {...}, "confidence": float, "supersedes": [id, ...] }
→ { "stored": id, "superseded": [id, ...] }          # 双写向量 + BM25

# memory_search —— 读（注册为 L1b 工具，模型自主调用）
{ "query": str, "scope": str, "key": str, "kinds": [str]?, "top_k": int = 5 }
→ [ { "id", "kind", "text", "score", "status" } ]     # 强制按 scope+key 过滤

# memory_forget —— 撤销（CLI / 人触发，不注册给会话）
{ "ids": [id, ...] } → { "forgotten": int }
```

> ⚠️ `memory_search` 的 `score` **必须标明语义**（RRF 融合分还是 rerank 分），否则模型会把「分数 0.82」当置信度解读。缺省不加 reranker，score = RRF 融合分。

> 📌 **上面的入参形态是设计意图，不是最终 schema。** RAG 侧落地时的**实际 schema 与返回体**见 `MODULAR-RAG-MCP-SERVER/DEV_SPEC.md` 阶段 J：写工具 → **J4.1**；检索工具 → **J5.1 / J5.3**（返回体多了 `score_type` / `scope` / `key` / `degraded` 四个必需字段，理由见该处表格）；撤销工具 → **J6**。两侧形态的唯一事实源是本文档 §15.16 的**跨仓库契约表**。

#### 15.8 触发：不要每轮都跑

「每轮结束都让 LLM 判断」是原始描述里的原话，但**每轮一次 fork = 每轮一次额外 LLM 调用**，token 成本与延迟都不可接受（chat 场景一轮可能就几秒）。改成**确定性信号 + 兜底**：

| 触发点 | 判据 | 位置 | 典型产出 kind | 成本 |
|---|---|---|---|---|
| **纠正信号**（主） | 用户文本命中纠正/偏好措辞（「不对」「应该是」「以后都」「记住」「不要再用」…），或本轮出现「工具失败 → 改参数后成功」 | 宿主 `onUserTurn` 之后，确定性正则 | **`feedback`**（几乎必然；提示词硬约束：纠正信号命中时优先出 `feedback`，不要直接跳到 `user`） | 零 LLM 预筛；命中才起 fork |
| **累计轮次**（次） | 会话内用户轮次 ≥ `minTurns`（缺省 3）且本会话提取次数 < `maxRunsPerSession` | 宿主 | `user` / `project` / `reference` | 同上 |
| **会话结束**（兜底） | `agent_end` / REPL 退出前跑最后一次 | 宿主 | 四类皆可（兜底清扫） | 每会话最多 1 次 |

> **触发点与 kind 的对应关系是提示词的一部分，不是巧合**：纠正信号是 `feedback` 的**天然采集口**（15.5 的「事件锚点」正好在用户这句话里），所以命中纠正信号时若 LLM 产出别的 kind，`policy.ts` 应记录一次归类漂移告警（不拒，但可观测）。

> **确定性预筛（`memory/policy.ts`，纯函数、零 LLM）在 fork 之前**：信号检测 → 候选长度上限 → 敏感扫描 → 「与权威三源重复检测」（知识库 / `AGENTS.md` / `config/*.yaml` 里已有的事实不记，与阶段 12 `MEMORY_GUIDE` 第 3 条同构）。**预筛不过 = 连 fork 都不起**，省掉无用 LLM 调用。

#### 15.9 安全红线：记忆是**持久化**注入面

这是本阶段与前 14 个阶段**性质不同**的风险：以往的风险面是「当轮」的（block 一次调用、拦一次写入），记忆的风险面是「**此后所有会话**」。四条对策：

1. **写入口唯一**：只有 `memory/store.ts` 能写，且只接受过 schema 校验的 `MemoryEntry`。主会话工具表里**永不出现**写工具（硬约束 1）。
2. **禁写形态用正则兜底**：与阶段 12 `policy.ts` 同思路（提示词是劝、正则才是拦）。禁止写入：
   - **规则形态**：「以后一律…」「无需审批」「跳过校验」「免复核」→ 直接拒（记忆绝不能成为第二规则源）；
   - **生产数据**：订单号 / 金额 / 手机号 / 卡号 / 邮箱 / 用户标识 → 命中即拒（不脱敏后入库，而是**整条丢弃**——脱敏后的记忆往往已失去价值，留着一个残缺事实更危险）；
   - **指令性内容**：形如「你必须…」「忽略之前的…」的祈使句 → 拒（这就是 prompt injection 的形态本身）。
3. **正文不进审计、不进 span**：审计只记 `id` / `hash(text)` / `length` / `kind` / `scope` / `evidence.sessionId`——审计表是合规证据，不是记忆副本；span 同理（`tracing.yaml` 的 `capture_content: redacted` 已定调）。
4. **可撤销 + 可溯源**：每条记忆带 `evidence`（哪个会话、哪个用户、什么时候），`fiat memory forget <id>` 一键撤销。**没有溯源就不能撤销，不能撤销的记忆库不能上线。**

#### 15.10 与阶段 12 记忆的边界（两套"记忆"不能打架）

| | 阶段 12 记忆 | 阶段 15 长期记忆 |
|---|---|---|
| 存储 | 本地 md（`workspace/memory/YYYY-MM-DD.md`） | RAG（向量 + BM25 双索引） |
| 范围 | 单机 workspace，**无检索** | 跨会话、按需检索 |
| 读取 | 全量注入近 3 天（双截断 1200 字） | 热注入一段（会话级冻结）+ 工具检索 |
| 写入 | evolution propose → 审批 / 自动落盘 | 轮末 extractor fork → **确定性落库** |
| 分类 | 无 | user / feedback / project / reference |
| 定位 | 提示层（当日事实） | 派生层（跨会话知识） |
| 落盘形态 | 文件（人可读、可 diff、进 git） | RAG 条目（机器可检、可撤销） |

**建议（待确认项 4）**：长期记忆上线后，`workspace/memory/` **降级为「当日工作台」**——只承载"本会话内新澄清、还没被提取走"的临时事实，跨会话一律走 RAG。理由是两套机制都往 systemPrompt 注入，重复注入既是 token 浪费，又会给出**互相矛盾的证据**（文件说 A、RAG 说 B，模型无从判断哪个新）。

#### 15.11 采集点与落点（不改 Pi 核心）

| 层 | 落点 | 产出 |
|---|---|---|
| 宿主 | `host/loop.ts` 的 `onUserTurn`（:254）/ `runTurnSafe` 收口 | 触发判定输入（用户文本 + 本轮 toolResults 摘要） |
| L1a（新增） | `host/l1a/memory-signal.ts`：`turn_end` 收集本轮 toolResults（失败→成功序列），`agent_end` 上报 | 纠正信号的**循环内**证据 |
| L2 新增 | `memory/{types,policy,prompts,extractor,store}.ts` | 预筛 / 提取编排 / 落库 |
| L1b 新增 | `host/l1b/memory-tools.ts` | `fiat_memory_search`（**唯一注册给会话的记忆工具，且是只读**） |
| 组合根 | `session/factory.ts`（工具注册 + 热注入段）+ `cli/chat.ts`（extractor 接线，挂在 `service.afterTurn()` 之后） | 装配 |
| L2 | `audit/client.ts` 双写 · `tracing` span | 留痕 |
| 跨仓库 | `MODULAR-RAG-MCP-SERVER/src/mcp_server/tools/{memory_store,memory_search,memory_forget}.py` | 存储与检索 |

**span 语义**（沿用阶段 14 命名规范）：`fiat.memory.extract`（fork 根，kind=`"memory"`）/ `fiat.memory.write` / `fiat.memory.search`（挂 `fiat.tool` 之下，与 `fiat.mcp.call` 嵌套）。

#### 15.12 配置（人写锚点，`enabled` 缺省 false）

```yaml
# config/memory.yaml（阶段 15 / P15-92）
memory:
  enabled: ${FIAT_MEMORY:-false}      # 缺省关；关时零网络、零定时器、零行为变化
  # 连接复用 config/rag.mcp.yaml，memory 只是多调 3 个工具
  trigger:
    onCorrectionSignal: true          # 确定性正则命中即触发（零 LLM 预筛）
    minTurns: 3                       # 或累计用户轮次达标
    atSessionEnd: true                # 会话结束兜底跑一次
    maxRunsPerSession: 2
  extract:
    timeoutMs: 45000                  # 45s（比评审 60s 短：提取比反思轻）
    sliceTurns: 12                    # 与 evolution 同口径，复用 slice.ts
  write:
    minConfidence: 0.6                # 低于此值直接丢弃，不落库
    maxTextChars: 300                 # 单条记忆长度硬上限
    maxPerRun: 5                      # 单次提取最多落几条（防"一次写 50 条"）
  promote:                            # feedback → user 晋升（确定性聚类，见 15.5）
    promotionThreshold: 3             # 同向 feedback 累计 ≥ 3 条 → 提炼为一条 user
    similarityFloor: 0.82             # 同族判定用的文本相似度下限
  read:
    hotInjectionMaxEntries: 8         # 热注入段条数上限（会话首轮算一次后冻结）
    hotInjectionMaxChars: 400
    defaultTopK: 5
    hotKinds: [user, feedback]        # 只有这两类进热注入（其余走工具）
  retention:                          # 二期：到期标 stale + 检索降权，不物理删
    referenceTtlDays: 90
    projectTtlDays: 180
  # user / feedback 不过期；feedback 被晋升为 user 后标 superseded（不删，保留溯源链）
```

`config/tool_policies.yaml` 追加（**人写锚点，自进化/记忆都只读**）：

```yaml
  - tool: memory_search              # 检索跨会话记忆（注册名 fiat_memory_search）
    risk_level: L1                   # 只读；scope/key 由 L2 注入，模型无法越界
    allowed_roles: [oncall, ops, viewer]
    allowed_environments: [dev, staging, prod]
    allowed_scopes: [memory_read]
```

> ⚠️ **必须加这条**：`policy/engine.ts:83` 对未知工具**默认拒绝**——新工具漏配策略会静默全灭（阶段 13 已踩过同类坑）。

#### 15.13 任务清单

- [x] P15-91 **【跨仓库前置】RAG server 新增 3 个 MCP 工具**（✅ 已完成 2026-09-23，落在 `MODULAR-RAG-MCP-SERVER` 的**阶段 J**）：`memory_store` / `memory_search` / `memory_forget`（`src/mcp_server/tools/`，对齐既有 `query_knowledge_hub.py` 的 `TOOL_NAME` / `TOOL_DESCRIPTION` / `TOOL_INPUT_SCHEMA` 三件套形状）；写入复用 `src/ingestion/pipeline.py` 现有链路（dense + sparse **双写**），检索复用 `HybridSearch`；**collection 约定 `fiat_memory_<scope>_<key>`，不与知识库混用**。本地验收：手工 MCP callTool 写入一条 → `query_knowledge_hub`（限该 collection）能召回。**实测证据**（该仓 `DEV_SPEC.md` §15.1~15.5）：J-01~J-14 全部 `[x]`；per-file 通过数 `guard 114 / tools 64 / isolation 40 / vector_store_contract 50 / chroma_roundtrip 34 / config_loading 11 / e2e 12`；**与 HEAD 干净 worktree 逐例比对：只在当前树失败 = 空（零回归）**，且唯一一处「只在基线失败」是被本阶段改好的既有红用例；真实向量 E2E 全链路（写 → 检索 → 撤销）在 ollama `bge-m3` 上跑通，撤销后 `degraded=false` **且** `count=0`（证明「真的删了」而非「库挂了」）
- [x] P15-92 **契约与配置**（✅ 已完成 2026-09-23）：`src/server/memory/types.ts`（`MemoryKind` / `MemoryScope` / `MemoryStatus` / `MemoryEntry` / `MemoryCandidate` + wire 类型 `MemoryHit` / `MemorySearchResult` / `MemoryStoreResult` / `MemoryForgetResult` + `KIND_DEFAULT_SCOPE` + `MEMORY_ENTRY_ID_PATTERN` + `DEFAULT_MEMORY_CONFIG` / `MEMORY_PROMPT_VERSION`）+ `src/server/memory/config.ts`（加载器：**关记忆宽容、开记忆字段非法即抛**，复用 tracing 的 `${VAR:-default}` 插值）+ `config/memory.yaml` + `config/tool_policies.yaml` 追加 `memory_search` 条目（L1，**刻意不给 `collection_scopes`** —— 否则 `engine.ts` 会往入参注入 `collection`，给「谁决定分区」留下第二个说法）。**`MemoryScope` 的权威定义移入 `types.ts`**（`identity.ts` 改为 import + re-export：两份枚举会漂移成「路径按一个拼、collection 按另一个拼」）。单测 `test/memory-config.test.ts`（23 条，含契约 3 的 id 定长与契约 8 的 `maxTextChars=300` 断言锁）
- [x] P15-93 **纯函数策略**（✅ 已完成 2026-09-23）：`src/server/memory/policy.ts`（**零 Pi 依赖**）—— ① 纠正信号检测（确定性正则，与提示词措辞成对；分 `correction` / `confirmation` 两组）+ §15.8 的**触发判定 `shouldExtract()`**（优先级：开关 → trivial → 预算 → 纠正信号 → 会话结束 → 轮次）+ trivial 预筛（§2.3）② 候选校验（kind 合法 / 长度上限 / `minConfidence`）③ **禁写三形态**正则兜底（规则形态 / 生产数据 / 指令性内容）④ 幂等键计算 ⑤ supersede 判定 ⑥ **`feedback` → `user` 晋升判定** ⑦ **归类漂移检测**。单测 `test/memory-policy.test.ts`（70 条）。**三处实现期事实源决策**见 15.17
- [x] P15-94 **提取 fork**（✅ 已完成 2026-09-23）：三个文件 —— `src/server/memory/prompts.ts`（`MEMORY_SUBMIT_TOOL = "fiat_memory_submit"` + `KIND_GUIDE` 四类各「判定线 / 正例 / 反例」+ `renderExtractPrompt()`；硬约束「纠正信号命中 → 优先 `feedback`」写在提示词里）+ `src/server/memory/submit.ts`（`createCandidateSink(max)` **纯内存、零 Pi**，`normalizeCandidate` 只校形状、不跑策略）+ `src/server/memory/extractor.ts`（`MemoryExtractor`，**逐条复用阶段 12 的 fork 纪律**：`runFork` 注入（对齐 `reviewer.ts`）/ 只挂 `submit` 一个工具（运行时白名单）/ 45s 超时 / 递归防护靠 `checkWriteQualification()` 首句短路 / **永不抛** / 全量留痕）。管线：`shouldExtract → slice → fork → normalize → validateCandidate → dedupe → pickSuperseded → pickPromotions → port.write`。**两处实现期决策**见 15.17-⑦。单测 `test/memory-extractor.test.ts`（31 条，faux 驱动、零真实 Pi 会话），钉住六种失败模式：纠正信号命中必产 `feedback`、禁写三形态**不进** `acceptedIds`、幂等重复计 `duplicates`、晋升时 `supersedes === promotedFrom`、超时**仍采用**已入 sink 的候选、fork 抛错不影响本轮回复
- [x] P15-95 **存储桥**：`src/server/memory/store.ts` —— 复用 `host/l1b/mcp-rag.ts` 的 `McpClientLike` 接口与 transport 配置，**但写入通道持独立 client 实例**（⚠️ 此处更正初稿的「不新建 MCP 连接」：共用连接的隔离依赖「代码永不把写方法包装成 HostTool」这条纪律，独立实例的隔离是**结构性的**——会话侧手上根本没有那个 client 对象，见设计文档 §3-L3）；调 `memory_store` / `memory_search` / `memory_forget` —— **入参只给 `scope` + `key`，不给 `collection`**（拼接是 RAG 侧的职责，`MemoryIdentity.collection` 降级为审计/展示用；见 §15.16 跨仓库契约 1）；`entry_id` 由本侧按 §15.6 幂等键生成后传入，**必须定长 `m_<32hex>`**（RAG 侧按前缀删，变长会误删，契约 3）；`forget` **属主校验靠 RAG 侧的 collection 分区**（不需要本侧传 owner，契约 7）；写入前后走 `policy.ts` 校验与 `slice.ts:redact()` 脱敏；检索结果**一律走第 ③ 道后置校验**（`assertOwned`，比对返回体里的 `scope`/`key`，不匹配即丢弃 + 记 `isolation_violation`，不抛），并消费返回体的 `degraded` 标志驱动熔断（`P15-106`）。（✅ 已完成 2026-09-23）：`MemoryStoreBridge` + `MemoryReadChannel`（会话侧唯一入口；**类型上没有 `write` / `forget`** —— 隔离是结构性的）+ `assertOwned`（导出纯函数，第 ③ 道防线，三处刻意的严格）+ `status()`（P15-99 的状态快照）。`call()` **一律先解 payload 再看 `isError`**。两处实现期更正见 **15.17-⑧**。单测 `test/memory-store.test.ts`（48 条）
- [x] P15-96 **检索工具（L1b）**：`src/server/host/l1b/memory-tools.ts` —— `fiat_memory_search`；**`scope` / `key` 由宿主闭包注入，不出现在工具 schema 里**（模型既看不到也改不了隔离边界）；返回带 `id` 便于引用与纠错（✅ 已完成 2026-09-23）：schema 只有 `query` / `kinds` / `top_k`（测试**逐字扫 schema 文本**，6 个禁词一个不许出现）；三种「什么都没有」分开说（命中 / 真空 / `degraded` —— 混在一起最典型的事故是「RAG 挂了，模型告诉用户『你之前没提过』」）；`details` 只带 `ids` / `count` / `kind`，**不带正文**（硬约束 6）；越界条数**不告诉模型**（断言输出与「零违规」时**逐字相同** —— 弱一点的 `not.toContain` 挡不住「另有 N 条被丢弃」这种泄漏），只留 error 级宿主日志。单测 `test/memory-tools.test.ts`（13 条）
- [x] P15-97 **组合根接线 + 热注入**：`session/factory.ts`（注册 `fiat_memory_search` + **会话首轮算一次热注入段并冻结**，追加在 `evolutionPrompt` 之后）/ `cli/chat.ts`（extractor 挂在 `service.afterTurn()` 之后）；**缺省不注册（fail-safe，现有测试零改动）**；位置契约更新为 `[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?, ...traceHook?, ...memorySignal?]`（✅ 已完成 2026-09-23）：新增 `memory/hot.ts`（`composeHotSegment` 永不抛 + 3s 超时 + 纯函数 `renderHotSegment`；段内**无 id** —— 一条 id 占 34 字符而整段预算 400）与 `host/l1a/memory-signal.ts`（`turn_end` 只记 `{tool, isError}`，**永不记正文**）。**冻结落在宿主**（`PiHostLoop.hotSegment`）而不是组合根：`buildSession` 是同步的而热注入要一次异步往返；且**失败也冻结**（`hotApplied` 先置位再 await）—— 否则 systemPrompt 会话中途变化、prefix cache 全废。`buildMemoryWiring()` **先判 `cfg.enabled` 再碰身份**（关记忆时哨兵守卫根本不会被走到，硬约束 7 的落地细节）。单测 `test/memory-e2e.test.ts`（12 条，走**真实** `buildSession` + 假 MCP）
- [x] P15-98 **审计与追踪**：写入 / 遗忘双写 `fiat_audit_log`（**正文不入、只记 id/hash/长度/kind/scope/evidence.sessionId**）；span `fiat.memory.extract`（kind `"memory"`）/ `fiat.memory.write` / `fiat.memory.search`（✅ 已完成 2026-09-23）：`memory/audit.ts`（`memory_written` / `memory_write_failed` / `memory_forgotten` 三个 outcome + `memoryAuditPayload` —— id / `sha256(text)` 前 16 位 / 长度 / kind / scope / collection / `evidence.sessionId`）+ `AuditOutcome` 加三值 + `TraceKind` 加 `"memory"` 与 `sampleRate.memory = 1`。**`await` 在这里是数据完整性决定、不是风格**：审计是**证据** → 逐条 await（不 await 会留下「写了但没有审计记录」的窗口，而那条记录正是合规意义上的证据；漏记一条失败会让「为什么这条没写进去」变成查不到的事）；提取是**尽力而为的派生数据** → 刻意不 await（硬约束 8）。审计自身**永不抛**（回归用例：「审计 client 抛错不影响写入结果」）。`write()` 的**所有**终结分支都过同一个 `note()` 收口 → 保证「审计条数 = 计划条数」
- [x] P15-99 **CLI 与维护**：`fiat memory list / search / forget / stats`（离线可跑、零 Pi 依赖，对齐 `fiat trace status` 的写法）；retention 衰减与 `stale` 标记（**可延后到二期**）（✅ 已完成 2026-09-23，**retention 按本条约定延后二期**）：`cli/memory.ts`（`createMemoryOps` —— **零 Pi 依赖**，由源码级断言锁住：`memory/**` + `cli/memory.ts` 全文件不许出现 Pi 命名空间）+ `cli/index.ts` 的 `cmdMemory`（`stats` / `list` / `search` / `forget`，另有 `--scope user|repo|global` / `--kind` / `--top` / `--mode` / `--active-only`）+ `commands.ts` 四个渲染函数 + `HELP` + `entry.ts` 接线（`cliSubject()` 的 `resolveIdentity()` **可能抛**，刻意让它抛在 thunk 里由能力层收进 `stats` 的报告字段）+ `main()` 退出前 `await deps.memory.close()`。`MemoryStoreBridge` 同步新增 `status()`（零网络快照）。**三处实现期决策**见 **15.17-⑨**。单测 `test/cli-memory.test.ts`（36 条）+ `test/memory-store.test.ts` §10（`status()` 3 条）
- [x] P15-100 **测试与验收**：`test/memory-policy.test.ts`（纯函数分支全覆盖：信号 / 禁写三形态 / 幂等 / supersede / **`feedback`→`user` 晋升（达阈值晋升、未达不晋升、不同族不误聚）** / **归类漂移告警**）+ `memory-extractor.test.ts`（faux 驱动：信号触发 → 候选 → 落库载荷断言；**纠正信号命中必须产 `feedback`**；递归防护；超时兜底）+ `memory-tools.test.ts`（mock MCP client：`scope`/`key` 注入正确、越界不可达）+ **`memory-isolation.test.ts`（必测：user A 写的记忆，user B 检索不到）** + 端到端（新会话召回 + 回答带 id 引用）；同步 `workspace/AGENTS.md` 与本文（✅ 已完成 2026-09-23）：`memory-policy.test.ts`（70）· `memory-extractor.test.ts`（34）· `memory-tools.test.ts`（13 —— schema 禁词逐字扫描 + 三种空/满措辞 + `details` 不带正文）· **`memory-isolation.test.ts`（9）** —— 「A 写的 B 检索不到」按**三道防线各一条**写：① 真实分区语义（不喂脚本化返回体）② 两个身份跑同一套代码 ③ 打开假服务的 `leakPartition` 让它**真的返回别人的条目**，断言被丢弃 + `isolationViolations` 记下证据；另有「B 用 A 的 entry_id `forget` 只得 `not_found`」「A 的热注入有、B 的空」「返回体缺 `scope`/`key` 时 fail-closed」· `memory-e2e.test.ts`（12 —— 走**真实** `buildSession`：关记忆零装配且工具表仍非空 / 工具注册 / 身份来自 subject / 新会话召回 / 跨用户热注入为空 / 工具输出带 id 且**不含 collection** / 降级措辞 / 工具表里没有写与遗忘 / 只读通道**没有** `write`/`forget` 成员）· `cli-memory.test.ts`（36）· 共用装置 `test/memory-fake-mcp.ts`（**有状态**假 MCP，带真实 `fiat_memory_<scope>_<key>` 分区、`entry_id` 幂等、`supersedes` 标退役、降级与越界注入开关）。**`workspace/AGENTS.md` 已同步**：工具清单加 `fiat_memory_search`、新增「跨会话长期记忆（阶段 15）」章节、人写锚点加 `config/memory.yaml`、并顺手修正过期表述 `workspace/memory/` → `workspace/users/<分区>/memory/`（P15-103 已改为按身份分区）。**实测：`npm run check` 干净；`npm test` 53 文件 / 672 例全绿**（2026-09-23 19:41，零回归）
- [x] P15-101 **可信身份解析（A 期，✅ 已完成 2026-09-23）**：`src/server/identity/resolver.ts`（新增）—— `resolveIdentity()`（优先级 `trustedId` > OS（显式开 `FIAT_IDENTITY_SOURCE=os`）> `FIAT_USER_ID` > `"cli"` 哨兵）+ `isMultiTenantMemory()` + `IdentityUnavailableError`；`FIAT_MEMORY_MULTI_TENANT=1` 时解析不出身份 → **抛**，由 `cli/index.ts` / `cli/entry.ts` 收口**拒绝会话**（不是 fallback 到 `"cli"`）。**遗留**：`source` 字段暂无消费点 → 哨兵语义未生效（见 15.15-10）。设计文档 §3-L0 / §5.1
- [x] P15-102 **隔离边界载体（A 期，✅ 已完成）**：`src/server/memory/identity.ts`（新增）—— `MemoryIdentity` / `resolveMemoryIdentity()`（**唯一构造点**）/ `sanitizeMemoryKey()`（小写折叠 + 非法字符→`_` + 去首尾 `_` + 截断 32 + **原始值 sha256 前 8 位**；空值 / `.` / `..` 抛）/ `memoryCollection()` / `GLOBAL_MEMORY_KEY`。identity **不带 `sessionId`**（必须会话无关的稳定值）；输入类型是与 `SessionSubject` 结构兼容的 `{ user: { id } }`，不 import `session/`（切断依赖环）。设计文档 §4.2 / §3-L2
- [x] P15-103 **记忆改 per-identity 分区（A 期，✅ 已完成）**：`memoryStore.ts` 的 `memoryDir`（getter）→ `memoryDirFor(identity)` = `workspace/users/<safeKey>/memory/`；`appendFact` / `appendFacts` / `recentFacts` 全部改为 identity 入参；文件头写 `scope` / `key` 便于人肉核对；**③ role 约定有意保持共享**（不是隔离失效，见设计文档 §7 / §6-T15）。**不做旧 flat 目录回退读取**（已核实本仓无 `workspace/memory/` 历史数据）；写侧接线在 `evolution/apply.ts`，用 **`proposal.proposer`** 构造 identity（不能用 apply 时的会话主体，否则落在审批人分区）
- [x] P15-104 **【B 期前置·第一件事】哨兵语义修复**（✅ 已完成 2026-09-23）：多租户下把 `FIAT_USER_ID=cli` **视为未配置** + 存储边界拒收 `source="cli"`；配套单测「多租户 + `FIAT_USER_ID=cli` → 拒绝」。理由见 15.15-10 与设计文档 §2.4：默认值一旦被持久化就无法与真值区分（hermes `_DEFAULT_USER_ID` 的教训）。**落地**：`identity/resolver.ts` 新增 `IDENTITY_SENTINEL` / `isSentinelIdentity()` / `assertNotSentinelIdentity()`，**两条方案都上**（值层面 `resolveIdentity` 把 `cli` 当「没配」；边界层面 `resolveMemoryIdentity` 构造前过守卫）；`test/memory-identity.test.ts` 新增 9 条（该文件 33 条全绿）
- [x] P15-105 **写资格：非主上下文不写记忆**（与 §15.8 触发并轨）（✅ 已完成 2026-09-23）：`memory/policy.ts` 显式短路 `isPrimary === false` —— extractor fork 内部 / cron / eval 批量 / `job-apply` 等程序化路径**不产生写入**（既防递归提取，也防系统提示词污染用户画像）。判据来自 hermes `agent_context`（`"subagent"` 在跳过集合里），见设计文档 §2.6。**落地**：`AgentContext` 六值（hermes 四值 + fiat 特有的 `eval` / `job-apply`）+ `NON_PRIMARY_CONTEXTS` 单一事实源 + `checkWriteQualification()`（先判上下文后判开关：cron 不写记忆的理由该是「它是 cron」而不是「记忆没开」）。**消费点**：`P15-94` 的 extractor 首句短路 + `P15-95` 写入通道要求显式传上下文
- [x] P15-106 **熔断 + 有界 drain**（✅ 已完成 2026-09-23）：① 检索侧断路器 —— `memory/circuit.ts` 的 `MemoryCircuitBreaker`（连续 5 次失败 → 冷却 120s，对齐 hermes `_BREAKER_THRESHOLD` / `_BREAKER_COOLDOWN_SECS`；**时钟注入**，否则这组测试没人会跑）；`RagStatus` 加 `circuit_open` 取值以与 RAG 状态**合并展示**（设计文档 §2.7 原话）。② 有界 drain —— `memory/drain.ts` 的 `MemoryDrain`（`track()` 登记在飞写入；`run()` 超时即放弃 + 记 `abandonedTotal` + 日志，**永不抛 / 永不超时后继续等**）；单测 `test/memory-circuit.test.ts`（19 条，含「不假装成功」「写入失败也算结算」）。**消费点**：`P15-96` 检索工具套断路器；`P15-97` 把 drain 挂进 `ChatSession.flush()`（**复用阶段 14 已加的钩子，不新开**）

#### 15.14 阶段 15 硬约束（实现时不得破）

1. **主会话零写记忆能力**：写工具不注册、永不出现在主会话工具表里；写入只能由 L2 确定性代码发起。
2. **记忆永不参与**权限 / 金额 / 状态机 / 字段校验（阶段 12 铁律 4 的直接延伸，也是 Claude Code 官方那句「context，不是强制配置」的落地）。
3. **`scope` / `key` 由 L2 注入**，LLM 产出结构里**没有**这两个字段；隔离边界不经 LLM。
4. **记忆与知识库不同 collection，检索结果不合并**；`fiat_memory_search` 只搜 `fiat_memory_*`。
5. **禁写三形态**（规则形态 / 生产数据 / 指令性内容）由**正则兜底**实现，不依赖提示词自觉——提示词是劝，正则才是拦。
6. **正文不进审计、不进 trace span**：只记 id / hash / 长度 / kind / scope / 来源会话。
7. **缺省关**：`FIAT_MEMORY` 未设走 no-op，零网络、零行为变化、现有测试零改动（同 `evalSink` / `evolution` / `tracing` 惯例）。
8. **永不阻塞回复**：提取 fork 异步 + 检索失败降级为空结果（模型看不到记忆也能正常回答，只是少了历史）。
9. **单条长度硬上限 + 单次条数上限**：记忆不是文档库，塞长文档一律拒。
10. **每条可溯源、可撤销**：`evidence` 必填，`fiat memory forget <id>` 必须真的能让它从检索里消失；且 **`forget` 必须校验属主** —— 只按 id 删，会让拿到别人 entry id 的人（id 会在回答里被引用）删掉别人的记忆。
11. **`MemoryIdentity` 只有一个构造点**（`resolveMemoryIdentity`）：任何地方不得手工拼 `key`、路径或 collection 名。隔离边界多一个拼法，就多一个漏加身份的地方。
12. **写入通道用独立 client 实例**，不与通用 RAG 桥共用连接：会话侧手上**没有**那个 client 对象（结构性隔离），而不是靠「代码永不把写方法包装成 HostTool」这条纪律。
13. **多租户模式解析不出身份 → 拒绝会话**，不 fallback；`"cli"` 只表示「没配」，**不等于**一个叫 `cli` 的用户（默认值被持久化后无法与真值区分，见 15.15-10）。
14. **非主上下文（fork 子会话 / cron / eval 批量）不写记忆**：子会话产出的是「关于子任务的」，不是「用户对助手的表述」；子会话身份**显式继承**父会话，不重新解析环境变量。
15. **检索结果一律走后置校验**：与闭包身份不匹配即丢弃 + 记 `isolation_violation`，**不抛**（不阻塞回答）。
16. **`repo` / `global` 与 role 约定是「有意共享」**，不是隔离失效：改动前先读设计文档 §3-L2 的 ⚠️ 框 —— 把共享「修」成 per-user，会产生「同一份约定被复制成 N 份、各自漂移」，比共享更糟。

> 第 11 ~ 16 条来自专项设计文档 `docs/P15-101-user-scoped-memory-isolation.md`（§9 硬约束 + §6 威胁模型）。该文档的威胁模型 **T1 ~ T15** 是本章硬约束的推导依据。

#### 15.15 待确认与已拍板

| # | 问题 | 结论 / 倾向 | 状态 |
|---|---|---|---|
| 1 | 记忆写入走 **RAG server 新增 MCP 工具**，还是 L2 侧直连 ingestion pipeline？ | **前者**（你的口径即此，且复用 hybrid search）；代价是要改 `MODULAR-RAG-MCP-SERVER` | 已定 |
| 2 | 热注入（决策 C 第二轨）**做不做**？ | **做**。不做也能满足要求，但 15.0 第 2 条硬伤（prefix cache）会一直留着 | 已定 |
| 3 | ~~`performance` 保留还是改 `preference`？~~ | 四类定为 `user` / `feedback` / `project` / `reference`，`performance` 撤销并入 `feedback` | **已拍板（tog，2026-09-23）**，15.3 / 15.5 / 15.6 / 15.8 / 15.10 / 15.12 已同步 |
| 4 | 长期记忆上线后，阶段 12 的 `workspace/memory/` 怎么办？ | **降级为「当日工作台」**，跨会话一律走 RAG；避免两套注入给出矛盾证据。**并已按 per-identity 目录改造**（`workspace/users/<safeKey>/memory/`，见 15.16） | 已定 + A 期已执行 |
| 5 | 记忆写入是否要**人审**（像技能落盘那样）？ | **不审**（可撤销 + 不进判定链）；`prod` 可考虑"高置信自动、低置信丢弃" | 已定 |
| 6 | 提取 fork 的模型选型（与主会话同模型，还是走便宜档）？ | 走 **lite 档**（`model_policies.yaml` 里新加 `memory_extract` 路由）——提取是简单判断，不必用 pro | 已定 |
| 7 | ⭐ `feedback` → `user` **晋升机制**（15.5 的设计补充，非你的原话）用不用？ | **用**。不用的话热注入段会被十条同义 feedback 灌满（「改 map」「别用 forEach」其实是一件事）；代价是 `policy.ts` 多一段聚类 + 3 个测试用例 | **已拍板（tog，2026-09-23 本轮）** |
| 8 | `reference` 按新口径是「外部系统指针」，那**仓库内权威位置**（`config/tool_policies.yaml`）还算 `reference` 吗？ | **都算**——两者都是「什么在哪儿」，只是内/外之分。你最初的描述里「在哪个系统」与「代码在什么地方」本来就并列在同一类 | **已拍板（tog，2026-09-23 本轮）** |
| 9 | 隔离的「钥匙」（`userId` 从哪来、凭什么可信）在哪定义？ | 独立设计文档 `docs/P15-101-user-scoped-memory-isolation.md`；A 期已实现 | **已拍板 + 已实现**，见 15.16 |
| 10 | 隔离标识串（如 `"cli"`）与真身份要不要显式区分？ | **要**。默认值被持久化后就无法与真值区分，会静默滑回混装（hermes `_DEFAULT_USER_ID` 的教训）。修法见文档 §2.4，两条方案都上 | **已拍板（tog，2026-09-23）**：两条都上。设计与实现位点已定，随 B 期首批开工（`P15-104`） |
| 11 | 非主上下文（fork 子会话 / cron / eval 路径）**该不该写记忆**？ | **不该**。判据：子会话产出的是「关于子任务的」，不是「用户对助手的表述」（hermes `agent_context` 口径）。落 `policy.ts` 显式短路 | **已拍板（tog，2026-09-23）**：不该写。随 B 期首批开工（`P15-105`） |
| 12 | 检索失败「降级为空结果」怎么实现才真降级？ | 必须**熔断**：连续 N 次不可用 → 冷却期内直接返回空。否则每次仍撞 30s 超时，会话卡死。另：异步写入要有**有界 drain**（退出前 flush，超时即放弃 + 记 abandoned 计数） | **已拍板（tog，2026-09-23）**：要做。随 B 期首批开工（`P15-106`） |

#### 15.16 用户维度隔离：专项设计与 A 期实现（引用 `docs/`）

**本章只放索引与硬约束，完整设计在独立文档里** —— 隔离是跨仓库（fiat + `MODULAR-RAG-MCP-SERVER`）、跨期（A/B/C 三期）、且涉及威胁模型的专项，塞进 §15 会让主 spec 失焦。

📄 **`docs/P15-101-user-scoped-memory-isolation.md`**（v2，2026-09-23）—— 结论：**§15 已把「隔离的锁」设计完了，唯一缺的是「钥匙」：`userId` 从哪来、凭什么可信。** 照原样实现，`user` scope 会退化成「所有人都是 `cli`」，隔离在纸面上成立、运行时失效。

**该文档与本章的分工**：

| 内容 | 在哪 |
|---|---|
| 记忆的分类 / 触发 / 落库 / 检索契约 | 本章 §15.1 ~ §15.15 |
| 身份的来源与可信强度（L0） | 文档 §3-L0 / §5.1 |
| 三道隔离防线的分工与失效模式（L2）★ | 文档 §3-L2 / §5.3 |
| 威胁模型 T1 ~ T15 | 文档 §6 |
| A/B/C 三期切片与 A 期实现核对 | 文档 §8 / §12 |
| 借鉴 hermes 的七条结构（含 4 条缺口） | 文档 §2 |

**A 期已完成（2026-09-23）**：`P15-101` 可信身份解析（`src/server/identity/resolver.ts`）· `P15-102` 隔离边界载体（`src/server/memory/identity.ts`）· `P15-103` 阶段 12 记忆改 per-identity 目录（`memoryStore.ts` 的 `memoryDirFor()`）· 读侧接线（`factory.ts`）· 写侧接线（`apply.ts` 用 `proposal.proposer`）· 24 例单测（`test/memory-identity.test.ts`）—— **实测：该文件 24 passed；全量 `npm test` 44 文件 / 399 例全绿**（2026-09-23 17:36，零回归）。

**A 期遗留（B 期第一批，设计已全部定稿，不再有悬置项）**：哨兵值未生效（`P15-104`）· 写资格（`P15-105`）· 熔断与 drain（`P15-106`）· 后置校验第 ③ 道防线（`P15-95`/`P15-96`，需等 RAG 返回体才有对象）· 热注入未冻结（属 C 期 `P15-97`）。

> ✅ **B 期已全部完成（2026-09-23）**：上面五项悬置全部落地（`P15-104` 哨兵 / `P15-105` 写资格 / `P15-106` 熔断 + drain / 后置校验 / 热注入冻结），
> 连同 `P15-91`（跨仓库 RAG 侧 = `MODULAR-RAG-MCP-SERVER` 阶段 J）、`P15-92` ~ `P15-100`。
> 阶段 15 的 16 条任务**全部 `[x]`**（`P15-91` ~ `P15-106`）。实现期决策与更正见 **15.17 ⑧ ⑨**。
> **唯一按约定延后到二期的**：retention 衰减与 `stale` 标记（`P15-99` 条目内已说明）。
> 实测证据：`npm run check` 干净；`npm test` **53 文件 / 672 例全绿**（2026-09-23 19:41，零回归）。

> 📌 **B 期开工顺序（tog，2026-09-23 定）**：
>
> `P15-104` 哨兵 → **`P15-91` 跨仓库 RAG 侧**（= `MODULAR-RAG-MCP-SERVER` 的 **阶段 J**，设计已落于该仓 `DEV_SPEC.md`）→ `P15-105` / `P15-106` → `P15-92` ~ `P15-100`。
>
> **哨兵必须先修**：它的缺口现在只表现为「本地目录混装」，铺开 RAG 后会升级成「collection 混装」，而事后修复要动**已写入的数据**。

#### 跨仓库契约（fiat ↔ MODULAR-RAG-MCP-SERVER）

本节是**唯一的接口事实源** —— 两侧实现都必须对齐这里的形态。RAG 侧对应设计：`MODULAR-RAG-MCP-SERVER/DEV_SPEC.md` 阶段 J（J3 ~ J8）。

| # | 契约 | fiat 侧 | RAG 侧 | 不对齐的后果 |
|---|---|---|---|---|
| 1 | **collection 归属** | **不传 collection**，只传 `scope` + `key`（已 sanitize）；`MemoryIdentity.collection` 降级为**审计/展示用** | 自己拼 `fiat_memory_<scope>_<key>`，拼完**再校验一次**白名单正则 | 两边各有一份拼接逻辑 → 迟早不一致 → 写入与检索落到不同分区（**最难查的静默失败**） |
| 2 | **`entry_id` 生成方** | fiat 侧生成（取 §15.6 的幂等键 `sha256(scope+key+kind+归一化 text)`） | 只校验形态 `^m_[0-9a-f]{32}$`，**不做归一化** | 跨语言做「归一化文本」必然不一致；且 RAG 侧算出的 id 无法被 fiat 侧的幂等逻辑复用 |
| 3 | **`entry_id` 必须定长**（`m_` + 32 hex） | 生成时定长 | 定长不符即拒 | RAG 侧 `remove_document` 按**前缀**匹配删除（`bm25_indexer.py:394`）；变长会出现「`m_abc` 是 `m_abcd` 的前缀」→ **误删他人条目** |
| 4 | **一条记忆 = 一个 record，不切分** | 单条 ≤ `maxTextChars`（300） | 超长**拒写**（不截断、不切分） | 切分会让 `entry_id` 与 `chunk_id` 分离，`forget` 变成两次查找 |
| 5 | **检索返回体** | 消费 `hits[].{id, kind, text, score, **score_type**, status, **scope**, **key**, created_at}` + `collection` / `count` / **`degraded`** | 按此形态返回 | ① `scope`/`key` 缺失 → **后置校验（第 ③ 道防线）无从比对**；② `score_type` 缺失 → 模型把 RRF 融合分当置信度；③ `degraded` 缺失 → 无法区分「没有记忆」与「RAG 挂了」，熔断器（`P15-106`）无从触发 |
| 6 | **`status` 语义与 supersede 谁执行** | 判定「哪条被替代」（`policy.ts` 聚类），把 `supersedes: [id]` 传下去 | 执行 `update_metadata(status="superseded")`，**只改 metadata 不动向量** | 若 RAG 侧用 upsert 顶替，必须重新提供向量 → 白跑一次 embedding |
| 7 | **`forget` 属主校验靠分区** | 只把「自己的」`entry_id` 传下去 | 在指定 collection 内 `delete`，找不到即记 `not_found` | 若改成「传 owner 字段来比对」，多一个漏点（忘了比 / 比错字段 / 字段可被改）；**分区不可能「忘」** |
| 8 | **`max_text_chars` 与 `maxTextChars` 必须一致** | `config/memory.yaml` | `config/settings.yaml` 的 `memory.write.max_text_chars` | 「fiat 认为合法、RAG 拒写」——最难查的那类静默失败。**两边各写一条断言测试锁住自己的值** |
| 9 | **`memory_*` collection 不出现在列表里** | 不依赖它 | `list_collections` 的 `include_memory` **缺省 False** | 分区名里含 `userId`，列出来等于把「有哪些用户」暴露给模型 |


> ⚠️ **进入 B 期的前置顺序**：**先修哨兵（`P15-104`），再动 `P15-91` 的跨仓库改动。** 哨兵缺口目前影响面是「本地目录混装」，铺开 RAG 后会升级成「RAG collection 混装」，且事后修复要动已写入的数据。（完整顺序见本节上方 📌）

#### 15.17 实现期决策与更正（2026-09-23，阶段 15 B 期）

> 本节的规矩与 RAG 侧 §J15 一致：**实现期发现的事实写回文档**，不让它与代码分叉。

**① `feedback` 不走 supersede（否则晋升链自相矛盾）** —— 这是本轮最要紧的一处澄清。

§15.5 的晋升链要求「同向 `feedback` 累计 ≥ `promotionThreshold`（3）条才提炼成一条 `user`」；
而 §15.6 约束 2 要求「新条目标 `supersedes`，旧条目标 `superseded`」。两条规则**直接冲突**：
若 `feedback` 也走 supersede，每写一条新的就把上一条标 `superseded`，**永远攒不到 3 条 active**，
晋升链静默失效（而且失效方式很隐蔽 —— 热注入段只是「一直只有 feedback、没有 user」）。

定案：`policy.ts` 的 `SUPERSEDING_KINDS = [user, project, reference]`，**不含 `feedback`**。
两个机制的职责互补：

| kind | 语义 | 机制 |
|---|---|---|
| `user` / `project` / `reference` | 同一件事的**最新说法** | 新替旧（supersede） |
| `feedback` | **累积的证据** | 攒够阈值由晋升链统一收口成 `user`，届时才标 `superseded` |

**② 晋升写入时 `supersedes` 与 `promotedFrom` **同时**填同一批 id（不是冗余）** ——

分工不同：`supersedes` 是**给 RAG 侧的指令**（`memory_store` J4.2 第 5 步据此把这些 id 标
`superseded`，契约 6「fiat 判定、RAG 执行」）；`promotedFrom` 是**给审计读的溯源链**
（回答「这条 `user` 由哪几条 `feedback` 提炼而来」）。只填 `supersedes` 会丢溯源；
只填 `promotedFrom` 则 RAG 侧不改状态，旧 `feedback` 继续留在检索结果里 —— 那正是晋升要解决的问题。

**③ 禁写形态的正则与阶段 12 **共用**，并顺手补了阶段 12 的两个漏** ——

§15.9 的「规则形态」禁令（「以后一律…」「无需审批」「跳过校验」「免复核」）与阶段 12 的
`forbidden_approval_bypass` **本来就是同一批措辞**，因此 `memory/policy.ts` 直接 import
`evolution/policy.ts` 的 `findForbidden` / `findSensitive` / `similarity` / `normalizeText`，
**不新写一套正则**（两套必然一处紧一处松，那就是「一处判定说没有敏感信息、另一处却漏出去」的裂缝）。

顺手发现并修掉的漏：共用表的审批旁路模式只枚举了「审批 / 审核 / 复核」，**不含「校验 / 验证」**，
且动词侧缺「免」的简写形式 —— 于是 §15.9 自己举的「跳过校验」「免复核」两个例子**都没被拦住**。
定案：扩展共用表的目标名词到 `审批|审核|复核|校验|验证|approval|approve|validation`，
动词侧加 `(?<!避)免(?:除|去)?`（`(?<!避)` 用来挡掉「避免审批超时」这个正经句子）。
**这是对阶段 12 的加强**（只多拦、不多放），阶段 12 的 30 条测试全绿。

**④ 指令性内容是 `memory/policy.ts` 独有的第三形态** ——

阶段 12 没有对应物，因为**技能正文本来就该是指令式的**（「先校验再提交」）。记忆不同：
它会被注入此后每次 systemPrompt，存下一条祈使句等于给自己装了个后门。所以三组模式
（对模型下命令 / 覆盖既有指令 / 伪 system 段）放在记忆侧，不与阶段 12 混。

**⑤ `maxRunsPerSession` 的判定必须**先于**信号** ——

信号是事件驱动的，用户连说十句「不对」就能把预算撑爆。预算排在信号之前，否则它形同虚设。
同理，trivial 预筛排在预算之前（`ok` 这类输入连预筛都不必跑）。

**⑥ 跨仓库契约 8 的断言落点** —— 两侧各写一条**锁自己值**的测试
（fiat：`test/memory-config.test.ts` 断言 `maxTextChars === 300`；RAG：`config/settings.yaml` 侧同理）。
**不互相读文件** —— 跨仓库读路径的测试不可移植（CI 里两个仓不一定同机）。

**⑦ P15-94 提取 fork 的两处决策** ——

**(a) 策略校验不放进 `submit` 工具的 schema，fork 返回后单独跑。**

诱人的做法是把「长度上限 / kind 枚举 / 禁写三形态」全写进 `fiat_memory_submit` 的
`inputSchema`，让 Pi 的参数校验替我们拦掉。**不能这么做**，两个理由：

- 参数校验失败是**可重试的报错**。模型看到 `Input validation error` 会改写措辞再试一次 ——
  「以后无需审批」被拒后改成「审批环节可以省掉」，**绕过的是我们唯一那道理性检测**。
  禁写形态要的是**安静丢弃 + 留痕**（`rejected` 计数），不是和模型打一轮攻防。
- schema 校验的粒度是「字段合规」，策略的粒度是「**这条该不该被记住**」。后者要读
  `MEMORY_KINDS`、`minConfidence`、共享正则表，还得看 `enabled` ——塞进 typebox 会让
  schema 与 `policy.ts` 成为同一套规则的两个副本，而它们必然一处紧一处松。

定案：`submit.ts` 的 schema 只保证「四个 kind 之一 + text 是非空 string + 其余字段可选」，
**`normalizeCandidate` 只做形状归一**（trim / 截断超长 / 补默认值，**永不抛**），
`validateCandidate` 在 fork 返回之后跑，拒掉的候选**不进 `acceptedIds` 但仍然留痕**。
`sink` 侧不知道「策略」这回事，`policy.ts` 侧不知道「Pi 工具」这回事。

**(b) 超时语义 = 「不再等」，不是「中断」。**

45s 到点时**已经在 sink 里的候选一律采用**，只是不再等剩下的。若把超时当失败，
「候选质量」就会随网络抖动变成隐式的数据开关，而且边界附近的候选会**随机**蒸发 ——
这种「时快时慢地丢数据」最难查。同时这也与阶段 12 的 fork 纪律一致：
fork 的产出是**尽力而为的增量**，不是事务。

配套：fork **永不抛**（`plan()` / `finish()` 各自 try/catch），提取失败绝不冒泡到本轮回复；
`sink` 是纯内存对象，fork 抛错时已入 sink 的部分照常进入校验流程。

**⑧ P15-95 存储桥的三处事实源更正** —— 这三条都是「按对端**代码**改，不按本仓初稿改」。

**(a) `MemoryStoreResult.partialFailure` 的形态初稿猜错了。**

初稿写的是 `{ failed: string[]; detail?: string }`；RAG 侧实际返回的是
`dense_ok` / `sparse_ok` / `errors`（`MemoryStoreResult.to_dict()`）。
**契约表没有规定这一条** —— 而它恰是「一个字段猜错就静默丢掉半写状态」的位置：
按初稿实现会得到一个永远为 `undefined` 的 `partialFailure`，于是「向量写成功了、BM25 没写成功」
被读成「写成功了」。定案：按对端代码改（`types.ts` 已更正并写明出处），并留一条测试钉住。

**(b) `isError === true` **不等于**「没有 payload」。**

这是本阶段最要紧的一处实现事实。RAG 侧的三条降级路径**全都**是「`isError=true` + 带 payload」：

| 路径 | 形态 |
|---|---|
| `memory_search` 降级 | `failure(RuntimeError, payload={"degraded": true, "count": 0, ...})` |
| `memory_store` 部分写 | 同一份 payload 里带 `dense_ok` / `sparse_ok` / `errors` |
| 各类错误 | `error` / `error_type` 信封，同样带 payload |

看到 `isError` 就抛，会**同时丢掉两个最重要的信号**：熔断器拿不到 `degraded`（于是 RAG 挂掉时
每轮仍撞 30s 超时），半写状态变成「写失败」（于是重试的判据没了）。
定案：`store.ts` 的 `call()` **一律先解 payload，再交给调用方判**；`isError` 只是
「这条响应是失败的」这个事实的一部分，不是「payload 不存在」的同义词。

**(c) RAG 侧没有 list 工具 → `listActive` 用「本轮候选文本」做探针。**

`memory_search` 必须给 `query`，没有全量列举。所以 `listActive(identity, probe)` 拿候选文本
做一次近邻召回，而不是枚举。这不是将就：supersede 与晋升的语义本来就只看**相似**的旧条目 ——
一条无关的旧记忆既不会被顶替，也不该进同一个族。代价是「相似度阈值以下的旧条目看不见」，
而那正是阈值要表达的意思。**同一事实也决定了 `P15-99` 的 `list` 必须给探针**（见 ⑨-b）。

**⑨ P15-99 CLI 的三处决策** ——

**(a) `stats` 必须**同步、零网络、永不抛**，身份解析失败是**报告内容**而不是命令失败。**

诱人的做法是「在 entry 里当场 `resolveMemoryIdentity` 然后构造桥」，但
`resolveMemoryIdentity` 在多租户下**会抛**（P15-104 的哨兵守卫）。那样 `fiat memory stats`
——**恰好是排查「为什么没数据」的命令** —— 会在打印任何东西之前先自己挂掉，
而「身份没解析出来」很可能就是它本来要报出来的答案。定案：

- 身份构造收成 **thunk**（`(scope) => MemoryIdentity`），在能力层内 try/catch；
- 失败 → `stats.identityError` 有值，其余字段（配置面 / 端点）照常输出；
- **关记忆时连身份都不去解析**：关着就没有分区要报，而「关着但没配身份」报出来会误导。

这与 `fiat trace status` 的纪律同源：一个「诊断不工作」的命令如果自己要先发网络请求，
它自己就是不可靠的。所以 `status()` 也只读**已发生**的连接结果，不触发惰性连接。

**(b) `list` 与 `search` 的缺省**刻意相反**：`list` **含**退役条目，`search` **不含**。**

两个子命令的读者是同一批人，但问题不同：

| 子命令 | 回答的问题 | `include_superseded` |
|---|---|---|
| `list <探针>` | 「这条记忆怎么**不见了**」 | **true** —— 看到它 `superseded` 就是答案本身 |
| `search <查询>` | 「为什么是**这几条**排前面」 | **false** —— 与模型侧 `fiat_memory_search` 同口径 |

第二行的「同口径」是刻意的：若 CLI 能查到退役条目而模型查不到，排查时第一个假象就是
「CLI 查得到、模型查不到」。`--active-only` 用来把 `list` 拨到另一侧。

**(c) 关记忆时 `forget` **抛**，不返回 `notFound`。**

`MemoryStoreBridge.forget` 在 `enabled=false` 时早退返回 `{forgotten: 0, notFound: ids}`
—— 那是因为它作为一个**降级组件**不该抛。但渲染出来是「**未在本分区找到这几条**」，
而真相是「**根本不会去删**」。撤销是**不可逆动作**，语义错报的代价比一条报错高得多。
定案：在 `cli/memory.ts` 层把「关着还调用 forget」升级成显式错误，`store.ts` 的早退语义不动。

**`fiat memory` 的「零 Pi 依赖」由源码级断言锁住**（`test/cli-memory.test.ts` §6）：
`src/server/memory/**` 与 `src/server/cli/memory.ts` 全文件不许出现 Pi 命名空间，
且先断言「读到的文件数 > 10」—— 否则目录读空了也会「通过」。
这条断言的价值在于：任何一次「顺手 import 个工具函数」都会立刻红，而不是等到
某个没有 Pi dist 的环境里 `fiat memory` 起不来才发现。

---

## 9. 约束与踩坑

**铁律**：

1. 不改 Pi 核心（`packages/*/src`）一行代码。
2. 不把权限判定只放在 `tool_call` block —— 它只是第一道。
3. 高风险操作不返回 error，返回工单。
4. LLM 不参与金额计算、状态机判断、字段校验。
5. **记忆（技能 / 文件记忆 / 跨会话记忆）永远不是规则源**，也不参与权限 / 金额 / 状态机判定。权威只有三处：RAG 知识库、`config/*.yaml`、L2 规则引擎。三套记忆机制的定位见 §8 阶段 12（技能库 + `workspace/memory/`）与阶段 15（跨会话长期记忆）。
6. **凡是「会被以后每次会话读回」的内容，写入口必须唯一且在校验之后**（阶段 15 的核心风险口径）：记忆是**持久化**注入面，一次污染影响此后所有会话，量级不同于「当轮生效」的 `tool_call` block。
7. **决定「谁能看到」的字段只有一个构造点，且永不进 schema**（阶段 15 隔离设计文档口径）：`scope` / `key` / collection / `userId` 一类隔离标识，一律由代码从会话主体派生、以闭包注入，**不出现在任何对模型的 schema 里**，也**不允许任何地方手工拼接**。隔离标识多一个拼法，就多一处会漏加身份的地方。

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
| **被 block 的调用收不到 tool_call/tool_result 钩子** | `ExtensionRunner.emitToolCall` 对 block 结果短路返回（runner.js:639-657：`if (result.block) return result`），且被 block 不产生 `tool_result`（P8-39 实测）→ 排在 factories 尾部的扩展收不到被拦调用 | 评测采集（eval-recorder，阶段 11）不走 `tool_call`/`tool_result`，改用 `turn_end.toolResults`（含被 block 调用的 isError 回灌结果）；审计仍由 permission-gate 自落 blocked 记录（既有语义不变） |
| **扩展生命周期事件需宿主扇出** | 内嵌循环只桥接了 `tool_call`/`tool_result`/`before_agent_start` 三个钩子（P8-37）；`turn_start`/`turn_end`/`agent_end` 走 `Agent.subscribe()` + `runner.emit(...)`（0.80.3 通用 emit 不短路、逐扩展触发，runner.js:522-554） | 阶段 11 P11-59 补齐；`turn_end` 携带 `toolResults`（含 isError），`agent_end` 携带完整 messages |
| **OpenClaw 用的是 0.75.5 的 API 面，别照抄** | OpenClaw 从 `pi-agent-core` 只取 `Agent` / `runAgentLoop`；从 `pi-coding-agent` 取 `SessionManager` / `DefaultResourceLoader` / `SettingsManager` / `parseSessionEntries` / `migrateSessionEntries` / `create*Tool`、**`ExtensionAPI`/`ExtensionFactory`**——**它弃用的只是扩展加载器，不是这个包**（四个包全用：216/195/98/23 处 import） | 阶段 8 以 **0.80.3** 实际 d.ts 为准，勿照搬 0.75.5 写法。已验证 `Agent`(`packages/agent/src/agent.ts:171`)、`runAgentLoop`(`packages/agent/src/agent-loop.ts:95`) 在 0.80.3 均存在 ✅ |
| **「OpenClaw 不用 Pi extension」是误判** | 前稿据此写过「不用 extension 机制」，**此处更正**。实测 `pi-core` @ `27ae826`：它关掉的只是**目录自动发现**（`resource-loader.ts` 的 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true`），但仍经 `extensionFactories` 编译期注入 3 个内建 extension | 阶段 8 **保留 `extensionFactories` 通道**（P8-37/P8-40）。钩子型扩展不要改写为工具模块，否则要自造事件分发 + 短路回灌 + tool_result 改写 |
| **扩展性质不可望文生义** | `alert-fanout` 名字像事件钩子，实测**零 `pi.on`、单个 `defineTool`**，是纯工具——「fanout」指 L2 `diagnosis/{plan,fanout}.ts` 的并发编排，L1 侧只注册 `fiat_alert_diagnosis` 并渲染报告 | 分流以**实测**为准：统计 `pi.on(...)` 事件数与 `defineTool` 定义数（见 §3 表），不以命名为准 |
| **宿主级功能塞不进 Pi extension** | Pi extension 绑**单个 session** 生命周期，ctx 只有 `ui/mode/cwd/sessionManager(只读)/modelRegistry/signal`；无 HTTP 路由、无长驻服务、无渠道抽象；文档明写「run with your full system permissions」 | 长连接 / webhook / cron / 密钥 / 租户隔离 / 审批审计一律放宿主层（L2 `pi-host`）。这不是「嫌扩展麻烦」，是不能把**扩展的加载权**交给下层 |
| **Claude Code 的记忆不是 RAG** | 官方 memory 文档：两套机制 = CLAUDE.md（人写、四层、启动加载）+ auto memory（机器写、per-repo、每次会话只加载**前 200 行 / 25KB**）。**两者都是文件 + 全量注入，没有向量检索**。（第三方逆向文章提到的 `.memdir` / `teamMemorySync` 非官方文档，实现时勿作依据） | 阶段 15 别照抄"文件全量注入"：那样只解决"跨会话"，不解决"按相关性召回"。**可借鉴的是它的分层与定位口径**（记忆是 context 不是强制配置；要拦动作必须用 hook），不是它的存储与读取方式 |
| **记忆写入是持久化注入面** | 与 `tool_call` block（当轮生效）不同，记忆写入后的影响面是**此后所有会话**——一条被诱导写入的"以后无需审批"，等于长期掏空三道闸门 | 阶段 15 硬约束：主会话**零写工具**（写只能由 L2 确定性代码发起）+ 禁写三形态**正则兜底** + 正文不进审计/span + 每条带 `evidence` 可撤销 |
| **隔离失效的默认表现是「一切正常」** | 隔离出错时**不抛异常、不打日志、检索照样返回结果，只是返回了别人的**。而且「所有人共用一个分区」在功能上完全可用（甚至更"聪明"，因为模型看到了更多上下文），所以它不会被任何功能测试发现 | ① 隔离**按层**单测（每层配一个"故意让它坏"的用例，A/B 双身份是最小装置）；② 三道防线纵深（物理分区 / 闭包注入 / 后置校验），不靠"记得写过滤条件"；③ 共享必须显式声明意图（`repo`/`global`/role 约定是**有意共享**，要有测试断言 + 文档 ⚠️ 框，否则后人会把它当 bug"修"掉） |
| **默认值一旦被持久化，就无法与真值区分** | hermes `_DEFAULT_USER_ID = "hermes-user"` 的坑：setup 向导把建议默认值写进配置文件后，`configured` 就是非空 → 网关原生 id 被绕过 → 所有人共用 `hermes-user` 分区，全程无报错。fiat 的 `"cli"` 是同一形状的雷（`FIAT_USER_ID=cli` 写进 `.env` 就从"哨兵"变成"真身份"，多租户 fail-fast 再也拦不住） | 默认串必须被**显式识别为「没配」**：多租户下把 `"cli"` 视为未配置 + 存储边界拒收 `source="cli"`（P15-104）。**推论**：不要把身份值往配置文件里写（fiat 只用环境变量 + `trustedId` 注入，不学 hermes 的 `mem0.json`） |
| **fork 子会话不是"小号的会话"** | ① 身份：子会话必须**显式继承**父会话 subject，不能重新解析环境变量（服务端形态下会拿到空身份）；② 写资格：子会话产出的是「关于子任务的」，不是「用户对助手的表述」——hermes 把 `"subagent"` 与 `cron` 一起放在**跳过写入**的集合里。fiat 的记忆提取本身就跑在 fork 里，若 fork 内又能触发提取就是**递归** | 阶段 15 需两条显式规则：身份继承（读侧已由组合根从 subject 派生）+ `policy.ts` 短路 `isPrimary === false`（P15-105）。**注意这两条是不同的问题**，别用一个"子会话特殊处理"混着做 |

**Git 纪律**（多 pi session 并行时尤其重要）：

1. 禁止 `git add -A` / `git add .` / `git add -u`，只 `git add <明确路径>`。
2. 禁止 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `--no-verify`。
3. 只提交本会话改的文件，提交前跑 `git status` 确认。
4. 提交格式：`{feat,fix,docs,chore,test,refactor}[(scope)]: <msg>`，带任务 ID。
