#!/usr/bin/env bash
# ============================================================================
# afk-cloud 新用户从 0 到 1 全自动一键部署脚本 (Zero-Touch Onboarding)
# 支持由 Antigravity (agy) 自动执行，或由用户一键运行
# ============================================================================
set -euo pipefail

echo "======================================================================"
echo " 🚀 afk-cloud 个人云端自治 Agent 全自动部署引擎"
echo "======================================================================"

# 1. 基础依赖检查
if ! command -v node >/dev/null 2>&1; then
  echo "📦 正在安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable || sudo npm install -g pnpm
fi

echo "📦 [1/4] 安装工作区依赖..."
pnpm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 已生成 .env 配置文件。"
fi

echo "🧪 [2/4] 执行类型检查与 4 项核心冒烟测试..."
pnpm typecheck
pnpm test

if [ "${1:-}" = "--auto-provision" ]; then
  echo "☁️  [3/4] 全自动创建并绑定 Cloudflare D1 + Worker + GCP Cloud Run..."
  pnpm afk setup-all
else
  echo ""
  echo "💡 [3/4] 填入 .env 账号后，您可以通过以下任一方式全自动创建所有云资源（无需手动复制任何 ID 或 URL）："
  echo "   👉 方式 A (让 agy 代劳)：在当前目录启动 'agy'，直接说：\"帮我执行 setup-all 全自动开通 Cloudflare 和 GCP 服务\""
  echo "   👉 方式 B (一行命令全自动)：运行 'pnpm afk setup-all'（或仅开通 Cloudflare：'pnpm afk setup-cf'）"
fi

echo ""
echo "🛰️  [4/4] 当前环境状态："
pnpm afk status
