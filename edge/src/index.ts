import { checkAuth, isAllowedTaskUrl, isAuthEnforced, isValidAuthToken } from './auth';
import { routeAgentRequest } from 'agents';
import {
  fetchNoticeList,
  getCourses,
  login,
  performSign,
  scanCourseActivities,
  UserSession,
} from './chaoxing';
import { getDashboardData, renderDashboardHtml } from './dashboard';
import {
  approveAndPublishDiscussion,
  ensureChaoxingEdgeSession,
  handleDiscussionStatusUpdate,
  scanDiscussionsBatch,
} from './discussions';
import { runChaoxingInspectionCycle, syncChaoxingSignHistory } from './inspection';
import { ExtendedNotifyEnv, sendDigestNotification, sendNotification, sendTelegramReply } from './notify';
import { signRequest, timingSafeEqualString, verifySignedRequest } from './request-signing';
import { SignAgent } from './sign-agent';
import { SolverAgent } from './solver-agent';
import {
  getCachedSession,
  listDiscussions,
  logExecution,
  lookupQuestionCache,
  nowUtc8,
  resolveCanonicalPendingTaskId,
  saveCachedSession,
  saveDiscussionDraft,
  saveEnrolledCourses,
  saveNotices,
  updateDiscussionStatus,
  upsertQuestionCache,
} from './store';

export { SignAgent, SolverAgent, checkAuth };

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-AFK-Timestamp, X-AFK-Nonce, X-AFK-Signature',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function applyScopedCors(request: Request, env: ExtendedNotifyEnv, res: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return res;
  const reqOrigin = new URL(request.url).origin;
  const extraOrigins = String((env as any).AFK_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origin === reqOrigin || extraOrigins.includes(origin)) {
    const next = new Response(res.body, res);
    next.headers.set('Access-Control-Allow-Origin', origin);
    next.headers.set('Vary', 'Origin');
    return next;
  }
  return res;
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
 * 未认证访问 Web 看板时的暗黑磨砂玻璃登录解锁界面
 */
function renderAuthRequiredHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>安全解锁 · afk-cloud 控制面板</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#10b981', 600: '#059669' }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4 antialiased selection:bg-emerald-500 selection:text-white">
  <div class="w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-xl">
    <div class="flex items-center space-x-3 mb-6">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
        🔐
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white">afk-cloud 看板安全锁</h1>
        <p class="text-xs text-slate-400">Personal Autonomous Agent Edge Node</p>
      </div>
    </div>

    <p class="text-sm text-slate-300 mb-6 leading-relaxed">
      本边缘节点已启用全量安全隔离。请输入您配置的 <code class="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 text-xs font-mono">API_BEARER_TOKEN</code> 或访问口令解锁。
    </p>

    <form id="loginForm" class="space-y-4" onsubmit="handleLogin(event)">
      <div>
        <label class="block text-xs font-medium text-slate-400 mb-1">访问口令 (Token / Password)</label>
        <input
          id="tokenInput"
          type="password"
          required
          autocomplete="current-password"
          placeholder="输入口令 (如 .env 中的 AFK_EDGE_BEARER_TOKEN)"
          class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none text-sm transition-all text-white placeholder-slate-600"
        />
      </div>

      <div id="errorMsg" class="hidden text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-2.5">
        口令无效或已过期，请检查输入
      </div>

      <button
        type="submit"
        id="submitBtn"
        class="w-full py-3 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm transition-all shadow-lg shadow-emerald-500/20 active:scale-[0.98] flex items-center justify-center space-x-2"
      >
        <span>解锁进入看板</span>
        <span>→</span>
      </button>
    </form>

    <div class="mt-8 pt-6 border-t border-slate-800/60 text-center">
      <p class="text-xs text-slate-500">
        提示：若首次部署未配置口令，请运行 <code class="text-slate-400 font-mono">pnpm afk setup-cf</code> 自动注入
      </p>
    </div>
  </div>

  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const err = document.getElementById('errorMsg');
      const token = document.getElementById('tokenInput').value.trim();
      if (!token) return;

      btn.disabled = true;
      btn.innerText = '校验中...';
      err.classList.add('hidden');

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });

        if (res.ok) {
          window.location.href = '/';
        } else {
          err.classList.remove('hidden');
        }
      } catch (e) {
        err.innerText = '网络异常，请重试';
        err.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerText = '解锁进入看板 →';
      }
    }
  </script>
