---
trigger: always_on
---

# `afk-cloud` 个人云端自治 Agent 核心工程准则

本仓库是一套**高内聚、零闲置、免费额度优先、以协议原生驱动的云端个人自治 Agent（Personal Autonomous Cloud Agent）**。当你在本工作区执行任务时，必须严格遵守以下架构铁律：

## 1. 免费优先的三级弹性算力路由（Free-First Compute Pyramid）
- **Tier 0（Cloudflare Workers + D1，100% 免费常驻）**：
  - 负责 24/7 每分钟心跳巡检、复用 D1 缓存的登录 Cookie、秒级签到、新作业红点探测（`workTestPendingNew`）、以及 `question_bank` 题库 SHA-256 缓存查询。
  - **为什么主存储优先用 D1 而非 KV**：Cloudflare D1 免费层每日提供 **500 万次读 + 10 万次写**，远高于 Workers KV 免费层的每日 1,000 次写限额。
- **Tier 1（GCP 已开启常驻机 `e2-micro` + Cloud Run Jobs 免费层）**：
  - 日常课程扫描、课件资料 RAG 下载、常规作业解答优先在当前已开启的 GCP 服务器本机或通过 **Google Cloud Run Jobs (`gcloud run jobs execute`)** 执行。
  - Cloud Run 永久免费层每月提供 **360,000 vCPU-秒 + 180,000 GiB-秒 + 200 万次请求**，容器秒级拉起、跑完即归零，无任何闲置计费风险。
- **Tier 2（高负载 `gcloud` 短时拉起临时 GCE 实例 + 物理 TTL 熔断）**：
  - 仅当遇到重型并发无头浏览器（Playwright）、大规模编译沙箱或超出 Cloud Run 内存/时长限制的任务时，调用 `infra/gcp/spawn-ephemeral-gce.sh`（或 `pnpm afk burst --mode gce`）短时拉起新机器。
  - **强制自毁围栏**：任何通过 `gcloud compute instances create` 创建的临时机器，必须注入 `startup-script` 内的 `at now + 15 minutes` 物理自毁定时器，并在任务结束时立即执行 `gcloud compute instances delete --quiet`。

## 2. 双轨认知模型分级（Tiered Intelligence）
- **第 0 步（零 Token 缓存命中）**：求解任何题目前，必须先计算 `sha256(题干 + 规范化选项)` 查询 D1 / 本地 `question_bank` 缓存。
- **主力轨（90% 流量 -> Gemini Flash 批量结构化输出）**：
  - 针对单选题、多选题、判断题、填空题等客观题，严禁逐题串行 spawn CLI 进程！必须将同一份作业的所有客观题连同课件 RAG 检索片段打包为单次 JSON Batch Prompt，调用 Flash 模型一次性返回 `{"questionId": "answer"}`。
- **兜底轨（10% 流量 -> Gemini Pro 深度推理与沙箱自愈）**：
  - 针对高分主观论述题、PTA 算法编程题、或沙箱单元测试报错（WA/CE/TLE）的题目，升级调用 Pro 模型进行最多 3 轮的反思修复回路。

## 3. 安全与合规铁律
- **零明文凭据入库**：严禁在代码、`wrangler.jsonc` 或 Git 历史中写入真实手机号、密码、Token 或示例占位学号。所有敏感信息必须通过 `.env` 或 `wrangler secret put` 注入。
- **作业安全草稿优先**：除非用户显式传入 `--auto-submit`（或环境变量 `CHAOXING_AUTO_SUBMIT=true`），所有作业解答默认以 **安全草稿暂存模式（`pyFlag=1`）** 写入平台，并生成详细的 Markdown 作答报告供核验。
- **统一时区规范**：所有日志、数据库时间戳、作答报告必须统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。
