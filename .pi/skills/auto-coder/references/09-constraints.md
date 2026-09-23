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

