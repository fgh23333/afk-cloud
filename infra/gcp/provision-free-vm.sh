#!/usr/bin/env bash
# ============================================================================
# Google Cloud Always Free 常驻机 (e2-micro) 全自动拉起与自愈配置脚本
# 运行环境：本地开发机、CI 或已登录 gcloud 的 agy 会话
# 计费保证：100% 永久免费 ($0.00/月，严格限定 30GB 标准磁盘与美区三区)
# ============================================================================
set -euo pipefail

INSTANCE_NAME="${GCP_INSTANCE_NAME:-afk-node}"
ZONE="${GCP_ZONE:-us-central1-a}"
MACHINE_TYPE="e2-micro"
DISK_SIZE="30GB"
DISK_TYPE="pd-standard"
IMAGE_FAMILY="ubuntu-2204-lts"
IMAGE_PROJECT="ubuntu-os-cloud"

echo "======================================================"
echo " ☁️  afk-cloud GCP Always Free 实例全自动开通"
echo "======================================================"

# 1. 检查 gcloud 状态
if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ 本地未检测到 gcloud CLI，请先安装 Google Cloud SDK 并执行 'gcloud auth login'。"
  exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "")
if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "(unset)" ]; then
  echo "❌ 未检测到当前激活的 GCP 项目，请执行: gcloud config set project <PROJECT_ID>"
  exit 1
fi

echo "📋 GCP 项目 ID: ${PROJECT_ID}"
echo "📍 实例可用区: ${ZONE} (符合 Always Free 永久免费要求)"
echo "💻 实例规格  : ${MACHINE_TYPE} | 磁盘: ${DISK_SIZE} (${DISK_TYPE})"

# 2. 启用必须的 API (幂等)
echo "🔌 检查并启用 Compute Engine API..."
gcloud services enable compute.googleapis.com --quiet

# 3. 检查实例是否已经存在
if gcloud compute instances describe "${INSTANCE_NAME}" --zone="${ZONE}" >/dev/null 2>&1; then
  echo "✅ 实例 '${INSTANCE_NAME}' 已存在，状态如下："
  gcloud compute instances describe "${INSTANCE_NAME}" --zone="${ZONE}" --format="table(name,status,networkInterfaces[0].accessConfigs[0].natIP)"
else
  echo "🚀 正在创建 Always Free 实例 '${INSTANCE_NAME}'..."
  gcloud compute instances create "${INSTANCE_NAME}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family="${IMAGE_FAMILY}" \
    --image-project="${IMAGE_PROJECT}" \
    --boot-disk-size="${DISK_SIZE}" \
    --boot-disk-type="${DISK_TYPE}" \
    --tags=afk-node,http-server,https-server \
    --metadata=enable-oslogin=TRUE \
    --quiet

  echo "✅ Always Free 实例 '${INSTANCE_NAME}' 创建成功！"
fi

echo "======================================================"
echo " 💡 后续自动化执行提示："
echo " 1. 通过 gcloud ssh 连接实例："
echo "    gcloud compute ssh ${INSTANCE_NAME} --zone=${ZONE}"
echo " 2. 在实例中执行初始化环境脚本（含 Node 20, pnpm, gcloud, Chromium, Tunnel）："
echo "    curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash"
echo "======================================================"
