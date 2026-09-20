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