</body>
</html>`;
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
            await (signStub as any).checkInspection({
              checkHomework: shouldCheckHomework,
              scanDiscussions: shouldCheckHomework,
            });
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

        // 自动巡检并派发待办作业给 agy (仅在配置了常驻 shim 时由云端 Cron 主动推送，避免无 shim 时反复写入 task_queued 噪音)
        if (shouldCheckHomework && env.DB && (env.AFK_SHIM_URL || env.SHIM_URL)) {
          try {
            const pending = await env.DB.prepare(
              "SELECT task_id FROM pending_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 3"
            ).all<{ task_id: string }>();

            for (const row of pending.results || []) {
              await dispatchSingleTask(env, row.task_id, { force: false, suppressQueueLog: true });
            }
          } catch (e: any) {
            console.warn(`[scheduled 自动派发异常] ${e?.message || e}`);
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
   * HTTP 路由安全控制
   */
  async fetch(request: Request, env: ExtendedNotifyEnv, ctx: ExecutionContext): Promise<Response> {
    const response = await handleEdgeFetch(request, env, ctx);
    if (response.status === 101 || (response as any).webSocket) {
      return response;
    }
    return applyScopedCors(request, env, response);
  },
};

async function handleEdgeFetch(
  request: Request,
  env: ExtendedNotifyEnv,
  ctx: ExecutionContext
): Promise<Response> {
    const url = new URL(request.url);

    // 0. CORS 跨域预检快速通道
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(),
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 1. Cloudflare Agents SDK 原生路由派发（强制 Cookie / Bearer 鉴权拦截未认证 WebSocket RPC）
    const denyUnauthenticatedAgent = (req: Request): Response | undefined => {
      if (!checkAuth(req, env, { allowQueryToken: false })) {
        return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      }
      return undefined;
    };
    if (url.pathname === '/agents' || url.pathname.startsWith('/agents/')) {
      const denied = denyUnauthenticatedAgent(request);
      if (denied) return denied;
    }
    try {
      const agentRes = await routeAgentRequest(request, env, {
        onBeforeConnect: (req) => denyUnauthenticatedAgent(req),
        onBeforeRequest: (req) => denyUnauthenticatedAgent(req),
      });
      if (agentRes) return agentRes;
    } catch (e: any) {
      console.warn(`[routeAgentRequest 提示] ${e?.message || e}`);
    }

    // 2. 身份认证接口 (Web 看板解锁与登出)
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const token = String(body?.token || '').trim();
      if (!isValidAuthToken(token, env)) {
        return corsJson({ ok: false, error: '口令无效或未配置' }, 401);
      }
      return new Response(JSON.stringify({ ok: true, message: '认证成功' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `afk_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
          ...corsHeaders(),
        },
      });
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, message: '已安全退出' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `afk_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
          ...corsHeaders(),
        },
      });
    }

    // 3. 零服务器 Web 全景看板静态 HTML (带严格认证拦截)
    if ((url.pathname === '/' || url.pathname === '/dashboard') && request.method === 'GET') {
      // 若带有有效 ?token= 参数，自动注入 Cookie 并 302 重定向消除 URL 栏敏感信息
      const queryToken = url.searchParams.get('token');
      if (queryToken && isValidAuthToken(queryToken, env)) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/',
            'Set-Cookie': `afk_token=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
          },
        });
      }

      if (!checkAuth(request, env)) {
        return new Response(renderAuthRequiredHtml(), {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
        });
      }

      return new Response(renderDashboardHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    // 4. 公开存活探针 (仅返回最小健康状态，不泄漏敏感数据)
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const startTime = Date.now();
      let d1Status = 'unconfigured';
      let d1LatencyMs = -1;
      let taskStats = { pending: 0, draft_saved: 0, failed: 0 };

      if (env.DB) {
        try {
          const dbStart = Date.now();
          const check = await env.DB.prepare('SELECT 1 as ping').first<{ ping: number }>();
          d1LatencyMs = Date.now() - dbStart;
          d1Status = check?.ping === 1 ? 'healthy' : 'degraded';

          const statsRes = await env.DB.prepare(
            `SELECT status, count(*) as count FROM pending_tasks GROUP BY status`
          ).all<{ status: string; count: number }>();

          for (const row of statsRes.results || []) {
            if (row.status === 'pending') taskStats.pending = row.count;
            else if (row.status === 'draft_saved') taskStats.draft_saved = row.count;
            else if (row.status === 'failed') taskStats.failed = row.count;
          }
        } catch (e: any) {
          d1Status = 'error: ' + (e?.message || e);
        }
      }

      const isHealthy = d1Status === 'healthy' || (!env.DB && d1Status === 'unconfigured');
      const healthData = {
        status: isHealthy ? 'healthy' : 'degraded',
        version: '1.0.8',
        timestamp: nowUtc8(),
        latency_ms: Date.now() - startTime,
        auth_enforced: isAuthEnforced(env),
        components: {
          d1: {
            status: d1Status,
            latency_ms: d1LatencyMs,
          },
          kv: {
            configured: !!(env.KV || env.CHAOXING_KV),
          },
          agents: {
            sign_agent: !!env.SIGN_AGENT,
            solver_agent: !!env.SOLVER_AGENT,
          },
        },
        queue_metrics: taskStats,
      };

      return corsJson(healthData, isHealthy ? 200 : 503);
    }

    // 4.5 Telegram Bot Webhook（通过 Secret Token + TELEGRAM_CHAT_ID 严格单人鉴权）
    if (url.pathname === '/api/tg/webhook' && request.method === 'POST') {
      const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET || '';
      const gotSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!expectedSecret || !gotSecret || !(await timingSafeEqualString(gotSecret, expectedSecret))) {
        return corsJson({ error: 'Forbidden' }, 403);
      }

      const update: any = await request.json().catch(() => null);
      const msg = update?.message;
      const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
      const chatId = msg?.chat?.id;
      if (!text || !env.TELEGRAM_CHAT_ID || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
        return corsJson({ ok: true });
      }

      if (text === '/start' || text === '/help') {
        await sendTelegramReply(
          [
            '🤖 Personal Agent 已就绪！你可以直接发自然语言，或使用快捷指令：',
            '/status — 查看学习通队列与服务状态',
            '/tasks — 查看当前待处理作业',
            '/todos — 查看个人待办清单',
            '/todo <内容> — 新增个人待办',
            '/done <编号或关键词> — 完成待办',
            '/news — 获取最新精选资讯',
            '/activity — 查看近期自主活动日志',
            '/evolve — 立即触发一次自主优化',
          ].join('\n'),
          env
        );
        return corsJson({ ok: true });
      }

      if (text === '/status' || text === '状态') {
        const data = await getDashboardData(env);
        const s = data.stats;
        await sendTelegramReply(
          [
            `📊 当前状态 (${nowUtc8()})`,
            `• 待办作业: ${s.pendingCount} | 草稿: ${s.draftCount} | 已交: ${s.submittedCount} | 失败: ${s.failedCount}`,
            `• 讨论区: 待回复 ${s.discussionPendingCount} | 草稿 ${s.discussionDraftCount}`,
          ].join('\n'),
          env
        );
        return corsJson({ ok: true });
      }

      if (text === '/tasks' || text === '作业') {
        const data = await getDashboardData(env);
        const active = (data.tasks || []).filter((t: any) => t.status === 'pending' || t.status === 'draft_saved').slice(0, 8);
        const lines = active.length
          ? active.map((t: any, i: number) => `${i + 1}. [${t.status}] ${t.course_name || ''} - ${t.title || t.task_id}`)
          : ['当前没有 pending 或 draft_saved 作业！'];
        await sendTelegramReply(`📚 活跃作业列表：\n${lines.join('\n')}`, env);
        return corsJson({ ok: true });
      }

      // 其余个人指令与自然语言交由本地 Shim (/agent-chat) 异步处理并回传
      const shimUrl = env.AFK_SHIM_URL || env.SHIM_URL;
      const shimSecret = env.AFK_SHIM_SECRET;
      if (!shimUrl || !shimSecret) {
        await sendTelegramReply('⚠️ 未配置 AFK_SHIM_URL / AFK_SHIM_SECRET，无法转发到本机 AGY。', env);
        return corsJson({ ok: true });
      }

      const forwardTask = (async () => {
        try {
          const endpoint = new URL('/agent-chat', shimUrl.replace(/\/+$/, '') + '/');
          const body = JSON.stringify({ text: text.slice(0, 4000) });
          const signed = await signRequest({
            secret: shimSecret,
            method: 'POST',
            pathWithQuery: endpoint.pathname + endpoint.search,
            body,
          });
          const res = await fetch(endpoint.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...signed,
            },
            body,
          });
          if (!res.ok) {
            await sendTelegramReply(`⚠️ 本机 Shim 返回 HTTP ${res.status}`, env);
            return;
          }
          const data: any = await res.json().catch(() => ({}));
          if (data?.immediateReply) {
            await sendTelegramReply(String(data.immediateReply), env);
          }
        } catch (err: any) {
          await sendTelegramReply(`⚠️ 无法连接本机 AGY：${err?.message || err}`, env);
        }
      })();
      ctx.waitUntil(forwardTask);
      return corsJson({ ok: true });
    }

    // 5. 监控指标接口 (必须通过鉴权)
    if (url.pathname === '/metrics' || url.pathname === '/api/metrics') {
      if (!checkAuth(request, env, { allowQueryToken: false })) {
        return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      }

      let pendingCount = 0;
      let draftCount = 0;
      let submittedCount = 0;
      let failedCount = 0;
      let d1PingMs = 0;

      if (env.DB) {
        try {
          const t0 = Date.now();
          await env.DB.prepare('SELECT 1').first();
          d1PingMs = Date.now() - t0;

          const rows = await env.DB.prepare(
            `SELECT status, count(*) as c FROM pending_tasks GROUP BY status`
          ).all<{ status: string; c: number }>();
          for (const r of rows.results || []) {
            if (r.status === 'pending') pendingCount = r.c;
            else if (r.status === 'draft_saved') draftCount = r.c;
            else if (r.status === 'submitted') submittedCount = r.c;
            else if (r.status === 'failed') failedCount = r.c;
          }
        } catch {}
      }

      const prometheusMetrics = [
        '# HELP afk_health_status 1 if healthy, 0 if degraded',
        '# TYPE afk_health_status gauge',
        `afk_health_status 1`,
        '# HELP afk_d1_latency_ms Cloudflare D1 query roundtrip latency in milliseconds',
        '# TYPE afk_d1_latency_ms gauge',
        `afk_d1_latency_ms ${d1PingMs}`,
        '# HELP afk_tasks_count Total tasks in pending_tasks by status',
        '# TYPE afk_tasks_count gauge',
        `afk_tasks_count{status="pending"} ${pendingCount}`,
        `afk_tasks_count{status="draft_saved"} ${draftCount}`,
        `afk_tasks_count{status="submitted"} ${submittedCount}`,
        `afk_tasks_count{status="failed"} ${failedCount}`,
      ].join('\n');

      return new Response(prometheusMetrics + '\n', {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          ...corsHeaders(),
        },
      });
    }

    // 6. 超星业务代理接口 (全部强制 checkAuth 鉴权)
    if (url.pathname === '/login' && request.method === 'POST') {
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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

      const targetCourses = courses.length > 20 ? courses.slice(0, 20) : courses;
      for (const course of targetCourses) {
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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
          lat: String(body.lat || env.CHAOXING_SIGN_LAT || ''),
          lon: String(body.lon || env.CHAOXING_SIGN_LON || ''),
          address: body.address || env.CHAOXING_SIGN_ADDRESS || '校园教学楼',
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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
          lat: String(body.lat || env.CHAOXING_SIGN_LAT || ''),
          lon: String(body.lon || env.CHAOXING_SIGN_LON || ''),
          address: body.address || env.CHAOXING_SIGN_ADDRESS || '校园教学楼',
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
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
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      const body: any = await request.json().catch(() => ({}));
      const cookie = `_uid=${body.uid || body._uid}; UID=${body.uid || body._uid}; _d=${body._d}; vc3=${body.vc3}; uf=${body.uf}`;
      const tokenRes = await fetch('https://pan-yz.chaoxing.com/api/token/uservalid', {
        headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
      });
      const data: any = await tokenRes.json().catch(() => ({ _token: '' }));
      return corsJson(data);
    }

    if (url.pathname.startsWith('/monitor/status')) {
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      return corsJson({ code: 200, msg: 'Cloudflare Edge 24/7 Heartbeat Active' });
    }

    if (url.pathname.startsWith('/monitor/start')) {
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      return corsJson({ code: 200, msg: 'Started Successfully' });
    }

    if (url.pathname.startsWith('/monitor/stop')) {
      if (!checkAuth(request, env, { allowQueryToken: false })) return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      return corsJson({ code: 201, msg: 'Suspended' });
    }

    if (url.pathname === '/check' || url.pathname === '/run') {
      if (!checkAuth(request, env, { allowQueryToken: false })) {
        return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      }
      const bypassCooldown = url.searchParams.get('bypassCooldown') === '1';
      if (env.SIGN_AGENT) {
        try {
          const signStub = env.SIGN_AGENT.get(env.SIGN_AGENT.idFromName('default'));
          const result = await (signStub as any).checkInspection({
            force: true,
            checkHomework: true,
            scanDiscussions: true,
            bypassCooldown,
          });
          return corsJson(result, result?.success ? 200 : 500);
        } catch (e: any) {
          console.warn(`[SignAgent /check 异常] ${e?.message || e}，回退至原生巡检`);
        }
      }
      const result = await runChaoxingInspectionCycle(env, {
        force: true,
        checkHomework: true,
        scanDiscussions: true,
        bypassCooldown,
      });
      return corsJson(result, result.success ? 200 : 500);
    }

    // 7. /api/agent/callback 专用回调通道（具备 HMAC 签名 + Nonce 防重放）
    if (url.pathname === '/api/agent/callback' && request.method === 'POST') {
      const rawBody = await request.text();
      const shimSecret = env.AFK_SHIM_SECRET;

      // 强制签名校验：若配置了 AFK_SHIM_SECRET，必须通过 HMAC-SHA256 签名与 Nonce 防重放校验
      if (shimSecret) {
        const verifyRes = await verifySignedRequest({
          secret: shimSecret,
          method: 'POST',
          pathWithQuery: url.pathname + url.search,
          body: rawBody,
          getHeader: (name) => request.headers.get(name),
          seenNonce: async (nonce, timestamp) => {
            if (env.SOLVER_AGENT) {
              try {
                const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
                if (typeof (solverStub as any).consumeCallbackNonce === 'function') {
                  return await (solverStub as any).consumeCallbackNonce(nonce, timestamp);
                }
              } catch {
                // fall back to KV check if DO fails
              }
            }
            const kv = env.CHAOXING_KV || env.KV;
            if (kv) {
              const key = `cb_nonce:${nonce}`;
              const seen = await kv.get(key);
              if (seen) return true;
              await kv.put(key, '1', { expirationTtl: 600 });
            }
            return false;
          },
        });
        if (!verifyRes.ok) {
          console.warn(`[Edge Security] /api/agent/callback 验签失败: ${verifyRes.reason}`);
          return corsJson({ error: 'Unauthorized: Bad or expired signature' }, 401);
        }
      } else {
        // 回退：若未配置 AFK_SHIM_SECRET，检查强 Bearer Token
        if (!checkAuth(request, env, { allowQueryToken: false })) {
          return corsJson({ error: 'Unauthorized: Missing or invalid token' }, 401);
        }
      }

      let body: any = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        return corsJson({ error: 'Invalid JSON body' }, 400);
      }

      if (env.SOLVER_AGENT) {
        const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
        const result: any = await (solverStub as any).handleCallback(body);
        return corsJson(result);
      }
      return corsJson({ handled: false, reason: 'SOLVER_AGENT not configured' });
    }

    // 8. 其他所有 /api/* 接口必须通过 checkAuth 鉴权（禁止通过 URL ?token= 传递凭据）
    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(request, env, { allowQueryToken: false })) {
        return corsJson({ error: 'Unauthorized: Access Denied' }, 401);
      }

      // 看板全量数据接口 (兼容 /api/dashboard 与 /api/data)
      if ((url.pathname === '/api/dashboard' || url.pathname === '/api/data') && request.method === 'GET') {
        let data = await getDashboardData(env);
        if (((!data.courses || data.courses.length === 0) || (!data.notices || data.notices.length === 0)) && (env.CHAOXING_PHONE || env.PHONE)) {
          const phone = env.CHAOXING_PHONE || env.PHONE || '';
          const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
          let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
          if (!session && password) {
            session = await login(phone, password);
            if (session) await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
          }
          if (session) {
            if (!data.courses || data.courses.length === 0) {
              const courseList = await getCourses(session);
              if (courseList.length > 0) {
                await saveEnrolledCourses(env, courseList);
              }
            }
            if (!data.notices || data.notices.length === 0) {
              const list = await fetchNoticeList(session, 20);
              if (list.length > 0) {
                await saveNotices(env, list);
              }
            }
            data = await getDashboardData(env);
          }
        }
        return corsJson(data);
      }

      // 手动刷新或抓取全量在读课程
      if ((url.pathname === '/api/courses/refresh' || url.pathname === '/api/courses') && (request.method === 'GET' || request.method === 'POST')) {
        const phone = env.CHAOXING_PHONE || env.PHONE || '';
        const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
        let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
        if (!session && password) {
          session = await login(phone, password);
          if (session) await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
        }
        if (!session) return corsJson({ error: 'No Session' }, 401);

        const courses = await getCourses(session);
        await saveEnrolledCourses(env, courses);
        return corsJson({ courses, count: courses.length, time: nowUtc8() });
      }

      // 手动刷新通知箱消息
      if ((url.pathname === '/api/notices/refresh' || url.pathname === '/api/notices') && (request.method === 'GET' || request.method === 'POST')) {
        const phone = env.CHAOXING_PHONE || env.PHONE || '';
        const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
        let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
        if (!session && password) {
          session = await login(phone, password);
          if (session) await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
        }
        if (!session) return corsJson({ error: 'No Session' }, 401);

        const list = await fetchNoticeList(session, 20);
        const count = await saveNotices(env, list);
        return corsJson({ notices: list, count, time: nowUtc8() });
      }

      // 手动触发一次每日简报推送
      if (url.pathname === '/api/digest' && request.method === 'POST') {
        const data = await getDashboardData(env);
        const summary = await sendDigestNotification(
          env,
          {
            ...data.stats,
            recentTasks: data.tasks,
          },
          '手动触发任务简报'
        );
        return corsJson({ success: true, summary, time: nowUtc8() });
      }

      // 通用通知下发端点（供 agy-autopilot 等本地自主任务向用户推送进展/告警）
      if (url.pathname === '/api/notify' && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const title = String(body.title || '').trim();
        const content = String(body.content || '').trim();
        if (!title || !content) {
          return corsJson({ error: 'title and content are required' }, 400);
        }
        await sendNotification(title.slice(0, 120), content.slice(0, 1500), env);
        return corsJson({ success: true, time: nowUtc8() });
      }

      // 获取当前 D1 队列待办
      if (url.pathname === '/api/tasks' && request.method === 'GET') {
        if (!env.DB) return corsJson({ tasks: [] });
        const rows = await env.DB.prepare(
          'SELECT * FROM pending_tasks ORDER BY updated_at DESC LIMIT 50'
        ).all();
        return corsJson({ tasks: rows.results || [] });
      }

      // 批量同步作业待办 (支持跨 prefix workId 状态联动对齐与 DO 锁释放)
      if ((url.pathname === '/api/tasks/sync' || url.pathname === '/api/sync') && request.method === 'POST') {
        if (!env.DB) return corsJson({ error: 'DB not available' }, 500);
        const body: any = await request.json();
        const tasks: any[] = Array.isArray(body) ? body : body.tasks || [];
        let updatedCount = 0;
        const now = nowUtc8();

        for (const t of tasks) {
          if (!t.workId && !t.taskId) continue;
          const incomingTid = t.taskId || `chaoxing-work-${t.workId}`;
          const tid = await resolveCanonicalPendingTaskId(env.DB, incomingTid, t.workId);
          const rawId = String(t.workId || incomingTid.replace(/^chaoxing-(?:notice-)?(?:work|hw)-/, '').split('-')[0] || '');
          const nextStatus = t.status || (t.isPending ? 'pending' : 'submitted');
          const resultSummary = t.resultSummary || null;

          await env.DB.prepare(
            `INSERT INTO pending_tasks 
             (task_id, platform, course_id, class_id, course_name, title, status, compute_tier, deadline, result_summary, payload_json, updated_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET 
               title = excluded.title,
               status = CASE WHEN pending_tasks.status IN ('draft_saved', 'awaiting_approval', 'submitting', 'submitted') AND excluded.status = 'pending' THEN pending_tasks.status ELSE excluded.status END,
               deadline = excluded.deadline,
               result_summary = COALESCE(excluded.result_summary, pending_tasks.result_summary),
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at`
          )
            .bind(
              tid,
              t.platform || 'chaoxing',
              t.courseId || '',
              t.classId || '',
              t.courseName || '',
              t.title || '',
              nextStatus,
              t.computeTier || 'tier1-cloud-run',
              t.deadline || '',
              resultSummary,
              JSON.stringify(t),
              now,
              now
            )
            .run();

          if (rawId && (nextStatus === 'draft_saved' || nextStatus === 'submitted')) {
            await env.DB.prepare(
              `UPDATE pending_tasks 
               SET status = ?, result_summary = COALESCE(?, result_summary), updated_at = ?
               WHERE (task_id LIKE ? OR task_id LIKE ?) AND status != ?`
            )
              .bind(nextStatus, resultSummary, now, `%work-${rawId}%`, `%hw-${rawId}%`, nextStatus)
              .run()
              .catch(() => {});

            await logExecution(
              env,
              nextStatus,
              t.platform || 'chaoxing',
              `作业《${t.courseName || ''} - ${t.title || ''}》已${nextStatus === 'draft_saved' ? '暂存草稿 (pyFlag=1)' : '正式提交'}`,
              { taskId: tid, rawId, resultSummary }
            ).catch(() => {});
          }

          if (env.SOLVER_AGENT && ['draft_saved', 'submitted', 'failed'].includes(nextStatus)) {
            try {
              const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
              await (solverStub as any).syncExternalTaskStatus(tid, nextStatus, resultSummary || undefined);
            } catch {
              // ignore DO sync error
            }
          }

          updatedCount++;
        }
        return corsJson({ synced: updatedCount, time: nowUtc8() });
      }

      // 供无公网隧道环境下的本地 Worker / Cron 主动拉取待执行与超期未回调任务
      if ((url.pathname === '/api/tasks/pull' || url.pathname === '/api/tasks/pending') && request.method === 'GET') {
        if (!env.DB) return corsJson({ error: 'DB not available' }, 500);
        const rows = await env.DB.prepare(
          `SELECT * FROM pending_tasks WHERE status IN ('pending', 'dispatched') ORDER BY updated_at ASC LIMIT 20`
        ).all<any>();
        return corsJson({ ok: true, tasks: rows.results || [], time: nowUtc8() });
      }

      // 查询当前全局任务调度队列与单例执行状态
      if (url.pathname === '/api/tasks/queue' && request.method === 'GET') {
        if (env.SOLVER_AGENT) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          const queue = await (solverStub as any).getQueueStatus();
          return corsJson({ ok: true, queue, time: nowUtc8() });
        }
        return corsJson({ ok: true, queue: { activeJobId: null, pendingCount: 0, totalTasks: 0 }, time: nowUtc8() });
      }

      // D7 审批门接口：人工确认草稿无误后下发正式提交
      if (
        (url.pathname.match(/^\/api\/tasks\/([^\/]+)\/approve$/) || url.pathname === '/api/tasks/approve') &&
        request.method === 'POST'
      ) {
        const match = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/approve$/);
        const body: any = await request.json().catch(() => ({}));
        const jobId = match ? decodeURIComponent(match[1]) : (body.taskId || body.jobId);
        if (!jobId) {
          return corsJson({ success: false, msg: '缺少 taskId / jobId', reason: '缺少 taskId / jobId' }, 400);
        }
        if (env.SOLVER_AGENT) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          const result: any = await (solverStub as any).approveTask(jobId);
          return corsJson(result);
        }
        const shimUrl = env.AFK_SHIM_URL || env.SHIM_URL;
        const reason = shimUrl
          ? 'SOLVER_AGENT not available'
          : '未配置 AFK_SHIM_URL / SHIM_URL，无法派发正式提交指令，任务状态保持不变';
        return corsJson({ success: false, jobId, msg: reason, reason });
      }

      // 任务主动重新派发接口：支持单任务或批量派发给 agy (常驻服务器 shim / Cloud Run)
      if (
        (url.pathname.match(/^\/api\/tasks\/([^\/]+)\/dispatch$/) || url.pathname === '/api/tasks/dispatch') &&
        request.method === 'POST'
      ) {
        const match = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/dispatch$/);
        const body: any = await request.json().catch(() => ({}));
        const taskIds: string[] = match
          ? [decodeURIComponent(match[1])]
          : (Array.isArray(body.taskIds) ? body.taskIds : [body.taskId || body.jobId]).filter(Boolean);

        const results: Array<{ taskId: string; success: boolean; status: string; reason?: string }> = [];
        for (const tid of taskIds) {
          const res = await dispatchSingleTask(env, tid, { force: body.force === true });
          results.push(res);
        }

        const dispatchedCount = results.filter((r) => r.success).length;
        return corsJson({
          success: dispatchedCount > 0,
          total: results.length,
          dispatchedCount,
          results,
          time: nowUtc8(),
        });
      }

      // 一键重试失败任务接口：支持指定 taskIds 或批量重跑全部 status='failed' 作业
      if (url.pathname === '/api/tasks/retry-failed' && request.method === 'POST') {
        if (!env.DB) {
          return corsJson({ success: false, total: 0, dispatchedCount: 0, queuedCount: 0, results: [], reason: 'D1 数据库未连接' }, 500);
        }
        const body: any = await request.json().catch(() => ({}));
        let targetIds: string[] = Array.isArray(body.taskIds) ? body.taskIds.filter(Boolean) : [];
        if (targetIds.length === 0) {
          const failedRes = await env.DB.prepare(
            "SELECT task_id FROM pending_tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 50"
          ).all<{ task_id: string }>();
          targetIds = (failedRes.results || []).map((r) => r.task_id).filter(Boolean);
        }

        const results: Array<{ taskId: string; success: boolean; status: string; reason?: string }> = [];
        for (const tid of targetIds) {
          const res = await dispatchSingleTask(env, tid, { force: true, suppressQueueLog: true });
          results.push(res);
        }
        const retriedCount = results.filter((r) => r.success).length;
        const dispatchedCount = results.filter((r) => r.success && r.status === 'dispatched').length;
        const queuedCount = results.filter((r) => r.success && r.status === 'pending').length;
        return corsJson({
          success: retriedCount > 0 || targetIds.length === 0,
          total: results.length,
          retriedCount,
          dispatchedCount,
          queuedCount,
          results,
          time: nowUtc8(),
        });
      }

      // 忽略/归档单个任务接口
      if (url.pathname.match(/^\/api\/tasks\/([^\/]+)\/ignore$/) && request.method === 'POST') {
        if (!env.DB) return corsJson({ success: false, updated: false, reason: 'D1 数据库未连接' }, 500);
        const match = url.pathname.match(/^\/api\/tasks\/([^\/]+)\/ignore$/)!;
        const taskId = decodeURIComponent(match[1]);
        const body: any = await request.json().catch(() => ({}));
        const summary = typeof body.resultSummary === 'string' ? body.resultSummary : '';

        if (env.SOLVER_AGENT) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          await (solverStub as any).ignoreTask(taskId).catch(() => {});
        }
        await env.DB.prepare(
          "UPDATE pending_tasks SET status = 'ignored', result_summary = COALESCE(NULLIF(?, ''), result_summary), updated_at = ? WHERE task_id = ?"
        )
          .bind(summary, nowUtc8(), taskId)
          .run();
        return corsJson({ success: true, updated: true, taskId, status: 'ignored', time: nowUtc8() });
      }

      // 更新单个任务状态
      if (url.pathname === '/api/tasks/status' && request.method === 'POST') {
        if (!env.DB) return corsJson({ updated: false });
        const body: any = await request.json();

        if (body.status === 'submitted' && env.SOLVER_AGENT) {
          try {
            const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
            const result: any = await (solverStub as any).approveTask(body.taskId);
            return corsJson({
              updated: Boolean(result?.success),
              ...result,
              time: nowUtc8(),
            });
          } catch (e: any) {
            console.warn(`[联动 approveTask 异常] ${e?.message || e}`);
            return corsJson({
              updated: false,
              success: false,
              msg: e?.message || String(e),
              reason: e?.message || String(e),
              time: nowUtc8(),
            });
          }
        }

        if (body.status === 'ignored' && env.SOLVER_AGENT) {
          try {
            const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
            await (solverStub as any).ignoreTask(body.taskId);
          } catch (e: any) {
            console.warn(`[联动 ignoreTask 异常] ${e?.message || e}`);
          }
        }

        await env.DB.prepare(
          'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
        )
          .bind(body.status, body.resultSummary || '', nowUtc8(), body.taskId)
          .run();

        return corsJson({ updated: true, time: nowUtc8() });
      }

      // 分批回溯同步学习通历史签到记录
      if (url.pathname === '/api/signins/sync' && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const result = await syncChaoxingSignHistory(env, {
          offset: Number(body.offset) || 0,
          limit: Number(body.limit) || 5,
        });
        return corsJson({ ...result, time: nowUtc8() }, result.success || result.rateLimited ? 200 : 400);
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

      // 查询课程讨论区话题与 AI 拟稿队列
      if (url.pathname === '/api/discussions' && request.method === 'GET') {
        const statusParam = url.searchParams.get('status') || '';
        const statuses = statusParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
        const discussions = await listDiscussions(env, statuses.length > 0 ? statuses : undefined, limit);
        return corsJson({ ok: true, discussions, time: nowUtc8() });
      }

      // 分批扫描全课讨论区 (bbscircle)，避免超出 Workers 子请求上限
      if (url.pathname === '/api/discussions/scan' && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const phone = env.CHAOXING_PHONE || env.PHONE || '';
        const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';

        let session = await ensureChaoxingEdgeSession(env);
        if (!session) {
          return corsJson({ ok: false, error: '未配置或无法获取学习通登录态' }, 401);
        }

        let courses = await getCourses(session);
        if (courses.length === 0 && phone && password) {
          const freshSession = await login(phone, password);
          if (freshSession) {
            session = freshSession;
            await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
            courses = await getCourses(session);
          }
        }
        if (courses.length > 0) {
          await saveEnrolledCourses(env, courses);
        }

        const summary = await scanDiscussionsBatch(env, session, courses, {
          realname: env.CHAOXING_REALNAME,
          offset: Number(body.offset) || 0,
          limit: Number(body.limit) || 9,
          forceDetailRefresh: Boolean(body.forceDetailRefresh),
          notifyOnNew: Boolean(body.notifyOnNew),
        });
        return corsJson({ ok: true, ...summary, time: nowUtc8() });
      }

      // 保存讨论拟稿（由本地 agy CLI 或看板编辑提交，进入 awaiting_approval 待审批态，绝不自动发布）
      const discDraftMatch = url.pathname.match(/^\/api\/discussions\/([^\/]+)\/draft$/);
      if ((discDraftMatch || url.pathname === '/api/discussions/draft') && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const discussionId = decodeURIComponent(discDraftMatch ? discDraftMatch[1] : String(body.discussionId || ''));
        const draftReply = String(body.draftReply || '');
        if (!discussionId || !draftReply.trim()) {
          return corsJson({ ok: false, error: 'discussionId 或 draftReply 不能为空' }, 400);
        }
        const ok = await saveDiscussionDraft(
          env,
          discussionId,
          draftReply,
          typeof body.modelUsed === 'string' ? body.modelUsed : undefined
        );
        return corsJson({ ok, discussionId, status: 'awaiting_approval', time: nowUtc8() }, ok ? 200 : 500);
      }

      // 人工审批并公开发布回复到学习通讨论区 (/mooc-ans/bbscircle/addreply)
      const discPublishMatch = url.pathname.match(/^\/api\/discussions\/([^\/]+)\/publish$/);
      if ((discPublishMatch || url.pathname === '/api/discussions/publish') && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const discussionId = decodeURIComponent(discPublishMatch ? discPublishMatch[1] : String(body.discussionId || ''));
        if (!discussionId) {
          return corsJson({ ok: false, error: 'discussionId 不能为空' }, 400);
        }
        const overrideReply = typeof body.draftReply === 'string' ? body.draftReply : undefined;
        const result = await approveAndPublishDiscussion(env, discussionId, overrideReply);
        const failStatus = /重复|正在发布|已发布|已在该讨论帖回复|已回复/.test(result.msg) ? 409 : 400;
        return corsJson({ ok: result.success, ...result, time: nowUtc8() }, result.success ? 200 : failStatus);
      }

      // 回写讨论安全状态（仅允许白名单状态如 replied_externally / ignored，严禁绕过发布门伪造 submitted）
      const discStatusMatch = url.pathname.match(/^\/api\/discussions\/([^\/]+)\/status$/);
      if (discStatusMatch && request.method === 'POST') {
        const discussionId = decodeURIComponent(discStatusMatch[1]);
        const body: any = await request.json().catch(() => ({}));
        const res = await handleDiscussionStatusUpdate(
          env,
          discussionId,
          typeof body.status === 'string' ? body.status : ''
        );
        const { statusCode, ...payload } = res;
        return corsJson({ ...payload, time: nowUtc8() }, statusCode);
      }

      // 忽略某个话题讨论
      const discIgnoreMatch = url.pathname.match(/^\/api\/discussions\/([^\/]+)\/ignore$/);
      if (discIgnoreMatch && request.method === 'POST') {
        const discussionId = decodeURIComponent(discIgnoreMatch[1]);
        const ok = await updateDiscussionStatus(env, discussionId, 'ignored');
        return corsJson({ ok, discussionId, status: 'ignored', time: nowUtc8() });
      }

      // 获取边缘缓存的平台 Cookie / Browser Profile Session
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const platform = url.searchParams.get('platform') || 'chaoxing';
        const account = url.searchParams.get('account') || env.CHAOXING_PHONE || env.PHONE || 'default';
        const session = await getCachedSession(env, platform, account);
        return corsJson({ session, time: nowUtc8() });
      }

      // 上传/持久化浏览器 Profile 登录态到 D1
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const body: any = await request.json();
        const platform = body.platform || 'web-profile:pta';
        const account = body.account || 'default';
        const ttlSeconds = Number(body.ttlSeconds) || 30 * 24 * 3600;
        await saveCachedSession(env, platform, account, body.session, ttlSeconds);
        return corsJson({ saved: true, platform, account, time: nowUtc8() });
      }
    }

    // 默认兜底：未匹配路由返回 404
    return corsJson({ error: 'Endpoint Not Found' }, 404);
}

