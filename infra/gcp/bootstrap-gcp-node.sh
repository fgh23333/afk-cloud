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

# 1.5 系统精简与 e2-micro (1GB RAM) 内存/Swap/日志上限调优（防止 IO 颠簸与磁盘膨胀）
echo "🧠 正在优化内核参数、本地 Hosts 与 journald 上限..."
HOST_SHORT=$(hostname -s 2>/dev/null || hostname)
if grep -qE "^[[:space:]]*${HOST_SHORT}[[:space:]]*$" /etc/hosts 2>/dev/null; then
  sudo sed -i "/^[[:space:]]*${HOST_SHORT}[[:space:]]*$/d" /etc/hosts
fi
if ! grep -qE "^127\.0\.0\.1[[:space:]].*\b${HOST_SHORT}\b" /etc/hosts 2>/dev/null; then
  sudo sed -i "s/^127\.0\.0\.1[[:space:]]\+localhost.*/127.0.0.1\tlocalhost ${HOST_SHORT}/" /etc/hosts || true
fi

sudo mkdir -p /etc/systemd/journald.conf.d
cat << 'EOF' | sudo tee /etc/systemd/journald.conf.d/99-afk-limit.conf
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
EOF
sudo systemctl restart systemd-journald || true
sudo journalctl --vacuum-size=50M >/dev/null 2>&1 || true

sudo sysctl -w vm.swappiness=10
sudo sysctl -w vm.vfs_cache_pressure=50
echo -e "vm.swappiness=10\nvm.vfs_cache_pressure=50" | sudo tee /etc/sysctl.d/99-afk-tuning.conf
sudo sysctl -p /etc/sysctl.d/99-afk-tuning.conf

# 1.6 网络保活 (TCP Keepalive) 与 SSH 极速免卡顿调优 (彻底根治 NAT 超时断连与 DNS 逆向解析慢)
echo "🌐 正在配置网络保活与 SSH 极速响应..."
cat << 'EOF' | sudo tee /etc/sysctl.d/99-network-keepalive.conf
net.ipv4.tcp_keepalive_time = 30
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 5
EOF
sudo sysctl -p /etc/sysctl.d/99-network-keepalive.conf

cat << 'EOF' | sudo tee /etc/ssh/sshd_config.d/99-fast-keepalive.conf
ClientAliveInterval 15
ClientAliveCountMax 4
TCPKeepAlive yes
UseDNS no
GSSAPIAuthentication no
EOF
if sudo sshd -t; then
  sudo systemctl reload ssh || true
fi

# 开启 systemd 用户会话保活 (Linger)，防止 SSH 退出后后台守护被杀
sudo loginctl enable-linger "${USER}" 2>/dev/null || true
sudo loginctl enable-linger root 2>/dev/null || true

# 关停小内存机型不适用的重型监控套件
if systemctl is-active --quiet google-cloud-ops-agent 2>/dev/null; then
  echo "🛑 正在停用高内存消耗的 google-cloud-ops-agent..."
  sudo systemctl stop google-cloud-ops-agent || true
  sudo systemctl disable google-cloud-ops-agent || true
fi
if systemctl is-active --quiet exim4 2>/dev/null; then
  sudo systemctl stop exim4 || true
  sudo systemctl disable exim4 || true
fi

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
sudo bash -c "cat << EOF > ${SERVICE_FILE}
[Unit]
Description=afk-cloud Server Shim (Pet Node for Antigravity & Browser)
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${WORKSPACE_DIR}
Environment=NODE_ENV=production
Environment=PORT=8788
Environment=NODE_OPTIONS=--max-old-space-size=384
EnvironmentFile=${WORKSPACE_DIR}/.env
ExecStart=$(command -v pnpm) run shim
Restart=always
RestartSec=5
MemoryHigh=256M
MemoryMax=384M
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable --now afk-shim

# 8.5 注册并常驻守护 Antigravity CLI Remote Control 远程控制服务
if [ -f /root/.local/bin/agy ] || [ -f "${HOME}/.local/bin/agy" ] || command -v agy >/dev/null 2>&1; then
  AGY_EXEC=$(command -v agy || ([ -f /root/.local/bin/agy ] && echo "/root/.local/bin/agy") || echo "${HOME}/.local/bin/agy")
  echo "🤖 正在注册并守护 Antigravity Remote Control 常驻服务..."
  sudo bash -c "cat << EOF > /etc/systemd/system/antigravity-remote-control.service
[Unit]
Description=Antigravity CLI Remote Control Daemon
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
Environment=NODE_OPTIONS=--max-old-space-size=384
Environment=HOME=/root
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/root/.local/bin
ExecStart=${AGY_EXEC} remote-control serve
Restart=always
RestartSec=5
MemoryHigh=420M
MemoryMax=560M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"
  sudo systemctl daemon-reload
  sudo systemctl enable --now antigravity-remote-control.service || true
fi

# 8.6 注册并启动 cloudflared Tunnel（为 afk-shim 提供免费 HTTPS 隧道并自动同步 AFK_SHIM_URL）
if command -v cloudflared >/dev/null 2>&1 && [ -f "${WORKSPACE_DIR}/infra/gcp/run-shim-tunnel.sh" ]; then
  chmod +x "${WORKSPACE_DIR}/infra/gcp/run-shim-tunnel.sh"
  echo "🌐 正在注册并启动 afk-tunnel 服务..."
  sudo bash -c "cat << EOF > /etc/systemd/system/afk-tunnel.service
[Unit]
Description=afk-cloud Cloudflare Tunnel for afk-shim
After=network-online.target afk-shim.service
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${WORKSPACE_DIR}
Environment=AFK_REPO_DIR=${WORKSPACE_DIR}
ExecStart=/usr/bin/env bash ${WORKSPACE_DIR}/infra/gcp/run-shim-tunnel.sh
Restart=always
RestartSec=10
MemoryHigh=96M
MemoryMax=160M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF"
  sudo systemctl daemon-reload
  sudo systemctl enable --now afk-tunnel.service || true
fi

# 9. 状态自检与 Cloudflare OAuth2 说明
echo "======================================================"
echo " 🟢 GCP 常驻节点全自动环境编排完成！"
echo "======================================================"
sleep 2
curl -s http://127.0.0.1:8788/health || echo "提示：afk-shim 服务正在初始化中..."
echo ""
echo "🔑 Cloudflare OAuth2 登录提示："
echo "   若需在云端主机执行 wrangler 边缘命令，只需运行: npx wrangler login"
echo "   无桌面环境下 Wrangler 会直接打印 OAuth2 授权链接，在本地电脑浏览器打开并点击授权即可自动绑定！"
echo ""
echo "🚀 默认模型配置提示："
echo "   默认使用 Gemini 4 Hydrogen (AFK_FLASH_MODEL=gemini-4-hydrogen-medium / AFK_PRO_MODEL=gemini-4-hydrogen-xhigh)！"
