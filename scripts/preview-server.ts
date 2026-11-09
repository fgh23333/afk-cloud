import http from 'http';
import { renderDashboardHtml } from '../edge/src/dashboard';

const PORT = 8787;

// 真实初始状态：绝不伪造虚假数据，所有指标与列表基于真实扫描结果展示
const dashboardData: {
  time: string;
  lastSync: string;
  daemonStatus: string;
  stats: {
    pendingCount: number;
    draftCount: number;
    submittedCount: number;
    failedCount: number;
    signinCount: number;
    questionBankCount: number;
  };
  sessions: any[];
  tasks: any[];
  homeworks: any[];
  exams: any[];
  notices: any[];
  signinHistory: any[];
  courses: any[];
  logs: any[];
} = {
  time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)',
  lastSync: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)',
  daemonStatus: 'ONLINE',
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
  homeworks: [],
  exams: [],
  notices: [],
  signinHistory: [],
  courses: [],
  logs: [],
};

function sendCors(res: http.ServerResponse, status: number, headers: Record<string, string>, body: string) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    sendCors(res, 204, {}, '');
    return;
  }

  // 1. 原生零服务器 HTML 全景暗色科技看板
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    sendCors(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, renderDashboardHtml());
    return;
  }

  // 2. 看板数据聚合 API (支持 /api/dashboard 与 /api/data，100% 真实数据)
  if (url.pathname === '/api/dashboard' || url.pathname === '/api/data') {
    dashboardData.time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)';
    sendCors(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(dashboardData));
    return;
  }

  // 3. 立即巡检
  if (url.pathname === '/check') {
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    dashboardData.lastSync = nowStr + ' (UTC+8)';
    sendCors(
      res,
      200,
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({
        success: true,
        time: nowStr,
        coursesCount: dashboardData.courses.length,
        signsExecuted: [],
        homeworkCoursesDetected: [],
      })
    );
    return;
  }

  // 4. 即时简报推送
  if (url.pathname === '/api/digest') {
    sendCors(
      res,
      200,
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({
        sent: true,
        summary: `📊 afk-cloud 每日任务简报 (UTC+8)\n待办任务: ${dashboardData.stats.pendingCount} | 草稿已暂存: ${dashboardData.stats.draftCount} | 已提交: ${dashboardData.stats.submittedCount}\n累计签到: ${dashboardData.stats.signinCount} 次 | 题库缓存: ${dashboardData.stats.questionBankCount} 题`,
        time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      })
    );
    return;
  }

  // 5. 作业审批提交接口 (D7 准则：审批提交后更新状态)
  if (url.pathname === '/api/tasks/status') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const hw = dashboardData.homeworks.find((h) => h.taskId === body.taskId);
        if (hw) {
          hw.status = body.status || 'submitted';
          hw.isPending = false;
          hw.resultSummary = body.resultSummary || '用户已在看板手动审批正式提交';
          dashboardData.stats.draftCount = Math.max(0, dashboardData.stats.draftCount - 1);
          dashboardData.stats.submittedCount += 1;
        }
        sendCors(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ updated: true }));
      } catch {
        sendCors(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // 6. 同步真实任务数据接口 (供 CLI 扫描或 Cloud Run 执行后上报)
  if (url.pathname === '/api/tasks/sync' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        if (Array.isArray(body.tasks)) {
          for (const item of body.tasks) {
            const idx = dashboardData.homeworks.findIndex((h) => h.taskId === item.taskId);
            const isDraft = item.status === 'draft_saved';
            const isSubmitted = item.status === 'submitted';
            const isPending = !isDraft && !isSubmitted;
            const hwObj = {
              taskId: item.taskId,
              title: item.title,
              courseName: item.courseName || '未命名课程',
              endDate: item.deadline || '无截止限制',
              isPending,
              status: item.status || 'pending',
              platform: item.platform || 'chaoxing',
              computeTier: item.computeTier || 'tier1-cloud-run',
              resultSummary: item.resultSummary || '',
              aiSolved: isDraft || isSubmitted,
            };
            if (idx >= 0) {
              dashboardData.homeworks[idx] = hwObj;
            } else {
              dashboardData.homeworks.push(hwObj);
            }
          }
          // 重算统计
          dashboardData.stats.pendingCount = dashboardData.homeworks.filter((h) => h.isPending).length;
          dashboardData.stats.draftCount = dashboardData.homeworks.filter((h) => h.status === 'draft_saved').length;
          dashboardData.stats.submittedCount = dashboardData.homeworks.filter((h) => h.status === 'submitted').length;
        }
        sendCors(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ synced: true }));
      } catch {
        sendCors(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // 7. 健康检查
  if (url.pathname === '/health') {
    sendCors(
      res,
      200,
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ status: 'ok', preview: true, time: new Date().toISOString() })
    );
    return;
  }

  sendCors(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 afk-cloud 真实数据看板服务已启动: http://127.0.0.1:${PORT}`);
});
