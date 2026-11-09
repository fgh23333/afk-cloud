import { EdgeEnv, nowUtc8 } from './store';

export interface DashboardData {
  time: string;
  stats: {
    pendingCount: number;
    draftCount: number;
    submittedCount: number;
    failedCount: number;
    signinCount: number;
    questionBankCount: number;
  };
  sessions: Array<{
    platform: string;
    account: string;
    expires_at: number;
    updated_at: string;
    valid: boolean;
  }>;
  tasks: Array<{
    task_id: string;
    platform: string;
    course_id: string;
    class_id: string;
    course_name: string;
    title: string;
    status: string;
    compute_tier: string;
    deadline: string;
    result_summary: string;
    updated_at: string;
  }>;
  logs: Array<{
    id: number;
    event_type: string;
    platform: string;
    summary: string;
    created_at: string;
  }>;
}

/**
 * 从 Cloudflare D1 聚合查询看板所需的全量状态数据（0 云主机开销，直接走 D1 免费读配额）
 */
export async function getDashboardData(env: EdgeEnv): Promise<DashboardData> {
  const empty: DashboardData = {
    time: nowUtc8(),
    stats: {
      pendingCount: 0,
      draftCount: 0,
      submittedCount: 0,
      failedCount: 0,
      signinCount: 0,
      questionBankCount: 0,
    },
    sessions: [],
    tasks: [],
    logs: [],
  };

  if (!env.DB) return empty;

  try {
    const [tasksRes, logsRes, sessionsRes, qbRes, signinRes] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM pending_tasks ORDER BY updated_at DESC LIMIT 100'),
      env.DB.prepare('SELECT id, event_type, platform, summary, created_at FROM execution_logs ORDER BY id DESC LIMIT 40'),
      env.DB.prepare('SELECT platform, account, expires_at, updated_at FROM sessions ORDER BY updated_at DESC'),
      env.DB.prepare('SELECT COUNT(*) as cnt FROM question_bank'),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM execution_logs WHERE event_type = 'signin'"),
    ]);

    const tasks = (tasksRes.results || []) as DashboardData['tasks'];
    const logs = (logsRes.results || []) as DashboardData['logs'];
    const now = Date.now();
    const sessions = ((sessionsRes.results || []) as Array<any>).map((s) => ({
      platform: s.platform,
      account: s.account ? String(s.account).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : 'default',
      expires_at: Number(s.expires_at),
      updated_at: s.updated_at,
      valid: Number(s.expires_at) > now,
    }));

    const qbCount = Number((qbRes.results?.[0] as any)?.cnt || 0);
    const signinCount = Number((signinRes.results?.[0] as any)?.cnt || 0);

    let pendingCount = 0;
    let draftCount = 0;
    let submittedCount = 0;
    let failedCount = 0;

    for (const t of tasks) {
      if (t.status === 'pending' || t.status === 'processing') pendingCount++;
      else if (t.status === 'draft_saved') draftCount++;
      else if (t.status === 'submitted') submittedCount++;
      else if (t.status === 'failed') failedCount++;
    }

    return {
      time: nowUtc8(),
      stats: {
        pendingCount,
        draftCount,
        submittedCount,
        failedCount,
        signinCount,
        questionBankCount: qbCount,
      },
      sessions,
      tasks,
      logs,
    };
  } catch {
    return empty;
  }
}

