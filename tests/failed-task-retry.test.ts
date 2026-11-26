import assert from 'node:assert';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import { upsertPendingTask } from '../edge/src/store';
import { getDashboardData, renderDashboardHtml } from '../edge/src/dashboard';

// Stub `agents` and `cloudflare:workers` before requiring DO / Edge worker modules
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
      routeAgentRequest: async () => null,
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const edgeEntry = require('../edge/src/index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SolverAgent } = require('../edge/src/solver-agent');

interface MockPendingRow {
  task_id: string;
  platform: string;
  course_id: string;
  class_id: string;
  course_name: string;
  title: string;
  status: string;
  compute_tier: string;
  deadline: string;
  payload_json: string | null;
  result_summary: string;
  created_at: string;
  updated_at: string;
}

function createMockDoSql() {
  const tasks = new Map<string, any>();
  return {
    tasks,
    exec(query: string, ...args: any[]) {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        return [] as any[];
      }
      if (q.startsWith('SELECT * FROM tasks WHERE job_id = ?')) {
        const row = tasks.get(args[0]);
        return row ? [row] : [];
      }
      if (q.startsWith("SELECT * FROM tasks WHERE status = 'pending'")) {
        const pending = Array.from(tasks.values()).filter((r) => r.status === 'pending');
        return pending.slice(0, 1);
      }
      if (q.startsWith("SELECT * FROM tasks WHERE status = 'submitting'")) {
        return Array.from(tasks.values()).filter((r) => r.status === 'submitting');
      }
      if (q.startsWith('INSERT OR REPLACE INTO tasks') || q.startsWith('INSERT OR IGNORE INTO tasks')) {
        const [jobId, platform, taskUrl, deadline, updatedAt] =
          q.includes("'pending'")
            ? [args[0], args[1], args[2], args[3], args[4]]
            : [args[0], args[1], args[2], args[4], args[6]];
        if (q.startsWith('INSERT OR IGNORE') && tasks.has(jobId)) return [];
        const status = q.includes("'pending'") ? 'pending' : args[3];
        tasks.set(jobId, {
          job_id: jobId,
          platform,
          task_url: taskUrl,
          status,
          deadline,
          qa_json: '[]',
          summary: '',
          attempts: 0,
          updated_at: updatedAt,
        });
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
      if (q.startsWith('UPDATE tasks SET status = ?, updated_at = ? WHERE job_id = ?')) {
        const [status, updatedAt, jobId] = args;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.updated_at = updatedAt;
        }
        return [];
      }
      return [] as any[];
    },
  };
}

