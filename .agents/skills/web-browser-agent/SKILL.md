---
name: web-browser-agent
description: 通用无头浏览器与登录态 Profile 持久化操控技能（适用于 PTA pintia.cn、智慧树 zhihuishu.com 等一切 Web 教学/评测平台）。当需要操作 PTA、智慧树或通过无头浏览器保留登录态完成答题时加载此技能。
---

# `web-browser-agent` 通用无头浏览器与持久化 Profile 操控指南

针对 **PTA (`pintia.cn`)**、**智慧树 (`zhihuishu.com`)** 等纯 Web 平台，无需逆向复杂的私有加密接口，直接通过 **无头浏览器（Headless Chromium）+ 持久化 Profile（`userDataDir` + `storageState.json` 云端同步）+ 双轨 AI 模型** 原生操控页面即可完成全流程。

---

## 1. 登录态与 Profile 持久化的两层机制

1. **本机/常驻机完整 Profile 目录（`--user-data-dir`）**：
   - 路径固定为：`.cache/browser-profiles/<platform>/user-data/`（如 `.cache/browser-profiles/pta/user-data`）。
   - Chromium 的全部 Cookies、LocalStorage、IndexedDB、登录 Token 自动保存在该目录中，重启浏览器或机器后**永久保持登录态**。
2. **跨容器/跨机器云端快照同步（`storage-state.json` <-> Cloudflare D1）**：
   - 当需要在无状态的 **Cloud Run Jobs** 或 **临时拉起的 GCE 实例** 上运行无头浏览器时，使用：
     ```bash
     # 将当前已登录的 Profile 状态推送到 Cloudflare D1 持久层
     pnpm afk profile push --platform pta

     # 在新机器/新容器启动时从 Cloudflare D1 拉取登录态
     pnpm afk profile pull --platform pta
     ```

---

## 2. 标准无头浏览器操控工作流（结合 `chrome-devtools` MCP）

### 步骤 1：挂载持久化 Profile 启动无头浏览器（暴露 CDP `9222` 端口）
```bash
# 启动 PTA 无头浏览器并自动恢复登录态
pnpm afk web --platform pta

# 或启动智慧树无头浏览器
pnpm afk web --platform zhihuishu
```
执行后，无头 Chromium 会携带 `.cache/browser-profiles/<platform>/user-data` 在后台运行，并监听 `http://127.0.0.1:9222`。

### 步骤 2：使用 `chrome-devtools` MCP 原生工具操控页面
连接后，`agy` 直接通过内置的 `chrome-devtools` MCP 工具执行：
1. **获取精简 DOM / 无障碍树快照**：调用 `take_snapshot` 获取当前题目集或章节测试页面的结构化节点（比全量 HTML 节省 90% Token）。
2. **双轨认知分流**：
   - **客观题（单选/多选/判断/填空）**：使用 **Gemini Flash** 一次性解析快照中的所有题目并生成对应元素 `uid` 的点击/填写指令（`click` / `fill`）。
   - **PTA 编程题 / 函数题**：提取题面与输入输出样例 -> 调用 `packages/core/sandbox.ts` 在本地 GCC/Python 沙箱中编译并跑通样例（若 WA/CE 则由 **Gemini Pro** 自动反思修复） -> 将通过测试的源码填入页面代码编辑器并点击提交评测！

### 步骤 3：首次登录或手动导入 Cookie
- 若在无图形界面的 GCP 服务器上首次初始化登录态，可直接从本地浏览器复制 Cookie 导入并自动同步到 Cloudflare D1：
  ```bash
  pnpm afk profile import-cookie --platform pta --domain ".pintia.cn" --cookie "PTASession=xxx; ..."
  pnpm afk profile import-cookie --platform zhihuishu --domain ".zhihuishu.com" --cookie "CASLOGC=xxx; ..."
  ```
