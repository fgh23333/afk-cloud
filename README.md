# `afk-cloud` — 高校全能个人云端自治 Agent（Personal Autonomous Cloud Agent）

<p align="center">
  <img src="./dashboard-real-preview.png" alt="afk-cloud Dashboard" width="780" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);" />
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Edge%20Entry-Custom%20Domain%20%2F%20workers.dev-emerald.svg" alt="Edge Entry">
  <img src="https://img.shields.io/badge/Monthly%20Cost-%240.00%20(Always%20Free)-success.svg" alt="Cost: $0.00">
  <img src="https://img.shields.io/badge/Compute-Cloudflare%20Edge%20%2B%20GCP%20e2--micro-orange.svg" alt="Compute">
  <img src="https://img.shields.io/badge/Model-Gemini%20Pro%20%2B%20Flash-purple.svg" alt="Models">
</p>

> **核心使命**：为高校学生打造的高内聚、零闲置、以协议原生 + 真实浏览器驱动的个人云端自治 Agent。深度覆盖 **超星学习通、智慧树、PTA（拼题 A）** 等平台。
> **双轨理念**：全面榨干 Google Gemini Pro 深度推理与 1M 超大长上下文能力；严格遵循 **草稿安全优先 (`pyFlag=1`)** 与 **“边缘牛群 + 常驻宠物”** 架构，日常无需开启本地电脑，全系统 **100% 永久免费 ($0.00/月)** 运行。

- **线上访问入口**：部署后即可通过 Cloudflare 分配的 `https://<您的 Worker 子域名>.workers.dev`（或您在 Cloudflare 绑定的个人自定义域名）进入深色磨砂玻璃全景 Web 控制面板。

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

系统在架构设计之初就严格贯彻 **“免费配额金字塔”** ，杜绝任何隐性扣费：

| 服务组件 | 官方永久免费配额 (Always Free) | 本项目实际月度预估消耗 | 额度占用率 | 费用 |
| :--- | :--- | :--- | :---: | :---: |
| **Cloudflare Workers** | **100,000 次请求 / 天** | 约 288 次/天（每 5 分钟定时巡检一次） | **< 0.3%** | **$0.00** |
| **Cloudflare D1 (SQLite)** | **5,000,000 次读/天 + 100,000 次写/天**<br>存储上限 5 GB | 读 < 3,000 次/天，写 < 100 次/天<br>真实数据占用 < 5 MB | **< 0.1%** | **$0.00** |
| **Cloudflare Durable Objects** | **1,000,000 次请求 / 月** (免费层支持 SQLite) | 巡检 + 审批唤醒约 10,000 次/月 | **~1.0%** | **$0.00** |
| **Cloudflare Workers KV** | 100,000 次读/天 + 1,000 次写/天 | 仅作为容灾 Cookie 缓存，< 50 次/天 | **< 5.0%** | **$0.00** |
| **Cloudflare R2 对象存储** | **10 GB 永久免费存储 + 1,000 万次读/月**<br>零出网流量费 ($0 Egress) | 浏览器快照与大文件备份 < 500 MB | **< 5.0%** | **$0.00** |
| **GCP `e2-micro` 常驻机** | **1 台非抢占式实例 / 月**（需选美区特定可用区）<br>30 GB 永久标准磁盘 + 1 GB 出网流量 | 1 台常驻运行 `afk-shim` 与 `agy` | **100% 免费** | **$0.00** |
| **GCP Cloud Run Jobs** | **360,000 vCPU-秒 + 180,000 GiB-秒 / 月**<br>200 万次请求 / 月 | 偶发高并发作业，每月约 1,200 vCPU-秒 | **< 0.4%** | **$0.00** |
| **Tier 2 临时 GCE 实例** | 按需 Spot 抢占计费（**月度硬顶 $10 美元**） | 强制 **15 分钟物理自毁**，即用即销毁 | 极度安全 | **<$1.00** |
| **LLM 求解 (Antigravity CLI / Gemini)** | 复用已有的 Google Antigravity / Gemini Pro 配额 | 经 `agy` 读题解答，零额外 API 计费 | — | **$0.00** |

