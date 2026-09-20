# Progress (derived)

> 自动生成，**改这里无效**。改进度请改 `DEV_SPEC.md` 里对应任务的 checkbox。


## 阶段 0：跑通骨架（验收：`pi -e` 能起，能问一句答一句）  —  5/5

- [x] P0-1 建 `fiat-agent-pi/` 仓库（TS 版，与已完成的 Python 版并存），`file:` 依赖本地 Pi，迁入 `config/*.yaml`
- [x] P0-2 `workspace/` + `AGENTS.md` + `.pi/` 软链
- [x] P0-5 装依赖并打通运行时：确认 `npm install --ignore-scripts --legacy-peer-deps` 后能 `import` Pi（运行时走 `tsconfig.runtime.json` → `pi/packages/*/src`；类型检查走各包 `dist/*.d.ts`，由本地 `tsgo -p tsconfig.build.json --emitDeclarationOnly --noEmitOnError false` 生成，gitignored，不动源码）
- [x] P0-3 写一个 hello 级扩展，`pi -e` 验证加载链路
- [x] P0-4 用 faux provider 跑一条会话单测

## 阶段 1：RAG 问答（验收：能带引用回答法币业务问题）  —  4/4

- [x] P1-5 `mcp-rag` extension + stdio transport
- [x] P1-6 **先只接一个工具跑通 `Type.Unsafe` 转换**，再铺开三个
- [x] P1-7 降级与错误表实现
- [x] P1-8 `mcp_rag.*` 三个工具注册 + promptSnippet

## 阶段 2：权限与审计（验收：ops 角色看不到也调不动生产写工具）  —  4/4

- [x] P2-9 `permission-gate` + L2 `canExecute`
- [x] P2-10 `session-factory` 按角色裁剪工具集
- [x] P2-11 `audit-hook` + PG 审计表
- [x] P2-12 三道闸门的集成测试

## 阶段 3：告警与测试环境（验收：能查日志、能建测试账号）  —  3/3

- [x] P3-13 `fiat_es_search_logs` / `fiat_db_query_*` / `fiat_lark_send`
- [x] P3-14 `fiat_test_*` 测试环境工具
- [x] P3-15 告警诊断 skill

## 阶段 4：返现与物流 dry-run（验收：生成差异清单与变更计划，不改数据）  —  3/3

- [x] P4-16 `fiat_cashback_parse` / `fiat_cashback_reconcile`
- [x] P4-17 `fiat_logistics_parse` / `fiat_logistics_validate`
- [x] P4-18 L2 workflow 状态机 + 规则引擎

## 阶段 5：审批与生产写（验收：完整走通 dry-run → 工单 → 审批 → 执行 → 审计）  —  4/4

- [x] P5-19 approval ticket + 一次性 token + 幂等键
- [x] P5-20 `fiat_job_apply`
- [x] P5-21 Lark 审批卡片
- [x] P5-22 审计后台

## 阶段 6：（之后）  —  5/5

- [x] P6-23 RAG server 补 streamable-http 入口 → 配置切 http
- [x] P6-24 `model-router`
- [x] P6-25 多 agent 并行告警诊断
- [x] P6-26 业务 CLI（Web Console 按决策不做；离线命令零依赖可跑，diagnose 仅在配置 FIAT_MODEL 时经动态 import 加载 Pi）
- [x] P6-27 Pi harness 迁移跟进 → 评估 `PostgresSessionRepo`（结论：当前不可注入 coding-agent 会话路径，保持 JSONL 轨迹 + PG 业务/审计混合存储；预留 drop-in 设计与接入 seam，见 `docs/P6-27-postgres-session-repo.md`）

## 阶段 7：Pi 依赖 registry 化（架构不变，extension 机制仍在）  —  6/6