function createMockDb(initialRows: MockPendingRow[] = []) {
  const pendingTasks = new Map<string, MockPendingRow>();
  for (const r of initialRows) pendingTasks.set(r.task_id, { ...r });

  const executionLogs: any[] = [];

  return {
    pendingTasks,
    executionLogs,
    async batch(stmts: any[]) {
      return Promise.all(stmts.map((s) => s.all()));
    },
    prepare(sql: string) {
      const norm = sql.trim().replace(/\s+/g, ' ');
      return {
        bind(...args: any[]) {
          return {
            async first<T = any>(): Promise<T | null> {
              if (norm.startsWith('SELECT * FROM pending_tasks WHERE task_id = ?')) {
                const row = pendingTasks.get(args[0]);
                return row ? ({ ...row } as any) : null;
              }
              if (norm.startsWith('SELECT status, payload_json FROM pending_tasks WHERE task_id = ?')) {
                const row = pendingTasks.get(args[0]);
                return row ? ({ status: row.status, payload_json: row.payload_json } as any) : null;
              }
              if (norm.startsWith('SELECT task_id FROM pending_tasks WHERE task_id LIKE ?')) {
                const prefix = String(args[0]).replace(/%$/, '');
                for (const k of pendingTasks.keys()) {
                  if (k.startsWith(prefix)) return { task_id: k } as any;
                }
                return null;
              }
              return null;
            },
            async all<T = any>(): Promise<{ results: T[] }> {
              if (norm.startsWith("SELECT task_id FROM pending_tasks WHERE status = 'failed'")) {
                const rows = Array.from(pendingTasks.values())
                  .filter((r) => r.status === 'failed')
                  .map((r) => ({ task_id: r.task_id }));
                return { results: rows as any };
              }
              if (norm.includes('FROM pending_tasks')) {
                return { results: Array.from(pendingTasks.values()) as any };
              }
              return { results: [] };
            },
            async run() {
              if (norm.startsWith('INSERT INTO pending_tasks')) {
                const [
                  taskId,
                  platform,
                  courseId,
                  classId,
                  courseName,
                  title,
                  status,
                  computeTier,
                  deadline,
                  payloadJson,
                  createdAt,
                  updatedAt,
                ] = args;
                const prev = pendingTasks.get(taskId);
                if (prev) {
                  prev.title = title;
                  prev.deadline = deadline;
                  prev.payload_json = payloadJson ?? prev.payload_json;
                  prev.updated_at = updatedAt;
                } else {
                  pendingTasks.set(taskId, {
                    task_id: taskId,
                    platform,
                    course_id: courseId,
                    class_id: classId,
                    course_name: courseName,
                    title,
                    status,
                    compute_tier: computeTier,
                    deadline,
                    payload_json: payloadJson,
                    result_summary: '',
                    created_at: createdAt,
                    updated_at: updatedAt,
                  });
                }
              } else if (
                norm.startsWith("UPDATE pending_tasks SET status = ?, result_summary = '', updated_at = ? WHERE task_id = ?")
              ) {
                const [status, updatedAt, taskId] = args;
                const row = pendingTasks.get(taskId);
                if (row) {
                  row.status = status;
                  row.result_summary = '';
                  row.updated_at = updatedAt;
                }
              } else if (norm.startsWith('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?')) {
                const [status, updatedAt, taskId] = args;
                const row = pendingTasks.get(taskId);
                if (row) {
                  row.status = status;
                  row.updated_at = updatedAt;
                }
              } else if (
                norm.startsWith(
                  "UPDATE pending_tasks SET status = 'ignored', result_summary = COALESCE(NULLIF(?, ''), result_summary), updated_at = ? WHERE task_id = ?"
                )
              ) {
                const [summary, updatedAt, taskId] = args;
                const row = pendingTasks.get(taskId);
                if (row) {
                  row.status = 'ignored';
                  if (summary) row.result_summary = summary;
                  row.updated_at = updatedAt;
                }
              } else if (norm.startsWith('UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?')) {
                const [status, summary, updatedAt, taskId] = args;
                const row = pendingTasks.get(taskId);
                if (row) {
                  row.status = status;
                  row.result_summary = summary;
                  row.updated_at = updatedAt;
                }
              } else if (norm.startsWith('INSERT INTO execution_logs')) {
                executionLogs.push(args);
              }
              return { success: true };
            },
          };
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          if (norm.startsWith("SELECT task_id FROM pending_tasks WHERE status = 'failed'")) {
            const rows = Array.from(pendingTasks.values())
              .filter((r) => r.status === 'failed')
              .map((r) => ({ task_id: r.task_id }));
            return { results: rows as any };
          }
          if (norm.includes('FROM pending_tasks')) {
            return { results: Array.from(pendingTasks.values()) as any };
          }
          if (norm.includes('COUNT(*) as cnt FROM execution_logs')) {
            return { results: [{ cnt: 0 }] as any };
          }
          return { results: [] };
        },
        async first<T = any>(): Promise<T | null> {
          if (norm.includes('COUNT(*) as cnt FROM execution_logs')) {
            return { cnt: 0 } as any;
          }
          return null;
        },
      };
    },
  };
}

function makeTask(id: string, title: string, status: string, summary = ''): MockPendingRow {
  return {
    task_id: id,
    platform: 'chaoxing',
    course_id: '266874983',
    class_id: '154101446',
    course_name: 'LabVIEW编程及应用',
    title,
    status,
    compute_tier: 'tier1-server-shim',
    deadline: '2026-11-20 23:59',
    payload_json: JSON.stringify({
      url: `https://mooc1.chaoxing.com/mooc2/work/dowork?workId=${id}`,
    }),
    result_summary: summary,
    created_at: '2026/11/13 12:00:00 (UTC+8)',
    updated_at: '2026/11/13 12:52:00 (UTC+8)',
  };
}

