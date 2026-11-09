#!/usr/bin/env bash
# ============================================================================
# GCP 安全与最小权限围栏初始化脚本 (收敛爆炸半径，防天价账单)
# 剥离个人 Owner 凭据，创建专用 Service Account: sa-antigravity-worker
# ============================================================================
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
SA_NAME="${GCP_SERVICE_ACCOUNT:-sa-antigravity-worker}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo "🔒 [1/3] 正在项目 ${GCP_PROJECT_ID} 中创建或核验专用服务账号: ${SA_EMAIL}..."
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --display-name="Antigravity Ephemeral Worker (Least Privilege)"
fi

echo "🔒 [2/3] 绑定最小权限角色 (Compute Instance Admin + Cloud Run Invoker/Developer)..."
ROLES=(
  "roles/compute.instanceAdmin.v1"
  "roles/run.invoker"
  "roles/run.developer"
  "roles/iam.serviceAccountUser"
  "roles/logging.logWriter"
)

for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet >/dev/null
  echo "  ✅ 已授予: ${ROLE}"
done

echo "🔒 [3/3] 安全围栏配置完成！"
echo "💡 建议在 GCP Console -> Billing -> Budgets & alerts 中设置 $10~$20 月度预算告警。"
