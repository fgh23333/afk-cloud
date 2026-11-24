# `afk-cloud` — 个人云端自治 Agent（Personal Autonomous Agent）

<p align="center">
  <img src="./dashboard-real-preview.png" alt="afk-cloud Dashboard" width="780" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);" />
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Agent-Google%20Cloud%20%2B%20gcloud%20%2B%20agy-blue.svg" alt="Agent: GCP + gcloud + agy">
  <img src="https://img.shields.io/badge/Architecture-Core%20%2B%20Pluggable%20Skills-indigo.svg" alt="Plugins">
  <img src="https://img.shields.io/badge/Monthly%20Cost-%240.00%20(Always%20Free)-success.svg" alt="Cost: $0.00">
  <img src="https://img.shields.io/badge/AI%20Funnel-Gemini%204%20Hydrogen-purple.svg" alt="Gemini 4 Hydrogen">
  <img src="https://img.shields.io/badge/Edge%20Portal-Cloudflare%20Workers%20%2B%20D1-orange.svg" alt="Cloudflare Edge">
</p>

> **核心设计哲学**：
> 这是一个纯粹专属于个人的 **Personal Autonomous Agent**。
> 核心架构由 **Google Cloud (`e2-micro` + Cloud Run + Spot GCE) + `gcloud` + Antigravity CLI (`agy`) + 可选 Cloudflare 边缘层** 协同闭环：
>
> 1. **核心大脑与极简基础设施**：以 Google Cloud Always Free **`e2-micro` 常驻机（0 元月租）** 作为宿主机运行 **Server Shim (`packages/shim`)** 与 **Antigravity CLI (`agy`)**，借助原生 **`gcloud` CLI** 按需调度 Cloud Run 免费层与带物理 TTL 自毁的 Spot GCE；
> 2. **高校平台全面插件化（Plugins / Skills）**：核心宿主纯净解耦、零平台硬编码。**超星学习通、智慧树（知到）、拼题 A（PTA）** 全部实现统一 `PlatformPlugin` 接口契约，按需挂载、独立迭代；
> 3. **双轨认知漏斗（Gemini 4 Hydrogen）**：构建 `Level 0 题库 SHA-256 毫秒级防投毒缓存` → `Level 1 Gemini 4 Hydrogen Medium 整卷批量客观题` → `Level 2 Gemini 4 Hydrogen XHigh (1M Context 课件 RAG / 多模态看图 / 本地沙箱自愈)` 三级智能漏斗；
> 4. **长时算力优先免费层（$0.00/月）**：日常边缘巡检、讨论审批与通知调度运行于 Cloudflare Workers + D1 免费层；重型算力按需走 Cloud Run Jobs 免费额度；高内存浏览器视频任务可拉起 `e2-small` Spot 临时 GCE（带 `EXIT` trap 与 `at` 物理 TTL 熔断）；
> 5. **全链路安全与合规铁律**：Cloudflare ↔ Server Shim 全程使用 **HMAC-SHA256 + 5 分钟时间窗 + 持久化 Nonce 防重放**，Edge 默认 Fail-Closed 鉴权，作业默认以**安全草稿（`pyFlag=1`）暂存**，智慧树严格采用**真实 Chromium CDP 合规倍速播放**（不篡改前端隐藏检测、不绕过验证码）。

---

