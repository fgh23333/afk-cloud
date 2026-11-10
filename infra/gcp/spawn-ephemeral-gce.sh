#!/usr/bin/env bash
# ============================================================================
# Tier 2: 高负载 gcloud 临时 GCE 极速拉起与物理 TTL 自毁脚本 (防悬挂计费)
# 核心机制：
#   1. 启动即刻注册 `at now + N minutes` 物理自毁保险丝（无论业务是否卡死均强制删除实例）
#   2. 支持 Spot 抢占式或 e2-micro 轻量机型
#   3. 业务执行完毕后立即主动触发 `gcloud compute instances delete --quiet`
# ============================================================================
set -euo pipefail

TASK_CMD="${1:-solve}"
INSTANCE_NAME="runner-temp-$(date +%s)"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
ZONE="${GCP_ZONE:-us-west1-a}"
MACHINE_TYPE="${GCE_BURST_MACHINE_TYPE:-e2-micro}"
TTL_MINUTES="${GCE_BURST_TTL_MINUTES:-15}"
USE_SPOT="${GCE_BURST_USE_SPOT:-true}"
SA_NAME="${GCP_SERVICE_ACCOUNT:-sa-antigravity-worker}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
REPO_URL="${AFK_REPO_URL:-}"

SPOT_FLAGS=()
if [ "${USE_SPOT}" = "true" ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE --max-run-duration="${TTL_MINUTES}m")
fi

echo "⚡ [Tier 2 Burst] 正在拉起临时 GCE 实例: ${INSTANCE_NAME} (机型: ${MACHINE_TYPE}, 区域: ${ZONE}, 强制自毁 TTL: ${TTL_MINUTES} 分钟)..."

gcloud compute instances create "${INSTANCE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --zone="${ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --service-account="${SA_EMAIL}" \
  --scopes="cloud-platform" \
  "${SPOT_FLAGS[@]}" \
  --metadata="startup-script=#!/bin/bash
set -x
export TZ=Asia/Shanghai

# [保险丝 1] 物理 TTL 定时器：无论后续脚本是否卡死，${TTL_MINUTES} 分钟后强制销毁本实例
if ! command -v at >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y at
  systemctl enable --now atd || service atd start
fi
echo \"gcloud compute instances delete '${INSTANCE_NAME}' --zone='${ZONE}' --project='${GCP_PROJECT_ID}' --quiet\" | at now + ${TTL_MINUTES} minutes

# [保险丝 2] bash EXIT trap 兜底：无论正常退出还是报错退出，均触发自我销毁
cleanup() {
  echo \"[TTL Cleanup] 任务结束，正在彻底销毁临时实例 ${INSTANCE_NAME}...\"
  gcloud compute instances delete '${INSTANCE_NAME}' --zone='${ZONE}' --project='${GCP_PROJECT_ID}' --quiet
}
trap cleanup EXIT

# 拉取并执行任务
WORKDIR=/tmp/afk-cloud-burst
if [ -n '${REPO_URL}' ]; then
  git clone --depth=1 '${REPO_URL}' \"\${WORKDIR}\"
  cd \"\${WORKDIR}\"
  export CHAOXING_PHONE='${CHAOXING_PHONE:-}'
  export CHAOXING_PASSWORD='${CHAOXING_PASSWORD:-}'
  export AFK_EDGE_WORKER_URL='${AFK_EDGE_WORKER_URL:-}'
  export AFK_EDGE_BEARER_TOKEN='${AFK_EDGE_BEARER_TOKEN:-}'
  npx --yes tsx packages/cli/src/index.ts ${TASK_CMD}
fi
"

echo "✅ 临时实例 ${INSTANCE_NAME} 已启动，将在任务完成后或最多 ${TTL_MINUTES} 分钟后自动彻底销毁。"
