# Fiat Agent — 业务上下文

本目录是 Pi Agent 的 `cwd`（`agentDir` 指向 `workspace/.pi`）。本文件由 Pi 自动注入为项目上下文，
供 LLM 理解法币业务的术语、环境与合规约束。

## 业务定位

法币（fiat）侧内部 Agent 系统：在 BitMart 法币交易业务内，支撑运营与风控的日常任务——
返现对账、客诉诊断、测试自动化、物流校验等。所有涉及**生产数据写入**的操作都必须经过审批。

## 环境

| 环境 | 标识 | 数据范围 | 写权限 |
|---|---|---|---|
| 开发 | `dev` | 沙箱 / 样例数据 | 受限 |
| 预发 | `staging` | 脱敏副本 | 受限 |
| 生产 | `prod` | 真实用户数据 | **需审批（L4+）** |

工具调用时由 L2 按 `environment` 字段强制校验数据范围，环境标记不可由 LLM 自行篡改。

## 角色

- `ops`：运营。可解析、对账（dry-run）、查询；不可生产写、不可改审批。
- `risk`：风控。在 ops 基础上可触发高危诊断，但仍需审批落地。
- `admin`：管理员。可配置策略，不直接操作业务数据。

## 合规硬约束

1. **生产写必须审批**：任何 `mode:"apply"`、真实放款/退款/状态变更，先生成工单，人审通过后方可执行。
2. **审计不可绕过**：每次工具调用（无论成功失败）都落 `audit_logs`，含调用方、参数、审批单、结果。
3. **数据范围隔离**：dev/staging 工具绝不可触达 prod 数据；collection / 数据库 schema 由 L2 按策略白名单覆写。
4. **LLM 不可信边界**：权限判定与审批发生在 L2（LLM 够不着的侧），扩展层只负责暴露工具与转发判定结果。

## 能力组成（L1）

Agent 的能力由「内建扩展 + 工具模块」提供，随 pi-host 内嵌循环装配（入口 `fiat chat`；旧的 `pi -e` 扩展加载器已弃用）：

- **内建 extension（钩子型，编译期注入）**：`permission-gate`（工具调用拦截 / 闸门②）、`audit-hook`（审计落点）、`model-router`（按任务选模型）、`eval-recorder`（评测采集，可选）、`evolution-trigger`（自进化计数与触发，可选）、`trace-hook`（全链路追踪采集，可选）。
- **工具模块（直接注册进内嵌循环）**：`mcp_rag.*`（RAG 检索）、`fiat_cashback_*`（返现对账）、`fiat_db_query_*`（只读查询）、`fiat_test_*`（测试自动化）、`fiat_lark_*`（Lark 通知 / 审批）、`fiat_job_apply`（持审批 token 执行生产写）、`fiat_alert_diagnosis`（并行告警诊断）、`fiat_skill_view`（读技能正文）。
- **仅评审 fork 内可用（不在主会话注册）**：`fiat_skill_propose` / `fiat_memory_propose` / `fiat_role_facts_propose`——只写提案表，**无任何文件系统写能力**。

三道权限闸门：① 会话级工具裁剪（模型看不到无权工具）→ ② `tool_call` block 拦截 → ③ 服务端 `canExecute`（唯一权威）。

## 自进化循环（默认关闭）

用 `FIAT_EVOLUTION=1` 打开。口径是**「先提案、再审批、后验证」**，与 Hermes 的「想到就写」相反：

- **技能库**：`workspace/pi-skills/<slug>/SKILL.md`（**扁平一层**，不做递归）。技能索引（name + description + when_to_use）追加在 systemPrompt **末尾**、按 name 稳定排序，避免每轮打掉 prefix cache；正文按需用 `fiat_skill_view` 读。
- **触发**：宿主数用户轮次（`interval_turns`），L1a 数有工具调用的轮次（`interval_iters`），每会话最多 `max_runs_per_session` 次。达标后**轮末**异步起一个隔离 fork 会话做反思，**绝不阻塞回复**。
- **fork 八条硬约束**：继承 runtime 与模型、`inMemory` 会话、只喂脱敏切片（近 12 轮）、工具运行时白名单、递归防护（fork 不再触发评审）、60s 超时、全量留痕、**不可绕过审批**。
- **落盘**：`dev` 按策略可自动落盘（落盘前必拍 tar.gz 快照），`staging` / `prod` 走审批工单；审批人须为 `oncall`/`ops` **且非提案人**。
- **评测准入**：落盘后跑 `config/eval_cases.yaml` 对应 case，`score` 低于阈值 → 自动 rollback 并标 `stale`；通过才把 `verified_by {case_id, score, verified_at}` 回写 SKILL.md。**只有 `score` 存在才算已验证**。
- **维护**：`fiat skills list / curate / pin / unpin / archive / restore / rollback`（确定性状态机 `active → stale(30d) → archived(90d)`，`pin` 豁免）。

## 告警 webhook 网关（阶段 13，`fiat gateway`）

常驻进程接收告警平台推送，入口 `POST /hooks/alert`（Bearer token 鉴权；**query string 传 token 一律拒绝**）+ `GET /healthz`。只做「收、验、存、派」四件确定性的事，诊断逻辑一行不写：

