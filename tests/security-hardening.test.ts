import assert from 'node:assert';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { checkAuth, isAuthEnforced, isValidAuthToken } from '../edge/src/auth';
import { signRequest, verifySignedRequest } from '../edge/src/request-signing';
import {
  acquireLock,
  buildSanitizedEnv,
  getAgyQuotaState,
  invokeAgy,
  releaseLock,
} from '../packages/core/agy-invoke';
import { createShimServer } from '../packages/shim/src/index';
import { NonceCache } from '../packages/shim/src/security';

let capturedAgentRouteOptions: any = null;

// Stub `agents` and `cloudflare:workers` before requiring Edge modules
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'cloudflare:workers') {
    return { DurableObject: class {} };
  }
  if (request === 'agents') {
    class MockAgent {
      state: any = {};
      env: any = {};
      ctx: any = {};
      setState(next: any) {
        this.state = next;
      }
    }
    return {
      Agent: MockAgent,
      callable: () => () => {},
      routeAgentRequest: async (req: Request, _env: unknown, opts?: any) => {
        const pathname = new URL(req.url).pathname;
        if (!pathname.startsWith('/agents/')) return null;
        capturedAgentRouteOptions = opts;
        return new Response('agent-ok', { status: 200 });
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const edgeEntry = require('../edge/src/index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SolverAgent, MAX_TASK_ATTEMPTS } = require('../edge/src/solver-agent');

function createMockDoSql() {
  const tasks = new Map<string, any>();
  const nonces = new Map<string, number>();
  return {
    tasks,
    nonces,
    exec(query: string, ...args: any[]) {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        return [];
      }
      if (q.startsWith('DELETE FROM seen_nonces WHERE expires_at < ?')) {
        const cutoff = Number(args[0]);
        for (const [k, exp] of nonces) {
          if (exp < cutoff) nonces.delete(k);
        }
        return [];
      }
      if (q.startsWith('SELECT nonce FROM seen_nonces WHERE nonce = ?')) {
        return nonces.has(String(args[0])) ? [{ nonce: args[0] }] : [];
      }
      if (q.startsWith('INSERT OR IGNORE INTO seen_nonces')) {
        const [nonce, expiresAt] = args;
        if (!nonces.has(String(nonce))) {
          nonces.set(String(nonce), Number(expiresAt));
        }
        return [];
      }
      if (q.startsWith('SELECT * FROM tasks WHERE job_id = ?')) {
        const row = tasks.get(args[0]);
        return row ? [{ ...row }] : [];
      }
      if (q.startsWith("SELECT count(*) as cnt FROM tasks WHERE status = 'pending'")) {
        const cnt = Array.from(tasks.values()).filter((r) => r.status === 'pending').length;
        return [{ cnt }];
      }
      if (q.startsWith("SELECT * FROM tasks WHERE status = 'pending'")) {
        return Array.from(tasks.values())
          .filter((r) => r.status === 'pending')
          .slice(0, 1)
          .map((r) => ({ ...r }));
      }
      if (q.startsWith('INSERT OR REPLACE INTO tasks')) {
        const [jobId, platform, taskUrl, deadline, updatedAt] = args;
        tasks.set(jobId, {
          job_id: jobId,
          platform,
          task_url: taskUrl,
          status: 'pending',
          deadline,
          qa_json: '[]',
          summary: '',
          attempts: 0,
          updated_at: updatedAt,
        });
        return [];
      }
      if (q.startsWith('UPDATE tasks SET attempts = ? WHERE job_id = ?')) {
        const row = tasks.get(args[1]);
        if (row) row.attempts = Number(args[0]);
        return [];
      }
      if (q.startsWith('UPDATE tasks SET status = ?, attempts = attempts + 1')) {
        const [status, updatedAt, jobId] = args;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.attempts = Number(row.attempts || 0) + 1;
          row.updated_at = updatedAt;
        }
        return [];
      }
      if (q.startsWith('UPDATE tasks SET status = ?, qa_json = ?')) {
        const [status, qaJson, summary, updatedAt, jobId] = args;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.qa_json = qaJson;
          row.summary = summary;
          row.updated_at = updatedAt;
        }
        return [];
      }
      if (q.startsWith('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE job_id = ?')) {
        const [status, summary, updatedAt, jobId] = args;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.summary = summary;
          row.updated_at = updatedAt;
        }
        return [];
      }
      return [];
    },
  };
}

