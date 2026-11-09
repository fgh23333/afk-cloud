import {
  checkHomeworkPendingCourses,
  getCourses,
  login,
  performSign,
  resolveSignLocations,
  scanCourseActivities,
  UserSession,
} from './chaoxing';
import { getDashboardData, renderDashboardHtml } from './dashboard';
import { ExtendedNotifyEnv, sendDigestNotification, sendNotification } from './notify';
import {
  getCachedSession,
  logExecution,
  lookupQuestionCache,
  nowUtc8,
  saveCachedSession,
  upsertPendingTask,
  upsertQuestionCache,
} from './store';

function checkAuth(request: Request, env: ExtendedNotifyEnv): boolean {
  if (!env.API_BEARER_TOKEN) return true;
  const auth = request.headers.get('Authorization') || '';
  if (auth === `Bearer ${env.API_BEARER_TOKEN}`) return true;
  const url = new URL(request.url);
  return url.searchParams.get('token') === env.API_BEARER_TOKEN;
}

/**
 * 判断当前分钟是否命中定期汇总推送时刻 (默认每天 UTC+8 的 08:30 与 21:00 自动推送一次全景日报)
 */
function isScheduledDigestMinute(scheduledTimeMs: number): boolean {
  const utc8Date = new Date(scheduledTimeMs + 8 * 3600 * 1000);
  const hh = String(utc8Date.getUTCHours()).padStart(2, '0');
  const mm = String(utc8Date.getUTCMinutes()).padStart(2, '0');
  const hhmm = `${hh}:${mm}`;
  return hhmm === '08:30' || hhmm === '21:00';
}

