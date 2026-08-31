# P6-27 评估：Pi harness 迁移跟进 → `PostgresSessionRepo`

> 任务性质：**评估 + 决策**，不是实现。结论先行。
> 关联执行项：`DEV_SPEC.md` 阶段 6 `P6-27`。
> 验证依据：本地 `pi` 副本源码（`packages/agent`、`packages/coding-agent`），2026-08-31 核对。

## 结论

**`PostgresSessionRepo` 当前不可注入 fiat-agent 的会话路径，且在其可注入之前不应 fork Pi 去强接。保持现状（Pi JSONL 存对话轨迹 + PG 存业务态/审计）。**

- harness 侧已经有一个**干净、稳定**的 `SessionStorage<TMetadata>` 接口，`PostgresSessionRepo` 作为它的实现在**技术上是可行的、零改 Pi 核心**；
- 但 fiat-agent 真正驱动的是 `coding-agent` 的 `AgentSession`，它**仍运行在自有的 `SessionManager` 上**，`createAgentSession` 没有 `sessionStorage` 选项、也没有任何 `SessionManager → SessionStorage` 的桥接。  
  → 在 Pi 把 harness `SessionStorage` 接入 `AgentSession` 之前，PG 会话存储**没有干净注入点**。

## 现状核对（已 grep 源码，非凭记忆）

### 1. harness 已有可用的 `SessionStorage` 契约

`packages/agent/src/harness/types.ts:440`：

```ts
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType extends SessionTreeEntry["type"]>(type: TType): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}
```

- 配套实现已存在：`JsonlSessionStorage`（`harness/session/jsonl-storage.ts:161`）、`InMemorySessionStorage`（`harness/session/memory-storage.ts:40`）。
- 工厂接口 `SessionRepo<TMetadata>`（`types.ts:468`）：`create/open/list/delete/fork`。
- 数据模型是 **append-only 树**：`SessionTreeEntry` 共 11 种（`types.ts:409`）：`message / thinking_level_change / model_change / active_tools_change / compaction / branch_summary / custom / custom_message / label / session_info / leaf`。每条都继承 `SessionTreeEntryBase`（含 `id` / `parentId` / `timestamp`）。再加 metadata（id/createdAt/cwd/path/parentSessionPath）+ leaf 指针 + label 缓存。

### 2. coding-agent 的 `AgentSession` 没有用它

`packages/coding-agent/src/core/sdk.ts:166 createAgentSession`：

- 第 178 行：`const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));`
- 第 293 行：`agent = new Agent({...})`
- 第 377 行：`const session = new AgentSession({ agent, sessionManager, ... })` —— 直接吃 `SessionManager`。

`CreateAgentSessionOptions`（`sdk.ts:34`）里**没有** `sessionStorage` / `storage` 字段；`AgentSession` 构造函数只认 `sessionManager`（`packages/coding-agent/src/core/session-manager.ts` 是旧抽象，绑定 JSONL-on-disk + in-memory，与 harness `SessionStorage` 是两套平行世界）。

→ 写一个实现 `SessionStorage` 的 `PostgresSessionRepo` 很容易，但**没有任何调用方能把它传给 `AgentSession`**。强接 = 改 `sdk.ts` / `agent-session.ts` = 违反铁律 #5（不改 Pi 核心）。

### 3. 上游在动，但还没接到 coding-agent

`git log -- packages/agent/src/harness/session/` 近期活跃：`Finish harness tool registry semantics`、`harden harness session semantics`、`isolate node filesystem session dependencies`。即 harness 会话基础设施在演进，但**尚未**看到把它接入 `createAgentSession`/`AgentSession` 的提交（本地分支无 `harness-integration` 之类）。

## 决策

| 选项 | 评估 | 结论 |
|---|---|---|
| A. 现在 fork Pi 把 `SessionStorage` 接进 `AgentSession` | 改 Pi 核心，违背铁律 #5；与上游并行演进会冲突、难合并 | **否决** |
| B. 在 L2 自己镜像一份 transcript 进 PG | 与 Pi `SessionManager` 双写，易漂移、恢复语义难对齐（分支/紧凑/回退是 Pi 内部状态机） | **不优先**；仅当确需跨会话检索/分析时单独立项 |
| C. 保持现状混合（JSONL 轨迹 + PG 业务/审计），跟踪上游迁移，预先备好 `PostgresSessionRepo` 设计 | 零改 Pi、不漂移、等上游 seam 出现即 1 小时接入 | **采纳** |

