# `afk-cloud` — 高校全能个人云端自治 Agent（Personal Autonomous Cloud Agent）

<p align="center">
  <img src="./dashboard-real-preview.png" alt="afk-cloud Dashboard" width="780" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);" />
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://afk.idiotshoumy.com"><img src="https://img.shields.io/badge/Edge%20Domain-afk.idiotshoumy.com-emerald.svg" alt="Custom Domain"></a>
  <img src="https://img.shields.io/badge/Monthly%20Cost-%240.00%20(Always%20Free)-success.svg" alt="Cost: $0.00">
  <img src="https://img.shields.io/badge/Compute-Cloudflare%20Edge%20%2B%20GCP%20e2--micro-orange.svg" alt="Compute">
  <img src="https://img.shields.io/badge/Model-Gemini%20Pro%20%2B%20Flash-purple.svg" alt="Models">
</p>

> **核心使命**：为高校学生打造的高内聚、零闲置、以协议原生 + 真实浏览器驱动的个人云端自治 Agent。深度覆盖**超星学习通、智慧树、PTA（拼题 A）**等平台。
> **双轨理念**：全面榨干 Google Gemini Pro 深度推理与 2M 超大长上下文能力；严格遵循**草稿安全优先 (`pyFlag=1`)**与**“边缘牛群 + 常驻宠物”**架构，日常无需开启本地电脑，全系统 **100% 永久免费 ($0.00/月)** 运行。

