#!/usr/bin/env bash
# ============================================================================
# Tier 2: 高负载 gcloud 临时 GCE 极速拉起与物理 TTL 自毁脚本 (严格防悬挂计费)
# 成本控制与长时算力原则：
#   1. 长时挂机（如视频看门狗、保活、日常调度）一律优先走 GCP Always Free e2-micro 常驻机与 Cloud Run 免费层
#   2. 临时 GCE 仅作为极端大计算量备用（Spot 抢占式，完工即刻自我销毁，按秒释放）
#   3. 启动前自动对账并回收任何历史遗留的 runner-temp-* 悬挂机型
#   4. 默认安全兜底自毁时限 60 分钟（可配置，防止卡死导致计费悬挂）
#   5. 状态快照外置至 Cloudflare R2 / D1，计算节点纯无状态
# ============================================================================
set -euo pipefail

TASK_CMD="${1:-solve}"
INSTANCE_NAME="runner-temp-$(date +%s)"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
ZONE="${GCP_ZONE:-us-west1-a}"
MACHINE_TYPE="${GCE_BURST_MACHINE_TYPE:-e2-micro}"
TTL_MINUTES="${GCE_BURST_TTL_MINUTES:-60}"
USE_SPOT="${GCE_BURST_USE_SPOT:-true}"
SA_NAME="${GCP_SERVICE_ACCOUNT:-sa-antigravity-worker}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
REPO_URL="${AFK_REPO_URL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "======================================================"
echo " ⚡ [Tier 2 Burst] GCP 临时 GCE 实例调度（预算硬顶 \$10/月）"
echo "======================================================"

# 1. 自动对账并回收任何历史残留的临时实例（防止计费失控）
echo "🔍 检查是否存在历史残留的临时实例..."
DANGLING=$(gcloud compute instances list --project="${GCP_PROJECT_ID}" --filter="name ~ '^runner-temp-' AND status=RUNNING" --format="value(name,zone)" 2>/dev/null || echo "")
if [ -n "${DANGLING}" ]; then
  echo "🧹 发现残留未销毁的临时实例，立即执行回收以严控预算："
  while read -r DNAME DZONE; do
    if [ -n "${DNAME}" ]; then
      echo "  🗑️ 强制销毁悬挂实例: ${DNAME} (可用区: ${DZONE})..."
      gcloud compute instances delete "${DNAME}" --zone="${DZONE}" --project="${GCP_PROJECT_ID}" --quiet || true
    fi
  done <<< "${DANGLING}"
fi

SPOT_FLAGS=()
if [ "${USE_SPOT}" = "true" ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE --max-run-duration="${TTL_MINUTES}m")
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
STARTUP_FILE="${TMP_DIR}/startup.sh"
BUNDLE_FILE="${TMP_DIR}/afk-bundle.b64"
METADATA_ARGS=("startup-script=${STARTUP_FILE}")

if [ -z "${REPO_URL}" ]; then
  tar -czf "${TMP_DIR}/afk-bundle.tar.gz" -C "${REPO_ROOT}" packages package.json tsconfig.json
  base64 -w0 "${TMP_DIR}/afk-bundle.tar.gz" > "${BUNDLE_FILE}"
  METADATA_ARGS+=("afk-bundle=${BUNDLE_FILE}")
fi

cat > "${STARTUP_FILE}" <<EOF
#!/bin/bash
set -euxo pipefail
export TZ=Asia/Shanghai

# [保险丝 1] 物理 TTL 定时器：无论后续业务是否卡死，${TTL_MINUTES} 分钟后必物理自毁
apt-get update -y
if ! command -v at >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends at
  systemctl enable --now atd || service atd start
fi
echo "gcloud compute instances delete '${INSTANCE_NAME}' --zone='${ZONE}' --project='${GCP_PROJECT_ID}' --quiet" | at now + ${TTL_MINUTES} minutes

# [保险丝 2] bash EXIT trap：任务结束或异常退出时，同步快照并立即自我销毁
cleanup() {
  echo "[Persistence] 正在同步关键快照至持久层 (Cloudflare R2 / D1)..."
  if [ -d "/tmp/afk-cloud-burst/.cache" ] && [ -n '${AFK_EDGE_WORKER_URL:-}' ]; then
    cd /tmp/afk-cloud-burst && ./node_modules/.bin/tsx packages/cli/src/index.ts profile push --platform zhihuishu || true
  fi
  echo "[TTL Cleanup] 任务结束，正在彻底自毁临时实例 ${INSTANCE_NAME}..."
  gcloud compute instances delete '${INSTANCE_NAME}' --zone='${ZONE}' --project='${GCP_PROJECT_ID}' --quiet || true
}
trap cleanup EXIT

# 安装 Node.js 运行时与 Chromium（仅浏览器类任务）
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends nodejs npm curl ca-certificates git
fi
if echo '${TASK_CMD}' | grep -qE '^(zhihuishu|zhs|watch|web)'; then
  if ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends chromium fonts-noto-cjk
  fi
fi

WORKDIR=/tmp/afk-cloud-burst
mkdir -p "\${WORKDIR}"
if [ -n '${REPO_URL}' ]; then
  rm -rf "\${WORKDIR}"
  git clone --depth=1 '${REPO_URL}' "\${WORKDIR}"
else
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/afk-bundle" \
    | base64 -d | tar -xzf - -C "\${WORKDIR}"
fi

cd "\${WORKDIR}"
npm install --no-save --no-audit --no-fund kolorist tsx typescript @types/node jsdom

export CHAOXING_PHONE='${CHAOXING_PHONE:-}'
export CHAOXING_PASSWORD='${CHAOXING_PASSWORD:-}'
export AFK_EDGE_WORKER_URL='${AFK_EDGE_WORKER_URL:-}'
export AFK_EDGE_BEARER_TOKEN='${AFK_EDGE_BEARER_TOKEN:-}'
export ZHIHUISHU_STUDY_URL='${ZHIHUISHU_STUDY_URL:-}'
export AFK_FLASH_MODEL='${AFK_FLASH_MODEL:-gemini-4-hydrogen-medium}'
export AFK_PRO_MODEL='${AFK_PRO_MODEL:-gemini-4-hydrogen-xhigh}'

./node_modules/.bin/tsx packages/cli/src/index.ts ${TASK_CMD}
EOF

METADATA_FLAG="$(IFS=,; echo "${METADATA_ARGS[*]}")"

echo "🚀 正在拉起临时 GCE 实例: ${INSTANCE_NAME} (机型: ${MACHINE_TYPE}, 区域: ${ZONE}, 强制 TTL: ${TTL_MINUTES} 分钟)..."

gcloud compute instances create "${INSTANCE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --zone="${ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --service-account="${SA_EMAIL}" \
  --scopes="cloud-platform" \
  "${SPOT_FLAGS[@]}" \
  --metadata-from-file="${METADATA_FLAG}"

echo "✅ 临时实例 ${INSTANCE_NAME} 已就绪：完工后自动通过 EXIT trap 立即提前自毁；若遇死锁则在 ${TTL_MINUTES} 分钟后由 at 熔断兜底。"
