---
name: afk-orchestrator
description: 中央调度与编排技能。当需要巡检云端状态、从 Cloudflare D1/KV 同步待办作业与 Cookie、调度双轨模型答题或分发高负载任务到 Cloud Run / 临时 GCE 时加载此技能。
---

# `afk-orchestrator` 中央调度与编排指南

本技能指导 Antigravity CLI (`agy`) 充当中央控制面（Control Plane），协同 **Cloudflare 官方 Plugin/MCP**、**本地双轨求解器** 与 **GCP 弹性算力（Cloud Run Jobs / 临时 GCE）** 完成闭环自治。

## 1. 标准自治工作流（Lifecycle Pipeline）

### 步骤 1：通过 Cloudflare Plugin 或 CLI 检查边缘状态与待办任务
- 如果当前环境已挂载 Cloudflare MCP Plugin，可直接查询 D1 数据库 `afk_cloud_db`：
  ```sql
  SELECT task_id, platform, course_name, title, status, deadline, compute_tier, updated_at
  FROM pending_tasks
  WHERE status = 'pending'
  ORDER BY updated_at DESC;
  ```
- 或直接运行本地统一状态巡检命令：
  ```bash
  pnpm afk status
  pnpm afk scan
  ```

### 步骤 2：根据任务复杂度选择算力层级（Tier 0 -> Tier 1 -> Tier 2）
1. **常规签到与红点探测（Tier 0）**：
   - 由 Cloudflare Worker (`edge/`) 每分钟自动完成，无需云主机介入。
2. **常规课程作业与资料 RAG 解答（Tier 1 - 本机或 Cloud Run 免费层）**：
   - 在已开启的 GCP 服务器上直接运行：
     ```bash
     # 默认安全草稿暂存 (pyFlag=1)
     pnpm afk solve
     # 若确认直接正式提交 (pyFlag=3)
     pnpm afk solve --auto-submit
     ```
   - 若希望隔离执行并消耗 **Cloud Run 每月免费 vCPU/内存配额**，可执行：
     ```bash
     pnpm afk burst --mode cloud-run --task "solve"
     ```
3. **重型沙箱 / 大批量无头浏览器 / PTA 压轴评测（Tier 2 - `gcloud` 短时拉起新机器）**：
   - 当本机内存受限（如 `e2-micro` 1GB 内存不足以同时跑大型编译或重度 Playwright）时，调用短时拉起命令：
     ```bash
     pnpm afk burst --mode gce --task "solve --platform pta" --ttl 15
     ```

### 步骤 3：结果回写与算力归零核验
- 每次求解完成后，新的题干 Hash 与高置信度答案会自动同步至本地缓存与 Cloudflare D1 `question_bank` 表。
- 若启动了 Tier 2 临时 GCE 实例，务必确认实例已在任务结束或 15 分钟 TTL 内销毁：
  ```bash
  gcloud compute instances list --filter="name~'^runner-temp-'"
  ```