- [x] P7-28 **前置验证**：npm 安装 `@earendil-works/pi-{agent-core,ai,coding-agent}@0.80.3` 成功；复核 `Agent` / `runAgentLoop` / `SessionManager` / `DefaultResourceLoader` / `SettingsManager` 等符号在 0.80.3 的 d.ts 中均在（本地 dist 已核实，装完再复核一次）→ ✅ 2026-09-04 临时目录实测：三包安装成功（`pi-coding-agent@0.80.3` 版本核实）；`coding-agent` 10 符号、`agent-core` 的 `Agent`/`runAgentLoop` 全在；`pi-ai` 的 `Type` 经 typebox re-export、`Api`(types.d.ts:14)/`Model`(types.d.ts:567) 均在
- [x] P7-29 **依赖切换**：`package.json` 4 条 `file:../pi/packages/*` → 精确版本 `0.80.3`（不带 `^`）。`pi-agent-core` 虽当前零直接引用但**保留**（阶段 8 驱动循环要用）；`pi-tui` 依「是否保留 TUI 入口」决定去留
- [x] P7-30 **删 paths**：移除 `tsconfig.runtime.json`（→`*/src`）与 `tsconfig.json`（→`*/dist`）里全部指向本地 pi 的 paths（各 4 条）
- [x] P7-31 **调试开关**：加 `dev:pi-local` / `dev:pi-registry` 一键切换脚本（深挖 Pi 内部时临时切回本地源码链接，用完切回）
- [x] P7-32 **回归**：**无 sibling `pi/`** 的干净环境跑通 CI；阶段 0–6 验收标准重跑（本阶段架构未变，应全绿）
- [x] P7-33 **升级节奏制度化**：把「钉版本 → 跑测试 → 再 bump」写进 §9，Pi 版本 bump 为独立任务而非顺手升级

## 阶段 8：pi-host 内嵌宿主层（对标 pi-embedded）  —  7/7

