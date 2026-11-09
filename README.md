# `afk-cloud` — 个人云端自治 Agent（Personal Autonomous Cloud Agent）

> **核心理念**：“边缘免维护保活、协议级原生工具调用、免费算力优先（Cloudflare + Cloud Run + GCE `e2-micro`）、高负载按需秒级拉起、跑完即自毁”。

---

## 一、 三级免费优先算力架构全景

| 算力层级 | 承载设施与免费额度 | 核心职责 | 计费与生命周期 |
| :--- | :--- | :--- | :--- |
| **Tier 0：边缘常驻与持久记忆层**<br>([`edge/`](./edge)) | • **Cloudflare Workers Cron**（10万次/天免费）<br>• **Cloudflare D1 SQLite**（500万读/天、**10万写/天**免费） | • 每分钟自动巡检、复用 D1 缓存的登录 Cookie（6h TTL 免重登）<br>• 秒级执行全类型学习通签到<br>• 每 10 分钟极速探测新作业红点并写入 D1 `pending_tasks`<br>• 持久化 `question_bank` 题库 SHA-256 缓存与 Web 浏览器登录态 | **100% 永久免费**；不消耗任何云主机 CPU/内存 |
| **Tier 1：无服务器容器与常驻控制面**<br>([`packages/`](./packages) + Cloud Run) | • **GCP `e2-micro`**（Always Free 常驻机，运行 `agy` + CF Plugin）<br>• **Google Cloud Run Jobs**（每月 **36万 vCPU-秒 + 18万 GiB-秒** 永久免费） | • **Antigravity CLI (`agy`)** 自动加载仓库内 [`.agents/`](./.agents) 规则与技能，通过 Cloudflare Plugin 直连读写 D1<br>• **双轨认知答题**：90% 客观题由 **Gemini Flash** 单次批量输出 JSON；10% 主观/编程题由 **Gemini Pro** 结合沙箱自测完成 | **100% 落在免费配额内**；Cloud Run Job 按秒运行、跑完归零 |
| **Tier 2：重负载临时云主机爆破层**<br>([`infra/gcp/`](./infra/gcp)) | • **GCE Spot / 按需临时实例**<br>• 最小权限 SA (`sa-antigravity-worker`) | • 遇到超出 `e2-micro` / Cloud Run 限制的重型并发无头浏览器或长时评测时，通过 `pnpm afk burst --mode gce` 秒级拉起新机器<br>• 内置 `at now + 15 minutes` 物理自毁保险丝 + `EXIT trap` 完结即刻销毁 | **跑完即自毁**；彻底杜绝悬挂计费 |

---

## 二、 新用户从 0 到 1 完整部署教程（仅需 Google Cloud + Cloudflare 账号）

假设一位新用户刚刚拿到了 **Cloudflare 账号** 和 **Google Cloud (GCP) 账号**，按以下 4 步即可在 10 分钟内完成全套零闲置云端自治系统的搭建：

### 第 1 步：在 Google Cloud 创建免费常驻控制机（或直接使用已有服务器）
1. 登录 Google Cloud Console，创建一个新项目（例如 `my-afk-cloud`），记下 **Project ID**。
2. 创建一台属于 **GCP Always Free（永久免费层）** 的轻量虚拟机作为常驻控制节点（或直接在本地/已有云主机执行）：
   ```bash
   gcloud config set project <您的_GCP_PROJECT_ID>

   # 可选：若尚未开机器，一键创建美国西部/俄勒冈或台湾节点的 e2-micro 机器
   gcloud compute instances create afk-control-plane \
     --zone=us-west1-b \
     --machine-type=e2-micro \
     --image-family=debian-12 \
     --image-project=debian-cloud \
     --boot-disk-size=30GB
   ```
3. SSH 登录该服务器，克隆本仓库并执行一键初始化脚本：
   ```bash
   git clone <本仓库_GIT_URL> afk-cloud
   cd afk-cloud
   bash infra/gcp/bootstrap-gcp-node.sh
   ```

### 第 2 步：配置 `.env` 账号并让 `agy`（或一键命令）全自动创建 Cloudflare & GCP 服务

由于环境内已接入 **Cloudflare 官方技能（`cloudflare` / `wrangler`）** 与 **全自动编排引擎 [`cf-provisioner.ts`](./packages/core/cf-provisioner.ts)**，**您完全不需要手动创建数据库、不需要手动复制粘贴 `database_id` 或 Worker URL**！

