export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<Array<{ results?: unknown[] }>>;
}

export interface KVNamespaceLike {
  get(key: string, type?: string): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): any;
  get(id: any): any;
}

export interface EdgeEnv {
  DB?: D1DatabaseLike;
  KV?: KVNamespaceLike;
  CHAOXING_KV?: KVNamespaceLike;
  SIGN_AGENT?: DurableObjectNamespaceLike;
  SOLVER_AGENT?: DurableObjectNamespaceLike;
  AFK_SHIM_URL?: string;
  SHIM_URL?: string;
  AFK_SHIM_TOKEN?: string;
  SHIM_TOKEN?: string;
  AFK_EDGE_BEARER_TOKEN?: string;
  SYNC_SECRET?: string;
  CHAOXING_PHONE?: string;
  CHAOXING_PASSWORD?: string;
  CHAOXING_REALNAME?: string;
  CHAOXING_SIGN_LON?: string;
  CHAOXING_SIGN_LAT?: string;
  CHAOXING_SIGN_ADDRESS?: string;
  CHAOXING_LOCATIONS_JSON?: string;
  PHONE?: string;
  PASSWORD?: string;
  AUTO_SUBMIT_HOMEWORK?: string;
  HOMEWORK_SCAN_INTERVAL_MINUTES?: string;
  API_BEARER_TOKEN?: string;
  DASHBOARD_PASSWORD?: string;
  AFK_SHIM_SECRET?: string;
  AFK_TASK_HOST_ALLOWLIST?: string;
  WEBHOOK_URL?: string;
  SERVERCHAN_KEY?: string;
  BARK_KEY?: string;
}

export function nowUtc8(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)';
}

/**
 * 解析 UTC+8 格式化时间戳为毫秒数，避免在 V8 中出现 " (UTC+8)" 导致 Date.parse 返回 NaN
 */
