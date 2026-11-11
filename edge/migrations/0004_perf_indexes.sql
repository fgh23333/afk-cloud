-- ============================================================================
-- afk-cloud Cloudflare D1 Migration (0004_perf_indexes.sql)
-- 性能优化索引：加速任务队列检索、题库查询、审计日志分流与课程映射
-- 幂等设计：全部采用 IF NOT EXISTS 语法，支持无缝重复执行与安全回滚
-- ============================================================================

-- 1. 待办任务队列索引：加速状态与截止时间复合检索、课程维度过滤
CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_deadline ON pending_tasks(status, deadline);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_course_status ON pending_tasks(course_id, status);

-- 2. 题库索引：加速按平台与题型复合检索历史命中结果
CREATE INDEX IF NOT EXISTS idx_question_bank_lookup ON question_bank(platform, question_type, updated_at);

-- 3. 审计日志索引：支持按事件类型与时间降序高效分流检索
CREATE INDEX IF NOT EXISTS idx_execution_logs_event_type ON execution_logs(event_type, created_at DESC);

-- 4. 会话表索引：优化过期会话扫描与回收
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
