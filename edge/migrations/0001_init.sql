-- ============================================================================
-- afk-cloud Cloudflare D1 Schema (0001_init.sql)
-- 所有时间统一存储为 UTC+8 (Asia/Shanghai) ISO 字符串与 Unix 毫秒时间戳
-- ============================================================================

-- 1. 平台会话 Cookie 缓存表 (避免每分钟 Cron 重复请求登录接口)
CREATE TABLE IF NOT EXISTS sessions (
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  cookie_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, account)
);

-- 2. 待办任务队列表 (Edge 探测到未交作业或新评测任务时写入，供 GCP agy / Cloud Run 消费)
CREATE TABLE IF NOT EXISTS pending_tasks (
  task_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  course_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | draft_saved | submitted | failed
  compute_tier TEXT NOT NULL DEFAULT 'tier1-cloud-run', -- tier0-edge | tier1-cloud-run | tier2-gce-burst
  deadline TEXT,
  payload_json TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_tasks_status ON pending_tasks(status, updated_at);

-- 3. 题库 SHA-256 哈希缓存表 (命中缓存 0 Token 秒回)
CREATE TABLE IF NOT EXISTS question_bank (
  question_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  question_type TEXT NOT NULL,
  title TEXT NOT NULL,
  options_json TEXT,
  answer TEXT NOT NULL,
  model_tier TEXT NOT NULL, -- cache | flash | pro | heuristic
  confidence REAL DEFAULT 1.0,
  updated_at TEXT NOT NULL
);

-- 4. 执行审计日志表 (记录签到、作业发现、弹性算力拉起事件，UTC+8)
CREATE TABLE IF NOT EXISTS execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL, -- signin | homework_detected | homework_solved | burst_triggered | error
  platform TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_created ON execution_logs(created_at DESC);
