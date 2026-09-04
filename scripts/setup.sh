#!/usr/bin/env bash
# fiat-agent-pi 开发环境一键初始化
# 建立 workspace/.pi 下的软链（P9-49 起扩展目录为归档状态，入口已切自研 CLI）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_DIR="$ROOT/workspace/.pi"

mkdir -p "$PI_DIR"

# 技能放在仓库内，通过软链挂到 .pi 下，便于版本管理与 Review。
# 扩展软链（extensions -> ../pi-extensions）为【归档】状态（P9-49）：pi -e 加载链路
# 不再是受支持入口，仅保留历史快照对照；运行入口见 package.json 的 `npm run cli`。
ln -sfn ../pi-skills "$PI_DIR/skills"

echo "linked: $PI_DIR/skills -> ../pi-skills"
echo "done. (extensions 软链已归档，入口为 npm run cli)"
