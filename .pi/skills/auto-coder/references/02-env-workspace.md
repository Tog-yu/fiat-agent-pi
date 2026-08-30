## 2. 环境与 workspace

```text
Node >= 22.19        Pi 的 engines 硬要求
pnpm / npm workspace
TypeScript 5.9       Pi 用 tsgo 做类型检查
```

仓库布局（决策：workspace 在仓库内）：

```text
fiat-agent/
  package.json                  # 开发期 file: 依赖本地 Pi；稳定后切 npm 正式版
  workspace/                    # Pi 的 cwd，随仓库走
    AGENTS.md                   # 业务规则 / 术语 / 环境说明（Pi 自动注入上下文）
    .pi/
      settings.json
      extensions -> ../pi-extensions
      skills     -> ../pi-skills
    pi-extensions/
    pi-skills/
  src/server/                   # L2 Fastify 平台服务
  docs/
```

软链命令（写进 `scripts/setup.sh`）：

```bash
cd workspace/.pi && ln -s ../pi-extensions extensions && ln -s ../pi-skills skills
```

开发者入口（决策：MVP 保留 Pi 内置 TUI，不自写 CLI）：

```bash
cd fiat-agent/workspace && pi -e ./pi-extensions/index.ts
```

**硬约束：不在 Pi fork 里改任何一行核心代码。** 遇到缺口优先用 extension 解决，解决不了就在 L2 层绕开。

---

