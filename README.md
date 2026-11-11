# `afk-cloud` — 个人云端自治 Agent（Personal Autonomous Agent）

<p align="center">
  <img src="./dashboard-real-preview.png" alt="afk-cloud Dashboard" width="780" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);" />
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Agent-Google%20Cloud%20%2B%20gcloud%20%2B%20agy-blue.svg" alt="Agent: GCP + gcloud + agy">
  <img src="https://img.shields.io/badge/Architecture-Core%20%2B%20Pluggable%20Skills-indigo.svg" alt="Plugins">
  <img src="https://img.shields.io/badge/Monthly%20Cost-%240.00%20(Always%20Free)-success.svg" alt="Cost: $0.00">
  <img src="https://img.shields.io/badge/AI%20Funnel-Gemini%20Pro%20Maximized-purple.svg" alt="Gemini Pro Maximized">
  <img src="https://img.shields.io/badge/Edge%20Portal-Optional%20Cloudflare%20Web-orange.svg" alt="Optional Edge">
</p>

> **核心设计哲学**：
> 这是一个纯粹专属于个人的 **Personal Autonomous Agent**。
> 架构极其精简自足：**只需要 Google Cloud + `gcloud` + `agy`**！
> 
> 1. **核心大脑与极简基础设施**：以 Google Cloud 永久免费的 **`e2-micro` 常驻机（24/7 永不关机，0 元月租）** 作为个人智能体宿主，运行 **Antigravity CLI Agent (`agy`)** ，借助原生 **`gcloud` CLI** 按需调度 Cloud Run 免费弹性算力；
> 2. **高校平台全面插件化（Plugins / Skills）**：核心 Agent 纯净解耦、零平台硬编码。**超星学习通、智慧树（知到）、拼题 A（PTA）** 全部做成标准化插拔式插件 / 技能，按需选装、独立迭代；
> 3. **Google AI Pro 账号效益最大化**：构建“零 Token 缓存 $\rightarrow$ Gemini 3.8 Flash 批量客观题（防烧 Quota） $\rightarrow$ Gemini Pro 榨干 1M Context 与顶级多模态空间推理/自愈”的三级智能漏斗；
> 4. **长时占用优先免费算力（100% 永久免费 $0.00/月）**：长时视频观看与保活由常驻 `e2-micro`（宠物窝）承载；批量课件 RAG 由 Cloud Run Jobs 免费层（每月 100 小时 1 vCPU）弹性运行；短时临时机配备 60 分钟兜底物理自毁熔断；
> 5. **可选轻量边缘看板**：Cloudflare Workers + D1 仅作为可选的轻量移动端 Web 遥控器与通知看板，不承载沉重推理与浏览器。

---