> [!IMPORTANT]
> **算力成本硬顶与存储解耦准则**：
> 1. **GCP 预算硬顶**：每月最高预算限额 **$10 美元**（Always Free 常驻机 $0.00，偶发 Spot 任务单次消耗仅数美分）。
> 2. **GCE 即用即销毁，禁止长时间占用**：除常驻机外，所有临时机器必须在 15 分钟内自毁，任务结束立即触发销毁，严禁闲置与遗漏。
> 3. **计算与存储彻底解耦**：计算节点纯无状态，持久化快照与课件大文件统一同步至 **Cloudflare R2**（10GB 免费）或 **Google Drive**（支持 OAuth2 认证，不占云主机磁盘）。

> [!TIP]
> **GCP 避免扣费避坑指南**：
> Google Cloud 的 `e2-micro` 免费实例必须选择以下三个美国区域之一（**默认推荐美西俄勒冈**）：
> 1. **`us-west1` (美西俄勒冈 Oregon，默认推荐)**
> 2. **`us-central1` (爱荷华 Iowa)**
> 3. **`us-east1` (南卡罗来纳 South Carolina)**
> 并在创建磁盘时选择 **“标准永久磁盘 (Standard Persistent Disk)”** ，容量不超过 **30 GB** ，即可享受永久 0 元账单。

---

## 一、 核心架构：边缘牛群 (Cattle) 与常驻宠物 (Pet)

```
┌─ Cloudflare Edge（牛群：无黏性状态，高可用轻量托管）───────────────────────┐
│                                                                        │
│  边缘 Worker (https://<您的 Worker 域名或自定义域名>)                     │
│    ├─ SignAgent (DO)    24/7 秒级心跳巡检、全类型签到、作业红点探测          │
│    ├─ SolverAgent (DO)  任务排队、去重、记账、可选手机推送、审批门拦截     │
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
│    │    └─ Gemini Pro: 1M 课件上下文 RAG + 多模态图表解析 + 算法沙箱自愈  │
│    └─ 草稿安全暂存: 页面填写答案并暂存 (pyFlag=1)，绝不擅自越权正式提交     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **本地电脑是否可以关机？**
  - **完全可以！** 日常 24/7 常驻全部托管在 Cloudflare Edge；重型读题与浏览器答题托管在 GCP `e2-micro` 云主机。本地电脑无需开机。

---

## 二、 核心功能一览

### 1. 超星学习通（全自动 24/7 守护）
- **协议原生轻量拉取（Protocol-First）**：
  - 课程扫描、作业题目与选项抽取、课件资料下载（PPT/PDF/Word）与 RAG 文本构建、以及签到打卡 **100% 走原生轻量 HTTP 接口**（内存开销 < 30MB），秒级完成，日常完全无需启动沉重浏览器，极度节省云主机资源；仅当执行防作弊视频观看时才按需调用 Chromium。
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
  - **安全草稿暂存 (`pyFlag=1`)**：默认只存草稿，在 Web 看板一键人工复核提交（若选配推送通道亦会收到手机提醒）。

### 2. 智慧树 (知到) & PTA (拼题 A)
- **“知到”（智慧树）官方 Web 端与自动化看门狗**：
  - **完备的官方 Web 端支持**：许多人误以为“知到”仅有 App，实际上智慧树拥有官方 Web 学习端（`https://studyh5.zhihuishu.com/videoStudy.html`）。
  - **拒绝伪造 HTTP 进度包**：智慧树对播放心跳与行为时间差严格对账，伪造包极易触发审计封禁。
  - **挂载真实浏览器看门狗 (`ZHIHUISHU_INJECT_SCRIPT`)**：自动重写 `document.hidden` 与 `visibilityState` 阻止切屏失焦暂停；强制静音与 1.25x 安全合规倍速；自动识别并关闭视频中途弹窗测试题（`.popboxes_div`）；检测播放进度 $\ge 95\%$ 自动点击下一节。
- **Web Profile 本地持久化与 D1 备份**：Cookie 与 LocalStorage 跨机器无缝免登录同步。
- **PTA 算法题沙箱自愈**：本地沙箱编译与单测验证，若遭遇 WA/CE/TLE，由 Gemini Pro 自动反思修复并二次验证。

