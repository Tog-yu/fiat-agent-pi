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

---