## 目录
- [一、 极简架构：只要 Google Cloud + gcloud + agy](#一-极简架构只要-google-cloud--gcloud--agy)
- [二、 认知引擎：Google AI Pro 效益最大化三级漏斗](#二-认知引擎google-ai-pro-效益最大化三级漏斗)
- [三、 选装平台插件生态一览（Plugins / Skills）](#三-选装平台插件生态一览plugins--skills)
- [四、 算力梯队：为什么能 100% 永久免费（$0.00/月）](#四-算力梯队为什么能-100-永久免费000月)
- [五、 作业草稿与状态生命周期闭环（关于“做完暂存”）](#五-作业草稿与状态生命周期闭环关于做完暂存)
- [六、 极简实操：从 0 到 1 部署指南](#六-极简实操从-0-到-1-部署指南)
- [七、 常用 CLI 指令速查表](#七-常用-cli-指令速查表)
- [八、 安全规范与学术合规铁律](#八-安全规范与学术合规铁律)
- [九、 开源许可证](#九-开源许可证)

---

## 一、 极简架构：只要 Google Cloud + gcloud + agy

本系统彻底摒弃复杂冗长的第三方依赖，基础设施核心完全由 **Google Cloud + `gcloud` + `agy`** 闭环：

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                   Personal Autonomous Agent (个人云端自治核心)                   │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  【宿主大脑载体】                                                             │
│    • Google Cloud Always Free e2-micro 实例 (美区 us-west1-a，24/7 常驻 $0/月)  │
│    • Antigravity CLI (agy) 个人智能体运行时                                   │
│    • 真机 Chromium CDP (localhost:9222，真机渲染杜绝反作弊风控)               │
│    • Linux 沙箱评测环境 (gcc/g++/python3/node 单元测试与自愈)                 │
│                                                                               │
│  【gcloud 原生工具链与弹性算力调度】                                          │
│    • gcloud compute: 实例运维与短时临时 Spot GCE 调度 (60分钟物理自毁兜底熔断)│
│    • gcloud run jobs: 批量课件材料 RAG 向量化 (每月 100 小时免费 vCPU 算力)    │
│                                                                               │
│  【Google AI Pro 账号效益最大化三级漏斗】                                     │
│    • Level 0: 本地 SQLite / D1 题库 SHA-256 毫秒级命中 (0 Token 消耗)         │
│    • Level 1: Gemini 3.8 Flash 批量整卷客观题并发输出 (防烧 Pro 配额护盾)      │
│    • Level 2: Gemini Pro 榨干 1M Context 全量教材 RAG / 多模态看图 / 算法自愈   │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                     选装平台插件体系 (Platform Plugins / Skills)              │
├───────────────────────────────────────────────────────────────────────────────┤
│    ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐        │
│    │  plugin-chaoxing  │  │ plugin-zhihuishu  │  │    plugin-pta     │  ...   │
│    │   (超星学习通)    │  │   (智慧树知到)    │  │     (拼题 A)      │        │
│    └───────────────────┘  └───────────────────┘  └───────────────────┘        │
│    • 核心 Agent 零业务硬编码，高校教学与评测平台全部实现 PlatformPlugin 标准契约│
│    • 按需选装、热插拔挂载、独立迭代                                            │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                     可选轻量边缘控制面 (Cloudflare Workers + D1)              │
│    • 仅作为个人移动端 Web 全景看板、审批门 (D7 准则) 与多通道通知外延 (可选项)  │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 认知引擎：Google AI Pro 效益最大化三级漏斗

开发者拥有的 **Google AI (Gemini) Pro 账号/API 配额** 极具价值。如果盲目拿昂贵的 Pro 逐题串行调用简单单选，不仅极其低效，更会在极短时间内将每分钟 RPM/TPM 配额烧干，甚至导致关键大题无法作答。

系统严格贯彻 **三级智能漏斗（Tiered Intelligence Funnel）** ，实现 **“小题零损耗，大题榨干极限”** ：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Level 0: 零 Token 题库缓存层 (SHA-256 毫秒命中)        │
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
│     彻底摆脱传统向量粗暴切块的语义丢失与幻觉，精准索引老师讲义独门考点  │
│   • 多模态空间/图表推理: 电路图、空间几何、函数曲线原图直送视觉通道     │
│   • PTA 算法编程沙箱自愈: 本地 Linux 编译单测，WA/TLE/CE 闭环反思自愈   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 三、 选装平台插件生态一览（Plugins / Skills）

核心宿主不包含任何特定平台的私有逻辑，所有高校平台抽象为插拔式插件，统一遵循 `PlatformPlugin` 契约（[`packages/core/plugin.ts`](./packages/core/plugin.ts)）：

### 1. 插件标准化契约接口
```typescript
export interface PlatformPlugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void>;
  authenticate(): Promise<boolean>;
  scanCourses?(): Promise<CourseInfo[]>;
  scanTasks?(course?: CourseInfo): Promise<HomeworkSummary[]>;
  downloadMaterials?(course: CourseInfo): Promise<MaterialItem[]>;
  solveTask?(task: HomeworkSummary, autoSubmit?: boolean, options?: SolveOptions): Promise<SolveResult>;
  queryTaskStatus?(task: HomeworkSummary): Promise<'pending' | 'draft_saved' | 'submitted' | 'unknown'>;
  inspectAndSign?(): Promise<{ executed: string[] }>;
}
```

### 2. 核心选装插件矩阵
| 插件标识 | 适配平台 | 核心能力与防封策略 | 驱动技术栈 |
| :--- | :--- | :--- | :--- |
| **`plugin-chaoxing`** | 超星学习通 | • 协议原生轻量 HTTP（内存 < 30MB）<br>• 全类型签到秒杀（位置多坐标轮询、拍照自动获取 1x1 透明底图 `objectId`、手势、签到码、二维码）<br>• 课程 PPT/PDF 课件材料批量下载提取<br>• 双轨模型作业解答，默认以 **安全草稿先行暂存（`pyFlag=1`）**<br>• 作业真实状态反查（`getAllWork`），准确获取“已做完暂存”与“已交”状态 | 纯协议 HTTP + DES ECB PKCS7 |
| **`plugin-zhihuishu`** | 智慧树 (知到) | • 官方 Web 学习端真机操作（`studyh5.zhihuishu.com`）<br>• 重写 `document.hidden` 与 `visibilityState` 绕过切屏失焦风控<br>• 视频中途弹窗测验自动捕获并作答<br>• 1.25x 安全合规倍速与章节自动连播 | 本地真机 Chromium CDP (`localhost:9222`) |
| **`plugin-pta`** | 拼题 A (PTA) | • 编程题与判题限制（时间/内存）提取<br>• 本地 Linux 沙箱编译与单测执行（`gcc`/`g++`/`python3`/`node`）<br>• Gemini Pro WA/TLE/CE 错误自主反思迭代，直到全绿 AC | Chromium Profile 免登 + 本地沙箱 |
| **`plugin-*`** | 任意扩展平台 | 支持极速接入 Canvas、雨课堂、中国大学 MOOC 等，核心宿主零修改 | 标准插件契约 |

---

## 四、 算力梯队：为什么能 100% 永久免费（$0.00/月）

针对日常长时占用资源（视频观看挂机、课件深度向量化等）的场景，**严禁租用昂贵算力空耗！**

| 算力等级 | 适用任务场景 | 采用的基础设施与免费额度 | 月度费用 |
| :--- | :--- | :--- | :---: |
| **Tier 1<br>长时挂机首选** | **长时占用场景首选（宠物窝）**：智慧树长时视频看门狗、学习通保活、本地真机 Chromium 渲染、`agy` 核心常驻调度 | **Google Cloud Always Free `e2-micro` 常驻机**<br>（1 台 24/7 永不关机，30GB 标准磁盘，0 元月租） | **$0.00** |
| **Tier 1<br>弹性算力扩展** | **批量重型算力**：大批量课件材料 RAG 向量化、突发并发题目推理（单次支持连续运行长达 60 分钟） | **Google Cloud Run Jobs 免费层**<br>（每月 **360,000 vCPU-秒** $\approx$ **100 小时 1 vCPU** 免费算力，跑完毫秒级关机，0 闲置费） | **$0.00** |
| **Tier 2<br>极端应急算力** | 极端大并发、超大内存或独占硬件时的短时爆发应急 | **gcloud 临时 Spot GCE 实例**<br>• 完工通过 bash `trap cleanup EXIT` **立即提前销毁并释放**<br>• 默认放宽至 **60 分钟物理自毁兜底熔断**（防死锁挂机）<br>• 每月预算硬顶 $10 美元红线 | **<$1.00** |
| **Tier 0<br>(可选) 边缘控制** | 24/7 心跳巡检、全类型签到秒级捕获、新作业红点探测、Web 看板呈现 | **Cloudflare Workers 免费层**（10万次/天）<br>**Cloudflare D1**（500万次读+10万次写/天） | **$0.00** |

---

## 五、 作业草稿与状态生命周期闭环（关于“做完暂存”）

很多同学关心的 **“做完暂存 (`draft_saved`)”** 状态是如何流转的？

1. **状态流转机制（Agent 异步闭环驱动）**：
   - 超星平台的通知流（`getNoticeList`）和红点（`workTestPendingNew`）只报告“有新作业”，**不会主动推送平台内具体作答进度**；
   - 新作业被发现后初始登记为 `pending`（未派发）；
   - 用户点击或系统调度派发后进入 `dispatched`（已派发给 agy 求解器）；
   - **当云端 `agy` 运行器调用模型推理完成，以安全草稿（`pyFlag=1`）写入超星平台后**，向边缘发起 `/api/agent/callback` 回调，状态自动翻转为 **`🛡️ 做完暂存 · 待审批`**；
   - 用户在看板点击【✅ 审批提交】，正式完成向平台提交。
2. **主动反查超星真实状态**：
   - 超星插件支持通过 `getCourseHomeworkList`（抓取 `getAllWork` 页面）解析网页上的 `作业状态：([^\s]+)`；
   - 若检测到用户此前已经在超星上暂存过草稿（状态为“暂存”），插件可直接反向同步回控制台，准确呈现为“已做完暂存”。

---

## 六、 极简实操：从 0 到 1 部署指南

### 推荐方案：Google Cloud + gcloud + agy 极简 3 步跑起来

#### 第一步：在 Google Cloud 创建永久免费 `e2-micro` 常驻机（宠物窝）
```bash
# 区域选择美区 us-west1，机型 e2-micro，标准持久磁盘 30 GB，享受永久 0 元月租：
gcloud compute instances create afk-node \
  --zone=us-west1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB
```

#### 第二步：SSH 登录并安装环境
```bash
# 登录主机
gcloud compute ssh afk-node --zone=us-west1-a

# 克隆代码库并安装依赖
git clone https://github.com/fgh23333/afk-cloud.git
cd afk-cloud && pnpm install

# 复制环境变量模板并填入 Gemini Pro API Key 和学习通账号
cp .env.example .env
nano .env
```

#### 第三步：直接由 agy 驱动自动化全流程
```bash
# 1. 扫描当前在读课程与待办作业
pnpm afk scan

# 2. 批量下载课程全量课件资料用于 Gemini Pro 1M 上下文 RAG
pnpm afk materials

# 3. 驱动双轨模型作答（Flash 解客观题 + Pro 解主观题，安全草稿暂存 pyFlag=1）
pnpm afk solve

# 4. 执行日常全类型自动签到打卡
pnpm afk signin
```

---

### (可选增强)：开启 Cloudflare 边缘全景看板与手机通知

如果您希望在手机上随时随地查看全景暗黑磨砂 Web 看板，只需执行一行命令一键编排边缘层：

```bash
# 本地终端登录 Cloudflare 并一键编排
npx wrangler login
pnpm afk setup-cf
```
终端将自动输出专属看板网址（如 `https://afk.<your-domain>.com`），支持暗黑 Glassmorphic UI、作业一键审批门、考试过期动态实时对账与全自动秒签。

---

## 七、 常用 CLI 指令速查表

| 指令 | 说明 |
| :--- | :--- |
| `pnpm afk status` | **全局自检**：检查 `.env` 配置、Chromium、登录态及平台连接状态 |
| `pnpm afk scan` | **课程与作业扫描**：列出全部在读课程、未交作业详情与截止时间 |
| `pnpm afk solve` | **双轨作业求解（草稿先行）**：题库缓存 $\rightarrow$ Flash 批量小题 $\rightarrow$ Pro 深度大题，安全暂存草稿 |
| `pnpm afk solve --auto-submit` | **作业求解（正式提交）**：作答完毕后直接正式提交 (`pyFlag=3`) |
| `pnpm afk signin` | **秒级全类型签到**：执行位置虚拟打卡、拍照透明图上传打卡、手势与二维码签到 |
| `pnpm afk materials` | **课件材料下载**：下载课程全部 PPT/PDF/Word 文件，供 Gemini Pro 构建 1M 上下文 RAG |
| `pnpm afk plugins` | **插件生态一览**：列出当前已注册与挂载的全部平台插件与能力清单 |
| `pnpm afk burst --mode cloud-run` | **调用 Cloud Run 免费算力**：单次任务消耗每月 100 小时免费容器算力 |
| `pnpm afk burst --mode gce --ttl 60` | **拉起临时 GCE 算力**：默认 60 分钟兜底物理自毁熔断，完工立即释放 |
| `pnpm afk setup-vm` | **GCP 主机拉起**：自动在美区一键拉起 Always Free 永久免费 `e2-micro` 云主机 |
| `pnpm afk setup-cf` | **(可选) 边缘看板编排**：一键开通 D1 数据库、执行迁移并部署 Cloudflare Edge Worker |

---

## 八、 安全规范与学术合规铁律

1. **绝对零凭据入库**：代码库与 Git 提交历史中严禁出现真实手机号、明文密码、个人姓名或学号。所有敏感信息严格经由 `.env` 或 `wrangler secret` 加密注入。
2. **安全草稿优先 (`pyFlag=1`)**：默认模式下，AI 解题结果一律作为草稿暂存，杜绝越权错交与答题失误风险；正式提交必须通过看板由人工审批确认。
3. **真实浏览器防风控**：坚决摒弃伪造心跳包与爬虫逆向黑产做法，基于真实无头浏览器模拟人工阅读交互，尊重教学平台风控规范。
4. **统一时区标准**：全系统日志、数据库时间戳与作答报告统一使用 **UTC+8 (`Asia/Shanghai`)** 记录。
5. **Cloudflare 资源销毁安全防线**：允许拉起、创建与销毁 Cloudflare 资源，但 **仅允许销毁自己创建的资源（名称以 `afk-` 或 `afk-cloud-` 开头）** 。严禁误删、清空或篡改用户账户内未受管的其他生产 D1、KV、Worker 或 DNS 解析记录！

---

## 九、 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。仅供自动化运维、Agent 编排与个人效能工具技术交流使用，请自觉遵守所在高校的学风与考试纪律。
