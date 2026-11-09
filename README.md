# `afk-cloud` — 个人云端自治 Agent（Personal Autonomous Cloud Agent）

> **核心理念**：“边缘免维护保活、协议级原生工具调用、免费算力优先（Cloudflare + Cloud Run + GCE `e2-micro`）、高负载按需秒级拉起、跑完即自毁”。

---

## 零、 费用精细核算（为什么整套系统 100% 永久免费 $0.00/月）

系统在架构设计上严格执行**“免费额度金字塔”**，各组件的额度与真实消耗对比如下：

| 服务组件 | 官方永久免费额度 (Always Free) | 本项目实际月度预估消耗 | 额度占用率 | 费用 |
| :--- | :--- | :--- | :---: | :---: |
| **Cloudflare Workers** | **100,000 次请求 / 天** | 约 288 次/天（每 5 分钟定时唤醒一次） | **< 0.3%** | **$0.00** |
| **Cloudflare D1 (SQLite)** | **5,000,000 次读/天 + 100,000 次写/天**<br>存储上限 5 GB | 读 < 3,000 次/天，写 < 100 次/天<br>存储 < 5 MB | **< 0.1%** | **$0.00** |
| **Cloudflare Durable Objects** | **1,000,000 次请求 / 月** (免费层支持 SQLite) | 巡检 + 审批唤醒约 10,000 次/月 | **~1.0%** | **$0.00** |
| **Cloudflare Workers KV** | 100,000 次读/天 + 1,000 次写/天 | 仅作为二级容灾缓存，< 50 次/天 | **< 5.0%** | **$0.00** |
| **GCP `e2-micro` 云主机** | **1 台非抢占式实例 / 月**（需选美区）<br>30 GB 永久标准磁盘 + 1 GB 出网流量 | 1 台常驻运行 `afk-shim` 与 `agy` | **100% 免费** | **$0.00** |
| **GCP Cloud Run Jobs** | **360,000 vCPU-秒 + 180,000 GiB-秒 / 月**<br>200 万次请求 / 月 | 偶发作业运行，每月约 1,200 vCPU-秒 | **< 0.4%** | **$0.00** |
| **LLM 求解 (Antigravity CLI)** | 复用已有的 Google Antigravity / Gemini 权益 | 经 `agy` 读题解答，零额外 API 计费 | — | **$0.00** |
| **Tier 2 临时 GCE 实例** | 按需创建（普通/Spot 计费） | 强制注入 **15 分钟物理自毁保险丝** | 仅极端兜底 | **$0.00** |

> [!TIP]
> **GCP 避免扣费避坑指南**：
> Google Cloud 的 `e2-micro` Always Free 仅限美国三个区域：**`us-central1` (爱荷华)**、**`us-east1` (南卡罗来纳)** 或 **`us-west1` (俄勒冈)**。创建常驻机器时务必选择这三个区域之一，即可享受永久 0 元账单。

---

## 一、 本地与云端分工（本地电脑是否可以关机？）

**结论：本地电脑完全可以随时关机，日常运行 100% 托管在云端！**

- **日常 24/7 常驻**：全部由 **Cloudflare Edge Worker (`chaoxing-dashboard-worker`)** 接管，无缝进行课表窗口巡检、秒级签到、新作业红点探测、手机端定期与即时汇总通知。
- **做题与浏览器**：托管在云端 GCP 常驻服务器的 [`packages/shim`](./packages/shim) 守护进程中。当 Cloudflare 发现新作业时，会自动通过安全通道派发给 GCP 上的 `agy` 完成浏览器读题、答题与草稿暂存。
- **本地电脑定位**：仅用于初始代码克隆、配置部署或本地调试。本地开发预览服务已停用，不需要保持开机。

---

## 二、 部署指南：其他人如何从 0 到 1 部署？

系统支持两种部署形态，用户可根据自身需求自由选择：

```
┌────────────────────────────────────────────────────────────────────────┐
│ 模式 A：纯边缘 0 服务器极简托管（90% 同学推荐，5 分钟搞定，无需任何云主机） │
│  - 纯靠 Cloudflare 免费配额 24/7 自动签到 + 新作业红点提醒 + 全景监控看板 │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ 模式 B：全自动云端闭环托管（进阶：Cloudflare 边缘 + GCP 免费常驻机 agy 自动做题）│
│  - 边缘发现作业 -> 派发常驻机 agy 浏览器读题解答 -> 暂存草稿 -> 看板人工审批提交 │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 模式 A：纯边缘 0 服务器极简托管（无需服务器）

适合只需要：**24/7 自动全类型签到、手机端通知提醒、以及随时随地查看全景 Web 监控看板**的同学。

#### 1. 准备工作
- 注册一个免费的 [Cloudflare 账号](https://dash.cloudflare.com/)。
- 本地安装 Node.js (>= 18) 与 pnpm。

#### 2. 一键自动化部署
```bash
# 1. 克隆项目
git clone https://github.com/fgh23333/afk-cloud.git
cd afk-cloud
pnpm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 复制环境变量并填入账号
cp .env.example .env
# 编辑 .env，填入：
# CHAOXING_PHONE=您的手机号
# CHAOXING_PASSWORD=您的密码
# CHAOXING_REALNAME=您的姓名
# BARK_KEY=您的Bark推送Key（或 SERVERCHAN_KEY / WEBHOOK_URL）