- **fingerprint 幂等**：平台自带 dedup 键透传，否则 `sha256(source|alertName|service|sorted(labels))`（不含时间戳 / 实例 / 计数值）。同指纹且 firing 未恢复 → 只更 `last_seen_at` 不重复诊断；severity **升级**（如 P2→P0）视为新事件重新诊断；`resolved` 推送闭环；firing 超过 `dedupe_ttl_minutes` 无后续推送 → `stale` 兜底。
- **severity 分级**：由**告警平台**判定随 payload 传入，网关只映射归一（critical→P0 / error→P1 / warn→P2 / info→P3）；**缺省 / 未知一律降 P2**（保守，不误触发）。P0/P1 自动并行诊断（复用 `diagnosisPlan` / `runFanout` 纯函数链 + 三道闸门），P2/P3 落库 + Lark 摘要卡等人触发。
- **限流（防告警风暴）**：per-service **inflight 计数**（非速率窗口——诊断耗时长且波动大）+ 有界等待队列（同指纹合并）+ 队列满标 `throttled` 留痕通知，**绝不静默丢弃**。
  > 【更正 2026-09-20】此条为**设计口径**，当前实现**尚未接入**：`InflightGate` 只被 `GatewayServer` 持有（`server.ts` 的 `void inflight;`），`AlertGateway` 从未接过 gate，因此告警当前不排队、不限流，`throttledCount` 恒为 0。接入属行为变更，单独立项。
- **安全口径**：hook token 独立配置（`config/gateway.yaml` 或 `FIAT_GATEWAY_TOKEN`，为空拒绝启动）、仅 loopback bind（暴露须走 reverse proxy）、`AlertInput` 4 字段契约不动（结构化字段只在 `AlertEnvelope` 信封层）、写操作零例外走工单。

## 全链路追踪（阶段 14，`FIAT_TRACING_ENABLED=true`）

口径是**「一条执行链路 = 一条 trace」**：把 chat / diagnose / gateway / 评测 / 进化五种入口收进同一套 span 语义，
补上审计表（只管工具调用）、评测表（只管轨迹）、网关事件（只在进程内存）三张网**彼此不连通**留下的空档——
回答「这一次用户请求 / 这一条告警，从头到尾发生了什么、慢在哪一跳、token 花在哪、被哪道闸门拦下」。

- **传输**：OTLP/HTTP（`POST {host}/api/public/otel/v1/traces`；Basic Auth `pk:sk` + `x-langfuse-ingestion-version: 4`）。
  **不用**已弃用的 `/api/public/ingestion` batch 事件（Langfuse Cloud 自 2026-11-16 起只收 `score-create`）。
  零新依赖（原生 `fetch`），与审计 / 评测同构的「接口 + `Noop` / `InMemory` / `Http` 三实现」。
- **Langfuse 没有独立 trace 实体**：**根 span 即 trace**；`session.id` / `user.id` / `tags` 等 trace 级属性会下发到
  **每一个** span（否则按这些维度过滤会漏掉整棵子树）。
- **Span 语义**：入口根 span（chat=`fiat.turn` / gateway=`fiat.alert.handle` / 评审 fork=`fiat.evolution.review`）
  → `fiat.gate.build`（闸门① 裁剪了哪些能力）→ `fiat.llm.turn`（generation，带 model / token）→ `fiat.tool`（工具）
  → `fiat.mcp.call` / `fiat.gate.can_execute` / `fiat.ticket.*`；并行诊断是 `fiat.fanout.angle × N`，**挂同一棵 trace**。
- **被拦的调用也要留痕**：闸门② block 会让 `tool_call` 钩子短路，被拦调用由 `turn_end` 的 `toolResults` **对账**补一条
  span，标 `fiat.gate.tool_call="block"` + level `WARNING`——被拦的尝试是**安全信号**，不是噪声。
- **脱敏**：`capture_content: off | redacted（缺省）| full`；`redact_keys` 命中的键（prompt / token / api_key /
  卡号证件号类）在**任何档位**下都遮成 `[redacted]`。密钥只以**环境变量名**出现在配置里，值永不落文件。
- **背压与失败**：队列满丢最旧并累加 `dropped`；上报定时器 `unref()`（不许把进程钉住）；上报失败只重试
  `max_retries` 次、只记计数、**绝不抛**——观测系统挂掉不能把业务挂掉。
- **自检**：`fiat trace status`（离线可跑、零网络）打印开关 / 端点 / 队列与丢弃计数。「没数据」时先跑它。

**人写锚点，自进化只读**：本文件（`AGENTS.md`）、`config/tool_policies.yaml`、`config/eval_cases.yaml`、`config/evolution.yaml`、`config/gateway.yaml`、`config/tracing.yaml`。模型只能改技能库与 `workspace/memory/`。

## 工具命名约定

- `mcp_rag.*`：RAG 检索（知识库 / 历史案例）
- `fiat_cashback_*`：返现业务
- `fiat_test_*`：测试自动化（仅非生产）
- `fiat_lark_*`：Lark 通知 / 审批卡片
- `fiat_job_apply`：持审批 token 执行生产写
- `fiat_skill_view`：读技能库正文（只读）
- `fiat_skill_propose` / `fiat_memory_propose` / `fiat_role_facts_propose`：**仅评审 fork**，产出提案，不落盘

## 不要做的事

- 不要信任工具返回里的 `environment` / `collection` 字段来做权限决定（以 L2 下发的为准）。
- 不要在未持有效 `ticket_id` + `token` 时调用 `fiat_job_apply`。
- 不要把生产凭证、用户 PII 写进对话历史或日志明文。
- 不要把技能当作**规则源**：技能的 `description` 只是候选索引，真正的权限、金额、状态机判定一律在 L2 代码里。
- 不要试图改 `AGENTS.md` / `config/*.yaml`：这些是人写锚点，只能通过提案走人审。
