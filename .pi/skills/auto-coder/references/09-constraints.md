## 9. 约束与踩坑

**铁律**：

1. 不改 Pi 核心（`packages/*/src`）一行代码。
2. 不把权限判定只放在 `tool_call` block —— 它只是第一道。
3. 高风险操作不返回 error，返回工单。
4. LLM 不参与金额计算、状态机判断、字段校验。

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

**Git 纪律**（多 pi session 并行时尤其重要）：

1. 禁止 `git add -A` / `git add .` / `git add -u`，只 `git add <明确路径>`。
2. 禁止 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `--no-verify`。
3. 只提交本会话改的文件，提交前跑 `git status` 确认。
4. 提交格式：`{feat,fix,docs,chore,test,refactor}[(scope)]: <msg>`，带任务 ID。

