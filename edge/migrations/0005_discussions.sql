-- ============================================================================
-- afk-cloud Cloudflare D1 Migration (0005_discussions.sql)
-- 学习通课程讨论区（话题讨论）监听、AI 拟稿草稿与人工审批发布状态表
-- 幂等设计：全部采用 IF NOT EXISTS 语法，支持重复执行与安全回滚
-- ============================================================================

CREATE TABLE IF NOT EXISTS discussions (
  discussion_id TEXT PRIMARY KEY, -- 规范 ID，例如 chaoxing-bbs-726151794
  platform TEXT NOT NULL DEFAULT 'chaoxing',
  topic_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  author TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  chapter_label TEXT,
  topic_url TEXT NOT NULL,
  bbs_url TEXT,
  reply_params_json TEXT, -- { clazzid, topicId, cpi, ut, openc, showChooseClazzId }
  status TEXT NOT NULL DEFAULT 'pending', -- pending | drafting | awaiting_approval | submitted | replied_externally | ignored | failed
  draft_reply TEXT,
  posted_reply TEXT,
  model_used TEXT,
  reply_count INTEGER DEFAULT 0,
  is_teacher_topic INTEGER DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussions_course ON discussions(course_id, class_id);
