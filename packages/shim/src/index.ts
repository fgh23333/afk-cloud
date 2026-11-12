import http, { IncomingMessage, ServerResponse } from 'http';
import { verifySignedRequest } from '../../core/request-signing';
import { formatUtc8Now } from '../../core/types';
import { getManagedBrowserStatus, startManagedBrowser, stopManagedBrowser } from './browser';
import { enqueueJob, getJob, listJobs, pendingQueueLength, releaseLock, startAgyWatchdog } from './runner';
import {
  assertShimStartupSecurity,
  loadShimSecurityConfig,
  NonceCache,
  ShimSecurityConfig,
  validateDeadline,
  validateJobId,
  validateMode,
  validatePlatform,
  validateTaskUrl,
  ValidationError,
} from './security';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * 读取原始请求体（带大小上限，超限立即断开）
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (declared > maxBytes) {
      reject(new HttpError(413, 'Payload Too Large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Payload Too Large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson<T = any>(raw: string): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON payload');
  }
}

function sendJson(res: ServerResponse, status: number, data: any) {
  // 服务间接口：不下发任何 CORS 头，浏览器跨域脚本无法调用
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

export function createShimServer(overrides: Partial<ShimSecurityConfig> = {}): http.Server {
  const cfg: ShimSecurityConfig = { ...loadShimSecurityConfig(), ...overrides };
  assertShimStartupSecurity(cfg);
  const nonces = new NonceCache();

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const pathWithQuery = req.url || '/';
    const pathname = new URL(pathWithQuery, 'http://shim.local').pathname;

    try {
      // 0. 公开存活探针：仅返回最小信息，不暴露任务、浏览器与 CDP 细节
      if (pathname === '/health' && method === 'GET') {
        sendJson(res, 200, { status: 'ok', time: formatUtc8Now() });
        return;
      }

      if (method !== 'GET' && method !== 'POST') {
        throw new HttpError(405, 'Method Not Allowed');
      }
      if (method === 'POST') {
        const ctype = String(req.headers['content-type'] || '');
        if (!ctype.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Content-Type must be application/json');
        }
      }

      // 1. 全部业务接口必须携带 Edge 的 HMAC 签名（时间窗 + Nonce 防重放）
      const raw = await readRawBody(req, cfg.maxBodyBytes);
      if (!cfg.insecureDev) {
        const verdict = await verifySignedRequest({
          secret: cfg.secret,
          method,
          pathWithQuery,
          body: raw,
          getHeader: (name) => {
            const v = req.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
          seenNonce: (nonce) => nonces.checkAndRemember(nonce),
        });
        if (!verdict.ok) {
          console.warn(`[Shim Security] 拒绝未通过验签的请求 ${method} ${pathname}: ${verdict.reason}`);
          throw new HttpError(401, 'Unauthorized');
        }
      }

      // 2. GET /health/detail (签名后可见的详细状态)
      if (pathname === '/health/detail' && method === 'GET') {
        const browser = getManagedBrowserStatus();
        const jobs = listJobs();
        sendJson(res, 200, {
          status: 'ok',
          time: formatUtc8Now(),
          browser: browser.status,
          jobs: jobs.filter((j) => j.phase === 'running' || j.phase === 'pending').length,
          totalJobs: jobs.length,
          queue: pendingQueueLength(),
        });
        return;
      }

      // 3. POST /task (异步启动 solve-draft，立即返回 jobId)
      if (pathname === '/task' && method === 'POST') {
        const body = parseJson<Record<string, unknown>>(raw);
        const jobId = validateJobId(body.jobId);
        const taskUrl = validateTaskUrl(body.taskUrl, cfg.taskHostAllowlist);
        const platform = validatePlatform(body.platform);
        const deadline = validateDeadline(body.deadline);
        const mode = validateMode(body.mode);
        if (mode !== 'draft') {
          // 正式提交只能走 /submit，且只能作用于已存在的草稿任务
          throw new ValidationError('/task 仅接受 draft 模式');
        }
        if (pendingQueueLength() >= cfg.maxQueueLength && !getJob(jobId)) {
          throw new HttpError(429, 'Queue is full, retry later');
        }

        const job = enqueueJob({ jobId, taskUrl, platform, deadline, mode: 'draft' });
        sendJson(res, 202, { jobId: job.jobId, accepted: true, phase: job.phase, time: formatUtc8Now() });
        return;
      }

      // 4. POST /submit (只允许对已完成草稿的已知任务下发提交，taskUrl 不接受外部传入)
      if (pathname === '/submit' && method === 'POST') {
        const body = parseJson<Record<string, unknown>>(raw);
        const jobId = validateJobId(body.jobId);
        const existing = getJob(jobId);
        if (!existing) {
          throw new HttpError(404, `Job [${jobId}] not found`);
        }
        if (existing.phase !== 'draft_saved') {
          throw new HttpError(409, `Job [${jobId}] 当前阶段为 ${existing.phase}，仅 draft_saved 可提交`);
        }

        const job = enqueueJob({ jobId, taskUrl: existing.taskUrl, mode: 'submit' });
        sendJson(res, 202, { jobId: job.jobId, accepted: true, phase: job.phase, time: formatUtc8Now() });
        return;
      }

      // 5. GET /status/:jobId
      if (pathname.startsWith('/status/') && method === 'GET') {
        const jobId = validateJobId(decodeURIComponent(pathname.slice('/status/'.length)));
        const job = getJob(jobId);
        if (!job) {
          throw new HttpError(404, `Job [${jobId}] not found`);
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

      // 6. POST /browser (按需起停本地 Chromium，空闲 TTL 自停)
      if (pathname === '/browser' && method === 'POST') {
        const body = parseJson<Record<string, unknown>>(raw);
        const action = body.action === 'stop' ? 'stop' : 'start';
        if (body.action !== undefined && body.action !== 'start' && body.action !== 'stop') {
          throw new ValidationError('action 仅允许 start | stop');
        }

        if (action === 'stop') {
          sendJson(res, 200, await stopManagedBrowser());
          return;
        }

        const platform = validatePlatform(body.platform || 'pta');
        const ttl = Math.min(Math.max(Number(body.ttlMinutes) || 30, 1), 120);
        sendJson(res, 200, await startManagedBrowser(platform, ttl));
        return;
      }

      throw new HttpError(404, 'Endpoint Not Found');
    } catch (err: any) {
      const status = err instanceof HttpError || err instanceof ValidationError ? err.status : 500;
      if (status >= 500) console.error('[Shim Server Error]', err);
      // 5xx 不回显内部错误细节
      sendJson(res, status, { error: status >= 500 ? 'Internal Server Error' : err?.message || 'Bad Request' });
    }
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}

if (require.main === module) {
  const cfg = loadShimSecurityConfig();
  let server: http.Server;
  try {
    server = createShimServer(cfg);
  } catch (e: any) {
    console.error(`\n❌ [Shim Security] 拒绝启动: ${e?.message || e}\n`);
    process.exit(1);
  }
  server.listen(cfg.port, cfg.host, () => {
    // 启动宿主机 60s 看门狗巡检与孤儿进程回收器
    startAgyWatchdog();

    process.on('SIGTERM', () => {
      releaseLock();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      releaseLock();
      process.exit(0);
    });

    console.log(`\n======================================================`);
    console.log(` 🐾 afk-cloud Server Shim (Pet Node) 已就绪`);
    console.log(` 🚀 监听地址: http://${cfg.host}:${cfg.port}`);
    console.log(` 🔐 请求鉴权: ${cfg.insecureDev ? '⚠️ 本地调试免签名' : 'HMAC-SHA256 签名 + 时间窗 + Nonce 防重放'}`);
    console.log(` 🌐 任务域名白名单: ${cfg.taskHostAllowlist.join(', ')}`);
    console.log(` 🛡️ 单例保护: 硬件互斥锁与 60s 看门狗回收器已激活`);
    console.log(`======================================================\n`);
  });
}
