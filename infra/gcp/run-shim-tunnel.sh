#!/usr/bin/env bash
set -euo pipefail

# 启动 Cloudflare Quick Tunnel（HTTPS 出站免开入站端口）并自动将公网 URL 写入 Cloudflare Worker Secret AFK_SHIM_URL。
# 仅操作本项目的 Worker Secret，不触碰无关 DNS / D1 / Worker 资源。

REPO_DIR="${AFK_REPO_DIR:-/home/Jimmy/afk-cloud}"
ENV_FILE="${AFK_ENV_FILE:-$REPO_DIR/.env}"
SHIM_LOCAL_URL="${AFK_SHIM_LOCAL_URL:-http://127.0.0.1:8788}"
WORKER_NAME="${AFK_WORKER_NAME:-chaoxing-dashboard-worker}"
TUNNEL_LOG="${AFK_TUNNEL_LOG:-/tmp/afk-cloudflared.log}"

log_utc8() {
  local ts
  ts=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S (UTC+8)')
  echo "[$ts] [afk-tunnel] $*"
}

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  log_utc8 "❌ 未找到 cloudflared，请先安装 cloudflared。"
  exit 1
fi

: > "$TUNNEL_LOG"
log_utc8 "启动 cloudflared Quick Tunnel -> $SHIM_LOCAL_URL (protocol=http2)..."
cloudflared tunnel --no-autoupdate --protocol http2 --url "$SHIM_LOCAL_URL" --logfile "$TUNNEL_LOG" >/dev/null 2>&1 &
CF_PID=$!

cleanup() {
  kill "$CF_PID" >/dev/null 2>&1 || true
  wait "$CF_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sync_worker_secret() {
  local tunnel_url="$1"
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    log_utc8 "⚠️ 缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID，跳过 AFK_SHIM_URL 自动同步。"
    return 0
  fi

  local host="${tunnel_url#https://}"
  # 等待公共 DNS 传播后再探测，避免提前查询污染本地负缓存
  sleep 10
  local healthy=0
  local i code
  for i in $(seq 1 12); do
    code=$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "${tunnel_url}/health" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      healthy=1
      break
    fi
    log_utc8 "等待 ${host} DNS/健康检查就绪 (${i}/12, HTTP=${code})..."
    sleep 5
  done

  if [[ "$healthy" -ne 1 ]]; then
    log_utc8 "⚠️ ${tunnel_url}/health 暂未返回 200（可能本地 DNS 仍在缓冲），仍继续注册到 Worker Secret。"
  else
    log_utc8 "✅ ${tunnel_url}/health 返回 HTTP 200。"
  fi

  local api_url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets"
  local payload
  payload=$(printf '{"name":"AFK_SHIM_URL","text":"%s","type":"secret_text"}' "$tunnel_url")
  local resp http_code
  resp=$(curl -sS -w "\n%{http_code}" -X PUT \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$api_url")
  http_code=$(echo "$resp" | tail -n1)
  if [[ "$http_code" == "200" ]]; then
    log_utc8 "✅ 已自动更新 Worker [${WORKER_NAME}] Secret: AFK_SHIM_URL=${tunnel_url}"
  else
    log_utc8 "❌ 更新 Worker Secret 失败 (HTTP=${http_code}): $(echo "$resp" | sed '$d')"
  fi
}

ASSIGNED_URL=""
for _ in $(seq 1 30); do
  if ! kill -0 "$CF_PID" >/dev/null 2>&1; then
    log_utc8 "❌ cloudflared 进程提前退出。"
    cat "$TUNNEL_LOG" | tail -n 20 || true
    exit 1
  fi
  ASSIGNED_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n1 || true)
  if [[ -n "$ASSIGNED_URL" ]]; then
    log_utc8 "🌐 分配隧道地址: ${ASSIGNED_URL}"
    sync_worker_secret "$ASSIGNED_URL" &
    break
  fi
  sleep 1
done

if [[ -z "$ASSIGNED_URL" ]]; then
  log_utc8 "⚠️ 30s 内未解析到 trycloudflare 域名，保留进程继续运行。"
fi

wait "$CF_PID"
