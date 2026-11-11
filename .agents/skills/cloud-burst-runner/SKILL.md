---
name: cloud-burst-runner
description: Google Cloud 免费算力（Cloud Run Jobs）与高负载短时拉起新机器（gcloud Ephemeral GCE + 弹性自毁）操作指南。当需要配置 GCP IAM 安全围栏、调度免费 Cloud Run 任务或短时拉起临时 GCE 实例时加载此技能。
---

# `cloud-burst-runner` 弹性算力与安全围栏操作手册

本技能遵循 **“长时任务首选 Always Free 常驻机与 Cloud Run 免费配额，极端高负载按需拉起临时 GCE 并实行完工即刻自毁 + 物理 TTL 兜底”** 的原则。

## 1. 安全围栏初始化（首次在 GCP 上执行一次）

切勿使用个人 `Owner` 账号运行自动化工作负载。使用以下脚本创建最小权限服务账号 `sa-antigravity-worker`：

```bash
bash infra/gcp/setup-iam-guardrails.sh
```

该脚本仅授予：
- `roles/compute.instanceAdmin.v1`（管理临时实例生命周期）
- `roles/run.invoker` 与 `roles/run.developer`（触发 Cloud Run 免费层任务）
- `roles/iam.serviceAccountUser`

---

## 2. 长时挂机与常规算力首选：GCP Always Free `e2-micro`（宠物窝）

针对**视频看门狗、学习通会话保活、日常巡检**等长时占用资源的场景：
- **铁律：一律由 Google Cloud 永久免费的 1 台 `e2-micro` 实例（24/7 常驻运行，0 元月租）承载**！
- 绝不开付费临时机进行空耗挂机。

---

## 3. 中长时弹性无服务器算力：Google Cloud Run Jobs（免费层）

Google Cloud Run 每月提供极其慷慨的 **Always Free** 配额（每月 360,000 vCPU-秒、180,000 GiB-秒、200 万次请求，相当于 100 小时 1 vCPU 免费）：
- **部署/更新 Cloud Run Job**：
  ```bash
  bash infra/gcp/deploy-cloud-run-job.sh
  ```
- **按需触发一次无状态容器执行（单次支持最长 60 分钟，跑完即停，闲置 0 成本）**：
  ```bash
  pnpm afk burst --mode cloud-run --task "solve"
  ```

---

## 4. 极端高负载：`gcloud` 短时临时 GCE 实例（弹性完工销毁 + 60 分钟 TTL 兜底熔断）

当任务需要完整宿主内核、超大内存或重度真机浏览器多并发时，使用 `infra/gcp/spawn-ephemeral-gce.sh`（或 CLI 封装）：

```bash
# 通过 CLI 触发短时 GCE 机器（默认 e2-micro + Spot 抢占式 + 默认 60 分钟兜底自毁）
pnpm afk burst --mode gce --task "solve" --ttl 60 --machine-type e2-small
```

### 双重自毁保险机制说明
1. **正常完结即刻自毁（主路径）**：业务脚本执行完毕并将日志/题库写回 Cloudflare D1 后，自动通过 bash `trap cleanup EXIT` 立即触发 `gcloud compute instances delete` 提前释放算力，计费精确到秒。
2. **物理定时器（兜底防卡死）**：实例启动首行即执行 `echo "gcloud compute instances delete ${INSTANCE_NAME} --zone=${ZONE} --quiet" | at now + ${TTL} minutes`，即使发生死锁，到点依然物理销毁，严格防范悬挂计费。

---

## 5. 算力成本控制与存储解耦架构（每月最高 $10 预算红线）

为了防止意外产生云端账单，Agent 执行弹性算力调度时必须遵守以下铁律：
- **预算硬顶：每月最高 10 美元预算**：优先使用 Always Free 常驻机与 Cloud Run 免费层；临时 GCE 实例严格限定仅用于高并发短时批处理，且必须为 Spot 抢占式机型。
- **即用即销毁，禁止长时间占用**：所有非 Always Free 的 GCE 临时实例必须完工即删，最长兜底不得超过 60 分钟。
- **持久化存储与快照外置**：
  - 临时实例为纯无状态节点，严禁在临时节点本地长期保存数据。
  - **首选持久化存储：Cloudflare R2**（每月提供 **10 GB 永久免费空间**，100 万次写 + 1000 万次读，零出网流量费，存储桶统一命名为 `afk-cloud-snapshots`）。
  - **课件与超大资料备份：Google Drive**（支持通过 OAuth2 授权直接挂载或备份，不占服务器磁盘空间）。
  - **结构化元数据：Cloudflare D1**（SQLite 分布式数据库）。