### 3. 多通道即时通知（完全可选增强项）
- **100% 可选 / 非必需**：系统所有签到、未交作业与解题流水都会实时记录在 Cloudflare D1 并在 Web 看板展示。即使不配置任何推送渠道，系统依然 24/7 完整运行。
- **支持渠道**：仅当您希望在手机通知栏接收即时弹窗时才需配置：
  - **Bark (iOS)**：苹果官方 APNs 秒级即时弹窗
  - **Server酱 / PushPlus**：微信模板消息推送
  - **群机器人**：飞书 / 钉钉 / 企业微信 Webhook

---

## 三、 极简实操：从 0 到 1 部署指南（仅需 CF 与 GCP 免费账号）

### 方案 A：纯边缘 0 服务器极简版（推荐，只需 Cloudflare，5 分钟完成）

> 适合只需要：**24/7 自动全类型签到、作业红点探测、以及随时随地查看全景 Web 监控看板**的同学。无需任何服务器！

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

用任意编辑器打开 `.env`，填入学习通账号：
```env
# 学习通账号与凭据（必须配置）
CHAOXING_PHONE=13800000000
CHAOXING_PASSWORD=您的登录密码
CHAOXING_REALNAME=您的姓名
```

> [!NOTE]
> **关于手机推送通知（100% 可选 / 非必须）**：
> 系统所有 24/7 签到流水与作业状态均实时落盘在 Cloudflare D1 并在 Web 看板展示，**无需任何推送 Key 即可完整运行**。
> 仅当您希望在手机通知栏接收即时弹窗（如“签到成功”、“作业草稿已生成待审核”）时，才需在 `.env` 中选填任一通道（如 iOS 的 `BARK_KEY` 或微信的 `SERVERCHAN_KEY` / `PUSHPLUS_TOKEN`），不需要直接留空即可。

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

> 在【方案 A】的基础上，通过一台 Google Cloud 永久免费的 `e2-micro` 云主机，让 Agent 具备真正的 Gemini 深度读题、草稿暂存与真实 Chromium 操作能力。

> [!TIP]
> **交给 Agent 全自动配置（推荐）**：
> 如果当前终端已登录 `gcloud`，你可以直接对 `agy` 说：`"帮我自动配置并初始化 GCP 免费云主机"`，`agy` 将自动调用 `.agents/skills/gcp-auto-provision` 完成建机与环境编排！

#### 第一步：在 Google Cloud 创建永久免费 `e2-micro` 云主机

**方式 1（一行命令全自动创建，首选推荐）**：
```bash
# 自动校验可用区与免费磁盘规格，幂等拉起 Always Free 实例
pnpm afk setup-vm
# 或直接执行: bash infra/gcp/provision-free-vm.sh
```

