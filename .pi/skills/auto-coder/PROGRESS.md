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

## 阶段 15：跨会话长期记忆（RAG 检索式，参考 Claude Code）  —  16/16

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

**总计 108/108**

