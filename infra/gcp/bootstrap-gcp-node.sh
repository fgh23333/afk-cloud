#!/usr/bin/env bash
# ============================================================================
# 已开启的 Google Cloud 常驻控制机 (Control Plane) 一键初始化脚本
# 适用场景：您已在 GCP 开好服务器并装好 agy 与 Cloudflare Plugin，
#           clone 本仓库后执行此脚本即可完成全部依赖安装与自检。
# ============================================================================
set -euo pipefail

echo "======================================================"
echo " 🛠️  afk-cloud GCP 控制节点一键初始化"
echo "======================================================"

# 1. 检查 Node.js 与 pnpm
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装 Node.js >= 18"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "📦 正在启用 corepack / 安装 pnpm..."
  corepack enable || npm install -g pnpm
fi

# 2. 检查 agy 与 gcloud
echo "🔍 检查 Antigravity CLI (agy): $(command -v agy || echo '未在 PATH 中找到，请确认 alias 或 PATH')"
echo "🔍 检查 Google Cloud SDK (gcloud): $(command -v gcloud || echo '未安装')"

# 3. 初始化 .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 已从 .env.example 生成 .env，请填入您的 CHAOXING_PHONE 与 CHAOXING_PASSWORD。"
fi

# 4. 安装工作区依赖并执行自检
pnpm install
pnpm typecheck
pnpm test
pnpm afk status

echo "✅ GCP 节点初始化与自检全部通过！在当前目录运行 'agy' 即可自动加载 .agents/ 下的全部技能与规则。"
