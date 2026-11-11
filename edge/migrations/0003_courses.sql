-- ============================================================================
-- afk-cloud Cloudflare D1 Migration (0003_courses.sql)
-- 记录用户在读课程全量清单，避免因作业未派发导致看板漏显课程
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrolled_courses (
  course_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'chaoxing',
  course_name TEXT NOT NULL,
  cpi TEXT,
  teacher_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, course_id, class_id)
);

CREATE INDEX IF NOT EXISTS idx_enrolled_courses_platform ON enrolled_courses(platform, updated_at DESC);
