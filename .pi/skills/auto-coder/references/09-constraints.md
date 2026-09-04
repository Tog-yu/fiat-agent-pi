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