async function handleEdgeHeartbeat(env: ExtendedNotifyEnv, checkHomework = false) {
  return runChaoxingInspectionCycle(env, {
    force: checkHomework,
    checkHomework,
    scanDiscussions: checkHomework,
  });
}

/**
 * 安全派发单个作业任务给 agy (强制 URL 白名单校验与 HMAC 签名)
 */
async function dispatchSingleTask(
  env: ExtendedNotifyEnv,
  taskId: string,
  options?: { force?: boolean; suppressQueueLog?: boolean }
): Promise<{ taskId: string; success: boolean; status: string; reason?: string }> {
  if (!env.DB) {
    return { taskId, success: false, status: 'error', reason: 'D1 数据库未连接' };
  }

  const now = nowUtc8();
  const task = await env.DB.prepare('SELECT * FROM pending_tasks WHERE task_id = ?')
    .bind(taskId)
    .first<any>();

  if (!task) {
    return { taskId, success: false, status: 'not_found', reason: '任务不存在' };
  }
  const wasFailed = task.status === 'failed';

  let taskUrl = '';
  if (task.payload_json) {
    try {
      const parsed = JSON.parse(task.payload_json);
      taskUrl = parsed.url || '';
    } catch {
      // ignore
    }
  }

  if (!taskUrl) {
    const rawWorkId = task.task_id.replace(/^chaoxing-(?:notice-)?work-/, '').split('-')[0];
    taskUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${task.course_id}&classId=${task.class_id}&cpi=&workId=${rawWorkId}`;
  }

  // 安全防线 1：URL 域名白名单与 HTTPS 校验
  if (!isAllowedTaskUrl(taskUrl, env.AFK_TASK_HOST_ALLOWLIST)) {
    console.warn(`[dispatchSingleTask Security] taskUrl 非法或不在白名单内，拒绝派发给 agy: ${taskUrl}`);
    return { taskId, success: false, status: 'rejected', reason: '任务 URL 非法或不在安全白名单内' };
  }

  // 1. 调度派发 (优先通过 SOLVER_AGENT DO 状态机单例队列管理；未开启 DO 时直连常驻 shim)
  const shimUrl = env.AFK_SHIM_URL || env.SHIM_URL;
  const shimSecret = env.AFK_SHIM_SECRET;
  const shimToken = env.AFK_SHIM_TOKEN || env.SHIM_TOKEN;
  let finalStatus = 'pending';
  let reasonMsg = '等待客户端或 shim 执行';

  if (env.SOLVER_AGENT) {
    try {
      const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
      const res: any = await (solverStub as any).enqueue({
        jobId: task.task_id,
        platform: task.platform || 'chaoxing',
        taskUrl,
        deadline: task.deadline,
        courseName: task.course_name,
        title: task.title,
        force: options?.force ?? false,
      });
      if (res && res.accepted === false) {
        return {
          taskId,
          success: false,
          status: res.status || task.status,
          reason: res.reason || '任务已跳过（去重/冷却或触发限流保护）',
        };
      }
      finalStatus = res?.status || 'dispatched';
      reasonMsg = res?.reason || (finalStatus === 'dispatched' ? '已安全派发至服务器 shim' : '已入队单例队列等待排队');
    } catch (e: any) {
      console.warn(`[dispatchSingleTask] SOLVER_AGENT enqueue 异常: ${e?.message || e}`);
      finalStatus = 'pending';
      reasonMsg = `入队异常: ${e?.message || e}`;
    }
  } else if (shimUrl) {
    // 2. 未绑定 SOLVER_AGENT 时，直连常驻服务器 shim (强制 HMAC 签名或 Bearer)
    try {
      const endpoint = new URL('/task', shimUrl.replace(/\/+$/, '') + '/');
      const body = JSON.stringify({
        jobId: task.task_id,
        taskUrl,
        platform: task.platform || 'chaoxing',
        deadline: task.deadline,
        mode: 'draft',
      });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (shimSecret) {
        const sigHeaders = await signRequest({
          secret: shimSecret,
          method: 'POST',
          pathWithQuery: endpoint.pathname + endpoint.search,
          body,
        });
        Object.assign(headers, sigHeaders);
      } else if (shimToken) {
        headers['Authorization'] = `Bearer ${shimToken}`;
      }

      const res = await fetch(endpoint.toString(), {
        method: 'POST',
        headers,
        body,
      });
      finalStatus = res.ok ? 'dispatched' : 'pending';
      reasonMsg = res.ok ? '已成功签名下发至服务器 shim' : `shim 响应异常 HTTP ${res.status}`;
    } catch (e: any) {
      console.warn(`[dispatchSingleTask] 直接通知 shim 异常: ${e?.message || e}`);
      finalStatus = 'pending';
      reasonMsg = `派发网络异常: ${e?.message || e}`;
    }
  }

  // 3. 准确同步 D1 状态与执行日志（若从 failed 重试则清空旧失败摘要）
  if (wasFailed) {
    await env.DB.prepare("UPDATE pending_tasks SET status = ?, result_summary = '', updated_at = ? WHERE task_id = ?")
      .bind(finalStatus, now, taskId)
      .run();
  } else {
    await env.DB.prepare('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .bind(finalStatus, now, taskId)
      .run();
  }

  if (finalStatus === 'dispatched') {
    await logExecution(
      env,
      'task_dispatched',
      task.platform || 'chaoxing',
      `【主动派发给 agy】课程《${task.course_name}》- ${task.title}`
    );

    await sendNotification(
      'afk-cloud 任务主动派发 🚀',
      `课程：《${task.course_name}》\n作业：《${task.title}》\n状态：已安全派发至云端 agy / shim 深度推理求解。`,
      env
    );
  } else if (!options?.suppressQueueLog) {
    await logExecution(
      env,
      'task_queued',
      task.platform || 'chaoxing',
      `【排队等待】课程《${task.course_name}》- ${task.title} (单例保护已启动)`
    );
  }

  return {
    taskId,
    success: true,
    status: finalStatus,
    reason: reasonMsg,
  };
}
