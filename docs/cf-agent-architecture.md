# afk-cloud × Cloudflare Agents SDK — 架构定稿与实施清单

> 定稿时间：2026-11-09（UTC+8）。本文档是实施依据，按阶段推进，每阶段有验收标准。

---

## 0. 决策记录（为什么长这样）

| # | 决策 | 结论 | 原因 |
|---|------|------|------|
| D1 | LLM 来源 | **保持 agy** | Workers AI 免费神经元扛不住作业量；agy 内核带知识拉取，是解题质量的一部分 |
| D2 | agy 容器化（Cloud Run 按需拉起） | **否决** | 掉登录态、掉会话 memory，外部持久化逆着工具设计，得不偿失 |
| D3 | agy 归宿 | **常驻服务器（宠物）** | 登录态 + memory 原地不动，永不搬迁，尽量少打扰 |
| D4 | durable 边界 | **不给 agy 做 durable，给 agy 以外的一切做 durable** | 排队/缓存/重试/记账全在 CF DO；agy 的黏性状态一个字节都不外移 |
| D5 | 内容拉取 | **双模：协议原生轻量读 + 浏览器按需读** | 学习通全量作业与课件支持纯 HTTP 协议拉取（< 30MB 内存，极速）；PTA 与智慧树知到则通过浏览器快照对齐，按需启动，避免无谓 OOM |
| D6 | 读写分工 | **CF 负责巡检审批记账、宿主机负责解题与写入** | CF 纯协议定时探测与红点巡检（轻量零闲置）；解题、草稿写入与提交由宿主机 Agent 原生协议或真机完成，CF 不碰写协议 |
| D7 | 提交门 | **草稿 → 通知 → 确认 → 提交** | 对应现有 `AUTO_SUBMIT_HOMEWORK=false` / `pyFlag=1` 安全默认；全自动 = 打开开关连发两条指令 |
| D8 | 浏览器 | **本地 Chromium 按需起停**（不搬 Browser Rendering） | agy 经 chrome-devtools MCP 连 `localhost:9222`，远程 CDP 带鉴权改造脆；profile 本来就走 D1 同步，无黏性状态 |

**核心分工一句话：CF 负责"发现、决定何时、传什么链接、记账、审批、通知"，agy 只负责"想和动手"。**

---

## 1. 总体架构

```
┌─ Cloudflare（牛群：无黏性状态，随便重启）─────────────────────────┐
│                                                                    │
│  edge Worker（现有，保留看板/API 面，加 DO 路由）                    │
│    ├─ SignAgent (DO)   巡检：课表窗口+抖动 → 签到直接干 + 红点探测   │
│    │                   （纯协议读，无 LLM，不惊动 agy）              │
│    └─ SolverAgent (DO) 任务编排：去重 → deadline分桶 → 传链接        │
│                        → 记账（题库缓存/报告/看板）→ 通知 → 审批门   │
│                                                                    │
└──────────┬─────────────────────────────────────▲───────────────────┘
           │ ① POST /task {链接+指令}            │ ④ 回调 /api/agent/callback
           │    （cloudflared tunnel）           │    （shim → edge 公网 URL）
           ▼                                     │
┌─ 服务器（宠物窝：e2-micro / 2C2G，常驻但近乎空转）──────────────────┐
│                                                                    │
│  shim（~百行 HTTP 服务，只认 Bearer token）                          │
│    ├─ /task   → 组 agy prompt → execFile agy → 浏览器里读题/解/填/存草稿 │
│    ├─ /submit → 第二条指令：agy 在浏览器点提交                        │
│    ├─ /browser→ 按需起/停本地 Chromium（profile 从 D1 恢复，TTL 自停）│
│    └─ /status → 任务执行状态（DO 轮询兜底）                          │
│                                                                    │
│  agy（常驻宠物：登录态 + memory 原地不动，串行调用，一次一个）          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**生命周期：** DO alarm 驱动巡检（不再是每分钟 cron 全量扫）→ 发现作业 → 入队（deadline 不近则攒静默时段合并）→ 串行派发 shim → agy 浏览器作业（拉题/解/填/草稿）→ 回调 DO 记账 → 通知用户 → 用户确认 → DO 下发 submit → agy 点提交 → 记账收尾。

---

## 2. 接口契约

### 2.1 shim API（服务器侧，全部 Bearer `SHIM_TOKEN` 鉴权）

```
POST /task          异步启动，立即返回 job_id（agy 跑几分钟，不能同步等）
  请求 { "jobId": "chaoxing-hw-<courseId>-<workId>",        // DO 生成，幂等键
         "taskUrl": "https://...",                            // 任务链接
         "platform": "chaoxing" | "pta" | "zhihuishu",
         "deadline": "2026-11-20 23:59:00+08:00",
         "mode": "draft" }                                    // 固定 draft，提交走 /submit
  返回 { "jobId": "...", "accepted": true }

