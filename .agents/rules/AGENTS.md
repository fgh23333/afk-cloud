---
trigger: always_on
---

# `afk-cloud` 个人云端自治 Agent 核心工程准则

本仓库是一套**高内聚、零闲置、以协议原生 + 真实浏览器驱动的个人云端自治 Agent（Personal Autonomous Cloud Agent）**，主要覆盖超星学习通、智慧树、PTA 等高校教学与评测平台，最大化榨干 Google Gemini Pro 深度推理与长上下文资源，并在架构上实现 **100% 永久免费 ($0.00/月)** 运行。

- **官方标准线上入口**：`https://afk.idiotshoumy.com`（原备用镜像已全面下线归并，统一由此单一边缘域名提供服务）。

当你在本工作区执行任务时，必须严格遵守以下架构铁律：

---

## 1. 免费优先的三级弹性算力路由（Free-First Compute Pyramid）

- **Tier 0（Cloudflare Workers + D1 + DO + KV，100% 永久免费常驻）**：
  - 负责 24/7 心跳巡检、复用 D1 缓存的登录 Cookie、秒级全类型签到（普通/拍照/手势/定位/二维码）、新作业红点探测（`workTestPendingNew`）、题库 SHA-256 零 Token 缓存查询、以及移动端 Web 看板与审批门管控。
  - **D1 优先原则**：D1 免费层每日提供 **500 万次读 + 10 万次写**（存储 5GB），远高于 KV 的每日 1,000 次写限额，主持久化一律走 D1。
- **Tier 1（GCP `e2-micro` 常驻机 + Cloud Run Jobs 免费层）**：
  - **常驻机（宠物窝）**：使用 Google Cloud 永久免费的 1 台 `e2-micro` 实例（需选 `us-central1`、`us-east1` 或 `us-west1`），常驻运行 `afk-shim` 与 Antigravity CLI (`agy`)。
  - **网络互联**：通过 **Cloudflare Tunnel**（零公网暴露、零开放端口）与 Cloudflare Edge 建立安全双向隧道，Edge 通过 Bearer Token 派发解题与操作指令。
  - **容器秒级算力**：高并发扫描或批量课件解压通过 Cloud Run Jobs (`gcloud run jobs execute`) 弹性分发，每月 360,000 vCPU-秒免费额度，跑完即销毁。
- **Tier 2（极端负载 `gcloud` 短时临时 GCE 实例 + 物理 TTL 熔断）**：
  - 仅在遇到极端并发重型任务时调用 `infra/gcp/spawn-ephemeral-gce.sh` 短时创建临时机。
  - **强制自毁围栏**：创建时必须在 `startup-script` 内硬编码 `at now + 15 minutes` 物理自毁定时器，任务结束立即触发 `gcloud compute instances delete --quiet`。

---

## 2. 深度榨干 Gemini Pro 认知能力（Tiered Intelligence）

- **第 0 步（零 Token 缓存命中）**：求解任何题目前，必须先计算 `sha256(题干 + 规范化选项)` 查询 D1 / 本地 `question_bank` 缓存，命中即返。
- **主力轨（Gemini Flash 极速结构化批处理）**：
  - 针对常规单选题、多选题、判断题、简单填空题，**严禁逐题串行调用**！必须将整份作业的客观题打包为单次 JSON Batch Prompt，由 Flash 模型批量输出答案。
- **高阶轨（Gemini Pro 深度推理与多模态赋能）**：
  - **1M Token 超大上下文 RAG**：直接将全课程 PPT、PDF 课件材料一次性注入上下文，实现零幻觉检索与解答。
  - **多模态图表/公式解析**：针对包含函数图像、电路图、几何结构或手写公式的高分大题，直接输入原图调用 Pro 视觉能力精准读题。
  - **PTA 算法编程沙箱自愈回路**：在本地编译沙箱执行单元测试，若发生 WA/CE/TLE，由 Gemini Pro 执行最多 3 轮的反思修复闭环，直至代码全绿。

---

## 3. 真实浏览器操作与课程进度保活规范

- **拒绝伪造 HTTP 进度包**：针对智慧树、学习通视频课件与防作弊页面，一律通过本地 Chromium CDP (`localhost:9222`) 进行**真机无头/有头浏览器操控**，模拟真实播放、随机鼠标移动与答题弹窗捕获，彻底杜绝发包特征被平台反爬风控与作弊检测。
- **Profile 本地持久化与 D1 远程备份**：针对 PTA、智慧树等复杂登录态，Cookie 与 LocalStorage 状态统一存储于本地 `.cache/profiles/` 并加密同步至 Cloudflare D1，实现跨机器免登迁移。

---

## 4. 安全与合规铁律

- **零明文凭据入库**：严禁在代码、`wrangler.jsonc` 或 Git 历史中写入真实手机号、密码、Token 或示例占位学号。所有敏感信息必须通过 `.env` 或 `wrangler secret put` 注入。
- **作业安全草稿优先**：除非显式传入 `--auto-submit`（或环境变量 `CHAOXING_AUTO_SUBMIT=true`），所有作业解答默认以 **安全草稿暂存模式（`pyFlag=1`）** 写入平台，并生成详细的 Markdown 作答报告供用户在看板审核确认。
- **统一时区规范**：所有日志、数据库时间戳、作答报告必须统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。
