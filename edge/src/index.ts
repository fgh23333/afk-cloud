import {
  checkHomeworkPendingCourses,
  getCourses,
  login,
  performSign,
  resolveSignLocations,
  scanCourseActivities,
  UserSession,
} from './chaoxing';
import { sendNotification } from './notify';
import {
  EdgeEnv,
  getCachedSession,
  logExecution,
  lookupQuestionCache,
  nowUtc8,
  saveCachedSession,
  upsertPendingTask,
  upsertQuestionCache,
} from './store';

function checkAuth(request: Request, env: EdgeEnv): boolean {
  if (!env.API_BEARER_TOKEN) return true;
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.API_BEARER_TOKEN}`;
}

export default {
  /**
   * Cloudflare Cron Trigger (每分钟定时触发，全天候 0 成本常驻)
   */
  async scheduled(event: ScheduledEvent, env: EdgeEnv, ctx: ExecutionContext): Promise<void> {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const hwInterval = Math.max(1, parseInt(env.HOMEWORK_SCAN_INTERVAL_MINUTES || '10', 10));
    const shouldCheckHomework = minute % hwInterval === 0;

    ctx.waitUntil(handleEdgeHeartbeat(env, shouldCheckHomework));
  },

  /**
   * HTTP 接口：支持手动巡检 (/check) 以及与 GCP Control Plane / Cloud Run 的缓存与任务同步
   */
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', time: nowUtc8(), hasD1: !!env.DB, hasKV: !!env.KV });
    }

    if (url.pathname === '/check' || url.pathname === '/run') {
      if (!checkAuth(request, env)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const result = await handleEdgeHeartbeat(env, true);
      return Response.json(result, { status: result.success ? 200 : 500 });
    }

    // --- 供 GCP Control Plane / Cloud Run 调用的 D1 桥接接口 ---
    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(request, env)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // 1. 获取待办任务列表
      if (url.pathname === '/api/tasks' && request.method === 'GET') {
        if (!env.DB) return Response.json({ tasks: [] });
        const status = url.searchParams.get('status') || 'pending';
        const rows = await env.DB.prepare(
          'SELECT * FROM pending_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT 50'
        )
          .bind(status)
          .all();
        return Response.json({ tasks: rows.results || [], time: nowUtc8() });
      }

      // 2. 更新任务状态
      if (url.pathname === '/api/tasks/status' && request.method === 'POST') {
        if (!env.DB) return Response.json({ updated: false });
        const body: any = await request.json();
        await env.DB.prepare(
          'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
        )
          .bind(body.status, body.resultSummary || '', nowUtc8(), body.taskId)
          .run();
        return Response.json({ updated: true, time: nowUtc8() });
      }

      // 3. 批量查询题库 SHA-256 缓存
      if (url.pathname === '/api/cache/lookup' && request.method === 'POST') {
        const body: any = await request.json();
        const hits = await lookupQuestionCache(env, Array.isArray(body.hashes) ? body.hashes : []);
        return Response.json({ hits, time: nowUtc8() });
      }

      // 4. 批量写入题库 SHA-256 缓存
      if (url.pathname === '/api/cache/upsert' && request.method === 'POST') {
        const body: any = await request.json();
        const count = await upsertQuestionCache(env, Array.isArray(body.items) ? body.items : []);
        return Response.json({ count, time: nowUtc8() });
      }

      // 5. 获取边缘缓存的平台 Cookie / Browser Profile Session (免去云端重复登录)
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const platform = url.searchParams.get('platform') || 'chaoxing';
        const account = url.searchParams.get('account') || env.CHAOXING_PHONE || env.PHONE || 'default';
        const session = await getCachedSession(env, platform, account);
        return Response.json({ session, time: nowUtc8() });
      }

      // 6. 上传/持久化浏览器 Profile 登录态 (storageState: Cookies + LocalStorage) 到 D1
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const body: any = await request.json();
        const platform = body.platform || 'web-profile:pta';
        const account = body.account || 'default';
        const ttlSeconds = Number(body.ttlSeconds) || 30 * 24 * 3600;
        await saveCachedSession(env, platform, account, body.session, ttlSeconds);
        return Response.json({ saved: true, platform, account, time: nowUtc8() });
      }
    }

    return new Response(
      `🌿 afk-cloud Tier 0 Edge Worker 已上线 🌿\n\n- 定时巡检：每 1 分钟自动检测签到，每 10 分钟探测新作业红点\n- 存储引擎：Cloudflare D1 (Cookie 缓存 + 待办队列 + 题库 SHA-256)\n- 手动巡检：GET /check\n- 健康检查：GET /health\n- 时区：UTC+8`,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};

async function handleEdgeHeartbeat(env: EdgeEnv, checkHomework = false) {
  const phone = env.CHAOXING_PHONE || env.PHONE || '';
  const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
  const realname = env.CHAOXING_REALNAME || '同学';

  if (!phone || !password) {
    return {
      success: false,
      msg: '未配置 CHAOXING_PHONE 或 CHAOXING_PASSWORD (请使用 wrangler secret put 注入)',
      time: nowUtc8(),
    };
  }

  // 1. 优先从 D1 / KV 获取缓存的登录 Session
  let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
  let sessionFromCache = true;

  if (!session) {
    session = await login(phone, password);
    sessionFromCache = false;
    if (!session) {
      await logExecution(env, 'error', 'chaoxing', '登录失败，请检查账号密码');
      return { success: false, msg: '登录失败', time: nowUtc8() };
    }
    await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
  }

  // 2. 获取在读课程列表（若因 Cookie 过期获取为空，自动强制重登一次）
  let courses = await getCourses(session);
  if (courses.length === 0 && sessionFromCache) {
    const freshSession = await login(phone, password);
    if (freshSession) {
      session = freshSession;
      sessionFromCache = false;
      await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
      courses = await getCourses(session);
    }
  }

  const signsExecuted: string[] = [];
  const homeworkCoursesDetected: string[] = [];
  const locations = resolveSignLocations(env);

  // 3. 遍历扫描活跃签到并立即秒签
  for (const c of courses) {
    try {
      const activities = await scanCourseActivities(c, session);
      for (const act of activities) {
        const signRes = await performSign(act, c, session, realname, locations);
        const summary = `《${c.courseName}》: ${signRes}`;
        signsExecuted.push(summary);

        await logExecution(env, 'signin', 'chaoxing', summary, {
          courseId: c.courseId,
          classId: c.classId,
          activeId: act.id,
        });
        await sendNotification('afk-cloud 自动签到通知', `【${c.courseName}】\n${signRes}`, env);
      }
    } catch {
      // 单门课容错
    }
  }

  // 4. 轻量级探测课程未交作业红点并写入 D1 待办表 (供 GCP agy / Cloud Run 消费)
  if (checkHomework && courses.length > 0) {
    const pendingCourses = await checkHomeworkPendingCourses(courses, session);
    for (const pc of pendingCourses) {
      homeworkCoursesDetected.push(pc.courseName);
      const isNew = await upsertPendingTask(env, {
        taskId: `chaoxing-course-hw-${pc.courseId}-${pc.classId}`,
        platform: 'chaoxing',
        courseId: pc.courseId,
        classId: pc.classId,
        courseName: pc.courseName,
        title: `《${pc.courseName}》存在待完成作业`,
        computeTier: 'tier1-cloud-run',
      });

      if (isNew) {
        await logExecution(
          env,
          'homework_detected',
          'chaoxing',
          `发现新待办作业课程：《${pc.courseName}》`,
          pc
        );
        await sendNotification(
          'afk-cloud 发现待办作业',
          `课程《${pc.courseName}》检测到未交作业红点，已写入 D1 待办队列，等待 GCP/Cloud Run 双轨求解器处理。`,
          env
        );
      }
    }
  }

  return {
    success: true,
    time: nowUtc8(),
    sessionFromCache,
    coursesCount: courses.length,
    signsExecuted,
    homeworkCoursesDetected,
  };
}