- **官方标准线上入口**：[`https://afk.idiotshoumy.com`](https://afk.idiotshoumy.com)（深色磨砂玻璃全景 Web 控制面板）。

---

## 目录
- [零、 费用精细核算（为什么 100% 永久免费 $0.00/月）](#零-费用精细核算为什么-100-永久免费-000月)
- [一、 核心架构：边缘牛群 (Cattle) 与常驻宠物 (Pet)](#一-核心架构边缘牛群-cattle-与常驻宠物-pet)
- [二、 核心功能一览](#二-核心功能一览)
- [三、 极简实操：从 0 到 1 部署指南（仅需 CF 与 GCP 免费账号）](#三-极简实操从-0-到-1-部署指南仅需-cf-与-gcp-免费账号)
  - [方案 A：纯边缘 0 服务器极简版（推荐，只需 Cloudflare，5 分钟完成）](#方案-a纯边缘-0-服务器极简版推荐只需-cloudflare5-分钟完成)
  - [方案 B：全功能云端闭环版（Cloudflare 边缘 + GCP 免费常驻机，支持 AI 解题与真机刷课）](#方案-b全功能云端闭环版cloudflare-边缘--gcp-免费常驻机支持-ai-解题与真机刷课)
- [四、 日常 CLI 指令速查表](#四-日常-cli-指令速查表)
- [五、 安全与学术合规铁律](#五-安全与学术合规铁律)
- [六、 开源许可证](#六-开源许可证)

---

## 零、 费用精细核算（为什么 100% 永久免费 $0.00/月）

系统在架构设计之初就严格贯彻**“免费配额金字塔”**，杜绝任何隐性扣费：

| 服务组件 | 官方永久免费配额 (Always Free) | 本项目实际月度预估消耗 | 额度占用率 | 费用 |
| :--- | :--- | :--- | :---: | :---: |
| **Cloudflare Workers** | **100,000 次请求 / 天** | 约 288 次/天（每 5 分钟定时巡检一次） | **< 0.3%** | **$0.00** |
| **Cloudflare D1 (SQLite)** | **5,000,000 次读/天 + 100,000 次写/天**<br>存储上限 5 GB | 读 < 3,000 次/天，写 < 100 次/天<br>真实数据占用 < 5 MB | **< 0.1%** | **$0.00** |
| **Cloudflare Durable Objects** | **1,000,000 次请求 / 月** (免费层支持 SQLite) | 巡检 + 审批唤醒约 10,000 次/月 | **~1.0%** | **$0.00** |
| **Cloudflare Workers KV** | 100,000 次读/天 + 1,000 次写/天 | 仅作为容灾 Cookie 缓存，< 50 次/天 | **< 5.0%** | **$0.00** |
| **GCP `e2-micro` 常驻机** | **1 台非抢占式实例 / 月**（需选美区特定可用区）<br>30 GB 永久标准磁盘 + 1 GB 出网流量 | 1 台常驻运行 `afk-shim` 与 `agy` | **100% 免费** | **$0.00** |
| **GCP Cloud Run Jobs** | **360,000 vCPU-秒 + 180,000 GiB-秒 / 月**<br>200 万次请求 / 月 | 偶发高并发作业，每月约 1,200 vCPU-秒 | **< 0.4%** | **$0.00** |
| **LLM 求解 (Antigravity CLI / Gemini)** | 复用已有的 Google Antigravity / Gemini Pro 配额 | 经 `agy` 读题解答，零额外 API 计费 | — | **$0.00** |

> [!TIP]
> **GCP 避免扣费避坑指南**：
> Google Cloud 的 `e2-micro` 免费实例必须选择以下三个美国区域之一：
> 1. **`us-central1` (爱荷华 Iowa)**
> 2. **`us-east1` (南卡罗来纳 South Carolina)**
> 3. **`us-west1` (俄勒冈 Oregon)**
> 并在创建磁盘时选择 **“标准永久磁盘 (Standard Persistent Disk)”**，容量不超过 **30 GB**，即可享受永久 0 元账单。

---

## 一、 核心架构：边缘牛群 (Cattle) 与常驻宠物 (Pet)

```
┌─ Cloudflare Edge（牛群：无黏性状态，高可用轻量托管）───────────────────────┐
│                                                                        │
│  边缘 Worker (https://afk.idiotshoumy.com)                              │
│    ├─ SignAgent (DO)    24/7 秒级心跳巡检、全类型签到、作业红点探测          │
│    ├─ SolverAgent (DO)  任务排队、去重、记账、手机即时推送通知、审批门拦截     │
│    ├─ Cloudflare D1     SQLite 持久化（课程、签到流水、题库缓存、Web Profiles）│
│    └─ Web 看板          深色毛玻璃交互界面，真实数据展示与一键审批              │
│                                                                        │
└──────────┬─────────────────────────────────────────▲───────────────────┘
           │ ① POST /task (派发题目链接与指令)         │ ④ 回调 /api/agent/callback
           │    通过 Cloudflare Tunnel（零端口暴露）   │    （更新任务状态与草稿内容）
           ▼                                         │
┌─ GCP Always Free 宿主机（宠物窝：e2-micro，常驻但极低功耗）───────────────┐
│                                                                        │
│  afk-shim 守护进程 (Port: 8788, Bearer 鉴权, 单进程串行执行锁)            │
│    ├─ 本地真实 Chromium (CDP localhost:9222，真机渲染防风控)             │
│    ├─ Antigravity CLI (agy)                                            │
│    │    ├─ Gemini Flash: 批量客观题高速 JSON 批处理                      │
│    │    └─ Gemini Pro: 2M 课件上下文 RAG + 多模态图表解析 + 算法沙箱自愈  │
│    └─ 草稿安全暂存: 页面填写答案并暂存 (pyFlag=1)，绝不擅自越权正式提交     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **本地电脑是否可以关机？**
  - **完全可以！** 日常 24/7 常驻全部托管在 Cloudflare Edge；重型读题与浏览器答题托管在 GCP `e2-micro` 云主机。本地电脑无需开机。

---

## 二、 核心功能一览

### 1. 超星学习通（全自动 24/7 守护）
- **秒级多类型签到**：
  - **普通签到 / 签到码**：自动捕获并秒级响应。
  - **拍照签到**：自动调用云盘 API 上传 1×1 极简透明底图，获取真实 `objectId` 后完成提交。
  - **手势签到**：自动匹配多位手势轨迹。
  - **位置 / 定位签到**：支持配置精准经纬度与学校地址进行虚拟打卡。
  - **二维码签到**：支持解析 `enc` 参数完成自动化秒级确认。
- **作业探测与红点巡检**：
  - 自动调用 `workTestPendingNew` 接口，定期比对在读课程作业列表。
- **AI 双轨解题与草稿先行**：
  - **D1 题库 SHA-256 零 Token 缓存命中**：优先匹配历史题库。
  - **Gemini Flash 客观题批量求解**：单选题、多选题、判断题打包批处理，极速高效。
  - **Gemini Pro 深度推理**：主观大题、编程题、复杂图表题精准分析。
  - **安全草稿暂存 (`pyFlag=1`)**：默认只存草稿，手机收到推送后在 Web 看板一键人工复核提交。

### 2. 智慧树 (Zhihuishu) & PTA (拼题 A)
- **Web Profile 本地持久化与 D1 备份**：Cookie 与 LocalStorage 跨机器无缝免登录同步。
- **真实 Chromium 真机操控**：通过 Chrome DevTools Protocol (CDP) 驱动真实浏览器渲染页面与播放课件，**杜绝任何 HTTP 伪造进度包**，彻底免疫平台作弊检测。
- **PTA 算法题沙箱自愈**：本地沙箱编译与单测验证，若遭遇 WA/CE/TLE，由 Gemini Pro 自动反思修复并二次验证。

### 3. 多通道即时通知
- 支持 **Bark (iOS 即时弹窗)**、**Server酱 (微信通知)**、**企业微信 / 飞书 / 自定义 Webhook**。

---

## 三、 极简实操：从 0 到 1 部署指南（仅需 CF 与 GCP 免费账号）

### 方案 A：纯边缘 0 服务器极简版（推荐，只需 Cloudflare，5 分钟完成）

> 适合只需要：**24/7 自动全类型签到、手机端通知提醒、以及随时随地查看全景 Web 监控看板**的同学。无需任何服务器！

#### 1. 准备工作
- 注册一个免费的 [Cloudflare 账号](https://dash.cloudflare.com/)。
- 本地安装 Node.js (>= 18) 与 pnpm (`npm install -g pnpm`)。

#### 2. 一键配置与部署
```bash
# 1. 克隆代码库
git clone https://github.com/fgh23333/afk-cloud.git
cd afk-cloud
pnpm install

# 2. 登录 Cloudflare 账号（会自动拉起浏览器授权）
npx wrangler login

# 3. 复制环境变量模板并填写凭据
cp .env.example .env
```

用任意编辑器打开 `.env`，填入学习通账号与通知 Key：
```env
# 学习通账号与凭据
CHAOXING_PHONE=13800000000
CHAOXING_PASSWORD=YourPassword123
CHAOXING_REALNAME=张三

# 手机推送通道（选填任意一个即可）
BARK_KEY=https://api.day.app/your_bark_key/
# SERVERCHAN_KEY=SCTxxxxxxxx
```

#### 4. 执行一键自动化边缘编排
```bash
pnpm afk setup-cf
```

> **自动化脚本完成的全部工作**：
> 1. 在 Cloudflare 上自动创建 D1 数据库 `afk-cloud-db`；
> 2. 自动在 D1 中执行全套表结构迁移（课程表、签到流水、题库缓存、Web Profile）；
> 3. 自动创建 KV 容灾命名空间；
> 4. 将手机号密码等敏感信息通过 `wrangler secret` 加密写入 Worker；
> 5. 自动渲染 `edge/wrangler.jsonc` 并发布 Worker。

部署完成后终端将输出访问网址：
`https://chaoxing-dashboard-worker.<您的CF子域>.workers.dev`

打开该网址，即可看到实时更新的个人专属暗黑毛玻璃看板！

---

### 方案 B：全功能云端闭环版（Cloudflare 边缘 + GCP 免费常驻机，支持 AI 解题与真机刷课）

> 在【方案 A】的基础上，通过一台 Google Cloud 永久免费的 `e2-micro` 云主机，让 Agent 具备真正的 Gemini Pro 深度读题、草稿暂存与真机操作能力。

#### 第一步：在 Google Cloud 创建永久免费 `e2-micro` 云主机

1. 登录 [Google Cloud Console](https://console.cloud.google.com/)。
2. 导航至 **Compute Engine $\rightarrow$ 虚拟机实例 $\rightarrow$ 创建实例**：
   - **名称**：`afk-node`
   - **区域 (Region)**：务必选择 **`us-central1` (爱荷华)**、**`us-east1` (南卡罗来纳)** 或 **`us-west1` (俄勒冈)** 之一。
   - **机器类型**：选择 **`E2` 系列 $\rightarrow$ `e2-micro` (2 vCPU, 1 GB 内存)**。
   - **引导磁盘**：点击“更改”，操作系统选择 **Ubuntu 22.04 LTS**，磁盘类型选择 **标准永久磁盘 (Standard Persistent Disk)**，大小设为 **30 GB**。
   - **防火墙**：勾选“允许 HTTP 流量”和“允许 HTTPS 流量”（注：我们使用 Cloudflare Tunnel，即使不开放任何端口也能安全穿透）。
3. 点击 **创建**。

*(或直接使用 gcloud 命令行一键拉起)*：
```bash
gcloud compute instances create afk-node \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-standard
```

#### 第二步：SSH 连接云主机并安装基础运行环境

在 GCP 控制台点击实例右侧的 **“SSH”** 按钮打开网页终端，执行以下一键安装命令：

```bash
# 1. 更新系统并安装 Node.js 20、Git 与 Chromium
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs chromium-browser git build-essential

# 2. 安装 pnpm
sudo npm install -g pnpm
```

#### 第三步：部署 `afk-cloud` 与配置 Shim 守护进程

```bash
# 1. 克隆代码并安装依赖
git clone https://github.com/fgh23333/afk-cloud.git ~/afk-cloud
cd ~/afk-cloud
pnpm install

# 2. 配置服务器环境变量
cat << 'EOF' > .env
PORT=8788
SHIM_TOKEN=generate_a_random_token_here_123456
AFK_EDGE_WORKER_URL=https://afk.idiotshoumy.com
AFK_EDGE_BEARER_TOKEN=chaoxing_secure_sync_key
GEMINI_API_KEY=您的Gemini_API_Key
EOF

# 3. 将 afk-shim 注册为 systemd 开机自启服务
sudo cp infra/systemd/afk-shim.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now afk-shim

# 4. 检查服务健康状态
curl http://127.0.0.1:8788/health
# 正常应返回: {"status":"ok","time":"..."}
```

#### 第四步：使用 Cloudflare Tunnel 实现零公网暴露安全对接

无需公网 IP，无需防火墙放行，通过 Cloudflare Tunnel 将 GCP 宿主机与 Cloudflare Edge 安全连通：

```bash
# 1. 在 GCP 主机上安装 cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# 2. 方式一：快速启动临时/持久隧道（支持零门槛直接用）
cloudflared tunnel --url http://127.0.0.1:8788
```
*(终端将打印类似 `https://xxxx.trycloudflare.com` 的访问地址)*

#### 第五步：将 Tunnel 凭证绑定至 Cloudflare Edge Worker

在本地开发机（或 GCP 终端）执行以下命令，将隧道地址注入 Worker 密钥库：

```bash
cd afk-cloud

# 注入隧道地址
npx wrangler secret put AFK_SHIM_URL
# 输入您的 Tunnel 地址，例如: https://xxxx.trycloudflare.com

# 注入通信密钥
npx wrangler secret put AFK_SHIM_TOKEN
# 输入刚刚在 .env 中设置的 SHIM_TOKEN
```

**大功告成！** 全套闭环系统已就绪：
- 边缘 Worker 发现新作业后，自动通过加密隧道派发给 GCP 宿主机；
- GCP 上的 Agent 调用真实 Chromium 打开题目，利用 Gemini Pro 分析解题，并在网页上暂存为草稿 (`pyFlag=1`)；
- 手机端收到作业草稿已生成的推送，点击看板一键核验并确认提交。

---

## 四、 日常 CLI 指令速查表

在本地开发机或 GCP 终端中，可通过 `pnpm afk <command>` 便捷操控整个 Agent 系统：

| 指令 | 说明 |
| :--- | :--- |
| `pnpm afk status` | **全局自检**：检查 `.env` 配置、本地 Chromium、PTA/智慧树登录态及 Cloudflare Edge 连通状态 |
| `pnpm afk setup-cf` | **边缘一键编排**：自动开通 D1、执行迁移、加密密钥并部署 Worker |
| `pnpm afk setup-all` | **双端编排**：一键完成 Cloudflare Edge 与 GCP Cloud Run / IAM 安全配置 |
| `pnpm afk scan` | **课程与作业扫描**：列出全部在读课程、未交作业详情、截止时间与课件统计 |
| `pnpm afk materials` | **课件材料下载**：下载课程全部 PPT/PDF/Word 文件并提取文本索引，供 Gemini Pro 检索 |
| `pnpm afk solve` | **双轨作业求解（草稿先行）**：优先题库缓存 $\rightarrow$ Flash 批量客观题 $\rightarrow$ Pro 主观题，暂存草稿并出具报告 |
| `pnpm afk solve --auto-submit` | **作业求解（正式提交）**：作答完毕后直接正式提交 (`pyFlag=3`) |
| `pnpm afk digest` | **即时简报**：手动触发 Cloudflare Edge 推送全平台任务与签到完成状态摘要 |
| `pnpm shim` | **启动宿主机 Shim 守护**：提供带 Bearer 鉴权与单进程排队锁的 HTTP 控制平面 |

---

## 五、 安全与学术合规铁律

1. **绝对零凭据入库**：代码库与 Git 提交历史中严禁出现真实手机号、明文密码、个人姓名或学号。所有敏感信息严格经由 `.env` 或 `wrangler secret` 加密注入。
2. **安全草稿优先 (`pyFlag=1`)**：默认模式下，AI 解题结果一律作为草稿暂存，杜绝越权错交与答题失误风险；正式提交必须通过看板由人工审批确认。
3. **真实浏览器防风控**：坚决摒弃伪造心跳包与爬虫逆向黑产做法，基于真实无头浏览器模拟人工阅读交互，尊重教学平台风控规范。
4. **统一时区标准**：全系统日志、数据库时间戳与作答报告统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。

---

## 六、 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。仅供学习与自动化运维技术研究使用，请自觉遵守所在高校的学风与考试纪律。