# 4. 一键自动开通 D1 数据库与 Worker
pnpm afk setup-cf
```

> **全自动完成的事情**：脚本会自动在您的 Cloudflare 上创建 `afk-cloud-db` 数据库、创建 KV 命名空间、执行表结构初始化、将手机号密码通过加密 Secret 安全存入 Worker、部署 Worker 并将分配的域名写入 `.env`。

部署完成后打开返回的 Worker 网址（例如 `https://chaoxing-dashboard-worker.<您的子域名>.workers.dev`），即可看到深色毛玻璃的个人专属全景监控看板！

---

### 模式 B：全自动云端闭环托管（含 agy 自动解题与草稿）

在【模式 A】的基础上，结合一台免费的常驻云主机（例如 GCP `e2-micro`），实现全自动作业求解。

#### 1. 在服务器上运行服务 Shim（Pet 节点）
在常驻服务器上执行：
```bash
cd afk-cloud

# 配置 .env
cat << 'EOF' >> .env
PORT=8788
SHIM_TOKEN=生成一个随机Token作为通信密码
AFK_EDGE_WORKER_URL=https://您的worker.workers.dev
AFK_EDGE_BEARER_TOKEN=chaoxing_secure_sync_key
EOF

# 启动 Shim 守护进程 (支持 systemd 后台常驻)
pnpm shim

# 或注册为 systemd 系统自启服务：
sudo cp infra/systemd/afk-shim.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now afk-shim
```

#### 2. 将服务器通过 Cloudflare Tunnel 与 Worker 对接
在服务器上安装并启动 `cloudflared`：
```bash
cloudflared tunnel --url http://127.0.0.1:8788
```
记下生成的 Tunnel 域名（例如 `https://xxxx.trycloudflare.com`），在 Cloudflare Worker 中配置环境变量：
```bash
npx wrangler secret put AFK_SHIM_URL
# 输入 Tunnel 域名

npx wrangler secret put AFK_SHIM_TOKEN
# 输入刚刚配置的 SHIM_TOKEN
```

#### 3. 运行效果
- 边缘 `SignAgent` 探测到新作业，自动组装任务推入 `SolverAgent`。
- `SolverAgent` 派发给常驻机 `afk-shim`。
- `afk-shim` 串行唤起 `agy`，在真实浏览器中读题并暂存草稿（**绝不擅自正式提交**）。
- 手机收到**“作业草稿已保存”**通知，用户点击看板一键审核并【审批提交】。

---

## 三、 日常使用与 CLI 指令速查表

| 操作场景 | CLI 命令 | 说明 |
| :--- | :--- | :--- |
| **環境与边缘连通自检** | `pnpm afk status` | 检查 `.env`、无头浏览器、Web 登录态及 Cloudflare D1 连通状态 |
| **一键全自动开通 CF + GCP** | `pnpm afk setup-all` | 自动创建 D1、迁移表、注入密钥、部署 Worker 并部署免费 Cloud Run |
| **仅自动开通 Cloudflare 边缘** | `pnpm afk setup-cf` | 零手动配置，一键完成 D1 创建 + 表迁移 + 加密密钥 + Worker 部署 |
| **启动服务器侧 Shim 守护** | `pnpm shim` | 启动服务器 HTTP Shim (Pet 节点)，提供 Bearer 鉴权与 agy 串行排队锁 |
| **扫描在读课程与待做作业** | `pnpm afk scan` | 列出所有在读课程、未交作业、截止时间与课件数量 |
| **批量下载课程课件 (RAG)** | `pnpm afk materials` | 下载全部课程 PPT/PDF/DOCX 并自动提取文本索引供答题检索 |
| **双轨求解作业（草稿暂存）** | `pnpm afk solve` | **默认安全模式 (`pyFlag=1`)**：D1 缓存 $\rightarrow$ Flash 客观题 $\rightarrow$ Pro 主观题，暂存草稿并出报告 |
| **双轨求解作业（正式提交）** | `pnpm afk solve --auto-submit` | 解答完毕后直接正式提交至学习通 (`pyFlag=3`) |
| **导入 Web 登录态 (PTA/智慧树)** | `pnpm afk profile import-cookie --platform pta --cookie "..."` | 将 Cookie 写入本地 Profile 并加密备份至 Cloudflare D1，跨机器免登 |
| **手动触发汇总推送通知** | `pnpm afk digest` | 立即触发 Cloudflare Edge 推送全平台任务与签到完成状况简报 |
| **打开 Web 监控看板** | 浏览器访问 Worker 地址 | 在 Cloudflare 边缘直接查看任务进度、签到记录与审批提交 |
