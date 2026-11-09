import http, { IncomingMessage, ServerResponse } from 'http';
import { formatUtc8Now } from '../../core/types';
import { getManagedBrowserStatus, startManagedBrowser, stopManagedBrowser } from './browser';
import { enqueueJob, getJob, listJobs, TaskJob } from './runner';

const PORT = parseInt(process.env.SHIM_PORT || process.env.PORT || '8788', 10);
const SHIM_TOKEN = process.env.SHIM_TOKEN || process.env.AFK_SHIM_TOKEN || '';

function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : ({} as T));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function checkBearerAuth(req: IncomingMessage): boolean {
  const token = process.env.SHIM_TOKEN || process.env.AFK_SHIM_TOKEN || '';
  if (!token) return true; // 若未配置 Token 则默认不拦截 (便于本地单机调试)
  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${token}`;
}

export function createShimServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // 跨域预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 鉴权拦截 (除 /health 外全部需要 Bearer SHIM_TOKEN)
    if (pathname !== '/health' && !checkBearerAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized: Invalid or missing Bearer SHIM_TOKEN' });
      return;
    }

    try {
      // 1. GET /health
      if (pathname === '/health' && req.method === 'GET') {
        const browser = getManagedBrowserStatus();
        const jobs = listJobs();
        const activeJobs = jobs.filter((j) => j.phase === 'running' || j.phase === 'pending');
        sendJson(res, 200, {
          status: 'ok',
          time: formatUtc8Now(),
          agy: 'ok',
          browser: browser.status,
          cdpUrl: browser.cdpUrl,
          jobs: activeJobs.length,
          totalJobs: jobs.length,
        });
        return;
      }

      // 2. POST /task (异步启动 solve-draft，立即返回 jobId)
      if (pathname === '/task' && req.method === 'POST') {
        const body = await parseJsonBody<{
          jobId: string;
          taskUrl: string;
          platform?: string;
          deadline?: string;
          mode?: 'draft' | 'submit';
        }>(req);

        if (!body.jobId || !body.taskUrl) {
          sendJson(res, 400, { error: 'Missing jobId or taskUrl in request' });
          return;
        }

        const job = enqueueJob({
          jobId: body.jobId,
          taskUrl: body.taskUrl,
          platform: body.platform || 'chaoxing',
          deadline: body.deadline,
          mode: body.mode || 'draft',
        });

        sendJson(res, 202, {
          jobId: job.jobId,
          accepted: true,
          phase: job.phase,
          time: formatUtc8Now(),
        });
        return;
      }

      // 3. POST /submit (第二条指令：让 agy 回到该任务页面点提交)
      if (pathname === '/submit' && req.method === 'POST') {
        const body = await parseJsonBody<{
          jobId: string;
          taskUrl?: string;
        }>(req);

        if (!body.jobId) {
          sendJson(res, 400, { error: 'Missing jobId' });
          return;
        }

        const existing = getJob(body.jobId);
        const taskUrl = body.taskUrl || existing?.taskUrl;
        if (!taskUrl) {
          sendJson(res, 400, { error: 'taskUrl is required for submission' });
          return;
        }

        const job = enqueueJob({
          jobId: body.jobId,
          taskUrl,
          mode: 'submit',
        });

        sendJson(res, 202, {
          jobId: job.jobId,
          accepted: true,
          phase: job.phase,
          time: formatUtc8Now(),
        });
        return;
      }

      // 4. GET /status/:jobId
      if (pathname.startsWith('/status/') && req.method === 'GET') {
        const jobId = pathname.replace('/status/', '').trim();
        const job = getJob(jobId);
        if (!job) {
          sendJson(res, 404, { error: `Job [${jobId}] not found` });
          return;
        }

        sendJson(res, 200, {
          jobId: job.jobId,
          phase: job.phase,
          qa: job.qa || [],
          summary: job.summary || '',
          error: job.error,
          updatedAt: job.updatedAt,
        });
        return;
      }

      // 5. POST /browser (按需起停本地 Chromium，空闲 TTL 自停)
      if (pathname === '/browser' && req.method === 'POST') {
        const body = await parseJsonBody<{
          platform?: string;
          action?: 'start' | 'stop';
          ttlMinutes?: number;
        }>(req);

        const action = body.action || 'start';
        const platform = body.platform || 'pta';

        if (action === 'stop') {
          const resStop = await stopManagedBrowser();
          sendJson(res, 200, resStop);
          return;
        }

        const resStart = await startManagedBrowser(platform, body.ttlMinutes || 30);
        sendJson(res, 200, resStart);
        return;
      }

      sendJson(res, 404, { error: 'Endpoint Not Found' });
    } catch (err: any) {
      console.error('[Shim Server Error]', err);
      sendJson(res, 500, { error: err?.message || 'Internal Server Error' });
    }
  });

  return server;
}

if (require.main === module) {
  const server = createShimServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(` 🐾 afk-cloud Server Shim (Pet Node) 已就绪`);
    console.log(` 🚀 监听端口: http://0.0.0.0:${PORT}`);
    console.log(` 🔑 Bearer 鉴权: ${SHIM_TOKEN ? '已启用' : '未设置 (开放模式)'}`);
    console.log(`======================================================\n`);
  });
}
