---
trigger: always_on
---

# `afk-cloud` 个人云端自治 Agent 核心工程准则

本系统是一套 **以 Google Cloud 上常驻的 Antigravity Personal Agent (`agy`) 为大脑、平台能力解耦为选装插件（Plugins / Skills）的个人云端自治智能体系统（Personal Autonomous Agent）** ，深度覆盖超星学习通、智慧树、PTA 等高校教学与评测平台，最大化榨干 Google AI (Gemini) Pro 账号认知与长上下文效益，并在架构上实现 **100% 永久免费 ($0.00/月)** 运行。

- **线上服务入口**：统一由 Cloudflare Edge 分配的 Worker 域名或用户绑定的个人自定义域名（例如 `https://afk.<your-domain>.com`）提供轻量无服务器控制面板与任务队列。

当你在本工作区执行任务时，必须严格遵守以下架构铁律：

---

## 1. 核心架构解耦：Personal Agent 宿主 + 选装平台插件（Plugins / Skills）

- **大脑宿主（Core Host）**：部署在 Google Cloud（永久免费 `e2-micro` 实例或 Cloud Run）上的 **`agy` (Antigravity CLI Agent Runtime)**，拥有全局状态编排、真机 Chromium 操控与沙箱执行能力。
- **平台能力解耦（Plugins / Skills 规范）**：
  - 各高校平台（超星 Chaoxing、智慧树 知到 Zhihuishu、PTA 拼题 A 等）全部解耦为 **独立插拔式插件 / 技能模块**（统一实现 `packages/core/plugin.ts` 契约）。
  - 核心 Agent 不与任何特定高校平台产生硬编码耦合，按需加载，独立迭代。
- **轻量边缘控制面（Edge Control Plane）**：
  - Cloudflare Workers + D1 仅作为任务聚合看板、免登凭据池、状态队列与可选手机通知网关，不承载沉重浏览器或模型推理。

---

## 2. 长时占用与免费优先算力金字塔（Free-First Compute Hierarchy）

- **Tier 0（Cloudflare Workers + D1，100% 永久免费边缘）**：
  - 负责 24/7 心跳巡检、Cookie 缓存复用、全类型签到秒级捕获、新作业红点探测、题库 SHA-256 零 Token 缓存查询、以及移动端 Web 看板与审批门管控。
  - **D1 优先原则**：D1 免费层每日提供 **500 万次读 + 10 万次写**（存储 5GB），主持久化一律走 D1。
- **Tier 1（长时占用与常规算力首选：GCP Always Free `e2-micro` + Cloud Run Jobs 免费层）**：
  - **长时挂机与保活首选（宠物窝）**：长时视频观看、章节进度看门狗、学习通保活等长时占用资源的场景，**一律由 Google Cloud 永久免费的 1 台 `e2-micro` 实例（24/7 常驻运行，0 元月租）承载**，严禁开付费机型空耗！
  - **中长时弹性算力（Cloud Run Jobs 免费层）**：针对批量课件材料 RAG 向量化、大并发扫描等，优先调度 Cloud Run Jobs（每月 360,000 vCPU-秒免费额度，相当于 100 小时 1 vCPU，单次最长可跑 60 分钟），执行完毫秒级关机，0 闲置费用。
- **Tier 2（极端负载 `gcloud` 临时 GCE 实例 + 弹性自毁熔断）**：
  - 仅在遇到极端并发或必须独占硬件时调用 `infra/gcp/spawn-ephemeral-gce.sh` 拉起 Spot 临时机。
  - **自毁机制优化**：任务执行完通过 `trap cleanup EXIT` **立即提前销毁并释放算力**；同时设置 **默认 60 分钟物理自毁兜底定时器（`at now + 60 minutes`）** ，避免死锁导致计费悬挂。
  - **每月预算硬顶（最多 $10/月）**：弹性算力开销严控在 10 美元以内。
  - **持久化存储与快照外置**：计算实例纯无状态；快照外置至 **Cloudflare R2**（每月 10GB 免费，0 出网费）或 **Google Drive**（OAuth2 认证）。

---

## 3. Google AI Pro 账号效益最大化（Tiered Intelligence Funnel）

用户拥有高价值的 Google AI (Gemini) Pro 账号/配额，必须采取三级漏斗策略，在保障 Pro 配额安全（防烧 Quota）的前提下，将其顶级认知能力发挥到极致：

- **Level 0（零 Token 题库缓存命中）**：
  - 求解任何题目前，必须先计算 `sha256(题干 + 规范化选项)` 查询 D1 / 本地 `question_bank` 缓存，命中即返，**0 Token 消耗、毫秒级响应**。
- **Level 1（Gemini 4 Hydrogen Medium 极速批处理 · 默认主力）**：
  - 针对常规单选题、多选题、判断题、简单填空题与例行扫描，**默认切换至 Gemini 4 Hydrogen Medium (`gemini-4-hydrogen-medium`)** ，兼具极速低延迟与高精度，高难度压轴/主观编程升级至 `gemini-4-hydrogen-xhigh`。
  - **严禁逐题串行调用**！必须将整份作业的客观题打包为单次 JSON Batch Prompt，由 Flash 模型批量并发输出。
- **Level 2（Gemini Pro 极限认知效益爆发 · 榨干 1M Context 与多模态）**：
  - **1M+ Token 超大上下文全量课件 RAG**：直接将全课程整学期 20~50 份 PPT、PDF 教材原文全量注入 Pro 上下文，彻底杜绝粗糙向量切块导致的语义断裂与幻觉，精准定位老师独门考点。
  - **多模态图表/空间推理解析**：复杂电路图、几何体、函数曲线、手写推导，原图直送 Pro 视觉感知通道，一步完成多模态读题。
  - **PTA 算法编程沙箱闭环自愈**：在本地编译沙箱执行单元测试，若发生 WA/CE/TLE，由 Gemini Pro 自主反思并修复代码，最多 3 轮直至全绿 AC。

---

## 4. 真实浏览器操作与课程进度保活规范

- **拒绝伪造 HTTP 进度包**：针对智慧树、学习通视频课件与防作弊页面，一律通过本地 Chromium CDP (`localhost:9222`) 进行 **真机无头/有头浏览器操控** ，模拟真实播放、随机鼠标移动与答题弹窗捕获，杜绝异常发包被平台反爬风控与作弊检测。
- **Profile 本地持久化与 D1 远程备份**：针对 PTA、智慧树等复杂登录态，Cookie 与 LocalStorage 状态统一存储于本地 `.cache/profiles/` 并加密同步至 Cloudflare D1，实现跨机器免登迁移。

---

## 5. 安全与合规铁律

- **Cloudflare 资源销毁安全防线**：允许拉起、创建与销毁 Cloudflare 资源，但 **仅允许销毁自己创建的资源（名称以 `afk-` 或 `afk-cloud-` 开头）** 。严禁误删、清空或篡改用户账户内未受管的其他生产 D1、KV 命名空间、Worker 服务或 DNS 解析记录！
- **零明文凭据入库**：严禁在代码、`wrangler.jsonc` 或 Git 历史中写入真实手机号、密码、Token 或示例占位学号。所有敏感信息必须通过 `.env` 或 `wrangler secret put` 注入。
- **作业安全草稿优先**：除非显式传入 `--auto-submit`（或环境变量 `CHAOXING_AUTO_SUBMIT=true`），所有作业解答默认以 **安全草稿暂存模式（`pyFlag=1`）** 写入平台，并生成详细的 Markdown 作答报告供用户在看板审核确认。
- **统一时区规范**：所有日志、数据库时间戳、作答报告必须统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。
