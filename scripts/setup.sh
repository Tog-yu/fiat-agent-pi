#!/usr/bin/env bash
# fiat-agent-pi 开发环境一键初始化
# 建立 workspace/.pi 下的软链，使 Pi 直接加载仓库内的扩展与技能。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_DIR="$ROOT/workspace/.pi"

mkdir -p "$PI_DIR"

# 扩展与技能放在仓库内，通过软链挂到 .pi 下，便于版本管理与 Review
ln -sfn ../pi-extensions "$PI_DIR/extensions"
ln -sfn ../pi-skills     "$PI_DIR/skills"

echo "linked: $PI_DIR/extensions -> ../pi-extensions"
echo "linked: $PI_DIR/skills     -> ../pi-skills"
echo "done."