**保持**：Pi JSONL 存对话轨迹（含分支/紧凑/回退）；PG 存业务态 + 审计（既有 `audit-hook` + PG 审计表）。

## 预留的 drop-in 设计（等上游 seam 出现即用）

> 仅当 Pi 在 `createAgentSession` 增加 `sessionStorage?: SessionStorage` 选项、且 `AgentSession` 改吃它时，下面这套直接落地。

### 接口实现骨架

```ts
// src/server/session/postgres-session-repo.ts  （零 Pi 核心改动，纯实现 harness 接口）
import type { SessionStorage, SessionTreeEntry, SessionMetadata } from "@earendil-works/pi-agent/harness";

export class PostgresSessionRepo<TMetadata extends SessionMetadata>
  implements SessionStorage<TMetadata> {
  constructor(private db: Pool, private meta: TMetadata) {}
  // getMetadata / getLeafId / setLeafId / createEntryId / appendEntry /
  // getEntry / findEntries / getLabel / getPathToRoot / getEntries
  // 全部映射到下表 SQL，appendEntry 走 INSERT（append-only，不更新）
}
```

### PG 表结构

```sql
-- 会话元数据（每行一个 session）
session_metadata (
  id            text primary key,
  created_at    timestamptz not null,
  cwd           text not null,
  path          text,
  parent_session_path text,
  -- TMetadata 业务扩展列（tenant_id 等）按 L2 多租户约定加
  tenant_id     text not null default 'default'
);

-- append-only 树：每条 SessionTreeEntry 一行
session_entry (
  id          text not null,
  session_id  text not null references session_metadata(id),
  parent_id   text,                 -- 树边
  seq         bigint,               -- 同会话内单调序号，保证回放顺序
  type        text not null,        -- 11 种 entry type
  payload     jsonb not null,       -- 整条 SessionTreeEntry
  created_at  timestamptz not null default now(),
  primary key (session_id, id)
);
create index on session_entry (session_id, type);
create index on session_entry (session_id, parent_id);

-- leaf 指针（当前活跃分支叶）
session_leaf ( session_id text primary key references session_metadata(id), leaf_id text );

-- label 缓存（targetId -> label）
session_label ( session_id text references session_metadata(id), target_id text, label text );
```

要点：
- `appendEntry` 只 `INSERT`，**不 UPDATE** → append-only，天然支持 Pi-style 分支回放（`getPathToRoot` 按 `parent_id` 回溯）。
- `seq` 自增保证 `getEntries()` 顺序稳定（JSONL 靠文件行序，PG 需显式序）。
- `findEntries(type)` 直接 `WHERE type = $1`，比 JSONL 全扫描更适合审计/检索场景（这也是将来要切 PG 的动因）。

### 接入 seam（等 Pi 暴露后填）

```ts
// 期望未来的 CreateAgentSessionOptions 增加：
sessionStorage?: SessionStorage;   // 缺省回落 JsonlSessionStorage / InMemory
// AgentSession 内部用 sessionStorage 替代内部 SessionManager 的持久化职责
```

届时 L2 平台在 `session-factory` 里按配置决定注入 `PostgresSessionRepo` 还是默认 JSONL，做到**注入式 + fail-safe**（连不上 PG 回落 JSONL 并告警），与 P6-24/25 既定模式一致。

## 跟进动作

1. **跟踪上游**：关注 `pi-mono` 是否把 `harness/session` 接入 `createAgentSession`（看 `sdk.ts` 是否新增 `sessionStorage` 选项）。出现即回来落地上面的 drop-in 设计。
2. **不现在写代码**：避免产生无法被运行时实例化的死代码（铁律：不写用不上的扩展）。
3. 若近期出现**跨会话检索/审计分析**的硬需求，单独立 `P6-2x` 评估「L2 transcript 镜像」方案（只读副本，不替代 Pi 持久化），与本次决策 B 一致。

## 验收（本评估任务的完成标准）

- [x] 核对 Pi 当前 harness `SessionStorage` 契约与 coding-agent 会话路径，确认无注入点
- [x] 给出可行性结论（不可注入 / 不 fork）与保持混合存储的决策
- [x] 预留可落地的 `PostgresSessionRepo` 设计与接入 seam
- [x] 记录上游跟进动作