1. 先在根目录 `.env` 中填入您的基础账号：
   ```ini
   CHAOXING_PHONE=您的学习通手机号
   CHAOXING_PASSWORD=您的学习通密码
   CHAOXING_REALNAME=您的真实姓名
   GCP_PROJECT_ID=您的_GCP_PROJECT_ID
   ```
2. **任选以下一种方式全自动完成全部云端资源创建与绑定**：
   - **方式 A（直接让 `agy` 自己干）**：
     在 `afk-cloud` 目录下启动 `agy`，直接输入：
     > *“帮我全自动创建并部署 Cloudflare D1、Edge Worker 和 GCP Cloud Run 服务”*
     
     `agy` 会自动加载 [`.agents/skills/cf-auto-provision/SKILL.md`](./.agents/skills/cf-auto-provision/SKILL.md) 与官方 Cloudflare 技能完成全套创建、建表、加密密钥上传与 `.env` 回填。
   - **方式 B（一行命令全自动脚本化执行）**：
     ```bash
     # 仅需确保已登录 wrangler login 与 gcloud auth login，随后一行命令搞定全部：
     pnpm afk setup-all
     ```
     *(注：也可单独运行 `pnpm afk setup-cf` 仅自动开通 Cloudflare D1 + Worker，或 `pnpm afk setup-gcp` 仅配置 GCP 最小权限围栏与免费 Cloud Run Job。脚本会自动创建 `afk-cloud-db`、提取 UUID 生成 `edge/wrangler.jsonc`、执行 SQL 迁移、通过 `secret bulk` 加密上传密码、部署 Worker 并自动把生成的 Worker URL 与鉴权 Token 写回 `.env`！)*

### 第 3 步（可选）：首次导入 PTA (`pintia.cn`) / 智慧树 (`zhihuishu.com`) 浏览器登录态
只需在电脑浏览器登录一次 PTA 或智慧树，复制 `Cookie` 执行一次导入，系统会自动写入本地 Chromium Profile **并同步加密备份至刚刚自动创建的 Cloudflare D1**（此后任何容器或临时机器拉起均直接处于已登录态）：
```bash
pnpm afk profile import-cookie --platform pta --cookie "PTASession=xxx; ..."
pnpm afk profile import-cookie --platform zhihuishu --cookie "CASLOGC=xxx; ..."
```

---

## 三、 日常使用与 CLI 指令速查表

| 操作场景 | CLI 命令 | 说明 |
| :--- | :--- | :--- |
| **環境与边缘连通自检** | `pnpm afk status` | 检查 `.env`、无头浏览器、Web 登录态及 Cloudflare D1 连通状态 |
| **全自动开通 CF + GCP 服务** | `pnpm afk setup-all` | 自动创建 D1、迁移表、注入密钥、部署 Worker、回写 `.env` 并部署免费 Cloud Run |
| **仅全自动开通 Cloudflare** | `pnpm afk setup-cf` | 零手动复制 ID/URL，一键完成 D1 创建 + Worker 部署 + `.env` 自动绑定 |
| **扫描在读课程与待做作业** | `pnpm afk scan` | 列出所有在读课程、未交作业、截止时间与课件数量 |
| **批量下载课程课件 (RAG)** | `pnpm afk materials` | 下载全部课程 PPT/PDF/DOCX 并自动提取文本索引供答题检索 |
| **双轨求解作业（草稿暂存）** | `pnpm afk solve` | **默认安全模式 (`pyFlag=1`)**：D1 缓存查表 $\rightarrow$ Flash 批量客观题 $\rightarrow$ Pro 主观题，暂存草稿并生成 UTC+8 报告 |
| **双轨求解作业（正式提交）** | `pnpm afk solve --auto-submit` | 解答完毕后直接正式提交至学习通 (`pyFlag=3`) |
| **启动 PTA/智慧树无头浏览器** | `pnpm afk web --platform pta` | 挂载 `.cache/browser-profiles/<platform>` 持久化 Profile 启动无头浏览器并暴露 CDP `9222` 端口供 `agy` 操控 |
| **导入并云端同步 Web 登录态** | `pnpm afk profile import-cookie --platform pta --cookie "..."` | 将 PTA/智慧树 Cookie 写入本地 Profile 并同步至 Cloudflare D1，跨机器/跨容器永久免登 |
| **调度至 Cloud Run 免费容器** | `pnpm afk burst --mode cloud-run --task "solve"` | 使用 GCP Cloud Run Jobs 免费额度异步隔离运行 |
| **高负载短时拉起新 GCE 机器** | `pnpm afk burst --mode gce --task "solve" --ttl 15` | 调用 `gcloud` 拉起带 15 分钟物理自毁定时器的临时 GCE 实例 |