export function parseUtc8ToMs(ts?: string | null): number {
  if (!ts) return NaN;
  const cleaned = ts.replace(/\s*\(UTC\+8\)\s*$/i, '').trim();
  const match = cleaned.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}+08:00`;
    return Date.parse(iso);
  }
  return Date.parse(cleaned);
}

/**
 * 读取缓存的平台登录 Session (优先 D1，回退 KV，6 小时 TTL 免重复登录)
 */
export async function getCachedSession<T>(env: EdgeEnv, platform: string, account: string): Promise<T | null> {
  const now = Date.now();
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT cookie_json, expires_at FROM sessions WHERE platform = ? AND account = ?'
      )
        .bind(platform, account)
        .first<{ cookie_json: string; expires_at: number }>();

      if (row && row.expires_at > now) {
        return JSON.parse(row.cookie_json) as T;
      }
    } catch {
      // 表未初始化或单次读取异常时静默降级
    }
  }

  const kv = env.KV || env.CHAOXING_KV;
  if (kv) {
    try {
      const cached = await kv.get(`session:${platform}:${account}`, 'json');
      if (cached) return cached as T;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * 保存平台登录 Session 到 D1 / KV (默认缓存 6 小时)
 */
export async function saveCachedSession(
  env: EdgeEnv,
  platform: string,
  account: string,
  sessionData: unknown,
  ttlSeconds = 6 * 3600
): Promise<void> {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const jsonStr = JSON.stringify(sessionData);
  const updatedAt = nowUtc8();

  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO sessions (platform, account, cookie_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, account) DO UPDATE SET
           cookie_json = excluded.cookie_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
        .bind(platform, account, jsonStr, expiresAt, updatedAt)
        .run();
    } catch {
      // ignore
    }
  }

  const kv = env.KV || env.CHAOXING_KV;
  if (kv) {
    try {
      await kv.put(`session:${platform}:${account}`, jsonStr, { expirationTtl: ttlSeconds });
    } catch {
      // ignore
    }
  }
}

/**
 * 从 taskId 或显式 workId 提取超星唯一作业 ID，避免 notice-work / hw / work 前缀差异导致重复入库
 */
export function extractChaoxingWorkId(taskId: string, explicitWorkId?: string | number): string {
  if (explicitWorkId !== undefined && explicitWorkId !== null) {
    const clean = String(explicitWorkId).trim();
    if (/^\d+$/.test(clean)) return clean;
  }
  const match =
    String(taskId || '').match(/^chaoxing-(?:notice-)?work-(\d+)/) ||
    String(taskId || '').match(/^chaoxing-hw-(\d+)$/);
  return match ? match[1] : '';
}

/**
 * 解析 D1 pending_tasks 中已存在的规范 task_id（优先保留携带 notice idCode 的 chaoxing-notice-work-* 行）
 */
export async function resolveCanonicalPendingTaskId(
  db: D1DatabaseLike,
  incomingTaskId: string,
  explicitWorkId?: string | number
): Promise<string> {
  const workId = extractChaoxingWorkId(incomingTaskId, explicitWorkId);
  if (!workId) return incomingTaskId;

  try {
    const res = await db
      .prepare(
        `SELECT task_id FROM pending_tasks
         WHERE task_id = ?
            OR task_id LIKE ?
            OR task_id = ?
            OR task_id = ?`
      )
      .bind(
        incomingTaskId,
        `chaoxing-notice-work-${workId}-%`,
        `chaoxing-hw-${workId}`,
        `chaoxing-work-${workId}`
      )
      .all<{ task_id: string }>();

    const rows = res?.results || [];
    if (rows.length === 0) return incomingTaskId;

    const noticeRow = rows.find((r) => r.task_id.startsWith('chaoxing-notice-work-'));
    if (noticeRow) return noticeRow.task_id;
    const exactRow = rows.find((r) => r.task_id === incomingTaskId);
    return exactRow ? exactRow.task_id : rows[0].task_id;
  } catch {
    return incomingTaskId;
  }
}

/**
 * 写入或更新待办作业/评测任务（供 GCP 上 agy + Cloudflare Plugin 或 Cloud Run 消费）
 */
export async function upsertPendingTask(
  env: EdgeEnv,
  task: {
    taskId: string;
    platform: string;
    courseId: string;
    classId: string;
    courseName: string;
    title: string;
    status?: string;
    computeTier?: string;
    deadline?: string;
    payload?: unknown;
  }
): Promise<boolean> {
  if (!env.DB) return false;
  const ts = nowUtc8();
  const payloadStr = task.payload ? JSON.stringify(task.payload) : null;

  try {
    const canonicalTaskId = await resolveCanonicalPendingTaskId(
      env.DB,
      task.taskId,
      task.payload && typeof task.payload === 'object' ? (task.payload as any).workId : undefined
    );
    task = { ...task, taskId: canonicalTaskId };

    // 若已存在且状态为 submitted / draft_saved，则不覆盖其已完成状态；若新数据携带 notice idCode，仅补充合并 payload_json
    const existing = await env.DB.prepare('SELECT status, payload_json FROM pending_tasks WHERE task_id = ?')
      .bind(task.taskId)
      .first<{ status: string; payload_json?: string }>();

    if (existing && (existing.status === 'submitted' || existing.status === 'draft_saved')) {
      if (task.payload && typeof task.payload === 'object') {
        try {
          const prevPayload = existing.payload_json ? JSON.parse(existing.payload_json) : {};
          const incomingPayload = task.payload as Record<string, unknown>;
          if (incomingPayload.idCode && !prevPayload.idCode) {
            const mergedPayload = JSON.stringify({ ...prevPayload, ...incomingPayload });
            await env.DB.prepare('UPDATE pending_tasks SET payload_json = ?, updated_at = ? WHERE task_id = ?')
              .bind(mergedPayload, ts, task.taskId)
              .run();
          }
        } catch {
          // ignore
        }
      }
      return false;
    }

    await env.DB.prepare(
      `INSERT INTO pending_tasks (
         task_id, platform, course_id, class_id, course_name, title, status, compute_tier, deadline, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         title = excluded.title,
         deadline = excluded.deadline,
         payload_json = COALESCE(excluded.payload_json, pending_tasks.payload_json),
         updated_at = excluded.updated_at`
    )
      .bind(
        task.taskId,
        task.platform,
        task.courseId,
        task.classId,
        task.courseName,
        task.title,
        task.status || 'pending',
        task.computeTier || 'tier1-cloud-run',
        task.deadline || '',
        payloadStr,
        ts,
        ts
      )
      .run();

    return !existing; // 返回是否为新发现的任务
  } catch {
    return false;
  }
}

/**
 * 查询题库 SHA-256 缓存
 */
export async function lookupQuestionCache(
  env: EdgeEnv,
  hashes: string[]
): Promise<Record<string, { answer: string; modelTier: string }>> {
  const result: Record<string, { answer: string; modelTier: string }> = {};
  if (!env.DB || hashes.length === 0) return result;

  try {
    const placeholders = hashes.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT question_hash, answer, model_tier FROM question_bank WHERE question_hash IN (${placeholders})`
    )
      .bind(...hashes)
      .all<{ question_hash: string; answer: string; model_tier: string }>();

    for (const r of rows.results || []) {
      result[r.question_hash] = { answer: r.answer, modelTier: r.model_tier };
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * 批量写入题库 SHA-256 缓存
 */
export async function upsertQuestionCache(
  env: EdgeEnv,
  items: Array<{
    questionHash: string;
    platform: string;
    questionType: string;
    title: string;
    optionsJson?: string;
    answer: string;
    modelTier: string;
    confidence?: number;
  }>
): Promise<number> {
  if (!env.DB || items.length === 0) return 0;
  const ts = nowUtc8();
  let count = 0;

  for (const item of items) {
    try {
      await env.DB.prepare(
        `INSERT INTO question_bank (
           question_hash, platform, question_type, title, options_json, answer, model_tier, confidence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(question_hash) DO UPDATE SET
           answer = excluded.answer,
           model_tier = excluded.model_tier,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`
      )
        .bind(
          item.questionHash,
          item.platform,
          item.questionType,
          item.title,
          item.optionsJson || null,
          item.answer,
          item.modelTier,
          item.confidence ?? 1.0,
          ts
        )
        .run();
      count++;
    } catch {
      // ignore single row failure
    }
  }
  return count;
}

/**
 * 记录执行审计日志 (UTC+8)
 */
export async function logExecution(
  env: EdgeEnv,
  eventType: string,
  platform: string,
  summary: string,
  detail?: unknown
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO execution_logs (event_type, platform, summary, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(eventType, platform, summary, detail ? JSON.stringify(detail) : null, nowUtc8())
      .run();
  } catch {
    // ignore
  }
}

/**
 * 保存超星通知列表至 D1 (联动自动登记作业与测验到待办任务 pending_tasks)
 */
export async function saveNotices(
  env: EdgeEnv,
  notices: Array<{
    idCode: string;
    title: string;
    createrName: string;
    sendTime: string;
    content: string;
    tag?: string;
    sourceType?: number;
    rawJson?: string;
    examInfo?: {
      examId: string;
      title: string;
      courseId: string;
      courseName: string;
      classId: string;
      url: string;
      startTime: string;
      endTime: string;
      isExpired: boolean;
    };
    workInfo?: {
      workId: string;
      title: string;
      courseId: string;
      courseName: string;
      classId: string;
      url: string;
      startTime: string;
      endTime: string;
    };
  }>
): Promise<number> {
  if (!env.DB || notices.length === 0) return 0;
  const ts = nowUtc8();
  let savedCount = 0;

  for (const n of notices) {
    if (!n.idCode) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO notices (
           id_code, title, creater_name, send_time, content, tag, source_type, raw_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id_code) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      )
        .bind(
          n.idCode,
          n.title,
          n.createrName,
          n.sendTime,
          n.content,
          n.tag || '',
          n.sourceType || 0,
          n.rawJson || JSON.stringify(n),
          ts
        )
        .run();
      savedCount++;

      // 如果通知内包含作业，联动写入待办作业队列 pending_tasks
      if (n.workInfo && n.workInfo.courseId && n.workInfo.classId) {
        await upsertPendingTask(env, {
          taskId: `chaoxing-notice-work-${n.workInfo.workId}-${n.workInfo.classId}`,
          platform: 'chaoxing',
          courseId: n.workInfo.courseId,
          classId: n.workInfo.classId,
          courseName: n.workInfo.courseName,
          title: n.workInfo.title,
          deadline: n.workInfo.endTime || '',
          payload: {
            url: n.workInfo.url,
            idCode: n.idCode,
            type: 'homework_notice',
          },
        });
      }

      // 如果通知内包含未截止考试/测验，联动写入 pending_tasks 方便监控与作答
      if (n.examInfo && n.examInfo.courseId && n.examInfo.classId && !n.examInfo.isExpired) {
        await upsertPendingTask(env, {
          taskId: `chaoxing-notice-exam-${n.examInfo.examId}-${n.examInfo.classId}`,
          platform: 'chaoxing',
          courseId: n.examInfo.courseId,
          classId: n.examInfo.classId,
          courseName: n.examInfo.courseName,
          title: `[测验] ${n.examInfo.title}`,
          deadline: n.examInfo.endTime || '',
          payload: {
            url: n.examInfo.url,
            idCode: n.idCode,
            type: 'exam_notice',
            startTime: n.examInfo.startTime,
          },
        });
      }
    } catch {
      // ignore
    }
  }

  return savedCount;
}

