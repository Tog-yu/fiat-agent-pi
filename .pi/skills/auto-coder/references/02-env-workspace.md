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

