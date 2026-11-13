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
gcloud compute ssh afk-node --zone=us-west1-a --command="curl -fsSL https://raw.githubusercontent.com/fgh23333/afk-cloud/main/infra/gcp/bootstrap-gcp-node.sh | bash"
```

---

## 2. 算力安全与计费铁律（100% 永久免费 $0.00/月）

在执行任何 `gcloud compute instances create` 指令时，必须严格遵守以下参数以享受 Google Cloud Always Free 永久免费层：
- **区域 (Region)**：默认推荐 **`us-west1` (美西俄勒冈，默认)**，亦可选 `us-central1` (爱荷华) 或 `us-east1` (南卡罗来纳)。
- **机型规格**：固定为 **`e2-micro`** (2 vCPU, 1 GB 内存)。
- **磁盘类型与容量**：固定为 **标准永久磁盘 (`pd-standard`)** ，容量上限 **30 GB** 。

---

## 3. 服务器端必装核心组件（环境基线）

服务器初始化脚本 [`infra/gcp/bootstrap-gcp-node.sh`](../../infra/gcp/bootstrap-gcp-node.sh) 将自动确保以下组件全部就绪：
1. **Node.js 20 LTS + pnpm**：驱动 `afk-cloud` 与 `afk-shim` 守护进程。
2. **Google Cloud SDK (`gcloud` CLI)**：**服务器端必须安装 `gcloud`** ，以便常驻在服务器上的 `agy` 与守护进程能够按需调用 Cloud Run Jobs、管理 IAM 或短时拉起 Tier 2 临时 GCE 熔断实例。
3. **真实 Chromium 浏览器**：提供 Chrome DevTools Protocol (`localhost:9222`)，供 `agy` 在真机无头/有头浏览器中完成智慧树与 PTA 的真实交互与防反爬风控。
4. **Cloudflare Tunnel (`cloudflared`)**：实现零公网开放端口、零公网 IP 的安全双向隧道。
5. **systemd 服务守护**：将 `afk-shim` 注册为系统开机自启服务（端口 8788）。

---

## 4. 默认模型策略：Gemini 4 Hydrogen 分级调度

Agent 在调度与执行解题时按任务复杂度使用 Gemini 4 Hydrogen 分级模型：

> [!IMPORTANT]
> **主力轨默认切换至 Gemini 4 Hydrogen (`gemini-4-hydrogen-medium` / `gemini-4-hydrogen-xhigh`)**：
> - 针对在读课程扫描、客观题批量作答（单选/多选/判断/填空）、常规数据清洗与日常心跳，**默认使用 `gemini-4-hydrogen-medium`**。
> - 在 `.env` 中配置：`AFK_FLASH_MODEL=gemini-4-hydrogen-medium`，`AFK_PRO_MODEL=gemini-4-hydrogen-xhigh`。
> - Gemini 4 Hydrogen Medium 具备极高响应速度与并发吞吐，能在保证客观题准确率的同时避免不必要的高档位配额消耗。
> - **何时升级到 Gemini 4 Hydrogen XHigh**：当遇到 1M Token 超长课件 RAG 深度检索、包含电路/几何图表的多模态大题、主观论述及 PTA 算法代码沙箱反思自愈时，按需升级调用 `gemini-4-hydrogen-xhigh`。

---

## 5. 云端 Cloudflare 授权机制（基于 OAuth2）

在云端无桌面的 Linux 服务器上配置 Cloudflare 边缘与 Tunnel 时，采用 OAuth2 网页重定向与轮询机制完成授权：
- **Wrangler 边缘授权**：在云端机器执行 `npx wrangler login`，终端将直接打印形如 `https://dash.cloudflare.com/oauth2/auth?...` 的 OAuth2 授权 URL。用户只需在本地电脑浏览器中打开该 URL 并点击“允许”，凭据即自动下发至云主机的 `~/.config/.wrangler/`。
- **Cloudflare Tunnel 授权**：执行 `cloudflared tunnel login` 时，同样会生成 OAuth2 网页链接，在本地浏览器选择账号域名后即可自动下载 `cert.pem`。若使用临时测试隧道（`cloudflared tunnel --url ...`），则无需登录即可直接生成穿透域名。