/**
 * 从 D1 查询最近通知
 */
export async function getNoticesFromD1(env: EdgeEnv, limit = 30): Promise<Array<any>> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      'SELECT id_code, title, creater_name, send_time, content, tag, source_type, raw_json FROM notices ORDER BY send_time DESC LIMIT ?'
    )
      .bind(limit)
      .all<any>();
    return rows.results || [];
  } catch {
    return [];
  }
}

export interface EnrolledCourseRecord {
  courseId: string;
  classId: string;
  platform?: string;
  courseName: string;
  cpi?: string;
  teacherName?: string;
}

/**
 * 批量持久化用户在读课程全量列表到 D1
 */
export async function saveEnrolledCourses(
  env: EdgeEnv,
  courses: EnrolledCourseRecord[]
): Promise<number> {
  if (!env.DB || courses.length === 0) return 0;
  const ts = nowUtc8();
  let saved = 0;
  for (const c of courses) {
    try {
      await env.DB.prepare(
        `INSERT INTO enrolled_courses (course_id, class_id, platform, course_name, cpi, teacher_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, course_id, class_id) DO UPDATE SET
           course_name = excluded.course_name,
           cpi = excluded.cpi,
           teacher_name = COALESCE(excluded.teacher_name, enrolled_courses.teacher_name),
           updated_at = excluded.updated_at`
      )
        .bind(c.courseId, c.classId, c.platform || 'chaoxing', c.courseName, c.cpi || '', c.teacherName || '', ts)
        .run();
      saved++;
    } catch {
      // ignore
    }
  }
  return saved;
}