export default {
  /**
   * Cloudflare Cron Trigger (每分钟定时触发，全天候 0 成本常驻边缘)
   * - 每 1 分钟：巡检活跃签到并秒签（不定期事件实时通知）
   * - 每 10 分钟：极速探测新作业红点并写入 D1 看板（发现新作业实时通知）
   * - 每天 08:30 & 21:00 (UTC+8)：自动推送各平台任务与完成状况汇总简报（定期通知）
   */
  async scheduled(event: ScheduledEvent, env: ExtendedNotifyEnv, ctx: ExecutionContext): Promise<void> {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const hwInterval = Math.max(1, parseInt(env.HOMEWORK_SCAN_INTERVAL_MINUTES || '10', 10));
    const shouldCheckHomework = minute % hwInterval === 0;
    const shouldSendDigest = isScheduledDigestMinute(event.scheduledTime);

    ctx.waitUntil(
      (async () => {
        await handleEdgeHeartbeat(env, shouldCheckHomework);
        if (shouldSendDigest) {
          const data = await getDashboardData(env);
          await sendDigestNotification(
            env,
            {
              ...data.stats,
              recentTasks: data.tasks,
            },
            '每日定时任务简报'
          );
        }
      })()
    );
  },

  /**
   * HTTP 路由：
   * - GET / 或 /dashboard : 渲染 Cloudflare 零服务器全景 Web 看板
   * - GET /api/dashboard  : 看板聚合数据 JSON
   * - POST /api/digest    : 手动触发一次全平台汇总通知推送
   * - GET /check          : 立即执行一次边缘签到与作业红点探测
   * - /api/tasks/*        : 供 GCP / Cloud Run 同步任务状态并触发完成通知
   */
  async fetch(request: Request, env: ExtendedNotifyEnv): Promise<Response> {
    const url = new URL(request.url);

    // 1. 零服务器 Web 全景看板首页
    if ((url.pathname === '/' || url.pathname === '/dashboard') && request.method === 'GET') {
      return new Response(renderDashboardHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

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

    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(request, env)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // 看板全量数据接口
      if (url.pathname === '/api/dashboard' && request.method === 'GET') {
        const data = await getDashboardData(env);
        return Response.json(data);
      }

      // 按需立即发送一次汇总简报通知
      if (url.pathname === '/api/digest' && request.method === 'POST') {
        const data = await getDashboardData(env);
        const text = await sendDigestNotification(
          env,
          {
            ...data.stats,
            recentTasks: data.tasks,
          },
          '即时汇总通知'
        );
        return Response.json({ sent: true, summary: text, time: nowUtc8() });
      }

      // 获取待办任务列表
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

      // 批量上报/更新任务状态（当 GCP / Cloud Run 扫描到新作业或完成解答后调用）
      if (url.pathname === '/api/tasks/sync' && request.method === 'POST') {
        const body: any = await request.json();
        const items: any[] = Array.isArray(body.tasks) ? body.tasks : [];
        let updatedCount = 0;

        for (const item of items) {
          await upsertPendingTask(env, {
            taskId: item.taskId,
            platform: item.platform || 'chaoxing',
            courseId: item.courseId || '',
            classId: item.classId || '',
            courseName: item.courseName || '',
            title: item.title || '',
            status: item.status || 'pending',
            computeTier: item.computeTier || 'tier1-cloud-run',
            deadline: item.deadline || '',
            payload: item.payload,
          });

          if (env.DB && (item.status === 'draft_saved' || item.status === 'submitted' || item.resultSummary)) {
            await env.DB.prepare(
              'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
            )
              .bind(item.status, item.resultSummary || '', nowUtc8(), item.taskId)
              .run();
          }

          if (item.status === 'draft_saved' || item.status === 'submitted') {
            const actionLabel = item.status === 'submitted' ? '已正式提交' : '已安全暂存草稿';
            const msg = `课程：《${item.courseName}》\n作业：《${item.title}》\n状态：${actionLabel}\n详情：${item.resultSummary || '双轨模型作答完成'}`;
            await logExecution(env, 'homework_solved', item.platform || 'chaoxing', `${actionLabel}：《${item.courseName}》- ${item.title}`);
            await sendNotification(`afk-cloud 作业${actionLabel}`, msg, env);
          }
          updatedCount++;
        }

        return Response.json({ synced: updatedCount, time: nowUtc8() });
      }

      // 更新单个任务状态
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

      // 批量查询题库 SHA-256 缓存
      if (url.pathname === '/api/cache/lookup' && request.method === 'POST') {
        const body: any = await request.json();
        const hits = await lookupQuestionCache(env, Array.isArray(body.hashes) ? body.hashes : []);
        return Response.json({ hits, time: nowUtc8() });
      }

      // 批量写入题库 SHA-256 缓存
      if (url.pathname === '/api/cache/upsert' && request.method === 'POST') {
        const body: any = await request.json();
        const count = await upsertQuestionCache(env, Array.isArray(body.items) ? body.items : []);
        return Response.json({ count, time: nowUtc8() });
      }

      // 获取边缘缓存的平台 Cookie / Browser Profile Session
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const platform = url.searchParams.get('platform') || 'chaoxing';
        const account = url.searchParams.get('account') || env.CHAOXING_PHONE || env.PHONE || 'default';
        const session = await getCachedSession(env, platform, account);
        return Response.json({ session, time: nowUtc8() });
      }

      // 上传/持久化浏览器 Profile 登录态 (storageState: Cookies + LocalStorage) 到 D1
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const body: any = await request.json();
        const platform = body.platform || 'web-profile:pta';
        const account = body.account || 'default';
        const ttlSeconds = Number(body.ttlSeconds) || 30 * 24 * 3600;
        await saveCachedSession(env, platform, account, body.session, ttlSeconds);
        return Response.json({ saved: true, platform, account, time: nowUtc8() });
      }
    }

    return new Response(renderDashboardHtml(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

async function handleEdgeHeartbeat(env: ExtendedNotifyEnv, checkHomework = false) {
  const phone = env.CHAOXING_PHONE || env.PHONE || '';
  const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
  const realname = env.CHAOXING_REALNAME || '同学';

  if (!phone || !password) {
    return {
      success: false,
      msg: '未配置 CHAOXING_PHONE 或 CHAOXING_PASSWORD (请运行 pnpm afk setup-cf 自动注入)',
      time: nowUtc8(),
    };
  }

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
        await sendNotification('afk-cloud 自动签到成功', `【${c.courseName}】\n${signRes}`, env);
      }
    } catch {
      // 单门课容错
    }
  }

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
        title: `《${pc.courseName}》检测到未交作业红点`,
        computeTier: 'tier1-cloud-run',
      });

      if (isNew) {
        await logExecution(
          env,
          'homework_detected',
          'chaoxing',
          `发现新待办作业：《${pc.courseName}》`,
          pc
        );
        await sendNotification(
          'afk-cloud 发现新待办作业',
          `课程：《${pc.courseName}》\n检测到未交作业红点，已登记至 Cloudflare 看板队列。`,
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