---

## 6. e2-micro 极低内存 (1GB) 性能调优与防卡死规范

Google Cloud 免费层 `e2-micro` 只有 1GB 物理内存与 0.25 核心基准 CPU，极易因频繁 Swap 换页引起磁盘 IO 堵塞（Load Average 飙升至 10+ 严重卡死）。必须严格遵守以下优化基线：

1. **内核换页与缓存激进化调优**：
   - 必须配置 `vm.swappiness=10`（避免过度使用慢速持久磁盘的 Swapfile）。
   - 必须配置 `vm.vfs_cache_pressure=50`（保护目录与 inode 缓存）。
   - 固化于 `/etc/sysctl.d/99-afk-tuning.conf`。
2. **严禁在 1GB 机器上运行 Google Cloud Ops Agent**：
   - `google-cloud-ops-agent`（包含 OpenTelemetry Collector 与 Fluent-Bit）每秒进行高频日志追踪与磁盘写入，常态消耗 100MB+ 内存并耗尽 Standard PD 的 IOPS 额度。
   - 部署脚本中必须显式停用并禁用：`sudo systemctl stop google-cloud-ops-agent && sudo systemctl disable google-cloud-ops-agent`。
3. **Node.js 内存硬顶限制**：
   - 为后台守护进程与 agy 注入环境变量：`NODE_OPTIONS="--max-old-space-size=384"`，驱动 V8 引擎积极触发垃圾回收。
4. **进程组彻底杀灭与孤儿防泄漏**：
   - 严禁多实例挂起孤儿 `agy` 会话。
   - 关闭 Chromium 时使用 `process.kill(-pid, 'SIGKILL')` 杀死整个进程树，避免孤儿渲染进程持续霸占内存。

---

## 7. 网络保活 (Keepalive) 与 SSH 极速登录规范 (防掉线与无感直连)

针对国内直连 Google Cloud 跨境网络容易受 NAT 超时丢包与 DNS 逆向解析卡顿的问题，必须配置以下三级网络护盾：

1. **内核级 TCP Keepalive 秒级心跳**：
   - Linux 默认 `tcp_keepalive_time=7200`（2 小时），国内路由器或 GFW 在连接闲置 60~120 秒后会清除 NAT 会话状态表，导致 `agy remote-control` 的 WebRTC 信令断连。
   - 必须配置：
     ```ini
     net.ipv4.tcp_keepalive_time = 30
     net.ipv4.tcp_keepalive_intvl = 10
     net.ipv4.tcp_keepalive_probes = 5
     ```
   - 固化于 `/etc/sysctl.d/99-network-keepalive.conf`，每 30 秒自动发送探针保持路由表活跃，彻底解决 Remote Control 掉线问题。
2. **SSH 秒级无感直连与会话保活**：
   - 默认 `sshd` 会执行反向 DNS 查询（`UseDNS yes`），国内访问经常触发 5~10 秒 DNS 超时假死；闲置超过 1 分钟容易 Broken Pipe。
   - 在 `/etc/ssh/sshd_config.d/99-fast-keepalive.conf` 固化：
     ```ini
     ClientAliveInterval 15
     ClientAliveCountMax 4
     TCPKeepAlive yes
     UseDNS no
     GSSAPIAuthentication no
     ```
3. **Remote Control 必须由 systemd 纳管**：
   - 严禁以普通后台进程挂载（会因缺少会话或 session 退出而失效）。
   - 开启用户会话持久化：`sudo loginctl enable-linger <user>`。
   - 统一由 `/etc/systemd/system/antigravity-remote-control.service` 管理，配置 `Restart=always`，确保异常秒级拉起、开机自启。