## 目录
- [一、 系统架构总览](#一-系统架构总览)
- [二、 认知引擎：三级智能漏斗与防投毒机制](#二-认知引擎三级智能漏斗与防投毒机制)
- [三、 选装平台插件生态一览（Plugins / Skills）](#三-选装平台插件生态一览plugins--skills)
- [四、 算力梯队与成本控制（$0.00/月优先）](#四-算力梯队与成本控制000月优先)
- [五、 作业草稿、通知去重与防漏推送机制](#五-作业草稿通知去重与防漏推送机制)
- [六、 极简实操：从 0 到 1 部署指南](#六-极简实操从-0-到-1-部署指南)
- [七、 常用 CLI 指令速查表](#七-常用-cli-指令速查表)
- [八、 CI/CD 质量门禁与本地验证](#八-cicd-质量门禁与本地验证)
- [九、 注意事项与已知边界 (Caveats)](#九-注意事项与已知边界-caveats)
- [十、 TODO 与后续演进路线](#十-todo-与后续演进路线)
- [十一、 安全规范与开源许可](#十一-安全规范与开源许可)

---

## 一、 系统架构总览

```
┌───────────────────────────────────────────────────────────────────────────────┐
│              Tier 0: Cloudflare 边缘控制面 (Workers + D1 + KV + DO)             │
│  • Durable Objects: SignAgent (分时段巡检/退避冷却) & SolverAgent (队列/对账)  │
│  • Cloudflare D1: pending_tasks / notices / discussions / question_bank / logs │
│  • Dark Glassmorphic 看板 (审批提交、失败重试、忽略归档、状态监控)              │
│  • 多通道推送引擎: Telegram Bot (400 自动纯文本降级)、Webhook、Server酱、Bark    │
└───────────────────────────────┬───────────────────────────────┬───────────────┘
                                │ HMAC-SHA256 + Nonce           │ StorageState / D1 Sync
                                ▼                               ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│        Tier 1/2: Google Cloud 宿主机 (e2-micro) & 弹性算力 (Cloud Run / GCE)    │
│                                                                               │
│  【Server Shim 宿主执行节点 (packages/shim)】                                  │
│    • 全局硬件单例互斥锁 + 60s 看门狗（避免低配 969MB VM OOM）                 │
│    • Antigravity CLI (agy) 调用与跨进程并发单例锁                             │
│    • Linux 本地沙箱编译单测 (gcc / g++ / python3 / node)                       │
│                                                                               │
│  【gcloud 弹性算力调度 (infra/gcp)】                                          │
│    • Cloud Run Jobs 免费层: 批量重型任务（每月 36万 vCPU-秒）                  │
│    • Ephemeral Spot GCE (spawn-ephemeral-gce.sh): 完工 EXIT trap + at 熔断自毁 │
├───────────────────────────────────────────────────────────────────────────────┤
│                   标准平台插件体系 (Platform Plugins / Skills)                  │
│    ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐        │
│    │  plugin-chaoxing  │  │ plugin-zhihuishu  │  │    plugin-pta     │        │
│    │   (超星学习通)    │  │   (智慧树知到)    │  │     (拼题 A)      │        │
│    └───────────────────┘  └───────────────────┘  └───────────────────┘        │
│    统一遵循 PlatformPlugin 契约 (packages/core/plugin.ts)                      │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 认知引擎：三级智能漏斗与防投毒机制

系统严格贯彻 **三级智能漏斗（Tiered Intelligence Funnel）**，实现 **“小题零损耗，大题榨干 1M 上下文”**：

```
┌────────────────────────────────────────────────────────────────────────┐
│           Level 0: 零 Token 题库缓存层 (SHA-256 + 课程隔离 + 防投毒)     │
│   • sha256(courseScope + 题干 + 规范化选项) 毫秒级查库                   │
│   • 自动拦截“无法查看/拒绝回答/占位模板”等毒化缓存条目，绝不复用错误答案 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 未命中
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│      Level 1: Gemini 4 Hydrogen Medium 极速批处理 (配额护盾)             │
│   • 默认 AFK_FLASH_MODEL=gemini-4-hydrogen-medium                      │
│   • 整卷单选/多选/判断题打包单次 Batch Prompt，零串行浪费               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 主观题 / 大题 / 编程题
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│      Level 2: Gemini 4 Hydrogen XHigh 深度推理与沙箱自愈                 │
│   • 默认 AFK_PRO_MODEL=gemini-4-hydrogen-xhigh                         │
│   • 注入课程全量 PPT/PDF/Word 提取文本 (1M Context RAG)                │
│   • 自动预下载防盗链题目附件/图片供多模态理解                           │
│   • PTA 算法题在本地沙箱实测编译/运行，WA/TLE/CE 闭环自愈至 AC          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 三、 选装平台插件生态一览（Plugins / Skills）

核心宿主与特定教学平台解耦，所有适配器统一实现 [`PlatformPlugin`](file:///home/Jimmy/afk-cloud/packages/core/plugin.ts#L34-L76)：

| 插件 ID | 适配平台 | 核心能力与合规机制 | 驱动技术栈 |
| :--- | :--- | :--- | :--- |
| **`chaoxing`** | 超星学习通 | • DES 登录、在读课程与课件 RAG 资料批量拉取<br>• 网页端作业扫描（`getAllWork` 状态反查）+ 防空壳主观题/附件人工上传守卫<br>• 作业安全草稿先行（`pyFlag=1`）+ 打回重做自动重新激活<br>• 讨论区抓取、AI 拟稿与幂等发布闭环（区分 `myReplied` 与自动归档过期讨论）<br>• 全类型签到协议（位置/拍照/手势/二维码）+ WebIM 信令解析基础 | 原生 HTTP + DES + Edge Durable Objects |
| **`zhihuishu`** | 智慧树 (知到) | • 适配新版 `studyvideoh5.zhihuishu.com/stuStudy`<br>• 零外部依赖原生 RFC 6455 [`CdpClient`](file:///home/Jimmy/afk-cloud/packages/adapters/web-agent/cdp-client.ts) 驱动真机 Chromium<br>• 仅使用平台官方倍速控件（严格上限 `1.0x / 1.25x / 1.5x`）、静音、自然 `video.ended` 切换下一未完成小节<br>• 遇登录/扫码、易盾滑块（`#captchaYidun`）或随堂弹题（`.dialog-test`）**立即暂停视频并截图推送告警**，绝不注入反作弊或绕过钩子 | Chromium CDP + Cloudflare D1 Session 同步 |
| **`pta`** | 拼题 A (PTA) | • 浏览器 Profile Cookie 持久化免登 + DOM 题面提取<br>• 本地 Linux 沙箱（`gcc`/`g++`/`python3`/`node`）评测并迭代修复至 AC | Chromium Profile + 本地代码沙箱 |

---

## 四、 算力梯队与成本控制（$0.00/月优先）

| 算力等级 | 适用场景 | 基础设施与免费额度 | 预估月费 |
| :--- | :--- | :--- | :---: |
| **Tier 0** | 24/7 定时巡检、通知箱与作业轮询、D1 记忆库、Web 看板、多通道消息推送 | **Cloudflare Workers + D1 + KV + Durable Objects**（免费层） | **$0.00** |
| **Tier 1 (常驻)** | Server Shim 守护、轻量 HTTP 任务、超星课件提取与 `agy` 调度 | **Google Cloud Always Free `e2-micro`**（`us-west1` 1 台常驻，30GB 磁盘） | **$0.00** |
| **Tier 1 (弹性)** | 批量课件向量化、重型作业批处理 | **Google Cloud Run Jobs 免费层**（每月 `360,000` vCPU-秒） | **$0.00** |
| **Tier 2 (突发)** | 需完整 Chromium 内存（建议 `e2-small` 2GB）的智慧树等浏览器任务 | **Spot GCE 临时实例**（[`spawn-ephemeral-gce.sh`](file:///home/Jimmy/afk-cloud/infra/gcp/spawn-ephemeral-gce.sh)：完工 `EXIT` trap 秒级自毁 + `at` TTL 兜底，最小权限 `sa-antigravity-worker`） | **按秒微额 (<$1)** |

---

## 五、 作业草稿、通知去重与防漏推送机制

1. **作业生命周期与审批门**：
   - 新作业发现后进入 `pending` → 派发 `dispatched` → Server Shim 完成草稿（`pyFlag=1`）后回调 `awaiting_approval`（暂存草稿）→ 在看板确认或开启自动提交后进入 `submitting` → `submitted`。
   - 超时未响应（> 15 分钟）由 `SolverAgent.reconcileDispatchedTasks()` 自动对账回退；随堂测验/考试自动识别并归档 `ignored`，防误代做。
2. **多通道推送可靠性与去重**：
   - **Telegram 400 自动降级**：[`edge/src/notify.ts`](file:///home/Jimmy/afk-cloud/edge/src/notify.ts#L89-L127) 先发送 Markdown，一旦因课程名或 URL 中的 `_` / `[` 触发 HTTP 400，立即自动降级纯文本重发，避免静默丢消息。
   - **通知箱全量提醒**：[`edge/src/store.ts`](file:///home/Jimmy/afk-cloud/edge/src/store.ts#L755-L785) 对 48h 内全部首次见到的未过期通知推送（含教室上课、调课、实验等普通重要通知）；单批超过 5 条时通过 `notice_overflow_batch` 汇总补发，不静默截断。
   - **四重去重防刷屏**：
     - 同一 `workId` 在网页扫描与通知箱之间共享去重，已建档通知的作业不再重复推「新作业通知」；
     - 同一 `activeId` 签到失败仅首次推送异常详情；
     - `mobilelearn` 机房 IP 封禁告警冷却拉长至 `12` 小时；
     - 每日 `08:30` / `21:00` (UTC+8) 简报通过 D1 `digest_lock` 做同分钟幂等锁定。

---

## 六、 极简实操：从 0 到 1 部署指南

### 1. 初始化主机与环境
```bash
git clone https://github.com/fgh23333/afk-cloud.git
cd afk-cloud
pnpm install
cp .env.example .env
# 编辑 .env 填入 CHAOXING_PHONE / CHAOXING_PASSWORD / AFK_EDGE_WORKER_URL / AFK_EDGE_BEARER_TOKEN / AFK_SHIM_SECRET 等
```

### 2. 部署轻量边缘控制面（Cloudflare Workers + D1）
```bash
npx wrangler login
pnpm afk setup-cf
```

### 3. 启动本机 Server Shim（供 Edge 安全派发作业与讨论拟稿）
```bash
pnpm shim
# 生产机建议使用 systemd 托管 (afk-shim.service) + cloudflared (afk-tunnel.service)
```

### 4. 配置 GCP 最小权限（如需调度 Cloud Run / 临时 Spot GCE）
```bash
bash infra/gcp/setup-iam-guardrails.sh
```

---

## 七、 常用 CLI 指令速查表

| 指令 | 说明 |
| :--- | :--- |
| `pnpm afk status` | **全局自检**：检查 `.env`、Chromium、登录态与各服务连通性 |
| `pnpm afk plugins` / `skills` | **插件体系一览**：查看已注册的 `chaoxing`、`pta`、`zhihuishu` 插件与能力清单 |
| `pnpm afk scan` | **课程与作业扫描**：扫描在读课程待办作业；加 `--progress` 可同步章节任务点进度 |
| `pnpm afk solve` | **双轨作业求解**：缓存 → Flash 批量客观题 → Pro 主观/大题，安全暂存草稿 (`--auto-submit` 可直接提交) |
| `pnpm afk discuss` | **讨论区自动拟稿**：结合课件 RAG 为未回复话题生成草稿供审批或发布 |
| `pnpm afk materials` | **课件批量下载**：下载全量课程 PPT/PDF/Word 资料构建 1M 上下文 |
| `pnpm afk signin` | **本地/代理签到扫描**：执行全类型签到打卡 |
| `pnpm afk zhihuishu --url "<URL>" --rate 1.5 --headed` | **智慧树合规播放**：支持 `zhs` / `watch` 别名、最高 `1.5x` 倍速、`--headed` 桌面窗口与 `--tier gce` 云端 Spot 调度 |
| `pnpm afk profile import-cookie --platform zhihuishu --cookie '<Cookie>'` | **导入浏览器 Cookie 并上云**：持久化至 `.cache/browser-profiles/` 并同步到 Edge D1；也支持 `push` / `pull` |
| `pnpm afk burst --mode cloud-run\|gce` | **调度弹性算力**：触发 Cloud Run Job 或带物理 TTL 的 Spot GCE |
| `pnpm afk setup-cf` / `setup-vm` / `setup-gcp` | **自动化基础设施编排**：Cloudflare 边缘一键开通、GCP 常驻机及安全围栏初始化 |

---

## 八、 CI/CD 质量门禁与本地验证

GitHub Actions 包含两条工作流（[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) 与 [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)）：

1. **PR / Push 门禁（`ci.yml`）**：
   - **全量双端静态类型检查**（`pnpm typecheck`）：同时校验根目录 `packages/` + `tests/` 与 Cloudflare Worker `edge/tsconfig.json`；
   - **完整集成与安全测试套件**（`pnpm test`）：包含核心链路、频控退避、签到状态机、讨论幂等、失败重试、题库防投毒、HMAC/Nonce 安全加固、打回重做/通知去重、智慧树 CDP 插件以及 Edge auth/notify/溢出汇总覆盖测试，全部通过隔离锁变量运行；
   - **孤儿测试文件守卫**：校验 `tests/*.test.ts` 下每一个测试文件都已接入 [`package.json`](./package.json) 的 `test` 脚本；
   - **Edge Worker 离线打包校验**：通过 `wrangler deploy --dry-run` 验证 Edge 代码可无报错打包构建；
   - **运维脚本语法门禁**：对 `infra/gcp/*.sh` 全部执行 `bash -n` 静态语法检查；
   - **凭证泄露与 SQL 幂等审计**：拦截 `.env` / 密钥文件 / 硬编码 Token 或Cookie 入库，并强制要求 `edge/migrations/*.sql` 全部带有 `IF NOT EXISTS`。
2. **主分支持续交付与自动回滚（`deploy.yml`）**：
   - `edge/**` 合入 `main` 时自动执行类型检查、远程 D1 迁移、`wrangler deploy --keep-vars`，并对 `/health` 进行 5 次观测探测，失败即自动 `wrangler rollback`。

本地完整验证命令（低内存主机建议配合隔离锁环境变量）：
```bash
pnpm typecheck
AFK_LOCK_FILE="/tmp/afk-test-lock-$$.lock" pnpm test
```

---

## 九、 注意事项与已知边界 (Caveats)

1. **⚠️ 超星 `mobilelearn` 海外机房 IP 封禁**：
   - 经实测，**Cloudflare Workers**（`104.23.213.x`）与 **GCP 云主机**（`35.247.85.194`）均会被 `mobilelearn.chaoxing.com` 拦截并返回 `当前ip [...] 已被封禁，请勿使用vpn、代理等网络`。
   - 目前 Edge 侧通过 `notice.chaoxing.com` 通知箱、网页作业与讨论区仍可正常工作，但**实时主动签到扫描必须经由国内网络、校园网或非风控住宅代理出口执行**。
2. **⚠️ 签到监听时段与频控退避**：
   - 默认签到扫描窗口限制在 UTC+8 `08:15-11:40, 13:00-16:20, 18:00-19:35`（通过 `SIGN_LISTEN_WINDOWS` 配置，设为 `*` 可放开），且按每批 4 门加随机抖动轮转；触发「请勿频繁操作」后将按 `15m → 30m → 60m → 120m` 指数退避，单次探测异常则锁定 15 分钟。
3. **⚠️ 智慧树（知到）真实播放与人机验证边界**：
   - 智慧树登录页（含学号登录）受 **网易易盾滑块（`initNECaptcha`）** 强制保护；本插件严格不破解、不绕过验证码，需先在本地浏览器登录后通过 `profile import-cookie --platform zhihuishu` 导入 `zhihuishu.com` Cookie，或使用 `--headed` 打开窗口由本人完成验证。
   - 宿主机 `e2-micro`（总内存 969 MB）默认触发 `< 220 MB` 内存守卫防 OOM；云端调度建议使用 `--tier gce` 拉起 `e2-small` Spot 实例。无头模式下若播放中途弹出滑块或随堂测验，会立即暂停、截图并通过 Edge 发送 Telegram 告警后退出等待人工接管。
4. **⚠️ 统一时区与测试锁隔离**：
   - 全系统业务时间、Cron 窗口与日志均以 **UTC+8 (`Asia/Shanghai`)** 为准。
   - 在运行宿主机 `afk-shim.service` 的同一台机器上跑测试时，务必设置临时锁路径（如 `AFK_LOCK_FILE=/tmp/test.lock`），避免干扰线上正在执行的 `agy` 单例锁。

---

## 十、 TODO 与后续演进路线

- [ ] **签到干净出口代理 / WebIM 被动监听闭环**：接入国内住宅/校园网出口代理专责承接 `mobilelearn` 签到请求，并打通 [`packages/adapters/chaoxing/webim.ts`](file:///home/Jimmy/afk-cloud/packages/adapters/chaoxing/webim.ts) 群聊信令监听与毫秒级签到回调。
- [ ] **在读课程章节任务点看板合并上线**：审核并合入 `/api/courses/progress` 章节完成率统计与看板进度卡片。
- [ ] **智慧树 GCE Spot 私有库分发与握手脚本合入**：将已验证的 [`spawn-ephemeral-gce.sh`](file:///home/Jimmy/afk-cloud/infra/gcp/spawn-ephemeral-gce.sh) 私有包分发、`e2-small` 默认配置与 `gologin?fromurl=...` 前置握手合入主分支，并验证海外 IP 下弹题/滑块实播稳定性。
- [ ] **Telegram 交互增强**：为签到码/手势/智慧树随堂弹题通知接入 Telegram Bot Inline Keyboard 快速人工回传通道。
- [ ] **测试覆盖率与真实行为验证深化**：持续提高 Edge Worker、Server Shim 与适配器分支的断言覆盖，逐步减少脆弱的模拟逻辑，增加端到端真实集成检查。

---

## 十一、 安全规范与开源许可

1. **绝对零凭据入库**：严禁将 `.env`、`wrangler.jsonc`、私钥、`CASTGC`、手机号或明文密码提交到 Git 历史。
2. **Cloudflare 受管资源隔离**：自动化脚本仅允许操作带 `afk-` 或 `afk-cloud-` 前缀的受管资源，严禁改动账户下其他无关资源。
3. **开源许可**：基于 [MIT License](./LICENSE) 开源，仅供个人效率自动化与 Agent 工程实践交流使用，请自觉遵守所属高校学术与课程规范。