**方式 2（在 GCP 控制台手动创建）**：
1. 登录 [Google Cloud Console](https://console.cloud.google.com/) $\rightarrow$ **Compute Engine $\rightarrow$ 虚拟机实例 $\rightarrow$ 创建实例**：
   - **名称**：`afk-node`
   - **区域 (Region)**：推荐选择 **`us-west1` (美西俄勒冈，默认)**，亦可选 `us-central1` (爱荷华) 或 `us-east1` (南卡罗来纳)。
   - **机器类型**：选择 **`E2` 系列 $\rightarrow$ `e2-micro` (2 vCPU, 1 GB 内存)**。
   - **引导磁盘**：操作系统选择 **Ubuntu 22.04 LTS**，磁盘类型选择 **标准永久磁盘 (Standard Persistent Disk)**，大小设为 **30 GB**。
2. 点击 **创建**。

#### 第二步：云端机器一键环境编排（含 gcloud CLI、Node 20、Chromium 与守护进程）

在云端宿主机上也 **必须安装 `gcloud` CLI** ，以便常驻的 Agent 能自由调度 Cloud Run 与临时应急算力。

连接云主机并执行一行全自动初始化脚本：
```bash
# 通过 gcloud ssh 一键远程触发全自动初始化：
gcloud compute ssh afk-node --zone=us-west1-a --command="curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash"

# 或在 GCP 控制台打开网页 SSH 终端后直接粘贴运行：
curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash
```

> **该脚本自动完成的全部准备工作**：
> 1. 安装 Node.js 20 LTS 与 pnpm；
> 2. **自动安装 Google Cloud SDK (`gcloud` CLI)** 与认证工具环；
> 3. 安装真实无头 Chromium 浏览器与相关图形渲染底层依赖；
> 4. 安装 Cloudflare Tunnel 客户端 (`cloudflared`)；
> 5. 克隆/更新项目代码，执行依赖安装与冒烟自检测试；
> 6. 注册并启动 systemd `afk-shim.service` 守护进程（开机自启）。

#### 第三步：使用 Cloudflare Tunnel 打通边缘 Worker 与云主机

无需公网 IP，无需防火墙开放任何端口，通过 Cloudflare Tunnel 将 GCP 宿主机与 Cloudflare Edge 安全连通：

```bash
# 在云主机上启动穿透隧道（零配置快速开箱即用）：
cloudflared tunnel --url http://127.0.0.1:8788
```
*(终端将打印类似 `https://xxxx.trycloudflare.com` 的安全域名)*

在本地终端（或云主机）将 Tunnel 域名与通信密钥写入 Worker：
```bash
cd afk-cloud

# 注入隧道地址
npx wrangler secret put AFK_SHIM_URL
# 输入您的 Tunnel 地址，例如: https://xxxx.trycloudflare.com

# 注入通信密钥
npx wrangler secret put AFK_SHIM_TOKEN
# 输入云端 .env 中的 SHIM_TOKEN
```

> [!NOTE]
> **关于云端机器的 Cloudflare OAuth2 登录机制**：
> 若您在云端 Linux 主机上需要运行 `npx wrangler login`，因为服务器没有桌面浏览器，Wrangler 会自动在终端输出一条 OAuth2 授权链接（如 `https://dash.cloudflare.com/oauth2/auth?...`）。您只需在本地电脑浏览器打开该链接点击“授权”，即可无缝将登录凭证下发至云端机器！同理，若使用命名隧道 `cloudflared tunnel login`，也是通过终端给出的 OAuth2 链接在本地浏览器一键完成证书下载。

> [!TIP]
> **模型防烧 Quota 提示（强烈推荐切到 Gemini 3.8 Flash）**：
> 在 `.env` 中设置 `AFK_FLASH_MODEL=gemini-3.8-flash`（默认）。90% 的客观题批量求解、例行扫描均由 **Gemini 3.8 Flash** 处理，响应极速且配额消耗极低，避免短时间内过快烧干高价值的 Gemini Pro 额度。仅难题与代码沙箱才按需升级至 Gemini Pro。

**大功告成！** 全套闭环系统已就绪：
- 边缘 Worker 发现新作业后，自动通过加密隧道派发给 GCP 宿主机；
- GCP 上的 Agent 调用真实 Chromium 打开题目，利用 Gemini 3.8 Flash / Pro 分析解题，并在网页上暂存为草稿 (`pyFlag=1`)；
- 作业草稿安全暂存完毕，用户在 Web 看板一键核验并确认提交（若配置了手机通知亦会同步收到即时弹窗）。

---

## 四、 日常 CLI 指令速查表

在本地开发机或 GCP 终端中，可通过 `pnpm afk <command>` 便捷操控整个 Agent 系统：

| 指令 | 说明 |
| :--- | :--- |
| `pnpm afk status` | **全局自检**：检查 `.env` 配置、本地 Chromium、PTA/智慧树登录态及 Cloudflare Edge 连通状态 |
| `pnpm afk setup-cf` | **边缘一键编排**：自动开通 D1、执行迁移、加密密钥并部署 Worker |
| `pnpm afk setup-vm` | **GCP 主机拉起**：自动在美区一键拉起 Always Free 永久免费 `e2-micro` 云主机 |
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
5. **Cloudflare 资源销毁安全防线**：允许拉起、创建与销毁 Cloudflare 资源，但 **仅允许销毁自己创建的资源（名称以 `afk-` 或 `afk-cloud-` 开头）** 。严禁误删、清空或篡改用户账户内未受管的其他生产 D1、KV、Worker 或 DNS 解析记录！

---

## 六、 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。仅供学习与自动化运维技术研究使用，请自觉遵守所在高校的学风与考试纪律。