function createMockDb(initialRows: Record<string, any>[] = []) {
  const pending = new Map<string, any>(initialRows.map((r) => [r.task_id, { ...r }]));
  return {
    pending,
    prepare(sql: string) {
      const execFn = (args: unknown[] = []) => ({
        async first<T = any>(): Promise<T | null> {
          if (sql.includes('FROM pending_tasks WHERE task_id = ?')) {
            return (pending.get(String(args[0])) as T) ?? null;
          }
          return null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          return { results: Array.from(pending.values()) as T[] };
        },
        async run() {
          if (sql.includes('INSERT INTO pending_tasks')) {
            const tid = String(args[0]);
            pending.set(tid, {
              task_id: tid,
              platform: args[1],
              status: args[6],
              updated_at: args[10],
            });
          } else if (sql.includes('UPDATE pending_tasks SET status = ?') && sql.includes('WHERE task_id = ?')) {
            const tid = String(args[args.length - 1]);
            const row = pending.get(tid);
            if (row) row.status = String(args[0]);
          }
          return { success: true };
        },
      });
      return {
        ...execFn(),
        bind: (...args: unknown[]) => execFn(args),
      };
    },
  };
}

async function runTests() {
  console.log('\n🛡️ 开始运行安全加固、WebSocket 鉴权、防重放与防刷熔断专项测试...\n');
  const origFetch = globalThis.fetch;

  try {
    // Test 1: 公开默认 SYNC_SECRET 必须彻底失效（Fail-Closed）
    {
      const insecureEnv: any = { SYNC_SECRET: 'chaoxing_secure_sync_key' };
      assert.strictEqual(isAuthEnforced(insecureEnv), false, '公开默认 SYNC_SECRET 不得被视作有效安全口令');
      assert.strictEqual(
        isValidAuthToken('chaoxing_secure_sync_key', insecureEnv),
        false,
        '不得接受 chaoxing_secure_sync_key 作为认证凭据'
      );
      const req = new Request('https://afk.example.com/api/tasks', {
        headers: { Authorization: 'Bearer chaoxing_secure_sync_key' },
      });
      assert.strictEqual(checkAuth(req, insecureEnv, { allowQueryToken: false }), false);

      const loginRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'chaoxing_secure_sync_key' }),
        }),
        { SYNC_SECRET: 'chaoxing_secure_sync_key', API_BEARER_TOKEN: 'strong-random-token-abcdef123456' },
        { waitUntil() {} }
      );
      assert.strictEqual(loginRes.status, 401, '即使环境变量残留旧 SYNC_SECRET，login 接口也必须拒绝默认值');
      console.log(' ✅ [Test 1/7 PASS] 硬编码默认 SYNC_SECRET 彻底失效与 Fail-Closed 校验通过');
    }

    // Test 2: /agents/* WebSocket & API Query Token 拦截 + 收敛 CORS
    {
      const strongToken = 'prod-strong-bearer-token-0123456789abcdef';
      const env: any = { API_BEARER_TOKEN: strongToken };
      const ctx = { waitUntil() {} };

      // 2.1 未鉴权 WebSocket 连接 /agents/solver-agent/default 必须直接 401
      const unauthAgentWs = await edgeEntry.fetch(
        new Request('https://afk.example.com/agents/solver-agent/default', {
          headers: { Upgrade: 'websocket' },
        }),
        env,
        ctx
      );
      assert.strictEqual(unauthAgentWs.status, 401, '未鉴权的 WebSocket /agents/* 连接必须返回 401');

      // 2.2 ?token= 不得用于 /agents/* 或 /api/*
      const queryAgentRes = await edgeEntry.fetch(
        new Request(`https://afk.example.com/agents/solver-agent/default?token=${strongToken}`),
        env,
        ctx
      );
      assert.strictEqual(queryAgentRes.status, 401, '/agents/* 不得接受 ?token= URL 参数鉴权');

      const queryApiRes = await edgeEntry.fetch(
        new Request(`https://afk.example.com/api/tasks/queue?token=${strongToken}`),
        env,
        ctx
      );
      assert.strictEqual(queryApiRes.status, 401, '/api/* 不得接受 ?token= URL 参数鉴权');

      // 2.3 合法 Bearer 调用 /agents/* 必须向 routeAgentRequest 传递 onBeforeConnect 和 onBeforeRequest 守卫
      capturedAgentRouteOptions = null;
      const authAgentRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/agents/solver-agent/default', {
          headers: { Authorization: `Bearer ${strongToken}` },
        }),
        env,
        ctx
      );
      assert.strictEqual(authAgentRes.status, 200);
      assert.ok(
        typeof capturedAgentRouteOptions?.onBeforeConnect === 'function' &&
          typeof capturedAgentRouteOptions?.onBeforeRequest === 'function',
        'routeAgentRequest 必须配置 onBeforeConnect 与 onBeforeRequest 安全钩子'
      );
      const hookDenied = capturedAgentRouteOptions.onBeforeConnect(
        new Request('https://afk.example.com/agents/solver-agent/default')
      );
      assert.strictEqual(hookDenied?.status, 401, 'onBeforeConnect 钩子本身也必须拒绝未鉴权请求');

      // 2.4 收敛 CORS：第三方源不得拿到 Access-Control-Allow-Origin，同源可拿到
      const evilCorsRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/health', {
          headers: { Origin: 'https://evil.attacker.example' },
        }),
        env,
        ctx
      );
      assert.strictEqual(
        evilCorsRes.headers.get('Access-Control-Allow-Origin'),
        null,
        '未授权第三方 Origin 不得返回 Access-Control-Allow-Origin'
      );

      const sameOriginRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/health', {
          headers: { Origin: 'https://afk.example.com' },
        }),
        env,
        ctx
      );
      assert.strictEqual(sameOriginRes.headers.get('Access-Control-Allow-Origin'), 'https://afk.example.com');
      console.log(' ✅ [Test 2/7 PASS] /agents/* WebSocket RPC 鉴权、?token= 禁令与同源 CORS 收敛通过');
    }

    // Test 3: Telegram Webhook 转发 /agent-chat 签名修复 & Webhook Secret 校验
    {
      const shimSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      let forwardedHeaders: Headers | null = null;
      let forwardedBody = '';
      const bgPromises: Promise<unknown>[] = [];

      try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u === 'https://shim.mock.local/agent-chat') {
          forwardedHeaders = new Headers(init?.headers);
          forwardedBody = String(init?.body || '');
          return new Response(JSON.stringify({ accepted: true, immediateReply: 'ok' }), { status: 200 });
        }
        if (u.startsWith('https://api.telegram.org/')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch;

      const env: any = {
        TELEGRAM_WEBHOOK_SECRET: 'tg-secret-12345',
        TELEGRAM_CHAT_ID: '99887766',
        TELEGRAM_BOT_TOKEN: 'bot-token-mock',
        AFK_SHIM_URL: 'https://shim.mock.local',
        AFK_SHIM_SECRET: shimSecret,
      };
      const tgReq = new Request('https://afk.example.com/api/tg/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'tg-secret-12345',
        },
        body: JSON.stringify({
          message: { chat: { id: 99887766 }, text: '总结今日待办' },
        }),
      });
      const tgRes = await edgeEntry.fetch(tgReq, env, {
        waitUntil: (p: Promise<unknown>) => bgPromises.push(p),
      });
      assert.strictEqual(tgRes.status, 200);
      await Promise.all(bgPromises);
      assert.ok(forwardedHeaders, 'Webhook 应转发 POST /agent-chat 到 Shim');

      const verifyRes = await verifySignedRequest({
        secret: shimSecret,
        method: 'POST',
        pathWithQuery: '/agent-chat',
        body: forwardedBody,
        getHeader: (name) => forwardedHeaders!.get(name),
      });
      assert.strictEqual(verifyRes.ok, true, `转发 /agent-chat 的 HMAC 签名必须验签通过 (got: ${JSON.stringify(verifyRes)})`);
      console.log(' ✅ [Test 3/7 PASS] Telegram Webhook -> /agent-chat HMAC 签名头修复与验签通过');
      } finally {
        globalThis.fetch = origFetch;
      }
    }

    // Test 4: /api/agent/callback Nonce 原子防重放校验
    {
      const shimSecret = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const sql = createMockDoSql();
      const db = createMockDb();
      const env: any = { DB: db, AFK_SHIM_SECRET: shimSecret };
      const agent = new (SolverAgent as any)({ storage: { sql } }, env);
      agent.env = env;
      agent.ctx = { storage: { sql } };
      agent.onStart();
      env.SOLVER_AGENT = { idFromName: () => 'default', get: () => agent };

      const payload = JSON.stringify({ jobId: 'cb-job-1', phase: 'failed', error: 'timeout' });
      const sigHeaders = await signRequest({
        secret: shimSecret,
        method: 'POST',
        pathWithQuery: '/api/agent/callback',
        body: payload,
      });

      const firstRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/api/agent/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...sigHeaders },
          body: payload,
        }),
        env,
        { waitUntil() {} }
      );
      assert.strictEqual(firstRes.status, 200, '首次合法签名回调应通过');

      const replayRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/api/agent/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...sigHeaders },
          body: payload,
        }),
        env,
        { waitUntil() {} }
      );
      assert.strictEqual(replayRes.status, 401, '相同 Nonce 重放回调 /api/agent/callback 必须被 401 拦截');
      console.log(' ✅ [Test 4/7 PASS] /api/agent/callback 原子 Nonce 防重放拦截通过');
    }

    // Test 5: SolverAgent 防刷围栏（URL 白名单、冷却期、累计重试硬上限与 dispatch 默认 force=false）
    {
      const sql = createMockDoSql();
      const db = createMockDb([
        {
          task_id: 'done-job-1',
          platform: 'chaoxing',
          course_id: '1',
          class_id: '2',
          course_name: '测试课程',
          title: '已提交作业',
          status: 'submitted',
          payload_json: JSON.stringify({ url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=1' }),
        },
      ]);
      const env: any = {
        DB: db,
        API_BEARER_TOKEN: 'strong-edge-bearer-token-9876543210',
        AFK_SHIM_URL: 'https://shim.mock.local',
        AFK_SHIM_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const agent = new (SolverAgent as any)({ storage: { sql } }, env);
      agent.env = env;
      agent.ctx = { storage: { sql } };
      agent.onStart();
      env.SOLVER_AGENT = { idFromName: () => 'default', get: () => agent };

      // 5.1 注入已 submitted 任务到 DO，再调默认 POST /api/tasks/:id/dispatch 不得强行重跑
      sql.tasks.set('done-job-1', {
        job_id: 'done-job-1',
        platform: 'chaoxing',
        task_url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=1',
        status: 'submitted',
        attempts: 1,
        updated_at: '2026/11/17 09:00:00 (UTC+8)',
      });
      const dispatchSubmittedRes = await edgeEntry.fetch(
        new Request('https://afk.example.com/api/tasks/done-job-1/dispatch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.API_BEARER_TOKEN}` },
        }),
        env,
        { waitUntil() {} }
      );
      const dispatchSubmittedJson: any = await dispatchSubmittedRes.json();
      assert.strictEqual(dispatchSubmittedJson.dispatchedCount, 0, '已完成任务默认 dispatch 必须跳过，不能强行重跑');

      // 5.2 非法 URL 在 DO enqueue 入口即被拦截
      const badUrlEnqueue = await agent.enqueue({
        jobId: 'evil-job-1',
        platform: 'chaoxing',
        taskUrl: 'https://attacker.evil.com/steal',
      });
      assert.strictEqual(badUrlEnqueue.accepted, false);
      assert.strictEqual(badUrlEnqueue.status, 'rejected');

      // 5.3 failed 冷却期与最大次数熔断拦截（即使 force=true 也受 attempts >= MAX * 2 硬顶）
      sql.tasks.set('flaky-job-1', {
        job_id: 'flaky-job-1',
        platform: 'chaoxing',
        task_url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=99',
        status: 'failed',
        attempts: 2,
        updated_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/') + ' (UTC+8)',
      });
      const cooldownRes = await agent.enqueue({
        jobId: 'flaky-job-1',
        platform: 'chaoxing',
        taskUrl: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=99',
      });
      assert.strictEqual(cooldownRes.accepted, false, '刚失败任务 60s 内非强制重入队应被冷却拦截');

      sql.tasks.get('flaky-job-1').attempts = MAX_TASK_ATTEMPTS * 2;
      const hardCapRes = await agent.enqueue({
        jobId: 'flaky-job-1',
        platform: 'chaoxing',
        taskUrl: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=99',
        force: true,
      });
      assert.strictEqual(hardCapRes.accepted, false, '超过硬重试上限即使 force=true 也必须熔断');
      console.log(' ✅ [Test 5/7 PASS] SolverAgent URL 白名单、冷却期、硬上限与默认 force=false 校验通过');
    }

    // Test 6: Shim 持久化 NonceCache 重启防重放 + /task 提交去重与配额熔断 (429)
    {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-sec-test-'));
      const nonceFile = path.join(tmpDir, 'nonces.json');
      const quotaFile = path.join(tmpDir, 'quota.json');
      const testSecret = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
      const origQuotaFile = process.env.AFK_AGY_QUOTA_FILE;
      const origMaxHour = process.env.AFK_AGY_MAX_PER_HOUR;
      const origNodeEnv = process.env.NODE_ENV;
      const origSecret = process.env.AFK_SHIM_SECRET;

      try {
        const cache1 = new NonceCache(600, 1000, nonceFile);
        assert.strictEqual(cache1.checkAndRemember('nonce-persist-001'), false);
        const cache2 = new NonceCache(600, 1000, nonceFile);
        assert.strictEqual(cache2.checkAndRemember('nonce-persist-001'), true, '重启重建 NonceCache 后仍须拦截已用 Nonce');

        // 预写入 2 次调用记录且设上限=2，验证 Shim /task 返回 429 熔断
        const now = Date.now();
        fs.writeFileSync(quotaFile, JSON.stringify({ timestamps: [now - 1000, now - 500] }), 'utf8');
        process.env.NODE_ENV = 'test';
        process.env.AFK_SHIM_SECRET = testSecret;
        process.env.AFK_AGY_QUOTA_FILE = quotaFile;
        process.env.AFK_AGY_MAX_PER_HOUR = '2';

        const qState = getAgyQuotaState(now);
        assert.strictEqual(qState.allowed, false, '到达每小时调用上限时 quota 状态应为 disallowed');

        const shimServer = createShimServer({ secret: testSecret });
        await new Promise<void>((resolve) => shimServer.listen(8799, '127.0.0.1', () => resolve()));
        try {
          const body = JSON.stringify({
            jobId: 'quota-blocked-job',
            taskUrl: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=1',
            platform: 'chaoxing',
            mode: 'draft',
          });
          const hdrs = await signRequest({ secret: testSecret, method: 'POST', pathWithQuery: '/task', body });
          const res = await fetch('http://127.0.0.1:8799/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...hdrs },
            body,
          });
          assert.strictEqual(res.status, 429, '触发 agy 小时配额上限后 Shim /task 必须返回 429 熔断');
        } finally {
          await new Promise<void>((resolve) => shimServer.close(() => resolve()));
        }
      } finally {
        if (origQuotaFile === undefined) delete process.env.AFK_AGY_QUOTA_FILE;
        else process.env.AFK_AGY_QUOTA_FILE = origQuotaFile;
        if (origMaxHour === undefined) delete process.env.AFK_AGY_MAX_PER_HOUR;
        else process.env.AFK_AGY_MAX_PER_HOUR = origMaxHour;
        if (origNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origNodeEnv;
        if (origSecret === undefined) delete process.env.AFK_SHIM_SECRET;
        else process.env.AFK_SHIM_SECRET = origSecret;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      console.log(' ✅ [Test 6/7 PASS] 持久化 NonceCache 防重启重放与 Shim /task 配额 429 熔断通过');
    }

    // Test 7: buildSanitizedEnv 脱敏 + invokeAgy 跨进程互斥锁 + 测试模式防误触发真实 agy
    {
      const sanitized = buildSanitizedEnv({
        PATH: '/usr/bin',
        HOME: '/home/test',
        AFK_SHIM_SECRET: 'must-not-leak',
        AFK_EDGE_BEARER_TOKEN: 'must-not-leak',
        CLOUDFLARE_API_TOKEN: 'must-not-leak',
        CHAOXING_PASSWORD: 'must-not-leak',
        AGY_SECRET_FOO: 'must-not-leak',
        AGY_LOG_LEVEL: 'info',
      });
      assert.strictEqual(sanitized.AFK_SHIM_SECRET, undefined);
      assert.strictEqual(sanitized.AFK_EDGE_BEARER_TOKEN, undefined);
      assert.strictEqual(sanitized.CLOUDFLARE_API_TOKEN, undefined);
      assert.strictEqual(sanitized.CHAOXING_PASSWORD, undefined);
      assert.strictEqual(sanitized.AGY_SECRET_FOO, undefined);
      assert.strictEqual(sanitized.AGY_LOG_LEVEL, 'info');

      const origNodeEnv = process.env.NODE_ENV;
      const origAgyBin = process.env.AGY_BIN;
      process.env.NODE_ENV = 'test';
      delete process.env.AGY_BIN;
      try {
        await assert.rejects(
          () => invokeAgy({ prompt: 'hi', timeoutMs: 5000 }),
          /test 模式下已拦截真实 agy 调用/
        );
      } finally {
        if (origNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origNodeEnv;
        if (origAgyBin !== undefined) process.env.AGY_BIN = origAgyBin;
      }

      // 占锁时非上下文 invokeAgy 必须拒绝并发启动
      assert.strictEqual(acquireLock('external-holder-job'), true);
      process.env.AGY_BIN = '/nonexistent-agy-bin';
      try {
        await assert.rejects(
          () => invokeAgy({ prompt: 'concurrent', timeoutMs: 5000 }),
          /单例硬件锁已被占用/
        );
      } finally {
        releaseLock('external-holder-job');
        if (origAgyBin === undefined) delete process.env.AGY_BIN;
        else process.env.AGY_BIN = origAgyBin;
      }
      console.log(' ✅ [Test 7/7 PASS] 环境变量脱敏、测试防误触与 invokeAgy 跨进程单例锁通过');
    }

    console.log('\n🎉 安全加固、WebSocket 鉴权、防重放与防刷熔断全部 7 项专项测试 100% 通过！\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