/**
 * 从 D1 查询已持久化的在读课程列表
 */
export async function getEnrolledCoursesFromD1(
  env: EdgeEnv
): Promise<Array<{ courseId: string; classId: string; courseName: string; cpi?: string; teacherName?: string }>> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      'SELECT course_id as courseId, class_id as classId, course_name as courseName, cpi, teacher_name as teacherName FROM enrolled_courses ORDER BY updated_at DESC'
    ).all<any>();
    return rows.results || [];
  } catch {
    return [];
  }
}

export interface DiscussionRecord {
  discussionId: string;
  platform?: string;
  topicId: string;
  courseId: string;
  classId: string;
  courseName: string;
  author?: string;
  title: string;
  prompt: string;
  chapterLabel?: string;
  topicUrl: string;
  bbsUrl?: string;
  replyParams?: Record<string, unknown> | null;
  status?:
    | 'pending'
    | 'drafting'
    | 'awaiting_approval'
    | 'publishing'
    | 'submitted'
    | 'replied_externally'
    | 'ignored'
    | 'failed';
  draftReply?: string;
  postedReply?: string;
  modelUsed?: string;
  replyCount?: number;
  isTeacherTopic?: boolean;
  publishedAt?: string;
  updatedAt?: string;
}

/**
 * 检查 D1 pending_tasks 中该课程是否已有已知作业记录（用于避免对已暂存/已提交课程重复入队占位任务）
 */