async function runTests() {
  console.log('\n🧪 开始运行失败任务重试与归档闭环测试...\n');
  const origFetch = globalThis.fetch;

  try {
    // Test 1: /api/tasks/retry-failed 批量重跑失败任务，清零旧错误并遵守单例队列锁
    {
      const db = createMockDb([
        makeTask('chaoxing-notice-work-101-154101446', '设计实例', 'failed', 'Error: --json-schema'),
        makeTask('chaoxing-notice-work-102-154101446', 'VI创建及子VI的设计', 'failed', 'Error: --json-schema'),
      ]);
      const sql = createMockDoSql();
      const env: any = {
        DB: db,
        API_BEARER_TOKEN: 'test-token',
        AFK_SHIM_URL: 'https://shim.mock.local',
        AFK_SHIM_SECRET: 'test-shim-secret-key-at-least-32-chars!!',
      };
      const agent = new (SolverAgent as any)({ storage: { sql } }, env);
      agent.env = env;
      agent.ctx = { storage: { sql } };
      agent.onStart();
      env.SOLVER_AGENT = { idFromName: () => 'default', get: () => agent };

      let shimCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.startsWith('https://shim.mock.local/task')) {
          shimCalls++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch;

      const res = await edgeEntry.fetch(
        new Request('https://edge.example.com/api/tasks/retry-failed', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env
      );
      const json: any = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.total, 2);
      assert.strictEqual(json.retriedCount, 2);
      assert.strictEqual(json.dispatchedCount, 1, '单例队列首个任务应立即派发');
      assert.strictEqual(json.queuedCount, 1, '第二个失败任务应排队等待');
      assert.strictEqual(shimCalls, 1, '并发重跑仅允许向 shim 派发 1 个 active 任务');
      assert.strictEqual(
        db.pendingTasks.get('chaoxing-notice-work-101-154101446')?.status,
        'dispatched'
      );
      assert.strictEqual(
        db.pendingTasks.get('chaoxing-notice-work-101-154101446')?.result_summary,
        '',
        '重试后应清空旧的失败摘要'
      );
      assert.strictEqual(
        db.pendingTasks.get('chaoxing-notice-work-102-154101446')?.status,
        'pending'
      );
      console.log(' ✅ [Test 1/4 PASS] /api/tasks/retry-failed 批量重试、清空旧错与单例排队列通过');
    }

    // Test 2: /api/tasks/:id/ignore 与 upsertPendingTask 防复活保护
    {
      const taskId = 'chaoxing-notice-work-201-154101446';
      const db = createMockDb([makeTask(taskId, '已过期作业', 'failed', '已截止无法提交')]);
      const sql = createMockDoSql();
      const env: any = {
        DB: db,
        API_BEARER_TOKEN: 'test-token',
      };
      const agent = new (SolverAgent as any)({ storage: { sql } }, env);
      agent.env = env;
      agent.ctx = { storage: { sql } };
      agent.onStart();
      env.SOLVER_AGENT = { idFromName: () => 'default', get: () => agent };

      const res = await edgeEntry.fetch(
        new Request(`https://edge.example.com/api/tasks/${encodeURIComponent(taskId)}/ignore`, {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env
      );
      const json: any = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(db.pendingTasks.get(taskId)?.status, 'ignored');

      // 周期扫课再次 upsertPendingTask，绝不能把 ignored 重置回 pending
      const resurrected = await upsertPendingTask(env, {
        taskId,
        platform: 'chaoxing',
        courseId: '266874983',
        classId: '154101446',
        courseName: 'LabVIEW编程及应用',
        title: '已过期作业',
        status: 'pending',
      });
      assert.strictEqual(resurrected, false);
      assert.strictEqual(db.pendingTasks.get(taskId)?.status, 'ignored', 'ignored 终态绝不可被周期扫课覆盖');
      console.log(' ✅ [Test 2/4 PASS] /api/tasks/:id/ignore 归档与防扫课复活保护通过');
    }

    // Test 3: getDashboardData 准确统计 failedCount 与 ignoredCount（不污染 pendingCount）
    {
      const db = createMockDb([
        makeTask('chaoxing-notice-work-301-154101446', '失败作业A', 'failed', 'agy timeout'),
        makeTask('chaoxing-notice-work-302-154101446', '已忽略作业B', 'ignored', '旧学期作业'),
        makeTask('chaoxing-notice-work-303-154101446', '待做作业C', 'pending', ''),
      ]);
      const dash = await getDashboardData({ DB: db } as any);
      assert.strictEqual(dash.stats.failedCount, 1);
      assert.strictEqual(dash.stats.ignoredCount, 1);
      assert.strictEqual(dash.stats.pendingCount, 1, 'ignored 与 failed 均不得计入 pendingCount');
      console.log(' ✅ [Test 3/4 PASS] getDashboardData 失败与忽略计数隔离通过');
    }

    // Test 4: 看板前端渲染 失败/忽略 筛选、错误详情以及 一键重试/忽略 按钮交互
    {
      const html = renderDashboardHtml();
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        url: 'https://edge.example.com/dashboard',
        beforeParse(window) {
          (window as any).tailwind = {};
          (window as any).fetch = async () =>
            new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });
      const win = dom.window as any;
      win.confirm = () => true;

      let retryPayload: any = null;
      let ignoreUrl = '';
      win.fetch = async (input: string, init?: RequestInit) => {
        if (input === '/api/tasks/retry-failed') {
          retryPayload = JSON.parse(String(init?.body || '{}'));
          return new Response(
            JSON.stringify({ success: true, retriedCount: 1, dispatchedCount: 1, queuedCount: 0 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (input.endsWith('/ignore')) {
          ignoreUrl = input;
          return new Response(JSON.stringify({ success: true, updated: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (input === '/api/dashboard') {
          return new Response(JSON.stringify(win.state), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200 });
      };

      win.eval(`
        state = {
          time: '2026/11/13 23:50:00 (UTC+8)',
          homeworks: [
            {
              taskId: 'chaoxing-notice-work-401-154101446',
              title: '实验二报告提交',
              courseName: '数字图像处理',
              platform: 'chaoxing',
              status: 'failed',
              resultSummary: 'Error: --json-schema'
            },
            {
              taskId: 'chaoxing-notice-work-402-154101446',
              title: '实验四人工确认',
              courseName: '数据结构',
              platform: 'chaoxing',
              status: 'awaiting_approval',
              resultSummary: '⚠️ 缺少有效附件正文，请在学习通确认'
            }
          ],
          discussions: [],
          exams: [],
          notices: [],
          signinHistory: [],
          courses: [],
          stats: { failedCount: 1 }
        };
        renderUI();
      `);

      const retryBtn = win.document.getElementById('retryFailedBtn') as HTMLButtonElement;
      assert.ok(retryBtn && !retryBtn.classList.contains('hidden'), '有失败任务时必须显示一键重试按钮');
      const hwListHtml = win.document.getElementById('homeworkList')?.innerHTML || '';
      assert.ok(hwListHtml.includes('⚠️ 需人工处理'), 'awaiting_approval 人工提示卡片不得触发 TDZ 并应正确渲染');
      const cntFailedEl = win.document.getElementById('cnt-failed') as any;
      assert.strictEqual(String(cntFailedEl?.innerText ?? cntFailedEl?.textContent), '1');

      await win.retryFailedTasksUI();
      assert.deepStrictEqual(retryPayload.taskIds, ['chaoxing-notice-work-401-154101446']);

      await win.ignoreTaskUI('chaoxing-notice-work-401-154101446');
      assert.strictEqual(ignoreUrl, '/api/tasks/chaoxing-notice-work-401-154101446/ignore');
      dom.window.close();
      console.log(' ✅ [Test 4/4 PASS] 看板失败筛选、一键重试与忽略归档前端交互通过');
    }

    console.log('\n🎉 失败任务重试与归档闭环全部 4 项测试 100% 通过！\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