- [x] P8-34 **最小循环**：用 `Agent` / `runAgentLoop` 驱动最小循环，跑通「问一句答一句」（对标 openclaw `pi-embedded` 最小骨架）
- [x] P8-35 **会话基础设施**：接入 `SessionManager` / `parseSessionEntries` / `migrateSessionEntries` / `CURRENT_SESSION_VERSION` / `DefaultResourceLoader` / `SettingsManager`（取自 `pi-coding-agent`，**当库用**）
- [x] P8-36 **工具注册通道（L1b）**：替代扩展加载器，把工具**直接**注册进内嵌循环（承载 4 个工具型扩展）
- [x] P8-37 **钩子通道（L1a）**：**【更正】** 不实现 pi-host 自研 before-tool-call 钩子，改为打通 `extensionFactories` 注入通道（对标 `pi-embedded-runner/extensions.ts` 的 `buildEmbeddedExtensionFactories()`），承载闸门② 与 3 个钩子型扩展
- [x] P8-38 **宿主职责移植**：provider 错误兜底 / 消息去重·清洗 / thinking·图片 / bootstrap context / 事件扇出（逐项对标 `pi-embedded` 文件职责）
- [x] P8-39 **版本差异对齐**：以 0.80.3 实际 d.ts 为准，核对与 OpenClaw 所用 0.75.5 的 API 差异并落表
- [x] P8-40 **关闭自动发现 + 通道自测**：`DefaultResourceLoader` 显式传 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true`；自测「编译期注入的 extension 生效、外部目录 extension 不生效」

## 阶段 9：L1 重写（7 个 Pi 扩展 → 3 个内建 extension + 4 个工具模块）  —  10/10

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

## 阶段 10：（之后）  —  3/3

- [x] P10-50 清理**扩展加载器**残留（`pi -e` 与 `.pi/extensions` 目录扫描引用归零）
- [x] P10-51 文档同步：`AGENTS.md`、Obsidian 技术方案、以及本文 §1/§3 中 L1 的描述
- [x] P10-52 评估是否进一步**内化** `agent-core`（对标 OpenClaw v2026.5.28 的做法），作为长期选项单独立项

## 阶段 11：三层评测（结果 / 轨迹 / 单步）  —  9/9

- [x] P11-53 **eval 纯逻辑 types + outcome grader**：`src/server/eval/types.ts`（`EvalCase` / `RunTrace` / `StepRecord` / `Score` / `TrajectoryExpectation`）+ `src/server/eval/outcome.ts`（终态判定 `terminalOf`：`answered` / `ticket_created` / `applied`；`requiresApproval` 校验必须出现 `fiat_job_apply`；`stopReason error/aborted` → 0 分）
- [x] P11-54 **轨迹打分**：`src/server/eval/trajectory.ts`——LCP 前缀匹配（部分分来源）、路标子序列相对顺序校验、forbid/max_steps 硬约束、blocked/超步惩罚、按上方公式合成
- [x] P11-55 **单步打分 + 汇总**：`src/server/eval/first-step.ts`（`any_of` 首工具命中）+ `src/server/eval/aggregate.ts`（加权汇总 + `passed` 判定：outcome 一票否决）
- [x] P11-56 **case 配置加载**：`config/eval_cases.yaml`（首个 case：alert-diagnose-prod，含 terminal / requires_approval / first_step.any_of / milestones / forbid / max_steps / threshold）+ `src/server/eval/cases.ts` 加载与校验（缺 terminal / threshold 的 case 拒绝加载）
- [x] P11-57 **InMemoryEvalSink**：`src/server/eval/sink.ts`——`EvalSink` 接口（`writeRun`）+ `InMemoryEvalSink`（零依赖，测试断言用）；run / step / score 结构与设计方案 §3 三张表字段一一对应
- [x] P11-58 **eval-recorder L1a 扩展**：`src/server/host/l1a/eval-recorder.ts`——订阅 `turn_start` / `turn_end` / `agent_end`，从 `turn_end.toolResults` 提取 step（tool / isError / blocked 推断 / durationMs），`agent_end` 时组装 `RunTrace` 写 sink；factory 尾部追加进 `buildSession` 的 factories（不插队，位置契约：`[gate, audit, modelRouter, ...evalRecorder?]`）；`SessionFactoryOptions` 加可选 `evalSink?: EvalSink` + `parentRunId?: string`，**缺省不注册（fail-safe，现有测试零改动）**
- [x] P11-59 **宿主事件扇出补齐**：`src/server/host/loop.ts` / `extensions.ts`——`PiHostLoop` 订阅 `Agent.subscribe()`，把 `turn_start` / `turn_end` / `agent_end` 经 `runner.emit(...)` 扇出给 extension 钩子（P8-38 遗留职责，eval-recorder 的前置）；不改 Pi 核心
- [x] P11-60 **三层评测集成测试**：`test/eval-outcome.test.ts` / `test/eval-trajectory.test.ts` / `test/eval-first-step.test.ts`（纯逻辑直接断言）+ `test/eval-recorder.test.ts`（faux provider 驱动完整会话：闸门② block 场景 → step.blocked=true；正常场景 → 全链路 score 落 InMemoryEvalSink、pass 判定生效）
- [x] P11-61 **CI case 闭环**：跑真实 `config/tool_policies.yaml`（不放宽）+ stub Lark/Fiat client，`cashback-reconcile-approval` case 全链路出分 ≥ threshold（含 viewer 越权场景：gate ①裁剪后猜名调用 → not found 记 blocked + outcome 一票否决）；同步 `npm run check` 全绿

## 阶段 12：自进化循环（轮末反思 → 提案 → 审批 → 评测准入）  —  11/11

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

## 阶段 13：告警 webhook 网关（gateway 常驻进程 + hooks 端点，参考 OpenClaw）  —  9/9

- [x] P13-73 **契约与配置**：`src/server/gateway/types.ts`（`AlertEnvelope`：`alert_id` / `fingerprint` / `severity: "P0"|"P1"|"P2"|"P3"` / `fired_at` / `status: "firing"|"resolved"` / `source` / `alert: AlertInput`——**AlertInput 本体保持 4 字段不动**，它是给模型看的压缩视图，结构化字段只在信封与持久化层）+ `config/gateway.yaml`（`port` / `bind: "loopback"` / `token`（独立 hook token，**不复用其他凭据**）/ `autoDiagnoseSeverities: ["P0","P1"]` / `dedupeTtlMinutes` / `maxInflightPerService`）
- [x] P13-74 **HTTP 服务骨架**：`src/server/gateway/server.ts` —— `node:http` 起服务（**零新依赖**，对齐 CLI「纯 Node、零新依赖」惯例），仅 loopback bind；请求体大小上限（如 64KB）+ 超时；进程级错误隔离：单请求异常不影响主监听
- [x] P13-75 **hooks 端点与鉴权**：`POST /hooks/alert` —— Bearer token 恒定时间比对（防时序侧信道）；token 缺失/错误 → 401，payload 非法（schema 校验）→ 400；健康检查 `GET /healthz`；**query string 里传 token 一律拒绝**（对齐 openclaw 口径）
- [x] P13-76 **payload 适配层（mapping）**：`src/server/gateway/adapters.ts` —— 各告警平台 payload → `AlertEnvelope` 的纯函数转换器；首版先实现一个通用 JSON 适配器（字段映射表驱动，config 里可配 `titleField` / `serviceField` 等），后续按接入的平台（Prometheus Alertmanager / 灯塔 / 自研）逐个加；转换失败明确报错不猜字段。**fingerprint 生成规则**（适配层职责，纯函数）：平台自带 fingerprint/dedup 键（如 Alertmanager 的 `fingerprint`）则**透传**；否则本地算 `sha256(source + "|" + alertName + "|" + service + "|" + sorted(labels_json))` —— 刻意**不含 timestamp / 实例 ip / 计数值**，保证「同一条告警的重试与重复通知」哈希一致，而「换了实例/换了的标签集」是不同指纹。**severity 归一化**：severity 由告警平台判定、随 payload 传入，网关**只做映射不判断**（critical/fatal→P0、error/high→P1、warn→P2、info→P3 映射表可配）；payload 缺 severity 或映射表未命中 → 一律降级 P2（宁可少自动诊断，不可误触发）
- [x] P13-77 **幂等与持久化**：`src/server/gateway/store.ts` —— SQLite 表 `fiat_alert_event`（`id` / `fingerprint` / `status` / `severity` / `envelope_json` / `diagnosis_session_id?` / `created_at` / `last_seen_at` / `last_diagnosis_at?`）；幂等判定（store 层纯查询 + 插入/更新，**单进程内用 SQLite 串行性兜底，不加分布式锁**）：`SELECT ... WHERE fingerprint = ? AND status = 'firing'` 命中 → 只 `UPDATE last_seen_at = now`（若 `severity` 比现存**升级**则视为新事件重新诊断，降级只记不改）；未命中 → INSERT + 触发下游分级。`resolved` 推送 → `status='resolved'` 关闭活跃告警；`dedupeTtlMinutes` 兜底：firing 超过该时长无后续推送 → 视为过期（平台丢了 resolved），状态改 `stale`，此后同 fingerprint 再来按新事件处理。表结构与会话存储同库（复用既有 SQLite 栈）
- [x] P13-78 **severity 分级策略**：`src/server/gateway/policy.ts`（纯函数，零 Pi 依赖）—— P0/P1 → 自动起诊断；P2/P3 → 只落库 + Lark 发摘要卡（带「让 Agent 诊断」的触发指引，人回一句即可唤起）。**限流（防告警风暴）逻辑**：per-service **inflight 计数器**（进程内 `Map<service, number>`，诊断开始 +1、结束（成功/失败/超时）-1）+ 有界等待队列；新告警到闸：`inflight < maxInflightPerService` → 立即诊断；`≥ max` 且队列未满 → 入队（**同 fingerprint 的等待期内新推送合并去重**）；队列满 → 事件标 `throttled` 落库 + 汇总后 Lark 节流通知（**绝不静默丢弃**）。选 inflight 计数而非固定速率窗口的原因：诊断单次耗时波动大（fan-out 多视角子会话），按「同时在跑几个」限才能守住 token 预算，速率窗口挡不住长耗时堆积
- [x] P13-79 **诊断执行链**：`src/server/gateway/runner.ts` —— `AlertEnvelope.alert` → 复用 `src/server/session/factory.ts` 起独立 AgentSession（角色/env 取配置，缺省 ops/prod 只读口径）→ 组装诊断 prompt（含信封结构化信息：severity / fired_at / 原文 detail）→ 模型走 `fiat_alert_diagnosis`（或直接调 `diagnosisPlan` + `runFanout`，实现时按子会话工具注册口径二选一，**不改 plan/fanout 纯函数**）→ `renderReport()` 出报告 → 回写 `diagnosis_session_id`
- [x] P13-80 **Lark 回推**：复用 `fiat_lark_send` 既有通道把报告卡发值班群；P0 附审批提示（若诊断建议含写操作，指引走 `approve/reject` 工单流，网关**绝不直接执行写**）
- [x] P13-81 **CLI 与测试**：`fiat gateway`（启动常驻进程，前台跑，daemonize 不做）/ `fiat gateway status`；测试 `test/gateway-server.test.ts`（鉴权 / 4xx / 体积上限）、`gateway-store.test.ts`（fingerprint 幂等 / resolved 闭环）、`gateway-policy.test.ts`（分级 / 限流纯函数分支）、`gateway-e2e.test.ts`（curl 模拟推送 → stub Lark → 断言落库与诊断触发，模型层用 faux provider）；同步 `workspace/AGENTS.md` 工具清单与本节

## 阶段 14：Langfuse 全链路追踪（一条执行链路 = 一条 trace，OTLP/HTTP）  —  9/9

- [x] P14-82 **契约与配置**：`src/server/tracing/types.ts`（`TracingConfig` / `TraceKind` / `SpanKind` / `TraceSpan`（`traceId` / `spanId` / `parentSpanId?` / `name` / `kind` / `startNs` / `endNs` / `attributes` / `status` / `level`）/ `AttributeValue` 联合类型 / `TraceContext`（一次 trace 的共享上下文：`traceId` + 根 `spanId` + 采样结论 + trace 级属性）/ `Tracer` 接口）+ `src/server/tracing/config.ts`（`loadTracingConfig(path?)`：读 yaml + `${VAR:-default}` 插值 + 校验——`enabled=true` 而公钥/密钥环境变量缺失 → **fail-fast 抛错**（同 gateway token 口径，不静默降级成「追踪悄悄不工作」）；`capture_content` 非法值 / `sample_rate` 越界 → 拒绝；`DEFAULT_TRACING_CONFIG` 使 `enabled=false`）+ `config/tracing.yaml`
- [x] P14-83 **OTLP 编码器（纯函数，零依赖）**：`src/server/tracing/ids.ts`（`randomTraceId()` 32 hex / `randomSpanId()` 16 hex / `msToNanos` / `hexId` 校验）+ `src/server/tracing/otlp.ts`（`encodeOtlp(spans, ctx, cfg)` → `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }`：`startTimeUnixNano` 字符串、`attributes` → `{key, value:{stringValue|intValue|doubleValue|boolValue|arrayValue}}`、`langfuse.*` 属性映射、**trace 级属性下发到每个 span**、`gen_ai.*` 语义约定（`gen_ai.operation.name="chat"` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`）、`status.code` 与 `langfuse.observation.level` 对应、脱敏函数 `redact(value, mode, keys)` 三档 + `redact_keys` 一律遮罩）
- [x] P14-84 **TracingClient 三实现 + 批处理队列**：`src/server/tracing/client.ts` —— `TracingClient` 接口（`send(spans)` / `flush()` / `shutdown()` / `stats()`）+ `NoopTracingClient`（`enabled=false`，**零网络零定时器**）/ `InMemoryTracingClient`（测试断言，与 `InMemoryAuditClient` 同构）/ `HttpOtlpTracingClient`（原生 `fetch` + `AbortSignal.timeout`；Basic auth `Buffer.from(pk + ":" + sk).toString("base64")`；必带 `x-langfuse-ingestion-version`；有界队列丢最旧 + `max_batch` + `flush_interval_ms` 定时器 `unref()` + 重试 + `dropped` 计数；**任何失败都不抛**）
- [x] P14-85 **Tracer 与 span 构建器**：`src/server/tracing/tracer.ts` —— `createTracer(cfg, client)`：`startTrace({name, kind, sessionId, userId, role, environment, metadata})` → `TraceContext`（生成 traceId + 根 spanId、按 `sample_rate[kind]` 采样，允许注入 `random` 保证测试确定性）；`startSpan(ctx, name, opts)` → `SpanHandle`（`setAttribute` / `setInput` / `setOutput` / `setModel` / `setUsage` / `setLevel` / `setStatus` / `end()`，`end()` 幂等）；`withSpan(ctx, name, opts, fn)`（异常自动 `recordError` 后 rethrow）；`shutdown()`（flush + 取消防抖定时器）；**span 仅在 `end()` 时入队**（OTLP 无 update 事件，一次成型）
- [x] P14-86 **L1a trace-hook**：`src/server/host/l1a/trace-hook.ts` —— `turn_start` 开 `fiat.llm.turn`（generation）/ `turn_end` 关 span + `gen_ai.usage.*`（取自 `event.message.usage`）+ **对账补 blocked tool span** / `tool_call` 开 `fiat.tool` / `tool_result` 关 span（isError → ERROR）；**尾部追加、只读不拦、缺省不注册**；位置契约更新为 `[gate, audit, modelRouter, ...evalRecorder?, ...evolutionTrigger?, ...traceHook?]`
- [x] P14-87 **宿主与组合根接线**：`PiHostLoop` 新增可选 `tracer` + `trace: TraceContext`（`runTurn` 开/关根 span `fiat.turn`，`runTurnSafe` 把 provider 错误写 span status/level）；`buildSession` 新增 `tracer?` → ① 开 `fiat.gate.build` span（记录角色 / 环境 / 注册工具数）② 尾部追加 trace-hook ③ 用装饰器包 `policyClient` 产出 `fiat.gate.can_execute` span；`SessionFactoryResult` 透出 `tracer`
- [x] P14-88 **L2 全链路子 span**：`approval/ticket.ts` 新增可选 `tracer`（`fiat.ticket.create` / `fiat.ticket.approve` / `fiat.ticket.apply` 三处，含幂等键与 token 校验结论）；`host/l1b/mcp-rag.ts` 的 `callTool` 外包 `fiat.mcp.call` span（transport / 耗时 / isError）；`diagnosis/fanout.ts` + `sessionRunner.ts` 透传父 span（每视角一个 `fiat.fanout.angle` span，**挂同一 trace**），子会话用该 span 作父
- [x] P14-89 **gateway / evolution / CLI 接线**：`gateway/runner.ts` 在 `handleAlert` 开根 span `fiat.alert.handle`（tags=`[gateway, severity]`、metadata=`{fingerprint, source}`）+ dedupe / classify / queue 三段子 span，诊断派发把该 `TraceContext` 透传给 `diagnose()` 使蜂群挂同一棵树；`cli/chat.ts` 装配 tracer 并把 `TraceContext` 交给 `PiHostLoop`；evolution 评审 fork 开独立 trace（`fiat.evolution.review` + metadata `parentSessionId`）；`cli/index.ts` 新增 `fiat trace status`（打印 enabled / endpoint / 队列与丢弃计数，**离线零 Pi 依赖**）；`shutdown` 在 `fiat chat` 结束与 gateway `SIGINT` 时显式 flush；同步 `workspace/AGENTS.md`
- [x] P14-90 **测试与验收**：`test/tracing-otlp.test.ts`（纯函数：traceId 32 hex / spanId 16 hex / nanos 合法 / `langfuse.*` + `gen_ai.*` 映射 / **trace 级属性出现在每个 span** / 脱敏三档 + `redact_keys` 遮罩）+ `test/tracing-client.test.ts`（本地 stub HTTP server 收包：Basic auth 头与 `x-langfuse-ingestion-version` 正确、批次大小、定时 flush、**队列满丢最旧且计数**、上报失败只重试不抛、`enabled=false` 零请求）+ `test/tracing-hook.test.ts`（faux provider 驱动完整会话：根 span + N 个 generation + tool span **树闭合**；**闸门② block 场景仍出 span 且 level=WARNING**）+ `test/tracing-e2e.test.ts`（gateway 推一条 P0 → 同一 `traceId` 下 alert 根 + N 个视角 span + 子会话 generation 链）；`npm run check` + `npm test` 全绿

**总计 92/92**