export async function hasTrackedHomeworkForCourse(env: EdgeEnv, courseId: string): Promise<boolean> {
  if (!env.DB || !courseId) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT task_id FROM pending_tasks
       WHERE course_id = ? AND status IN ('pending', 'dispatched', 'processing', 'draft_saved', 'awaiting_approval')
       LIMIT 1`
    )
      .bind(courseId)
      .first<{ task_id: string }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 查询已登记的讨论帖轻量索引，避免 Cron 扫描时对未变动帖子重复抓取详情页消耗 Workers 子请求配额
 */
export async function getKnownDiscussionMetaMap(
  env: EdgeEnv,
  courseId?: string
): Promise<Map<string, { status: string; replyCount: number }>> {
  const map = new Map<string, { status: string; replyCount: number }>();
  if (!env.DB) return map;
  try {
    const stmt = courseId
      ? env.DB.prepare('SELECT topic_id, status, reply_count FROM discussions WHERE course_id = ?').bind(courseId)
      : env.DB.prepare('SELECT topic_id, status, reply_count FROM discussions');
    const res = await stmt.all<{ topic_id: string; status: string; reply_count: number }>();
    for (const r of res.results || []) {
      map.set(String(r.topic_id), { status: r.status, replyCount: Number(r.reply_count || 0) });
    }
  } catch {
    // 迁移未就绪时容错
  }
  return map;
}

/**
 * 写入或刷新探测到的课程讨论话题（绝不覆盖已拟稿/已提交/已忽略状态）
 * @returns true 表示这是一条新发现的、尚未回复的教师讨论话题
 */
export async function upsertDiscoveredDiscussion(
  env: EdgeEnv,
  item: DiscussionRecord & { myReplied?: boolean }
): Promise<boolean> {
  if (!env.DB) return false;
  const ts = nowUtc8();
  const replyParamsJson = item.replyParams ? JSON.stringify(item.replyParams) : null;

  try {
    const existing = await env.DB.prepare(
      'SELECT status, draft_reply FROM discussions WHERE discussion_id = ?'
    )
      .bind(item.discussionId)
      .first<{ status: string; draft_reply?: string }>();

    if (existing) {
      let nextStatus = existing.status;
      if (item.myReplied && existing.status !== 'submitted' && existing.status !== 'publishing') {
        nextStatus = 'replied_externally';
      }

      await env.DB.prepare(
        `UPDATE discussions SET
           course_name = CASE WHEN ? != '' THEN ? ELSE course_name END,
           author = COALESCE(NULLIF(?, ''), author),
           title = CASE WHEN ? != '' THEN ? ELSE title END,
           prompt = CASE WHEN ? != '' THEN ? ELSE prompt END,
           chapter_label = COALESCE(?, chapter_label),
           topic_url = COALESCE(NULLIF(?, ''), topic_url),
           bbs_url = COALESCE(NULLIF(?, ''), bbs_url),
           reply_params_json = COALESCE(?, reply_params_json),
           reply_count = ?,
           is_teacher_topic = ?,
           status = ?,
           updated_at = ?
         WHERE discussion_id = ?`
      )
        .bind(
          item.courseName || '',
          item.courseName || '',
          item.author || '',
          item.title || '',
          item.title || '',
          item.prompt || '',
          item.prompt || '',
          item.chapterLabel || null,
          item.topicUrl || '',
          item.bbsUrl || '',
          replyParamsJson,
          Number(item.replyCount || 0),
          item.isTeacherTopic === false ? 0 : 1,
          nextStatus,
          ts,
          item.discussionId
        )
        .run();

      return false;
    }

    const initialStatus = item.myReplied ? 'replied_externally' : item.status || 'pending';
    await env.DB.prepare(
      `INSERT INTO discussions (
         discussion_id, platform, topic_id, course_id, class_id, course_name, author,
         title, prompt, chapter_label, topic_url, bbs_url, reply_params_json,
         status, draft_reply, model_used, reply_count, is_teacher_topic, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        item.discussionId,
        item.platform || 'chaoxing',
        item.topicId,
        item.courseId,
        item.classId,
        item.courseName || `课程_${item.courseId}`,
        item.author || '',
        item.title,
        item.prompt,
        item.chapterLabel || '',
        item.topicUrl,
        item.bbsUrl || '',
        replyParamsJson,
        initialStatus,
        item.draftReply || null,
        item.modelUsed || null,
        Number(item.replyCount || 0),
        item.isTeacherTopic === false ? 0 : 1,
        ts,
        ts
      )
      .run();

    return initialStatus === 'pending';
  } catch {
    return false;
  }
}

