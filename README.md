# `afk-cloud` — 个人云端自治 Agent（Personal Autonomous Agent）

<p align="center">
  <img src="./dashboard-real-preview.png" alt="afk-cloud Dashboard" width="780" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);" />
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Agent-Antigravity%20(agy)%20on%20GCP-blue.svg" alt="Agent">
  <img src="https://img.shields.io/badge/Architecture-Core%20%2B%20Decoupled%20Plugins-indigo.svg" alt="Plugins">
  <img src="https://img.shields.io/badge/Monthly%20Cost-%240.00%20(Always%20Free)-success.svg" alt="Cost: $0.00">
  <img src="https://img.shields.io/badge/Model%20Efficiency-Gemini%20Pro%20Maximized-purple.svg" alt="Gemini Pro Maximized">
  <img src="https://img.shields.io/badge/Edge%20Portal-Cloudflare%20Workers-orange.svg" alt="Edge">
</p>

> **核心定位**：专为个人打造的高内聚、自进化、以协议原生 + 真实浏览器驱动的 **个人云端自治智能体（Personal Autonomous Agent）** 。
> 
> **三大核心设计思想**：
> 1. **Personal Agent 核心与平台解耦**：核心宿主仅在 Google Cloud 上运行统一的 **Antigravity CLI Agent (`agy`)** ，超星学习通、智慧树（知到）、PTA（拼题 A）等高校教学评测平台**全部解耦为可插拔插件（Plugins / Skills）**，按需选装、独立迭代。
> 2. **Google AI Pro 账号效益最大化**：构建“零 Token 缓存 $\rightarrow$ Gemini 3.8 Flash 批量客观题（防烧 Quota） $\rightarrow$ Gemini Pro 榨干 1M Context 与顶级视觉推理与自愈”的三级智能漏斗，最大化发挥 Pro 认知红利。
> 3. **长时占用深度倾斜免费算力（100% 永久免费 $0.00/月）**：杜绝付费算力空耗！长时挂机与看门狗由 **GCP Always Free `e2-micro`（宠物窝）** 24/7 常驻承载；中长时重型任务由 **Cloud Run Jobs 免费层（每月 100 小时 vCPU）** 弹性调度；极端临时机自毁时限放宽至 60 分钟且完工即删。

- **个人 Web 控制台**：通过 Cloudflare 边缘分配的域名或用户绑定的个人自定义域名（如 `https://afk.<your-domain>.com`）随时随地查看全局状态与一键审批。

---

