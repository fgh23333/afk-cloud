#!/usr/bin/env bash
# ============================================================================
# Tier 1: Google Cloud Run Jobs 部署脚本 (100% 落在 GCP 每月永久免费额度内)
# 免费额度：每月 360,000 vCPU-秒 + 180,000 GiB-秒 + 2,000,000 次请求
# 跑完即归零，无任何悬挂计费风险
# ============================================================================
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
GCP_REGION="${GCP_REGION:-us-west1}"
JOB_NAME="${CLOUD_RUN_JOB_NAME:-afk-sandbox-runner}"
SA_NAME="${GCP_SERVICE_ACCOUNT:-sa-antigravity-worker}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo "🚀 [Tier 1] 正在部署无状态 Cloud Run Job (${JOB_NAME}) 至 ${GCP_REGION}..."

gcloud run jobs deploy "${JOB_NAME}" \
  --source . \
  --dockerfile infra/docker/Dockerfile.runner \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT_ID}" \
  --service-account="${SA_EMAIL}" \
  --cpu=1 \
  --memory=512Mi \
  --task-timeout=600s \
  --max-retries=1 \
  --set-env-vars="TZ=Asia/Shanghai,CHAOXING_PHONE=${CHAOXING_PHONE:-},CHAOXING_PASSWORD=${CHAOXING_PASSWORD:-},AFK_EDGE_WORKER_URL=${AFK_EDGE_WORKER_URL:-}"

echo "✅ Cloud Run Job [${JOB_NAME}] 部署完毕！"
echo "👉 按需触发执行命令: gcloud run jobs execute ${JOB_NAME} --region=${GCP_REGION} --wait"
