import { routeAgentRequest } from 'agents';
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
import { SignAgent } from './sign-agent';
import { SolverAgent } from './solver-agent';
import {
  getCachedSession,
  logExecution,
  lookupQuestionCache,
  nowUtc8,
  saveCachedSession,
  upsertPendingTask,
  upsertQuestionCache,
} from './store';

export { SignAgent, SolverAgent };

function checkAuth(request: Request, env: ExtendedNotifyEnv): boolean {
  if (!env.API_BEARER_TOKEN) return true;
  const auth = request.headers.get('Authorization') || '';
  if (auth === `Bearer ${env.API_BEARER_TOKEN}`) return true;
  const url = new URL(request.url);
  return url.searchParams.get('token') === env.API_BEARER_TOKEN;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function corsJson(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function corsText(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...corsHeaders(),
    },
  });
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
        // 优先使用 SignAgent Durable Object 驱动巡检与秒签
        if (env.SIGN_AGENT) {
          try {
            const signStub = env.SIGN_AGENT.get(env.SIGN_AGENT.idFromName('default'));
            await (signStub as any).checkInspection();
          } catch (e: any) {
            console.warn(`[SignAgent scheduled 异常] ${e?.message || e}，回退至原生巡检`);
            await handleEdgeHeartbeat(env, shouldCheckHomework);
          }
        } else {
          await handleEdgeHeartbeat(env, shouldCheckHomework);
        }

        // SolverAgent 状态对账兜底 (查超时未响应的 dispatched 任务)
        if (env.SOLVER_AGENT) {
          try {
            const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
            await (solverStub as any).reconcileDispatchedTasks();
          } catch (e: any) {
            console.warn(`[SolverAgent 对账异常] ${e?.message || e}`);
          }
        }

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

    // 0. CORS 跨域预检快速通道 (支持 Web 前端跨域调用边缘 Worker)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(),
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 1. Cloudflare Agents SDK 原生路由派发 (如 /agents/sign-agent/... 与 /agents/solver-agent/...)
    try {
      const agentRes = await routeAgentRequest(request, env);
      if (agentRes) return agentRes;
    } catch (e: any) {
      console.warn(`[routeAgentRequest 提示] ${e?.message || e}`);
    }

    // 1. 零服务器 Web 全景看板静态 HTML (当直接通过浏览器访问 Worker 根路径时呈现)
    if ((url.pathname === '/' || url.pathname === '/dashboard') && request.method === 'GET') {
      return new Response(renderDashboardHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    if (url.pathname === '/health') {
      return corsJson({ status: 'ok', time: nowUtc8(), hasD1: !!env.DB, hasKV: !!(env.KV || env.CHAOXING_KV) });
    }

    // 2. 超星 Web 前端适配接口 (零服务器边缘化签到与登录态复用)
    if (url.pathname === '/login' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const phone = body.phone || '';
      const password = body.password || '';
      if (!phone || !password) return corsText('AuthFailed');

      const session = await login(phone, password);
      if (!session) return corsText('AuthFailed');

      const realname = env.CHAOXING_REALNAME || '同学';
      await saveCachedSession(env, 'chaoxing', phone, session, 24 * 3600);

      return corsJson({
        name: realname,
        phone,
        _uid: session._uid,
        uf: session.uf,
        vc3: session.vc3,
        _d: session._d,
        fid: session.fid,
        lv: '0',
      });
    }

    if (url.pathname === '/activity' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const session: UserSession = {
        _uid: body.uid || body._uid || '',
        _d: body._d || '',
        vc3: body.vc3 || '',
        uf: body.uf || '',
        fid: body.fid || '2893',
        cookie: `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}; fid=${body.fid || '2893'}`,
      };

      const courses = await getCourses(session);
      if (courses.length === 0) return corsText('NoCourse');

      for (const course of courses) {
        try {
          const acts = await scanCourseActivities(course, session);
          if (acts.length > 0) {
            const act = acts[0];
            return corsJson({
              name: act.name,
              activeId: Number(act.id),
              courseId: course.courseId,
              classId: course.classId,
              otherId: act.otherId,
            });
          }
        } catch {
          // 单门课跳过
        }
      }
      return corsText('NoActivity');
    }

    if (url.pathname === '/general' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const session: UserSession = {
        _uid: body.uid || body._uid || '',
        _d: body._d || '',
        vc3: body.vc3 || '',
        uf: body.uf || '',
        fid: body.fid || '2893',
        cookie: `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}; fid=${body.fid || '2893'}`,
      };
      const res = await performSign(
        { id: String(body.activeId), name: '通用签到', otherId: 0 },
        { courseId: String(body.courseId || ''), classId: String(body.classId || ''), courseName: '在线签到' },
        session,
        body.name || env.CHAOXING_REALNAME || '同学'
      );
      return corsText(res.includes('成功') ? 'success' : res);
    }

    if (url.pathname === '/location' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const session: UserSession = {
        _uid: body.uid || body._uid || '',
        _d: body._d || '',
        vc3: body.vc3 || '',
        uf: body.uf || '',
        fid: body.fid || '2893',
        cookie: `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}; fid=${body.fid || '2893'}`,
      };
      const customLocs = [
        {
          lat: String(body.lat || '30.884000'),
          lon: String(body.lon || '121.896500'),
          address: body.address || '上海海洋大学教学楼',
        },
      ];
      const res = await performSign(
        { id: String(body.activeId), name: '位置签到', otherId: 4 },
        { courseId: String(body.courseId || ''), classId: String(body.classId || ''), courseName: '位置签到' },
        session,
        body.name || env.CHAOXING_REALNAME || '同学',
        customLocs
      );
      return corsText(res.includes('成功') ? 'success' : res);
    }

    if (url.pathname === '/qrcode' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const session: UserSession = {
        _uid: body.uid || body._uid || '',
        _d: body._d || '',
        vc3: body.vc3 || '',
        uf: body.uf || '',
        fid: body.fid || '2893',
        cookie: `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}; fid=${body.fid || '2893'}`,
      };
      const customLocs = [
        {
          lat: String(body.lat || '30.884000'),
          lon: String(body.lon || '121.896500'),
          address: body.address || '上海海洋大学教学楼',
        },
      ];
      const res = await performSign(
        { id: String(body.activeId), name: '二维码签到', otherId: 2 },
        { courseId: String(body.courseId || ''), classId: String(body.classId || ''), courseName: '二维码签到' },
        session,
        body.name || env.CHAOXING_REALNAME || '同学',
        customLocs,
        body.enc || ''
      );
      return corsText(res.includes('成功') ? 'success' : res);
    }

    if (url.pathname === '/photo' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const session: UserSession = {
        _uid: body.uid || body._uid || '',
        _d: body._d || '',
        vc3: body.vc3 || '',
        uf: body.uf || '',
        fid: body.fid || '2893',
        cookie: `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}; fid=${body.fid || '2893'}`,
      };
      const res = await performSign(
        { id: String(body.activeId), name: '拍照签到', otherId: 2 },
        { courseId: String(body.courseId || ''), classId: String(body.classId || ''), courseName: '拍照签到' },
        session,
        body.name || env.CHAOXING_REALNAME || '同学',
        undefined,
        '',
        body.objectId || ''
      );
      return corsText(res.includes('成功') ? 'success' : res);
    }

    if (url.pathname === '/uvtoken' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const cookie = `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}`;
      const tokenRes = await fetch('https://pan-yz.chaoxing.com/api/token/uservalid', {
        headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
      });
      const data: any = await tokenRes.json().catch(() => ({ _token: '' }));
      return corsJson(data);
    }

    if (url.pathname.startsWith('/monitor/status')) {
      return corsJson({ code: 200, msg: 'Cloudflare Edge 24/7 Heartbeat Active' });
    }

    if (url.pathname.startsWith('/monitor/start')) {
      return corsJson({ code: 200, msg: 'Started Successfully' });
    }

    if (url.pathname.startsWith('/monitor/stop')) {
      return corsJson({ code: 201, msg: 'Suspended' });
    }

    if (url.pathname === '/check' || url.pathname === '/run') {
      if (!checkAuth(request, env)) {
        return corsJson({ error: 'Unauthorized' }, 401);
      }
      const result = await handleEdgeHeartbeat(env, true);
      return corsJson(result, result.success ? 200 : 500);
    }

    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(request, env)) {
        return corsJson({ error: 'Unauthorized' }, 401);
      }

      // 看板全量数据接口 (兼容 /api/dashboard 与 /api/data)
      if ((url.pathname === '/api/dashboard' || url.pathname === '/api/data') && request.method === 'GET') {
        const data = await getDashboardData(env);
        return corsJson(data);
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
        return corsJson({ sent: true, summary: text, time: nowUtc8() });
      }

      // 获取待办任务列表
      if (url.pathname === '/api/tasks' && request.method === 'GET') {
        if (!env.DB) return corsJson({ tasks: [] });
        const status = url.searchParams.get('status') || 'pending';
        const rows = await env.DB.prepare(
          'SELECT * FROM pending_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT 50'
        )
          .bind(status)
          .all();
        return corsJson({ tasks: rows.results || [], time: nowUtc8() });
      }

      // 批量上报/更新任务状态（兼容 /api/tasks/sync 与 /api/sync）
      if ((url.pathname === '/api/tasks/sync' || url.pathname === '/api/sync') && request.method === 'POST') {
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

        return corsJson({ synced: updatedCount, time: nowUtc8() });
      }

      // 核心回调接口：接收常驻服务器 shim 发来的 draft_saved / submitted / failed 结果
      if (url.pathname === '/api/agent/callback' && request.method === 'POST') {
        const body: any = await request.json();
        if (env.SOLVER_AGENT) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          const result: any = await (solverStub as any).handleCallback(body);
          return corsJson(result);
        }
        return corsJson({ handled: false, reason: 'SOLVER_AGENT not configured' });
      }

      // D7 审批门接口：人工确认草稿无误后下发正式提交
      if (
        (url.pathname.match(/^\/api\/tasks\/([^\/]+)\/approve$/) || url.pathname === '/api/tasks/approve') &&
        request.method === 'POST'
      ) {
        const match = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/approve$/);
        const body: any = await request.json().catch(() => ({}));
        const jobId = match ? match[1] : (body.taskId || body.jobId);
        if (env.SOLVER_AGENT && jobId) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          const result: any = await (solverStub as any).approveTask(jobId);
          return corsJson(result);
        }
        return corsJson({ success: false, reason: 'SOLVER_AGENT not available or missing jobId' });
      }

      // 更新单个任务状态
      if (url.pathname === '/api/tasks/status' && request.method === 'POST') {
        if (!env.DB) return corsJson({ updated: false });
        const body: any = await request.json();
        await env.DB.prepare(
          'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
        )
          .bind(body.status, body.resultSummary || '', nowUtc8(), body.taskId)
          .run();

        // 若状态推进为 submitted 且绑定了 SOLVER_AGENT，联动下发提交
        if (body.status === 'submitted' && env.SOLVER_AGENT) {
          try {
            const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
            await (solverStub as any).approveTask(body.taskId);
          } catch (e: any) {
            console.warn(`[联动 approveTask 异常] ${e?.message || e}`);
          }
        }
        return corsJson({ updated: true, time: nowUtc8() });
      }

      // 批量查询题库 SHA-256 缓存
      if (url.pathname === '/api/cache/lookup' && request.method === 'POST') {
        const body: any = await request.json();
        const hits = await lookupQuestionCache(env, Array.isArray(body.hashes) ? body.hashes : []);
        return corsJson({ hits, time: nowUtc8() });
      }

      // 批量写入题库 SHA-256 缓存
      if (url.pathname === '/api/cache/upsert' && request.method === 'POST') {
        const body: any = await request.json();
        const count = await upsertQuestionCache(env, Array.isArray(body.items) ? body.items : []);
        return corsJson({ count, time: nowUtc8() });
      }

      // 获取边缘缓存的平台 Cookie / Browser Profile Session
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const platform = url.searchParams.get('platform') || 'chaoxing';
        const account = url.searchParams.get('account') || env.CHAOXING_PHONE || env.PHONE || 'default';
        const session = await getCachedSession(env, platform, account);
        return corsJson({ session, time: nowUtc8() });
      }

      // 上传/持久化浏览器 Profile 登录态 (storageState: Cookies + LocalStorage) 到 D1
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const body: any = await request.json();
        const platform = body.platform || 'web-profile:pta';
        const account = body.account || 'default';
        const ttlSeconds = Number(body.ttlSeconds) || 30 * 24 * 3600;
        await saveCachedSession(env, platform, account, body.session, ttlSeconds);
        return corsJson({ saved: true, platform, account, time: nowUtc8() });
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