export async function saveDiscussionDraft(
  env: EdgeEnv,
  discussionId: string,
  draftReply: string,
  modelUsed?: string
): Promise<boolean> {
  if (!env.DB) return false;
  const ts = nowUtc8();
  try {
    await env.DB.prepare(
      `UPDATE discussions
       SET draft_reply = ?,
           model_used = COALESCE(?, model_used),
           status = CASE WHEN status IN ('submitted', 'publishing', 'replied_externally') THEN status ELSE 'awaiting_approval' END,
           updated_at = ?
       WHERE discussion_id = ?`
    )
      .bind(draftReply, modelUsed || null, ts, discussionId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function markDiscussionPublished(
  env: EdgeEnv,
  discussionId: string,
  postedReply: string
): Promise<boolean> {
  if (!env.DB) return false;
  const ts = nowUtc8();
  try {
    await env.DB.prepare(
      `UPDATE discussions
       SET status = 'submitted',
           posted_reply = ?,
           draft_reply = ?,
           published_at = ?,
           updated_at = ?
       WHERE discussion_id = ?`
    )
      .bind(postedReply, postedReply, ts, ts, discussionId)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子抢占讨论帖发布锁：仅当状态既非 submitted、publishing 也非 replied_externally 时写入 publishing
 */
export async function claimDiscussionForPublishing(
  env: EdgeEnv,
  discussionId: string
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const res = (await env.DB.prepare(
      `UPDATE discussions
       SET status = 'publishing', updated_at = ?
       WHERE discussion_id = ? AND status NOT IN ('submitted', 'publishing', 'replied_externally')`
    )
      .bind(nowUtc8(), discussionId)
      .run()) as { success?: boolean; meta?: { changes?: number } } | undefined;

    if (res?.meta && typeof res.meta.changes === 'number') {
      return res.meta.changes > 0;
    }
    return res?.success !== false;
  } catch {
    return false;
  }
}

/**
 * 发布失败时安全回退状态至 awaiting_approval（仅回退仍处于 publishing 锁中的记录）
 */
export async function restoreDiscussionAfterPublishFailure(
  env: EdgeEnv,
  discussionId: string
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    await env.DB.prepare(
      `UPDATE discussions
       SET status = 'awaiting_approval', updated_at = ?
       WHERE discussion_id = ? AND status = 'publishing'`
    )
      .bind(nowUtc8(), discussionId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function updateDiscussionStatus(
  env: EdgeEnv,
  discussionId: string,
  status: NonNullable<DiscussionRecord['status']>
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    await env.DB.prepare('UPDATE discussions SET status = ?, updated_at = ? WHERE discussion_id = ?')
      .bind(status, nowUtc8(), discussionId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function getDiscussionById(env: EdgeEnv, discussionId: string): Promise<any | null> {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare('SELECT * FROM discussions WHERE discussion_id = ?')
      .bind(discussionId)
      .first<any>();
  } catch {
    return null;
  }
}

export async function listDiscussions(
  env: EdgeEnv,
  statuses?: string[],
  limit = 100
): Promise<any[]> {
  if (!env.DB) return [];
  try {
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `SELECT * FROM discussions WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`
      )
        .bind(...statuses, limit)
        .all<any>();
      return res.results || [];
    }
    const res = await env.DB.prepare('SELECT * FROM discussions ORDER BY updated_at DESC LIMIT ?')
      .bind(limit)
      .all<any>();
    return res.results || [];
  } catch {
    return [];
  }
}
