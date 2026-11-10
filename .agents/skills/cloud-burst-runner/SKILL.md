---
name: cloud-burst-runner
description: Google Cloud 免费算力（Cloud Run Jobs）与高负载短时拉起新机器（gcloud Ephemeral GCE + TTL 自毁）操作指南。当需要配置 GCP IAM 安全围栏、部署免费 Cloud Run 任务或短时拉起临时 GCE 实例时加载此技能。
---

# `cloud-burst-runner` 弹性算力与安全围栏操作手册

本技能遵循 **“优先榨干免费配额（Cloud Run Jobs），高负载按需秒级拉起临时 GCE 并强制 TTL 自毁”** 的原则。

## 1. 安全围栏初始化（首次在 GCP 上执行一次）

切勿使用个人 `Owner` 账号运行自动化工作负载。使用以下脚本创建最小权限服务账号 `sa-antigravity-worker`：

```bash
bash infra/gcp/setup-iam-guardrails.sh
```

该脚本仅授予：
- `roles/compute.instanceAdmin.v1`（管理临时实例生命周期）
- `roles/run.invoker` 与 `roles/run.developer`（触发 Cloud Run 免费层任务）
- `roles/iam.serviceAccountUser`

## 2. Tier 1：Google Cloud Run Jobs（首选免费无服务器算力）

Google Cloud Run 提供极其慷慨的 **Always Free** 配额（每月 360,000 vCPU-秒、180,000 GiB-秒、200 万次请求）：
- **部署/更新 Cloud Run Job**：
  ```bash
  bash infra/gcp/deploy-cloud-run-job.sh
  ```
- **按需触发一次无状态容器执行（跑完即停，闲置 0 成本）**：
  ```bash
  pnpm afk burst --mode cloud-run --task "solve"
  ```

## 3. Tier 2：高负载 `gcloud` 短时拉起新 GCE 机器（带 15 分钟物理自毁熔断）

当任务需要完整 VM 内核、大容量临时磁盘或重度浏览器并发时，使用 `infra/gcp/spawn-ephemeral-gce.sh`（或 CLI 封装）：

```bash
# 通过 CLI 触发短时 GCE 机器（默认 e2-micro + Spot 抢占式 + 15分钟强制自毁）
pnpm afk burst --mode gce --task "solve" --ttl 15 --machine-type e2-small
```

### 双重自毁保险机制说明
1. **物理定时器（防卡死悬挂）**：实例启动的第一行指令即执行 `echo "gcloud compute instances delete ${INSTANCE_NAME} --zone=${ZONE} --quiet" | at now + ${TTL} minutes`，哪怕业务脚本死锁，到点依然物理销毁。
2. **正常完结即刻自毁**：业务逻辑执行完毕并将日志/题库写回 Cloudflare D1 后，立即执行 `gcloud compute instances delete` 提前释放算力，计费精确到秒。
