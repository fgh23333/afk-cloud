-- ============================================================================
-- afk-cloud Cloudflare D1 Schema (0002_notices.sql)
-- 学习通班级通知、考试随堂测验与系统消息表
-- ============================================================================

CREATE TABLE IF NOT EXISTS notices (
  id_code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  creater_name TEXT NOT NULL,
  send_time TEXT NOT NULL,
  content TEXT,
  tag TEXT,
  source_type INTEGER,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notices_send_time ON notices(send_time DESC);