## 目录
- [一、 核心哲学：Google AI Pro 账号效益最大化](#一-核心哲学google-ai-pro-账号效益最大化)
- [二、 架构设计：Personal Agent 宿主 + 选装平台插件体系](#二-架构设计personal-agent-宿主--选装平台插件体系)
- [三、 算力梯队：长时占用与免费算力优先（为什么 100% 免费 $0.00/月）](#三-算力梯队长时占用与免费算力优先为什么-100-免费-000月)
- [四、 选装插件生态一览（Plugins / Skills）](#四-选装插件生态一览plugins--skills)
- [五、 极简实操：从 0 到 1 部署指南](#五-极简实操从-0-到-1-部署指南)
- [六、 日常 CLI 指令速查表](#六-日常-cli-指令速查表)
- [七、 安全与学术合规铁律](#七-安全与学术合规铁律)
- [八、 开源许可证](#八-开源许可证)

---

## 一、 核心哲学：Google AI Pro 账号效益最大化

高校学生与开发者拥有的 **Google AI (Gemini) Pro 账号/API 配额** 极具价值。如果拿昂贵的 Pro 逐题串行求解“1+1=2”或简单单选，不仅极其低效，更会在极短时间内将高价值的每分钟 RPM/TPM 配额烧干，甚至导致复杂大题无配额可用。

为此，系统严格贯彻 **三级智能漏斗（Tiered Intelligence Funnel）** ，实现 **“小题不费配额，大题榨干极限”** ：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Level 0: 零 Token 题库缓存层 (D1 SHA-256)             │
│   • sha256(题干 + 规范化选项) 毫秒级查库                                 │
│   • 历年真题/已答题目命中即返，0 Token 消耗，0 Quota 占用               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 未命中
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Level 1: Gemini 3.8 Flash 极速批处理 (Pro 配额护盾)          │
│   • 针对单选、多选、判断题与例行扫描，严禁逐题串行调用！                  │
│   • 整卷客观题打包为单次 JSON Batch Prompt，由 Flash 秒级并发返回       │
│   • 极低消耗，响应极速，为核心大题构筑坚不可摧的配额防护盾               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 主观题 / 复杂大题 / 编程题
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Level 2: Gemini Pro 顶级认知爆发 (榨干 1M Context 效益)      │
│   • 1M+ Token 课件原汁原味 RAG: 全学期 20~50 份 PPT/PDF 教材全文注入， │
│     彻底摆脱传统向量粗暴切块的语义丢失与幻觉，精准索引老师讲义原话      │
│   • 多模态空间/图表推理: 电路图、空间几何、函数曲线原图直送视觉通道     │
│   • PTA 算法编程沙箱自愈: 本地 Linux 编译单测，WA/TLE/CE 闭环反思自愈   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 架构设计：Personal Agent 宿主 + 选装平台插件体系

系统采用彻底解耦的 **“微内核 + 插件（Microkernel + Plugins）”** 架构：

```
┌───────────────────────────────────────────────────────────────────────────┐
│              Cloudflare Edge (轻量无服务器控制面 & Web 看板)                │
│   • D1 数据库 (课程表/题库缓存/待办队列)                                    │
│   • 24/7 事件心跳捕获、手机多通道通知 (可选)、作业一键审批门 (D7 准则)     │
└─────────────────────────────────────▲─────────────────────────────────────┘
                                      │ Cloudflare Tunnel (安全内网穿透)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│     Google Cloud 常驻宿主机 (Personal Agent: Antigravity CLI 'agy')        │
│                                                                           │
│  [宿主内核与运行环境]                                                       │
│    • afk-shim 守护进程 (串行排队锁 / Bearer 鉴权)                           │
│    • 真实 Chromium 实例 (CDP localhost:9222，真机渲染防风控)               │
│    • Linux 本地编译运行沙箱 (C/C++/Python/Node 单元测试与自愈)             │
│                                                                           │
│  [选装插件库 (Platform Plugins / Skills)]                                 │
│    ├─ plugin-chaoxing  (超星学习通：DES登录/多类型签到/课件RAG/草稿暂存)    │
│    ├─ plugin-zhihuishu (智慧树知到：官方Web学习端看门狗/防切屏/弹窗答题)  │
│    ├─ plugin-pta       (拼题A：题目抓取/本地沙箱测试/Gemini Pro 自愈重构)  │
│    └─ plugin-*         (未来可极速插拔扩展 Canvas、Blackboard 等平台)      │
└───────────────────────────────────────────────────────────────────────────┘
```

- **统一插件契约规范**：每个教学平台统一实现 [`packages/core/plugin.ts`](./packages/core/plugin.ts) 的 `PlatformPlugin` 契约，暴露 `detectTasks`、`solveTask`、`syncMaterials` 与 `submitDraft` 标准生命周期。
- **按需选装**：这学期只学超星课程，就只加载 `plugin-chaoxing`；下学期有算法课，就随时开启 `plugin-pta`，核心 Agent 保持终身轻量、干净、稳定。

---

## 三、 算力梯队：长时占用与免费算力优先（为什么 100% 免费 $0.00/月）

针对日常长时挂机、视频观看进度保活与课件分析等**长时占用资源的场景，严禁租用昂贵算力空耗！**

系统采用分层算力调度，将 **免费配额榨取到极致**：

| 算力等级 | 适用场景与任务类型 | 采用的基础设施与配额 | 月度开销 |
| :--- | :--- | :--- | :---: |
| **Tier 0<br>边缘常驻** | 24/7 心跳巡检、全类型签到秒级捕获、新作业红点探测、SHA-256 零 Token 查库、Web 看板呈现 | **Cloudflare Workers 免费层**（10万次/天）<br>**Cloudflare D1**（500万次读+10万次写/天） | **$0.00** |
| **Tier 1<br>长时挂机首选** | **长时占用场景首选（宠物窝）**：智慧树长时视频看门狗、学习通章节进度保活、本地 Chromium 渲染、`agy` 核心调度 | **Google Cloud Always Free `e2-micro` 常驻机**<br>（1 台 24/7 永不关机，30GB 标准磁盘，0 元月租） | **$0.00** |
| **Tier 1<br>中长时弹性算力** | **批量重型算力**：大批量课件材料下载与 RAG 向量化、突发并发题目推理（单次支持连续运行长达 60 分钟） | **Google Cloud Run Jobs 免费层**<br>（每月 **360,000 vCPU-秒** $\approx$ **100 小时 1 vCPU** 免费算力，跑完毫秒级关机，0 闲置费） | **$0.00** |
| **Tier 2<br>极端应急算力** | 极端大并发、超大内存或独占硬件时的短时爆发应急 | **gcloud 临时 Spot GCE 实例**<br>• 完工通过 bash `trap cleanup EXIT` **立即提前销毁并释放**<br>• 默认放宽至 **60 分钟物理自毁兜底熔断**（防死锁悬挂）<br>• 每月预算硬顶 $10 美元红线 | **<$1.00** |
| **数据持久层** | 课件大文件、浏览器登录 Profile 快照、执行快照外置备份 | **Cloudflare R2**（每月 10GB 免费存储，0 出网费）<br>**Google Drive**（OAuth2 认证免存储费） | **$0.00** |

---

## 四、 选装插件生态一览（Plugins / Skills）

### 1. `plugin-chaoxing`（超星学习通全能插件）
- **协议原生轻量（Protocol-First）**：作业扫描、题目抽取、课件资料下载（PPT/PDF/Word）与签到打卡 **100% 走原生轻量 HTTP**（内存占用 < 30MB），秒级完成，日常完全无需启动沉重浏览器。
- **全类型秒级签到**：
  - 普通签到 / 签到码：自动捕获并秒级响应。
  - 拍照签到：自动上传 1×1 极简透明底图，获取真实 `objectId` 后完成提交。
  - 手势签到：自动识别手势特征并生成轨迹提交。
  - 位置 / 定位签到：支持配置精准经纬度与学校地址进行虚拟打卡。
  - 二维码签到：支持解析 `enc` 签名完成秒级验证。
- **安全草稿先行 (`pyFlag=1`)**：AI 解题结果默认只存为草稿，在 Web 看板一键人工复核提交（若选配推送通道亦会收到手机提醒）。
- **智能免 403 作答直达**：在看板点击【🔗 打开作答界面】，自动经由官方通知卡片通道进入，带齐 Session 与签名，彻底杜绝 403 跨站防盗链阻断。

### 2. `plugin-zhihuishu`（智慧树知到官方 Web 端插件）
- **官方 Web 端真机操作**：基于智慧树官方 Web 学习端（`https://studyh5.zhihuishu.com/videoStudy.html`）。
- **拒绝伪造 HTTP 进度包**：智慧树对播放心跳与行为时间差严格对账，伪造发包极易被封号。
- **真实浏览器看门狗注入**：自动重写 `document.hidden` 与 `visibilityState` 阻止切屏失焦暂停；强制静音与 1.25x 安全合规倍速；自动识别并关闭视频中途弹窗测试题；检测播放进度 $\ge 95\%$ 自动点击下一节。

### 3. `plugin-pta`（拼题 A 算法与编程题插件）
- **题目抓取与代码沙箱化**：自动提取编程题输入输出样例与判题限制（内存/时间）。
- **Gemini Pro 自愈闭环**：在本地 Linux 沙箱（`gcc`/`g++`/`python3`/`node`）编译运行单测；遭遇 WA/TLE/CE 时，由 Gemini Pro 自主反思并修复代码，迭代直到全绿。

---

## 五、 极简实操：从 0 到 1 部署指南

### 方案 A：纯边缘 0 服务器极简版（只需 Cloudflare，5 分钟完成）

> 适合只需要：**24/7 自动全类型签到、作业红点探测、以及随时随地查看全景 Web 监控看板**的同学。无需任何服务器！

```bash
# 1. 克隆代码库
git clone https://github.com/fgh23333/afk-cloud.git
cd afk-cloud
pnpm install

# 2. 登录 Cloudflare（自动拉起浏览器授权）
npx wrangler login

# 3. 复制环境变量模板并填写账号
cp .env.example .env
# 编辑 .env 填入超星账号密码

# 4. 执行一键自动化边缘编排
pnpm afk setup-cf
```

部署完成后终端将输出访问网址：`https://afk.<您的CF自定义域或workers.dev>`，打开即可使用！

---

### 方案 B：Personal Agent 云端闭环版（Cloudflare 边缘 + Google Cloud 常驻机）

> 推荐方案：让 Agent 具备真正的 **Gemini Pro 深度读题、草稿暂存与真实 Chromium 操作能力**。

#### 第一步：在 Google Cloud 创建永久免费 `e2-micro` 常驻机（宠物窝）

```bash
# 方式 1：通过 CLI 一行命令全自动幂等创建（首选推荐）
pnpm afk setup-vm
# 或直接运行: bash infra/gcp/provision-free-vm.sh
```

*(亦可在 GCP 控制台手动创建：区域选择 `us-west1`，机型 `e2-micro`，标准持久磁盘 30 GB，享受永久 0 元月租)*。

#### 第二步：云端宿主机一键环境编排

```bash
# 通过 gcloud ssh 一键远程触发全自动初始化：
gcloud compute ssh afk-node --zone=us-west1-a --command="curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash"
```

> **该脚本自动完成全部准备工作**：安装 Node 20 LTS、pnpm、`gcloud` CLI 工具链、无头 Chromium、Cloudflare Tunnel 客户端，并配置 `afk-shim.service` 开机自启。

#### 第三步：建立 Cloudflare Tunnel 双向加密穿透

```bash
# 在云主机上启动免开放端口的安全隧道：
cloudflared tunnel --url http://127.0.0.1:8788

# 在本地终端将隧道地址写入边缘 Worker：
npx wrangler secret put AFK_SHIM_URL
# 输入您的隧道地址，例如: https://xxxx.trycloudflare.com
```

**全套闭环就绪！**
- 边缘 Worker 发现新作业后，通过加密隧道派发给 GCP 宿主机上的 `agy`；
- `agy` 按三级智能漏斗优先查库 $\rightarrow$ Flash 批量解客观题 $\rightarrow$ Pro 深度推理大题，并在平台上安全暂存为草稿 (`pyFlag=1`)；
- 用户在 Web 看板一键核验并点击提交。

---

## 六、 日常 CLI 指令速查表

在本地开发机或 GCP 终端中，可通过 `pnpm afk <command>` 便捷操控整个 Agent 系统：

| 指令 | 说明 |
| :--- | :--- |
| `pnpm afk status` | **全局自检**：检查 `.env` 配置、本地 Chromium、PTA/智慧树登录态及 Cloudflare Edge 连通状态 |
| `pnpm afk setup-cf` | **边缘一键编排**：自动开通 D1、执行迁移、加密密钥并部署 Worker |
| `pnpm afk setup-vm` | **GCP 主机拉起**：自动在美区一键拉起 Always Free 永久免费 `e2-micro` 云主机 |
| `pnpm afk setup-all` | **双端编排**：一键完成 Cloudflare Edge 与 GCP Cloud Run / IAM 安全配置 |
| `pnpm afk scan` | **课程与作业扫描**：列出全部在读课程、未交作业详情、截止时间与课件统计 |
| `pnpm afk materials` | **课件材料下载**：下载课程全部 PPT/PDF/Word 文件，供 Gemini Pro 构建 1M 上下文 RAG |
| `pnpm afk solve` | **双轨作业求解（草稿先行）**：优先题库缓存 $\rightarrow$ Flash 批量客观题 $\rightarrow$ Pro 主观题，暂存草稿并出具报告 |
| `pnpm afk solve --auto-submit` | **作业求解（正式提交）**：作答完毕后直接正式提交 (`pyFlag=3`) |
| `pnpm afk burst --mode cloud-run` | **调用 Cloud Run 免费算力**：单次任务消耗每月 100 小时免费容器配额 |
| `pnpm afk burst --mode gce --ttl 60` | **拉起临时 GCE 算力**：默认 60 分钟兜底熔断，任务执行完立即自毁释放 |
| `pnpm afk digest` | **即时简报**：手动触发 Cloudflare Edge 推送全平台任务与签到完成状态摘要 |
| `pnpm shim` | **启动宿主机 Shim 守护**：提供带 Bearer 鉴权与单进程排队锁的 HTTP 控制平面 |

---

## 七、 安全与学术合规铁律

1. **绝对零凭据入库**：代码库与 Git 提交历史中严禁出现真实手机号、明文密码、个人姓名或学号。所有敏感信息严格经由 `.env` 或 `wrangler secret` 加密注入。
2. **安全草稿优先 (`pyFlag=1`)**：默认模式下，AI 解题结果一律作为草稿暂存，杜绝越权错交与答题失误风险；正式提交必须通过看板由人工审批确认。
3. **真实浏览器防风控**：坚决摒弃伪造心跳包与爬虫逆向黑产做法，基于真实无头浏览器模拟人工阅读交互，尊重教学平台风控规范。
4. **统一时区标准**：全系统日志、数据库时间戳与作答报告统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。
5. **Cloudflare 资源销毁安全防线**：允许拉起、创建与销毁 Cloudflare 资源，但 **仅允许销毁自己创建的资源（名称以 `afk-` 或 `afk-cloud-` 开头）** 。严禁误删、清空或篡改用户账户内未受管的其他生产 D1、KV、Worker 或 DNS 解析记录！

---

## 八、 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。仅供学习与自动化运维技术研究使用，请自觉遵守所在高校的学风与考试纪律。
