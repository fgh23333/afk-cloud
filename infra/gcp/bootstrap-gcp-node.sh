#!/usr/bin/env bash
# ============================================================================
# Google Cloud Always Free 常驻机 (Pet Node) 全自动初始化与环境编排脚本
# 适用场景：新开通的 GCP e2-micro 实例（Ubuntu 22.04 LTS / Debian 12），
#           自动安装 Node.js 20、pnpm、gcloud CLI、Chromium、cloudflared、
#           配置 afk-shim systemd 守护进程并完成全部自检。
# ============================================================================
set -euo pipefail

echo "======================================================"
echo " 🛠️  afk-cloud GCP 常驻节点全自动环境编排"
echo "======================================================"

# 1. 基础依赖与更新
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y curl wget git build-essential apt-transport-https ca-certificates gnupg

# 2. 安装 Node.js 20 LTS 与 pnpm
if ! command -v node >/dev/null 2>&1; then
  echo "📦 正在安装 Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "✅ Node.js: $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "📦 正在安装 pnpm..."
  sudo npm install -g pnpm
fi
echo "✅ pnpm: $(pnpm -v)"

# 3. 安装 Google Cloud SDK (gcloud CLI)
if ! command -v gcloud >/dev/null 2>&1; then
  echo "☁️ 正在安装 Google Cloud SDK (gcloud CLI)..."
  if [ ! -f /usr/share/keyrings/cloud.google.gpg ]; then
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  fi
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
  sudo apt-get update -y
  sudo apt-get install -y google-cloud-cli
fi
echo "✅ gcloud: $(gcloud --version 2>&1 | head -n 1)"

# 4. 安装无头浏览器 Chromium（用于智慧树/PTA真机交互与防风控）
if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "🌐 正在安装 Chromium 浏览器与渲染依赖..."
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium || true
fi
CHROME_BIN=$(command -v chromium-browser || command -v chromium || echo "")
echo "✅ Chromium: ${CHROME_BIN:-未安装}"

# 5. 安装 Cloudflare Tunnel (cloudflared)
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "🚇 正在安装 Cloudflare Tunnel (cloudflared)..."
  CLOUDFLARED_DEB="/tmp/cloudflared.deb"
  curl -fsSL -o "${CLOUDFLARED_DEB}" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i "${CLOUDFLARED_DEB}" || sudo apt-get install -f -y
  rm -f "${CLOUDFLARED_DEB}"
fi
echo "✅ cloudflared: $(cloudflared --version 2>&1 | head -n 1)"

# 6. 配置工作区与环境变量
WORKSPACE_DIR="${HOME}/afk-cloud"
if [ ! -d "${WORKSPACE_DIR}" ]; then
  if [ -d "$(pwd)/packages" ]; then
    WORKSPACE_DIR="$(pwd)"
  else
    echo "📥 克隆 afk-cloud 代码仓库..."
    git clone https://github.com/fgh23333/afk-cloud.git "${WORKSPACE_DIR}"
  fi
fi

cd "${WORKSPACE_DIR}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 已创建 .env 文件，请核对其中的配置。"
fi

# 7. 安装依赖与编译校验
echo "📦 正在安装项目依赖..."
pnpm install

echo "🧪 正在执行冒烟测试..."
pnpm typecheck
pnpm test

# 8. 注册并启动 afk-shim 守护进程
SERVICE_FILE="/etc/systemd/system/afk-shim.service"
echo "⚙️ 正在注册并启动 systemd afk-shim 服务..."
sudo bash -c "cat << 'EOF' > ${SERVICE_FILE}
[Unit]
Description=afk-cloud Server Shim (Pet Node for Antigravity & Browser)
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${WORKSPACE_DIR}
Environment=NODE_ENV=production
Environment=PORT=8788
EnvironmentFile=${WORKSPACE_DIR}/.env
ExecStart=$(command -v pnpm) shim
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable --now afk-shim

# 9. 状态自检
echo "======================================================"
echo " 🟢 GCP 常驻节点全自动环境编排完成！"
echo "======================================================"
sleep 2
curl -s http://127.0.0.1:8788/health || echo "提示：afk-shim 服务正在初始化中..."
echo ""
echo "🚀 提示：推荐将默认解题模型设为 Gemini 3.8 Flash (AFK_FLASH_MODEL=gemini-3.8-flash) 以大幅节省配额！"
