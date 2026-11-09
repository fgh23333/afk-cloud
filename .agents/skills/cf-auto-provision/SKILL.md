---
name: cf-auto-provision
description: Cloudflare 与 GCP 基础设施全自动开通与绑定技能。当用户要求初始化部署、自动创建 Cloudflare D1/Worker、同步密钥或由 agy 自动配置云端环境时加载此技能。
---

# `cf-auto-provision` 全自动基础设施编排技能（免手动复制 ID/URL）

由于运行环境已内置官方 **`cloudflare` / `wrangler` 技能** 以及 **Cloudflare MCP Plugin**，新用户或迁移用户**完全不需要手动敲命令创建 D1、不需要手动复制粘贴 `database_id` 或 Worker 域名**，一切由 `agy` 或自动化引擎 `pnpm afk setup-all` 自动完成。

---

## 1. 一键全自动编排命令（首选推荐）

当用户需要创建或更新 Cloudflare 边缘层（D1 数据库 + 表结构迁移 + `wrangler.jsonc` 自动绑定 + `.env` 密钥自动注入 + Worker URL 自动回写）时，直接执行：

```bash
# 全自动开通/更新 Cloudflare D1 + Worker 并自动回写 .env
pnpm afk setup-cf

# 或一次性完成 Cloudflare 边缘层 + GCP IAM 最小权限围栏 + Cloud Run 免费层部署
pnpm afk setup-all
```

### `pnpm afk setup-cf` 内部自动完成的 6 件事（幂等安全）：
1. **自动创建或复用 D1**：调用 `wrangler d1 list --json`，若不存在 `afk-cloud-db` 则自动执行 `wrangler d1 create afk-cloud-db` 并正则提取 `database_id` UUID。
2. **自动生成 `edge/wrangler.jsonc`**：将提取到的 `database_id` 直接渲染写入 `edge/wrangler.jsonc`，零人工粘贴。
3. **自动执行 SQL 迁移**：自动运行 `wrangler d1 execute afk-cloud-db --remote --file=./migrations/0001_init.sql --yes` 创建 4 张核心表。
4. **自动部署 Worker 并提取域名**：执行 `wrangler deploy` 并捕获分配的 `https://afk-cloud-edge.<subdomain>.workers.dev`。
5. **非交互式安全注入 Secrets**：自动生成高强度 `AFK_EDGE_BEARER_TOKEN`，连同 `.env` 中的 `CHAOXING_PHONE`、`CHAOXING_PASSWORD` 通过临时加密文件调用 `wrangler secret bulk` 一次性注入并立即销毁临时文件。
6. **自动回写 `.env`**：将生成的 `AFK_EDGE_WORKER_URL` 和 `AFK_EDGE_BEARER_TOKEN` 自动写回根目录 `.env`，实现本机/GCP 与 Cloudflare 的无缝闭环。

---

## 2. 结合 Cloudflare 官方 MCP Plugin 的协议级操作

如果当前 `agy` 会话已连接 **Cloudflare MCP Server**，你还可以直接通过原生 MCP 工具完成巡检与维护：
- **列出/创建 D1 数据库**：直接调用 Cloudflare MCP 的 D1 管理工具，检查 `afk-cloud-db` 状态。
- **直接执行 SQL 建表或查询**：将 [`edge/migrations/0001_init.sql`](../../edge/migrations/0001_init.sql) 的内容通过 MCP D1 Query 工具直接下发执行，或直接查询 `SELECT * FROM execution_logs ORDER BY id DESC LIMIT 20` 汇报签到与答题进展。