/**
 * 渲染零服务器成本的 Cloudflare Edge 全景监控看板 (Dark Tech UI)
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>afk-cloud 云端自治 Agent 全景看板 (Cloudflare Edge)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0b1120; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; }
    .glass { background: rgba(30, 41, 59, 0.75); backdrop-filter: blur(12px); border: 1px solid rgba(148, 163, 184, 0.14); }
  </style>
</head>
<body class="min-h-screen pb-16">
  <!-- 顶部固定导航栏 -->
  <header class="sticky top-0 z-30 glass border-b border-slate-800 px-6 py-4">
    <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <span class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30">🛰️</span>
        <div>
          <h1 class="text-lg font-bold text-white tracking-wide">afk-cloud 个人云端自治看板</h1>
          <p class="text-xs text-slate-400">100% 运行于 Cloudflare Workers + D1 免费边缘层 · 零云主机开销</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="tokenInput" type="password" placeholder="Bearer Token (若已启用鉴权)" class="px-3 py-1.5 text-xs rounded-lg bg-slate-900 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500" />
        <button onclick="loadDashboard()" class="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">🔄 刷新数据</button>
        <button onclick="triggerEdgeCheck()" id="btnCheck" class="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">⚡ 立即巡检签到/作业</button>
        <button onclick="triggerDigest()" id="btnDigest" class="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition">📨 推送今日汇总简报</button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-6 mt-6 space-y-6">
    <!-- 状态提示条 -->
    <div id="toast" class="hidden rounded-xl px-4 py-3 text-sm bg-blue-500/20 border border-blue-500/40 text-blue-200"></div>

    <!-- 核心指标卡片 -->
    <section class="grid grid-cols-2 md:grid-cols-6 gap-4">
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">⏳ 待办任务</div>
        <div id="statPending" class="text-2xl font-bold text-amber-400 mt-1">-</div>
      </div>
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">📝 草稿已暂存 (pyFlag=1)</div>
        <div id="statDraft" class="text-2xl font-bold text-blue-400 mt-1">-</div>
      </div>
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">✅ 已正式提交</div>
        <div id="statSubmitted" class="text-2xl font-bold text-emerald-400 mt-1">-</div>
      </div>
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">📍 累计自动签到</div>
        <div id="statSignin" class="text-2xl font-bold text-teal-300 mt-1">-</div>
      </div>
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">🧠 D1 题库 SHA-256 缓存</div>
        <div id="statQb" class="text-2xl font-bold text-purple-400 mt-1">-</div>
      </div>
      <div class="glass rounded-xl p-4">
        <div class="text-xs text-slate-400">🕒 最后同步 (UTC+8)</div>
        <div id="statTime" class="text-xs font-mono text-slate-300 mt-2">-</div>
      </div>
    </section>

    <!-- 平台登录态与 Profile 缓存监控 -->
    <section class="glass rounded-xl p-5">
      <h2 class="text-sm font-semibold text-white mb-3 flex items-center gap-2">🔐 跨平台登录态 & 无头浏览器 Profile 缓存状态 (D1 Sessions)</h2>
      <div id="sessionsGrid" class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div class="text-slate-500">正在加载会话状态...</div>
      </div>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- 各平台任务看板 (占 2 列) -->
      <section class="lg:col-span-2 glass rounded-xl p-5">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 class="text-sm font-semibold text-white">📋 各平台任务与作业完成状况 (学习通 / PTA / 智慧树)</h2>
          <div class="flex gap-1.5 text-xs">
            <button onclick="setFilter('all')" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">全部</button>
            <button onclick="setFilter('pending')" class="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300">待完成</button>
            <button onclick="setFilter('draft_saved')" class="px-2.5 py-1 rounded bg-blue-500/20 text-blue-300">已暂存草稿</button>
            <button onclick="setFilter('submitted')" class="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300">已提交</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-400 border-b border-slate-800">
              <tr>
                <th class="py-2.5 pr-3">平台</th>
                <th class="py-2.5 pr-3">课程名称</th>
                <th class="py-2.5 pr-3">任务 / 作业标题</th>
                <th class="py-2.5 pr-3">状态</th>
                <th class="py-2.5 pr-3">截止时间 / 详情</th>
                <th class="py-2.5">更新时间</th>
              </tr>
            </thead>
            <tbody id="tasksBody" class="divide-y divide-slate-800/70">
              <tr><td colspan="6" class="py-6 text-center text-slate-500">正在加载任务列表...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 实时审计日志流 (占 1 列) -->
      <section class="glass rounded-xl p-5">
        <h2 class="text-sm font-semibold text-white mb-4">⚡ 边缘签到与双轨执行时间线 (UTC+8)</h2>
        <div id="logsList" class="space-y-3 max-h-[520px] overflow-y-auto pr-1 text-xs">
          <div class="text-slate-500">正在加载执行日志...</div>
        </div>
      </section>
    </div>
  </main>

  <script>
    let allTasks = [];
    let currentFilter = 'all';

    const savedToken = localStorage.getItem('afk_edge_token') || new URLSearchParams(location.search).get('token') || '';
    if (savedToken) {
      document.getElementById('tokenInput').value = savedToken;
      localStorage.setItem('afk_edge_token', savedToken);
    }

    function getHeaders() {
      const tk = document.getElementById('tokenInput').value.trim();
      if (tk) localStorage.setItem('afk_edge_token', tk);
      return tk ? { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    }

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 6000);
    }

    function setFilter(f) {
      currentFilter = f;
      renderTasks();
    }

    function statusBadge(status) {
      if (status === 'submitted') return '<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">✅ 已提交</span>';
      if (status === 'draft_saved') return '<span class="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">📝 草稿已存</span>';
      if (status === 'failed') return '<span class="px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30">❌ 异常</span>';
      return '<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">⏳ 待处理</span>';
    }

    function renderTasks() {
      const tbody = document.getElementById('tasksBody');
      const filtered = currentFilter === 'all' ? allTasks : allTasks.filter(t => t.status === currentFilter);
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">当前筛选条件下暂无任务记录</td></tr>';
        return;
      }
      tbody.innerHTML = filtered.map(t => \`
        <tr class="hover:bg-slate-800/40 transition">
          <td class="py-3 pr-3 font-medium uppercase text-slate-300">\${t.platform}</td>
          <td class="py-3 pr-3 text-slate-200">\${t.course_name || '-'}</td>
          <td class="py-3 pr-3 font-medium text-white">\${t.title}</td>
          <td class="py-3 pr-3">\${statusBadge(t.status)}</td>
          <td class="py-3 pr-3 text-slate-400">\${t.result_summary || (t.deadline ? '截止: ' + t.deadline : t.compute_tier || '-')}</td>
          <td class="py-3 text-slate-500 font-mono">\${t.updated_at || '-'}</td>
        </tr>
      \`).join('');
    }

    async function loadDashboard() {
      try {
        const res = await fetch('/api/dashboard', { headers: getHeaders() });
        if (res.status === 401) {
          showToast('⚠️ 鉴权失败：请在右上角输入您的 API_BEARER_TOKEN 后点击刷新');
          return;
        }
        const data = await res.json();
        document.getElementById('statPending').textContent = data.stats.pendingCount;
        document.getElementById('statDraft').textContent = data.stats.draftCount;
        document.getElementById('statSubmitted').textContent = data.stats.submittedCount;
        document.getElementById('statSignin').textContent = data.stats.signinCount;
        document.getElementById('statQb').textContent = data.stats.questionBankCount;
        document.getElementById('statTime').textContent = data.time;

        allTasks = data.tasks || [];
        renderTasks();

        const sGrid = document.getElementById('sessionsGrid');
        if (!data.sessions || data.sessions.length === 0) {
          sGrid.innerHTML = '<div class="text-slate-500">尚无缓存的登录 Session，等待首次 Cron 触发或 CLI 同步</div>';
        } else {
          sGrid.innerHTML = data.sessions.map(s => \`
            <div class="p-3 rounded-lg bg-slate-900/70 border border-slate-800 flex items-center justify-between">
              <div>
                <div class="font-semibold text-slate-200">\${s.platform} <span class="text-slate-500 font-normal">(\${s.account})</span></div>
                <div class="text-[11px] text-slate-500 mt-0.5">更新: \${s.updated_at}</div>
              </div>
              <span class="px-2 py-0.5 rounded text-[11px] \${s.valid ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}">\${s.valid ? '🟢 有效' : '🔴 已过期'}</span>
            </div>
          \`).join('');
        }

        const logsEl = document.getElementById('logsList');
        if (!data.logs || data.logs.length === 0) {
          logsEl.innerHTML = '<div class="text-slate-500">暂无审计日志</div>';
        } else {
          logsEl.innerHTML = data.logs.map(l => \`
            <div class="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <div class="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                <span class="font-mono text-blue-400">[\${l.platform} · \${l.event_type}]</span>
                <span>\${l.created_at}</span>
              </div>
              <div class="text-slate-200">\${l.summary}</div>
            </div>
          \`).join('');
        }
      } catch (e) {
        showToast('加载异常: ' + e.message);
      }
    }

    async function triggerEdgeCheck() {
      showToast('⏳ 正在触发 Cloudflare Edge 实时签到与作业红点扫描...');
      const res = await fetch('/check', { headers: getHeaders() });
      const data = await res.json();
      showToast(\`✅ 巡检完成：扫描 \${data.coursesCount || 0} 门课，签到 \${(data.signsExecuted || []).length} 次，发现待办课程 \${(data.homeworkCoursesDetected || []).length} 门\`);
      loadDashboard();
    }

    async function triggerDigest() {
      showToast('📨 正在生成并向您的推送渠道发送今日任务简报...');
      const res = await fetch('/api/digest', { method: 'POST', headers: getHeaders() });
      const data = await res.json();
      showToast(data.sent ? '✅ 汇总简报已推送至您配置的通知渠道！' : '⚠️ 简报已生成（若需手机接收请配置 WEBHOOK_URL / SERVERCHAN_KEY / BARK_KEY）');
    }

    loadDashboard();
    setInterval(loadDashboard, 30000);
  </script>
</body>
</html>`;
}