POST /submit        第二条指令：让 agy 回到该任务页面点提交
  请求 { "jobId": "...", "taskUrl": "..." }
  返回 { "jobId": "...", "accepted": true }

GET  /status/:jobId
  返回 { "jobId": "...", "phase": "running"|"draft_saved"|"submitted"|"failed",
         "qa": [ { "id": "...", "type": "single|multiple|judgement|blank|essay|programming",
                   "title": "...", "answer": "...", "solvedBy": "agy" } ],
         "summary": "..." }

POST /browser
  请求 { "platform": "pta", "action": "start" | "stop", "ttlMinutes": 30 }
  返回 { "status": "running", "cdpUrl": "http://localhost:9222" }

GET  /health
  返回 { "agy": "ok", "browser": "running:pta" | "stopped", "jobs": 1 }
```

**回调（主路径）：** shim 在 phase 变化时 `POST {AFK_EDGE_WORKER_URL}/api/agent/callback`（带现有 `AFK_EDGE_BEARER_TOKEN`），body = `/status` 的内容。DO 侧 alarm 轮询 `/status/:jobId` 做兜底（回调丢了也能推进）。

### 2.2 agy prompt 模板（shim 内维护两段）

- **solve-draft**：`打开 {taskUrl}（浏览器已就绪），读取全部题目；逐题解答（客观题直接选，主观/编程题完整作答）；在页面中填写答案并保存草稿，【绝对不要点提交】；最后只输出一个 JSON：{"qa":[{"id","type","title","answer"}],"summary":"..."}`
- **submit**：`打开 {taskUrl}，确认草稿已在，点击提交并确认提交成功；输出 JSON：{"status":"submitted","summary":"..."}`

JSON 提取沿用 `solver.ts` 的正则兜底写法。

### 2.3 SolverAgent 内部状态（DO SQLite）

```sql
CREATE TABLE IF NOT EXISTS tasks (
  job_id TEXT PRIMARY KEY, platform TEXT, task_url TEXT,
  status TEXT,            -- pending|dispatched|draft_saved|awaiting_approval|submitted|failed
  deadline TEXT, qa_json TEXT, summary TEXT,
  attempts INTEGER DEFAULT 0, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS qa_cache (
  hash TEXT PRIMARY KEY,  -- 沿用 computeQuestionHash(type,title,options)
  platform TEXT, type TEXT, title TEXT, answer TEXT, updated_at TEXT
);
```

---

## 3. 代码落点（复用映射）

| 现有代码 | 去向 |
|---|---|
| `edge/src/chaoxing.ts`（登录/课程/签到/红点探测） | 拆进 SignAgent DO（逻辑不动，触发方式变窗口+抖动） |
| `edge/src/notify.ts` | 原样复用，DO 内调用 |
| `edge/src/dashboard.ts` + `/api/*` 路由 | 保留，加 `/api/agent/callback`、`/api/tasks/:id/approve` |
| `edge/src/store.ts` 的题库缓存部分 | 被 DO `qa_cache` 取代（看板聚合类保留 D1） |
| `packages/core/d1-bridge.ts` 的 `computeQuestionHash` | 移植进 SolverAgent |
| `packages/core/browser-profile.ts` | shim 复用（起浏览器 + profile D1 同步） |
| `packages/core/solver.ts` 双轨调度 | 宿主机 CLI 与 shim 共享复用（支持直接调用 Flash/Pro 模型，或转交 agy） |
| `packages/adapters/chaoxing/homework.ts` 协议读写接口 | 宿主机复用（超星协议原生极速读写，节省内存；复杂防作弊页面切真机 Chromium） |
| `.env` 的 `AFK_EDGE_WORKER_URL` / `AFK_EDGE_BEARER_TOKEN` | 直接复用做回调通道 |

---

## 4. 实施清单（TODO）

### P0 地基（半天）

- [ ] `edge/` 引入 `agents` 包（`pnpm add agents`），`wrangler.jsonc` 升级：近期 `compatibility_date`、`nodejs_compat`、DO 绑定与迁移：
      ```jsonc
      "durable_objects": { "bindings": [
        { "name": "SIGN_AGENT", "class_name": "SignAgent" },
        { "name": "SOLVER_AGENT", "class_name": "SolverAgent" } ] },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SignAgent", "SolverAgent"] }]
      ```
- [ ] cron 从 `* * * * *` 降为 `*/5 * * * *`（仅做 DO 唤醒兜底，实际节奏由 DO alarm 决定）
- [ ] 服务器：cloudflared tunnel 建立（shim 域名仅 tunnel 可达），`SHIM_TOKEN` 生成入 `.env`（两边）
- **验收**：`wrangler dev` 起 DO 不报错；tunnel 域名 curl 通（401）

### P1 shim + agy 模板（1 天，服务器侧）

- [ ] `packages/shim/src/index.ts`：HTTP 服务，Bearer 鉴权，四条路由 + 健康检查
- [ ] `/task`：组装 solve-draft prompt → `execFile('agy', ['-p', prompt, '--model', proModel, '--dangerously-skip-permissions'])`（复用 `solver.ts:154` 写法）→ 需要浏览器时先 `/browser start` → 解析 JSON → phase=draft_saved → 回调 DO
- [ ] `/submit`：submit 模板同理
- [ ] `/browser`：复用 `browser-profile.ts` 拉起/停止 Chromium，空闲 TTL 自停（定时器）
- [ ] **agy 串行锁**：同一时刻只跑一个 agy 进程（内存 ~1.5G/个），排队等锁
- [ ] systemd 单元（`Restart=always`）+ cloudflared 配置
- **验收**：`curl -H "Authorization: Bearer ..." -d '{"taskUrl":"<真实作业链接>",...}' /task` 走通"读题→解答→填→草稿"，`/status` 返回合法 qa JSON；手工确认草稿出现在学习通页面

### P2 SolverAgent DO（1~2 天，CF 侧）

- [ ] DO 骨架：`tasks`/`qa_cache` 建表；`routeAgentRequest` 挂进 edge Worker
- [ ] 派发流：`@callable enqueue(task)` → 去重（job_id 主键）→ deadline 分桶（>N 小时的攒静默时段 00:00–07:00 合并派发）→ 串行出队 → HTTP POST shim `/task`
- [ ] 回调接收：`/api/agent/callback` 转交 DO → 写 `qa_json`/`summary` → 逐题 hash 写 `qa_cache` → status=draft_saved → 通知
- [ ] 兜底轮询：alarm 每 2 分钟查 dispatched 超 15 分钟的任务 → `/status` 对账 → 回调丢失可推进
- [ ] 重试：failed → 退避重派（最多 3 次）→ 仍败则通知人工
- [ ] 审批门：status=awaiting_approval；`/api/tasks/:id/approve`（看板按钮 / Bark·TG 回指令）→ POST shim `/submit` → submitted → 通知收尾
- [ ] 自动提交开关：`AUTO_SUBMIT_HOMEWORK=true` 时 draft_saved 直接链 submit
- **验收**：手工 `enqueue` 一份真实作业，全链路"派发→草稿→通知→确认→提交"闭环跑通；kill shim 再恢复，任务靠轮询对账不丢

### P3 SignAgent 巡检（1 天，CF 侧）

- [ ] 移植 `edge/src/chaoxing.ts` 签到+红点探测逻辑进 DO
- [ ] 课表窗口调度：`schedule()`/`scheduleEvery()` 按课程表时段 + 随机抖动（±90s）巡检，非上课时段降频到每小时一次保活探测
- [ ] 会话缓存进 DO storage（6h TTL，失效重登），签到成功即通知
- [ ] 红点 → 组装 `{taskUrl, deadline}` → 调 SolverAgent.enqueue
- [ ] 退掉旧 `handleEdgeHeartbeat` 每分钟全量扫路径
- **验收**：连续 3 天窗口内自动签到成功；出站请求量较每分钟方案降一个数量级（可在 DO 计数验证）；发现新作业自动入队

### P4 收尾（半天）

- [ ] 看板：任务状态机五态展示 + 审批按钮 + qa 预览
- [ ] 通知分级：发现=普通、草稿好=重要（带确认引导）、失败=重要
- [ ] 文档：README 更新架构图与新部署步骤；`.env.example` 增补 `SHIM_TOKEN`/tunnel 项
- [ ] 端到端演练：一份真实作业从发现到提交全自动化（开 auto）+ 一份走人工审批
- [ ] 观察一周后：旧 `pnpm afk solve` 路径标记 deprecated（保留为人工兜底）

---

## 5. 风险与注意事项

1. **回调安全**：`/api/agent/callback` 必须校验 `AFK_EDGE_BEARER_TOKEN`；shim 域名只走 tunnel，不开公网端口
2. **agy 串行**：并发 spawn 会 OOM（单进程峰值 ~1.5G），shim 锁 + DO 串行出队双保险
3. **风控节奏**：巡检窗口化+抖动是刻意设计，不要图省事退回每分钟轮询；提交动作集中在确认后立即执行，不批量连点
4. **配额监控**：agy 每任务消耗上升（自己拉内容多了 loop 轮次），头两周记录每任务耗时/轮次，超预期再考虑客观题批量通道的补充方案
5. **草稿即检查点**：draft_saved 是天然断点，submit 独立成指令的意义就在这——审批门前的一切失败都可以安全重派
6. **DO 免费额度**：SQLite DO 免费层有请求数/时长限制，巡检频率别设过密；看板高频读走 D1 而不是打 DO
7. **回滚**：任一阶段失败，旧 cron 路径（P3 退掉前）与 `pnpm afk solve` 人工路径都在，可随时退回
