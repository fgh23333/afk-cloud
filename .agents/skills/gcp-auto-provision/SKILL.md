---
name: gcp-auto-provision
description: Google Cloud Always Free 云主机（e2-micro）与环境全自动编排技能。当需要自动开通/初始化 GCP 服务器、安装 Node.js/pnpm/Chromium/gcloud/cloudflared、配置 afk-shim 守护进程、切换 Gemini 3.8 Flash 避免烧干配额、或由 agy 全自动配置云端环境时加载此技能。
---

# `gcp-auto-provision` GCP 常驻机全自动编排与环境初始化技能

本技能指导 Antigravity CLI (`agy`) 与本地 Agent 通过 `gcloud` 原生命令与自动化脚本，**全自动从零拉起 Google Cloud 永久免费云主机（`e2-micro`）并完成全部运行环境（Node.js/pnpm/Chromium/gcloud CLI/Tunnel）的编排与自愈**。

---

## 1. 一键全自动编排命令（首选推荐）

当用户要求“配置/初始化 Google Cloud 服务器”时，优先执行自动化脚本：

```bash
# 1. 一键创建/检查 Always Free 永久免费云主机 (e2-micro)
pnpm afk setup-vm
# 或直接执行 bash infra/gcp/provision-free-vm.sh

# 2. 一键在云主机上完成环境全自动编排（包含安装 Node 20, pnpm, gcloud CLI, Chromium, cloudflared 与注册 systemd）
gcloud compute ssh afk-node --zone=us-central1-a --command="curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash"
```

---

## 2. 算力安全与计费铁律（100% 永久免费 $0.00/月）

在执行任何 `gcloud compute instances create` 指令时，必须严格遵守以下参数以享受 Google Cloud Always Free 永久免费层：
- **区域 (Region)**：必须为 **`us-central1` (爱荷华)**、**`us-east1` (南卡罗来纳)** 或 **`us-west1` (俄勒冈)** 之一。
- **机型规格**：固定为 **`e2-micro`** (2 vCPU, 1 GB 内存)。
- **磁盘类型与容量**：固定为 **标准永久磁盘 (`pd-standard`)**，容量上限 **30 GB**。

---

## 3. 服务器端必装核心组件（环境基线）

服务器初始化脚本 [`infra/gcp/bootstrap-gcp-node.sh`](../../infra/gcp/bootstrap-gcp-node.sh) 将自动确保以下组件全部就绪：
1. **Node.js 20 LTS + pnpm**：驱动 `afk-cloud` 与 `afk-shim` 守护进程。
2. **Google Cloud SDK (`gcloud` CLI)**：**服务器端必须安装 `gcloud`**，以便常驻在服务器上的 `agy` 与守护进程能够按需调用 Cloud Run Jobs、管理 IAM 或短时拉起 Tier 2 临时 GCE 熔断实例。
3. **真实 Chromium 浏览器**：提供 Chrome DevTools Protocol (`localhost:9222`)，供 `agy` 在真机无头/有头浏览器中完成智慧树与 PTA 的真实交互与防反爬风控。
4. **Cloudflare Tunnel (`cloudflared`)**：实现零公网开放端口、零公网 IP 的安全双向隧道。
5. **systemd 服务守护**：将 `afk-shim` 注册为系统开机自启服务（端口 8788）。

---

## 4. 模型配额保护铁律：切至 Gemini 3.8 Flash

为了防止过快耗尽高价值的 Gemini Pro Quota，Agent 在调度与执行解题时必须严格执行模型分级策略：

> [!IMPORTANT]
> **主力轨优先切换至 Gemini 3.8 Flash (`gemini-3.8-flash` / `flash`)**：
> - 针对在读课程扫描、客观题批量作答（单选/多选/判断/填空）、常规数据清洗与日常心跳，**默认一律使用 Gemini 3.8 Flash**。
> - 在 `.env` 中配置：`AFK_FLASH_MODEL=gemini-3.8-flash`。
> - Gemini 3.8 Flash 具备极高响应速度与高并发吞吐，能大幅降低 Token 消耗并避免触发 Pro 配额限流。
> - **何时才升级到 Gemini Pro**：仅当遇到 1M Token 超长课件 RAG 深度检索、包含电路/几何图表的多模态大题、以及 PTA 算法代码沙箱反思自愈时，才按需升级调用 Gemini Pro。
