# afk-cloud CI/CD、可观测性与自动回滚体系指南

本项目采用工业级云原生双轨架构（Cloudflare Serverless 边缘网关 + Google Cloud 重型计算），为保障 7×24h 零故障自愈，全面引入了 CI/CD 自动化门禁、实时可观测性指标监控与自动化熔断回滚机制。

---

## 一、 CI/CD 自动化流水线 (`.github/workflows/`)

### 1. 验证门禁 (`ci.yml`)
在每一次向 `main` 分支发起 Pull Request 或提交代码时，GitHub Actions 会自动触发以下全量安全核验：
* **静态类型检查 (`pnpm typecheck`)**：严格执行 TypeScript 5 编译与接口契约校验。
* **冒烟与核心链路测试 (`pnpm test`)**：覆盖加密、题库 SHA-256 哈希、课件 RAG 检索、代码沙箱执行、Server Shim 接口契约等 6 大核心自检。
* **零凭据入库安全扫描**：自动拦截未加密的 `.env` 或在 SQL 迁移脚本中硬编码的敏感口令。
* **D1 迁移脚本原子性校验**：强制要求所有的 `CREATE TABLE` 与 `CREATE INDEX` 包含 `IF NOT EXISTS` 幂等结构。

### 2. 持续交付与上线回滚保护 (`deploy.yml`)
* 每次合并入 `main` 分支且包含 `edge/**` 变更时触发自动构建。
* **端到端健康可观测性探活（Post-Deployment Probe）**：
  * 部署完成后，CI 流水线会对生产接口 `https://afk.idiotshoumy.com/health` 进行连续重试探测。
  * 校验项包含 D1 真实数据往返延迟 (`d1_latency_ms`)、D1 连接性与核心任务队列表健康度。
* **故障自动熔断回滚（Automated Rollback）**：
  * 若探测返回非 200 或状态为 `degraded/down`，CI 会在 30 秒内直接触发 `wrangler rollback`，立即将生产流量回滚至上一稳定版本。

---

## 二、 生产可观测性（Observability & Metrics）

### 1. 结构化健康诊断端点
* **地址**：`GET /health` 或 `GET /api/health`
* **响应示例**：
  ```json
  {
    "status": "healthy",
    "version": "1.0.4",
    "timestamp": "2026/11/11 22:42:00 (UTC+8)",
    "latency_ms": 14,
    "components": {
      "d1": {
        "status": "healthy",
        "latency_ms": 3
      },
      "kv": { "configured": true },
      "agents": { "sign_agent": true, "solver_agent": true }
    },
    "queue_metrics": {
      "pending": 10,
      "draft_saved": 0,
      "failed": 0
    }
  }
  ```

### 2. Prometheus 兼容指标端点
* **地址**：`GET /metrics` 或 `GET /api/metrics`
* **用途**：可直接接入 Google Cloud Ops Agent (OpenTelemetry Collector)、Prometheus 或 Datadog 进行指标采集与告警大盘配置。
* **暴露指标**：
  * `afk_health_status`：系统整体健康度（1 正常，0 降级）。
  * `afk_d1_latency_ms`：D1 SQLite 底层查询往返延迟（毫秒）。
  * `afk_tasks_count{status="..."}`：按状态分类的任务队列滞留度。

---

## 三、 手动应急回滚命令速查

若遇到极端异常或需人工介入时，可使用以下指令即刻恢复：

### 1. Cloudflare 边缘端即时秒级回滚
```bash
# 查看最近成功部署的版本历史
npx wrangler deployments list

# 一键秒级回退至上一个正常版本
npx wrangler rollback
```

### 2. 数据库迁移回退策略
本项目的 SQL 迁移脚本均采用追加式非破坏性设计（如 `0004_perf_indexes.sql` 为索引加速）。若需移除索引，执行：
```sql
DROP INDEX IF EXISTS idx_pending_tasks_status_deadline;
DROP INDEX IF EXISTS idx_pending_tasks_course_status;
DROP INDEX IF EXISTS idx_question_bank_lookup;
DROP INDEX IF EXISTS idx_execution_logs_event_type;
```

---

## 四、 Tier 2: Google Cloud Run 无服务器算力灾备节点

当本地虚拟机出现高负载计算或网络瞬断时，系统支持通过无服务器容器实现平滑故障转移：

* **构建与部署**：
  ```bash
  bash infra/gcp/deploy-cloud-run-service.sh
  ```
* **核心特性**：
  * **按需冷启动与零闲置计费 (`min-instances=0`)**：无流量时不占用任何 vCPU/内存资源，100% 落在 Google Cloud 每月 200 万次请求 + 360,000 vCPU-秒免费额度内。
  * **Fail-Closed HMAC 签名校验**：所有派发请求均由 Edge Worker 通过 HMAC-SHA256 签名，防止公网未授权访问。

---

## 五、 超星 WebIM 实时信令监听管道

为规避定时轮询引发的超星接口频控（“请勿频繁操作”），系统引入了基于环信 IM 课程群信令的事件驱动监听器：

* **核心模块**：[`packages/adapters/chaoxing/webim.ts`](file:///home/Jimmy/afk-cloud/packages/adapters/chaoxing/webim.ts)
* **信令抽取**：实时解析群聊消息正文与 `ext` 自定义载荷，100ms 级别捕获 `activeId` 并触发 `performSign`。
* **降级容灾**：当 WebSocket 离线时，系统自动保持 `taskactivelist` 移动抗风控接口兜底，主备无缝切换。

