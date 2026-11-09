export interface EdgeEnv {
  DB?: D1Database;
  KV?: KVNamespace;
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
  WEBHOOK_URL?: string;
  SERVERCHAN_KEY?: string;
  BARK_KEY?: string;
}

export function nowUtc8(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)';
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

  if (env.KV) {
    try {
      const cached = await env.KV.get(`session:${platform}:${account}`, 'json');
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

  if (env.KV) {
    try {
      await env.KV.put(`session:${platform}:${account}`, jsonStr, { expirationTtl: ttlSeconds });
    } catch {
      // ignore
    }
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
    // 若已存在且状态为 submitted / draft_saved，则不覆盖其已完成状态
    const existing = await env.DB.prepare('SELECT status FROM pending_tasks WHERE task_id = ?')
      .bind(task.taskId)
      .first<{ status: string }>();

    if (existing && (existing.status === 'submitted' || existing.status === 'draft_saved')) {
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
