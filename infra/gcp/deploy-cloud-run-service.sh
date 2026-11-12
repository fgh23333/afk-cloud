#!/usr/bin/env bash
# ============================================================================
# Tier 2: Google Cloud Run Service 部署脚本 (突发算力与高可用灾备无服务器节点)
# 计费与配额：
# - 闲置自动缩容至 0 (Scale to Zero)，无流量时 0 费用
# - 免费配额：每月 2,000,000 次请求 + 360,000 vCPU-秒 + 180,000 GiB-秒
# ============================================================================
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo '')}"
GCP_REGION="${GCP_REGION:-asia-east1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE_NAME:-afk-server-shim}"

if [ -z "${GCP_PROJECT_ID}" ]; then
  echo "❌ 错误: 未检测到有效的 GCP_PROJECT_ID，请先运行 gcloud config set project <PROJECT_ID>"
  exit 1
fi

echo "🚀 [Tier 2] 正在构建并部署 Cloud Run 服务 (${SERVICE_NAME}) 至 ${GCP_REGION}..."

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --dockerfile infra/docker/Dockerfile.shim \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT_ID}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=5 \
  --timeout=300s \
  --set-env-vars="TZ=Asia/Shanghai,SHIM_HOST=0.0.0.0,PORT=8080,AFK_SHIM_SECRET=${AFK_SHIM_SECRET:-},AFK_TASK_HOST_ALLOWLIST=chaoxing.com,zhihuishu.com,pintia.cn"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --platform=managed --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}" --format="value(status.url)")

echo "✅ Cloud Run 服务部署成功！"
echo "🌐 服务访问地址: ${SERVICE_URL}"
echo "👉 请将此 URL 配置至 Cloudflare Worker 环境变量 CLOUD_RUN_SHIM_URL 或本地 .env 作为突发灾备节点。"
