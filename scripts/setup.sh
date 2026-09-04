#!/usr/bin/env bash
# fiat-agent-pi 开发环境一键初始化
# 建立 workspace/.pi 下的软链（P9-49 起扩展目录为归档状态，入口已切自研 CLI）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_DIR="$ROOT/workspace/.pi"

mkdir -p "$PI_DIR"

# 技能放在仓库内，通过软链挂到 .pi 下，便于版本管理与 Review。
# 运行入口为自研 CLI（`npm run cli` → `fiat chat`，由 pi-host 内嵌循环驱动）；
# 旧扩展加载器（目录自动发现）已弃用，原实现归档于 `workspace/pi-extensions/` 仅作对照。
ln -sfn ../pi-skills "$PI_DIR/skills"

echo "linked: $PI_DIR/skills -> ../pi-skills"
echo "done. (extensions 软链已归档，入口为 npm run cli)"
