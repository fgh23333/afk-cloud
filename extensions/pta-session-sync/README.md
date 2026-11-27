# afk-cloud PTA 会话同步伴侣扩展 (`v0.0.1`)

零额外服务器成本的浏览器伴侣扩展，适用于桌面 Chrome / Edge / Brave 以及支持 MV3 扩展的 Android 浏览器（如 Edge Canary / Kiwi / Lemur）。

## 核心特性

1. **自动勾选「记住我」延长登录寿命**：打开 `https://pintia.cn/auth/login` 时自动勾选保持登录（可选在扩展本地保存并预填邮箱/密码，账号密码绝不上传至 Cloudflare Edge）。
2. **完整读取 `HttpOnly PTASession`**：通过官方 `chrome.cookies` API 读取普通 JS 读不到的 `PTASession` 与真实到期时间。
3. **无感事件同步 + 定时保活**：只要您在平时使用的浏览器完成一次登录并滑过腾讯滑块验证码，扩展会在 1.5 秒内自动推送完整会话到您自己的 `AFK_EDGE_WORKER_URL/api/pta/session`，并每 6 小时检查一次服务端续期 Cookie。
4. **严格合规边界**：绝不接触、点击、拖拽或破解腾讯滑块验证码，人机验证永远由用户本人完成。

## 安装步骤（2 分钟完成）

1. 打开浏览器扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 开启右上角 **开发者模式 (Developer mode)**。
3. 点击 **加载已解压的扩展程序 (Load unpacked)**，选择仓库中的 `extensions/pta-session-sync/` 目录。
4. 点击扩展图标，填入您的 Cloudflare Edge URL（即 `.env` 中的 `AFK_EDGE_WORKER_URL`）与 `AFK_EDGE_BEARER_TOKEN`，点击 **保存配置并授权同步**。
5. 正常登录 `https://pintia.cn` 并完成一次验证码，扩展图标角标显示 `OK` 即表示云端 D1 已同步就绪。
