import assert from 'node:assert';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import {
  classifyActiveList,
  classifyPreSignHtml,
  extractSignHistoryCandidates,
  isSignSubmissionSuccess,
  scanCourseActivitiesShared,
} from '../packages/adapters/chaoxing/activity-protocol';
import { performSign } from '../edge/src/chaoxing';
import { getDashboardData, renderDashboardHtml } from '../edge/src/dashboard';
import { runChaoxingInspectionCycle, syncChaoxingSignHistory } from '../edge/src/inspection';

// Stub `agents` and `cloudflare:workers` before importing DO / Edge worker modules
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

interface MockTaskRow {
  job_id: string;
  platform: string;
  task_url: string;
  status: string;
  deadline: string;
  qa_json: string;
  summary: string;
  attempts: number;
  updated_at: string;
}

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
  result_summary: string;
  payload_json: string | null;
  updated_at: string;
  created_at: string;
}

function createMockDoSql(initialTasks: MockTaskRow[] = []) {
  const tasks = new Map<string, MockTaskRow>(initialTasks.map((t) => [t.job_id, { ...t }]));
  return {
    tasks,
    exec(sql: string, ...params: any[]) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('CREATE TABLE')) return [];
      if (normalized.includes("FROM tasks WHERE status IN ('dispatched', 'submitting')")) {
        const list = Array.from(tasks.values()).filter(
          (t) => t.status === 'dispatched' || t.status === 'submitting'
        );
        return normalized.includes('LIMIT 1') && !normalized.includes('LIMIT 10')
          ? list.slice(0, 1)
          : list.slice(0, 10);
      }
      if (normalized.startsWith('SELECT * FROM tasks WHERE job_id = ?')) {
        const row = tasks.get(params[0]);
        return row ? [{ ...row }] : [];
      }
      if (normalized.startsWith("SELECT * FROM tasks WHERE status = 'pending'")) {
        const row = Array.from(tasks.values()).find((t) => t.status === 'pending');
        return row ? [{ ...row }] : [];
      }
      if (normalized.startsWith('SELECT count(*) as cnt FROM tasks WHERE status')) {
        return [{ cnt: Array.from(tasks.values()).filter((t) => t.status === 'pending').length }];
      }
      if (normalized.startsWith('SELECT count(*) as cnt FROM tasks')) {
        return [{ cnt: tasks.size }];
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO tasks')) {
        const [jobId, platform, taskUrl, status, deadline, summary, updatedAt] = params;
        if (!tasks.has(jobId)) {
          tasks.set(jobId, {
            job_id: jobId,
            platform,
            task_url: taskUrl,
            status,
            deadline,
            qa_json: '[]',
            summary,
            attempts: 0,
            updated_at: updatedAt,
          });
        }
        return [];
      }
      if (normalized.includes("SET status = 'draft_saved'") && normalized.includes("AND status = 'submitting'")) {
        const [updatedAt, jobId] = params;
        const row = tasks.get(jobId);
        if (row && row.status === 'submitting') {
          row.status = 'draft_saved';
          row.updated_at = updatedAt;
        }
        return [];
      }
      if (normalized.includes("AND status = 'submitting'") && normalized.includes('SET status = ?, updated_at = ?')) {
        const [status, updatedAt, jobId] = params;
        const row = tasks.get(jobId);
        if (row && row.status === 'submitting') {
          row.status = status;
          row.updated_at = updatedAt;
        }
        return [];
      }
      if (normalized.startsWith('UPDATE tasks SET status = ?, summary = ?')) {
        const [status, summary, updatedAt, jobId] = params;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.summary = summary;
          row.updated_at = updatedAt;
        }
        return [];
      }
      if (normalized.startsWith('UPDATE tasks SET status = ?, updated_at = ?')) {
        const [status, updatedAt, jobId] = params;
        const row = tasks.get(jobId);
        if (row) {
          row.status = status;
          row.updated_at = updatedAt;
        }
        return [];
      }
      return [];
    },
  };
}

function createMockD1(initialPending: MockPendingRow[] = [], initialLogs: any[] = []) {
  const pendingTasks = new Map<string, MockPendingRow>(initialPending.map((t) => [t.task_id, { ...t }]));
  const executionLogs: any[] = initialLogs.map((l, idx) => ({ id: idx + 1, ...l }));

  const makeStmt = (sql: string, args: unknown[] = []) => {
    const execAll = async () => {
      if (sql.includes('FROM pending_tasks') && sql.includes("status = 'submitting'")) {
        return { results: Array.from(pendingTasks.values()).filter((r) => r.status === 'submitting') };
      }
      if (sql.includes('FROM pending_tasks ORDER BY updated_at DESC')) {
        return { results: Array.from(pendingTasks.values()) };
      }
      if (sql.includes("SELECT COUNT(*) as cnt FROM execution_logs WHERE event_type IN ('signin', 'sign_success')")) {
        const cnt = executionLogs.filter((l) => l.event_type === 'signin' || l.event_type === 'sign_success').length;
        return { results: [{ cnt }] };
      }
      if (sql.includes('FROM execution_logs') && sql.includes('sign_missed')) {
        return {
          results: executionLogs
            .filter((l) => ['signin', 'sign_success', 'sign_fail', 'sign_missed'].includes(l.event_type))
            .slice()
            .reverse(),
        };
      }
      if (sql.includes('SELECT id, event_type, platform, summary, created_at FROM execution_logs')) {
        return { results: executionLogs.slice().reverse() };
      }
      if (sql.includes('SELECT COUNT(*) as cnt FROM question_bank')) {
        return { results: [{ cnt: 0 }] };
      }
      return { results: [] };
    };

    const firstFn = async () => {
      if (sql.includes('FROM pending_tasks WHERE task_id = ?')) {
        return pendingTasks.get(String(args[0])) ?? null;
      }
      const res = await execAll();
      return res.results?.[0] ?? null;
    };

    const runFn = async () => {
      if (sql.startsWith('INSERT INTO execution_logs')) {
        executionLogs.push({
          id: executionLogs.length + 1,
          event_type: args[0],
          platform: args[1],
          summary: args[2],
          detail_json: args[3],
          created_at: args[4],
        });
        return { success: true };
      }
      if (sql.includes("UPDATE pending_tasks SET status = 'draft_saved'") && sql.includes("status = 'submitting'")) {
        const [updatedAt, taskId] = args;
        const row = pendingTasks.get(String(taskId));
        if (row && row.status === 'submitting') {
          row.status = 'draft_saved';
          row.updated_at = String(updatedAt);
        }
        return { success: true };
      }
      if (sql.includes('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?') && sql.includes("status = 'submitting'")) {
        const [status, updatedAt, taskId] = args;
        const row = pendingTasks.get(String(taskId));
        if (row && row.status === 'submitting') {
          row.status = String(status);
          row.updated_at = String(updatedAt);
        }
        return { success: true };
      }
      if (sql.startsWith('UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ?')) {
        const [status, summary, updatedAt, taskId] = args;
        const row = pendingTasks.get(String(taskId));
        if (row) {
          row.status = String(status);
          row.result_summary = String(summary);
          row.updated_at = String(updatedAt);
        }
        return { success: true };
      }
      if (sql.startsWith('UPDATE pending_tasks SET status = ?, updated_at = ?')) {
        const [status, updatedAt, taskId] = args;
        const row = pendingTasks.get(String(taskId));
        if (row) {
          row.status = String(status);
          row.updated_at = String(updatedAt);
        }
        return { success: true };
      }
      return { success: true };
    };

    return {
      bind: (...nextArgs: unknown[]) => makeStmt(sql, nextArgs),
      all: execAll,
      first: firstFn,
      run: runFn,
    };
  };

  return {
    pendingTasks,
    executionLogs,
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: any[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };
}

async function runTests() {
  console.log('\n🧪 执行签到协议 + 历史回溯 + submitting 状态机专项测试...\n');

  const solverModulePath = '../edge/src/solver-agent';
  const edgeEntryPath = '../edge/src/index';
  const { SolverAgent } = await import(solverModulePath);
  const { default: edgeEntry } = await import(edgeEntryPath);

  // --- Test 1: activity-protocol 过滤 type=19 / id=-1 / type=5 讨论贴，保留真实测验与历史签到 ---
  {
    const rawList = [
      { id: -1, activeType: '19', status: 1, nameOne: '作业/考试' },
      { id: 726151794, activeType: 5, status: 1, nameOne: 'LabVIEW主题讨论' },
      { id: 3001, activeType: 4, status: 1, nameOne: '第5章随堂小测' },
      { id: 8000185468865, activeType: 2, status: 1, otherId: 0, nameOne: '签到', startTime: 1794466090000 },
      { id: 8000184264682, activeType: 2, status: 2, otherId: 0, nameOne: '签到', startTime: 1794379690000 },
    ];
    const classified = classifyActiveList(rawList, {
      courseId: '266874983',
      classId: '154101446',
      courseName: 'LabVIEW编程及应用',
    });
    assert.strictEqual(classified.activities.length, 1);
    assert.strictEqual(classified.activities[0].id, '8000185468865');
    assert.strictEqual(classified.classActivities.length, 1, '不得把作业/考试占位(19)和讨论贴(5)当作课堂活动噪音');
    assert.strictEqual(classified.classActivities[0].id, '3001');

    const hist = extractSignHistoryCandidates(rawList, {
      courseId: '266874983',
      classId: '154101446',
      courseName: 'LabVIEW编程及应用',
    });
    assert.strictEqual(hist.length, 2, '应包含 status=1 和 status=2 的全部历史签到活动');
    assert.strictEqual(hist[1].id, '8000184264682');
    console.log(' ✅ [Test 1/5 PASS] activity-protocol 过滤伪活动噪音与提取历史签到候选通过');
  }

  // --- Test 2: preSign 已签到 / 已过期识别，避免 performSign 误落入 pcReq HTML 500 报错 ---
  {
    assert.strictEqual(
      classifyPreSignHtml('<html><head><title>签到</title></head><body><div>签到成功</div></body></html>').state,
      'already_signed'
    );
    assert.strictEqual(
      classifyPreSignHtml('<html><head><title>提示</title></head><body><p>已过教师设置的截止时间 下次早点哦</p></body></html>')
        .state,
      'expired'
    );
    assert.strictEqual(classifyPreSignHtml('<div>未签到，请输入签到码</div>').state, 'pending');
    assert.strictEqual(isSignSubmissionSuccess('您已签到'), true);
    assert.strictEqual(isSignSubmissionSuccess('未签到'), false);

    const origFetch = globalThis.fetch;
    let calledPcReq = false;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('getPPTActiveInfo')) {
          return new Response(JSON.stringify({ data: { otherId: 0, ifphoto: 0 } }), { status: 200 });
        }
        if (u.includes('newsign/preSign')) {
          return new Response('<html><title>签到</title><body><p>签到成功</p></body></html>', { status: 200 });
        }
        if (u.includes('pcReq') || u.includes('stuSignajax')) {
          calledPcReq = true;
          return new Response('<html>500</html>', { status: 500 });
        }
        return new Response('', { status: 200 });
      }) as typeof fetch;

      const msg = await performSign(
        { id: '8000185468865', name: '签到', otherId: 0 },
        { courseId: '266874983', classId: '154101446', courseName: 'LabVIEW编程及应用' },
        { _uid: '1', _d: 'd', vc3: 'v', uf: 'u', fid: '2893', cookie: '_uid=1;' }
      );
      assert.strictEqual(calledPcReq, false, 'preSign 已显示签到成功时绝不应继续调用 pcReq');
      assert.ok(msg.includes('已签到'), `应明确返回已签到状态，实际: ${msg}`);
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 2/5 PASS] preSign 已签到前置拦截与响应分类通过');
  }

  // --- Test 3: syncChaoxingSignHistory 回溯导入历史签到 & 巡检 D1 去重记忆 ---
  {
    const mockDb = createMockD1([], [
      {
        event_type: 'sign_success',
        platform: 'chaoxing',
        summary: '课程《LabVIEW编程及应用》[签到]: [通用已签到] (ID: 8000185468865)',
        detail_json: JSON.stringify({ activeId: '8000185468865', address: '教学楼A' }),
        created_at: '2026/11/12 14:48:18 (UTC+8)',
      },
      {
        event_type: 'sign_fail',
        platform: 'chaoxing',
        summary: '课程《LabVIEW编程及应用》[签到]: [签到提交] 响应: <!DOCTYPE html>',
        detail_json: JSON.stringify({ activeId: '8000185468865' }),
        created_at: '2026/11/12 14:52:17 (UTC+8)',
      },
    ]);
    const env: any = { DB: mockDb, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' };

    const origFetch = globalThis.fetch;
    let performSignCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('/fanyalogin')) {
          return new Response(JSON.stringify({ status: true }), {
            status: 200,
            headers: { 'set-cookie': '_uid=1; UID=1; _d=d; vc3=v; uf=u; fid=2893;' },
          });
        }
        if (u.includes('/visit/courselistdata')) {
          return new Response(
            '<li class="course" courseId="266874983" clazzId="154101446" personId="99"><span class="course-name" title="LabVIEW编程及应用">LabVIEW编程及应用</span></li>',
            { status: 200 }
          );
        }
        if (u.includes('taskactivelist')) {
          return new Response(
            JSON.stringify({
              result: 1,
              activeList: [
                { id: 8000185468865, activeType: 2, status: 1, otherId: 0, nameOne: '签到', startTime: 1794466090000 },
                { id: 8000184264682, activeType: 2, status: 2, otherId: 5, nameOne: '签到码', startTime: 1794379690000 },
                { id: 6000181458042, activeType: 2, status: 2, otherId: 4, nameOne: '位置签到', startTime: 1794293290000 },
              ],
            }),
            { status: 200 }
          );
        }
        if (u.includes('newsign/preSign')) {
          if (u.includes('6000181458042')) {
            return new Response('<html><title>签到</title><div>签到成功</div></html>', { status: 200 });
          }
          if (u.includes('8000184264682')) {
            return new Response('<html><title>提示</title><div>已过教师设置的截止时间</div></html>', { status: 200 });
          }
          return new Response('<html><div>未签到</div></html>', { status: 200 });
        }
        if (u.includes('getPPTActiveInfo') || u.includes('stuSignajax')) {
          performSignCalls++;
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const syncRes = await syncChaoxingSignHistory(env, { offset: 0, limit: 5 });
      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(syncRes.syncedCount, 2, '应跳过已入库 8000185468865，新同步 2 条历史记录');
      assert.ok(syncRes.records.some((r) => r.activeId === '6000181458042' && r.result === '签到成功'));
      assert.ok(syncRes.records.some((r) => r.activeId === '8000184264682' && r.result === '已截止未签到'));

      // 验证 runChaoxingInspectionCycle 从 D1 恢复 recentSigned，不会重复打卡 8000185468865
      await runChaoxingInspectionCycle(env, {
        force: true,
        checkHomework: false,
        scanDiscussions: false,
        nowMs: Date.parse('2026-11-13T15:00:00+08:00'),
      });
      assert.strictEqual(performSignCalls, 0, 'D1 已有成功记录的活动不得再次触发签到请求');
    } finally {
      globalThis.fetch = origFetch;
    }

    // 验证看板聚合：按 activeId 去重消除 1 条成功后的 duplicate sign_fail，且颜色/按钮与 JSDOM 渲染无异常
    const dash = await getDashboardData(env);
    assert.strictEqual(dash.signinHistory?.length, 3, '同 activeId 重复 fail 记录应折叠，保留 3 条独立签到活动');
    assert.strictEqual(dash.stats.signinCount, 2, '成功总数应为 2（不含 sign_fail / sign_missed）');
    assert.ok(!dash.signinHistory!.some((s) => s.result === '签到异常'), '已被 sign_success 覆盖的 activeId 不应再显示签到异常');

    const html = renderDashboardHtml();
    const dom = new JSDOM(html, {
      url: 'https://afk.example.com/',
      runScripts: 'dangerously',
      beforeParse(win) {
        (win as any).tailwind = {};
        (win as any).fetch = async (url: string) => {
          if (String(url).includes('/api/dashboard')) {
            return { ok: true, json: async () => dash };
          }
          return { ok: true, json: async () => ({}) };
        };
      },
    });
    try {
      const w = dom.window as any;
      await w.refreshData();
      assert.strictEqual(String(w.document.getElementById('signedCount').innerText), '2');
      assert.strictEqual(String(w.document.getElementById('badge-signs').innerText), '3');
      assert.strictEqual(String(w.document.getElementById('totalSignCount').innerText), '3');
      assert.strictEqual(String(w.document.getElementById('successSignCount').innerText), '2');
      assert.ok(w.document.getElementById('syncSigninsBtn'), '应渲染历史签到同步按钮');
      const rows = w.document.querySelectorAll('#signinTableBody tr');
      assert.strictEqual(rows.length, 3);
      assert.ok(w.document.getElementById('signinTableBody').innerHTML.includes('text-amber-300'));
    } finally {
      dom.window.close();
    }
    console.log(' ✅ [Test 3/5 PASS] 历史签到回溯同步、D1 去重及 JSDOM 看板渲染验证通过');
  }

  // --- Test 4: SolverAgent submitting 状态机：无 shim 保持不变 + 超时自动回退 draft_saved ---
  {
    const staleId = 'chaoxing-notice-work-8101-154423000';
    const freshId = 'chaoxing-notice-work-8102-154423000';
    const d1OnlyId = 'chaoxing-notice-work-8103-154423000';

    const db = createMockD1([
      {
        task_id: staleId,
        platform: 'chaoxing',
        course_id: '266',
        class_id: '154423000',
        course_name: '测试课程',
        title: '超时提交任务1',
        status: 'submitting',
        compute_tier: 'tier1-cloud-run',
        deadline: '',
        result_summary: '已暂存草稿',
        payload_json: null,
        updated_at: '2026/11/13 10:00:00 (UTC+8)',
        created_at: '2026/11/13 09:00:00 (UTC+8)',
      },
      {
        task_id: freshId,
        platform: 'chaoxing',
        course_id: '266',
        class_id: '154423000',
        course_name: '测试课程',
        title: '未超时提交任务',
        status: 'submitting',
        compute_tier: 'tier1-cloud-run',
        deadline: '',
        result_summary: '已暂存草稿',
        payload_json: null,
        updated_at: '2026/11/13 10:55:00 (UTC+8)',
        created_at: '2026/11/13 09:00:00 (UTC+8)',
      },
      {
        task_id: d1OnlyId,
        platform: 'chaoxing',
        course_id: '266',
        class_id: '154423000',
        course_name: '测试课程',
        title: '仅 D1 超时 submitting',
        status: 'submitting',
        compute_tier: 'tier1-cloud-run',
        deadline: '',
        result_summary: '用户已在看板手动审批正式提交',
        payload_json: null,
        updated_at: '2026/11/13 10:00:00 (UTC+8)',
        created_at: '2026/11/13 09:00:00 (UTC+8)',
      },
    ]);

    const sql = createMockDoSql([
      {
        job_id: staleId,
        platform: 'chaoxing',
        task_url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=8101',
        status: 'submitting',
        deadline: '',
        qa_json: '[]',
        summary: '',
        attempts: 0,
        updated_at: '2026/11/13 10:00:00 (UTC+8)',
      },
      {
        job_id: freshId,
        platform: 'chaoxing',
        task_url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=8102',
        status: 'submitting',
        deadline: '',
        qa_json: '[]',
        summary: '',
        attempts: 0,
        updated_at: '2026/11/13 10:55:00 (UTC+8)',
      },
    ]);

    const agent = new (SolverAgent as any)({ storage: { sql } }, { DB: db, API_BEARER_TOKEN: 'tok' });
    agent.env = { DB: db, API_BEARER_TOKEN: 'tok' };
    agent.ctx = { storage: { sql } };
    agent.onStart();

    await agent.reconcileDispatchedTasks({
      submittingTimeoutMs: 15 * 60 * 1000,
      nowMs: Date.parse('2026-11-13T11:00:00+08:00'),
    });

    assert.strictEqual(db.pendingTasks.get(staleId)?.status, 'draft_saved', '超时 submitting DO+D1 任务应回退为 draft_saved');
    assert.strictEqual(db.pendingTasks.get(d1OnlyId)?.status, 'draft_saved', '仅 D1 滞留 submitting 超时任务也应兜底回退为 draft_saved');
    assert.strictEqual(db.pendingTasks.get(freshId)?.status, 'submitting', '未超时的 submitting 任务不应误回退');
    assert.strictEqual(
      db.executionLogs.filter((l) => l.event_type === 'submitting_reverted').length,
      2,
      '应写入 submitting_reverted 审计日志'
    );
    console.log(' ✅ [Test 4/5 PASS] reconcileDispatchedTasks 超时 submitting 自动回退机制验证通过');
  }

  // --- Test 5: 无 shim 时 /api/tasks/:id/approve 与 /api/tasks/status 不得制造伪 submitting/submitted ---
  {
    const taskId = 'chaoxing-notice-work-9001-154423000';
    const db = createMockD1([
      {
        task_id: taskId,
        platform: 'chaoxing',
        course_id: '266',
        class_id: '154423000',
        course_name: '测试课程',
        title: '无 shim 保护验证',
        status: 'draft_saved',
        compute_tier: 'tier1-cloud-run',
        deadline: '',
        result_summary: '已暂存草稿',
        payload_json: JSON.stringify({ url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=9001' }),
        updated_at: '2026/11/13 10:00:00 (UTC+8)',
        created_at: '2026/11/13 09:00:00 (UTC+8)',
      },
    ]);
    const agent = new (SolverAgent as any)({ storage: { sql: createMockDoSql() } }, { DB: db, API_BEARER_TOKEN: 'test-token' });
    agent.env = { DB: db, API_BEARER_TOKEN: 'test-token' };
    agent.ctx = { storage: { sql: createMockDoSql() } };
    agent.onStart();

    const env: any = {
      DB: db,
      SOLVER_AGENT: { idFromName: () => 'default', get: () => agent },
      API_BEARER_TOKEN: 'test-token',
    };

    const appRes = await edgeEntry.fetch(
      new Request(`https://edge.example.com/api/tasks/${encodeURIComponent(taskId)}/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      }),
      env
    );
    const appJson: any = await appRes.json();
    assert.strictEqual(appJson.success, false);
    assert.ok(String(appJson.msg).includes('AFK_SHIM_URL'));
    assert.strictEqual(db.pendingTasks.get(taskId)?.status, 'draft_saved');

    const statusRes = await edgeEntry.fetch(
      new Request('https://edge.example.com/api/tasks/status', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: 'submitted', resultSummary: 'manual' }),
      }),
      env
    );
    const statusJson: any = await statusRes.json();
    assert.strictEqual(statusJson.updated, false);
    assert.strictEqual(db.pendingTasks.get(taskId)?.status, 'draft_saved');
    console.log(' ✅ [Test 5/5 PASS] 无 shim 审批保护 Fail-Closed 契约通过');
  }

  // Test 6: 活动列表接口被封禁/异常时必须返回明确错误（不能伪装成“没有签到”），正常返回要带 rawCount
  {
    const origFetch = globalThis.fetch;
    const course = { courseId: '1', classId: '2', courseName: 'T' };
    try {
      let fetchCallCount = 0;
      globalThis.fetch = (async () => {
        fetchCallCount++;
        return new Response(JSON.stringify({ result: 0, errorMsg: '当前ip [1.2.3.4] 已被封禁，请勿使用vpn、代理等网络' }), {
          status: 200,
        });
      }) as typeof fetch;
      const blockedRes = await scanCourseActivitiesShared(course, 'c=1', '9', 'UA');
      assert.strictEqual(fetchCallCount, 1, 'taskactivelist 返回 IP 封禁时必须立即熔断，禁止再打 student/activelist');
      assert.strictEqual(blockedRes.activities.length, 0);
      assert.strictEqual(blockedRes.rateLimited, false, 'IP 封禁不应触发 15~120 分钟退避，否则会长时间失明');
      assert.strictEqual(blockedRes.blocked, true, 'IP 封禁必须被显式标记');
      assert.ok(String(blockedRes.errorMsg).includes('封禁'), `必须返回错误原因，实际: ${blockedRes.errorMsg}`);

      globalThis.fetch = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch;
      const garbageRes = await scanCourseActivitiesShared(course, 'c=1', '9', 'UA');
      assert.ok(garbageRes.errorMsg, '返回非 JSON/异常结构时必须带错误信息而不是静默为空');

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ result: 1, activeList: [{ id: 1001, status: 1, activeType: 2, nameOne: '签到' }] }),
          { status: 200 }
        )) as typeof fetch;
      const okRes = await scanCourseActivitiesShared(course, 'c=1', '9', 'UA');
      assert.strictEqual(okRes.rawCount, 1);
      assert.strictEqual(okRes.activities.length, 1);
      assert.strictEqual(okRes.errorMsg, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 6/7 PASS] 活动列表被封禁/异常时显式报错并短路而非静默漏签');
  }

  // Test 7: Edge 巡检遇到 IP 封禁时立即中断剩余课程并进入 15m 冷却，恢复时仅单课试探并发送恢复通知
  {
    const origFetch = globalThis.fetch;
    const logs: Array<{ eventType: string; summary: string }> = [];
    const mockEnv: any = {
      CHAOXING_PHONE: '13800000000',
      CHAOXING_PASSWORD: 'pwd',
      DB: {
        prepare(sql: string) {
          const makeBound = (args: unknown[]) => ({
            first: async () => {
              if (sql.includes('FROM sessions')) {
                return {
                  cookie_json: JSON.stringify({
                    _uid: '149258490',
                    _d: 'd',
                    vc3: 'v',
                    uf: 'u',
                    fid: '2893',
                    cookie: '_uid=149258490;',
                  }),
                  expires_at: Date.now() + 3600_000,
                };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.includes('INSERT INTO execution_logs')) {
                logs.push({ eventType: String(args[0] || ''), summary: String(args[2] || '') });
              }
              return { success: true };
            },
          });
          return { bind: (...args: unknown[]) => makeBound(args), first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
        },
        async batch() {
          return [];
        },
      },
    };

    const coursesHtml = Array.from({ length: 6 }, (_, i) =>
      `<li class="course" courseId="${2000 + i}" clazzId="${3000 + i}" personId="1"><span class="course-name" title="课程${i}">课程${i}</span></li>`
    ).join('\n');

    let mobileCalls = 0;
    let isBlocked = true;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('/visit/courselistdata')) {
          return new Response(coursesHtml, { status: 200 });
        }
        if (u.includes('mobilelearn.chaoxing.com') && u.includes('taskactivelist')) {
          mobileCalls++;
          if (isBlocked) {
            return new Response(JSON.stringify({ result: 0, errorMsg: '当前ip [1.2.3.4] 已被封禁' }), { status: 200 });
          }
          return new Response(JSON.stringify({ result: 1, activeList: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const t0 = Date.parse('2026-11-21T14:00:00+08:00');
      let state: any;

      const c1 = await runChaoxingInspectionCycle(mockEnv, {
        nowMs: t0,
        checkHomework: false,
        scanDiscussions: false,
        onStateUpdate: (s) => {
          state = s;
        },
      });
      assert.strictEqual(mobileCalls, 1, '首门课被 IP 封禁后必须立即跳出循环，不能继续连打 6 门课');
      assert.strictEqual(c1.blockedCooldownActive, true);
      assert.strictEqual(c1.rateLimited, false);
      assert.strictEqual(state.blockedCooldownUntilMs, t0 + 15 * 60 * 1000);
      assert.ok(logs.some((l) => l.eventType === 'scan_error'), '应写入 scan_error 告警日志');

      mobileCalls = 0;
      const c2 = await runChaoxingInspectionCycle(mockEnv, {
        nowMs: t0 + 5 * 60 * 1000,
        checkHomework: false,
        scanDiscussions: false,
        state,
        onStateUpdate: (s) => {
          state = s;
        },
      });
      assert.strictEqual(mobileCalls, 0, '15 分钟 IP 封禁冷却窗口内不得向 mobilelearn 发请求');
      assert.strictEqual(c2.blockedCooldownActive, true);

      mobileCalls = 0;
      isBlocked = false;
      const c3 = await runChaoxingInspectionCycle(mockEnv, {
        nowMs: t0 + 15 * 60 * 1000,
        checkHomework: false,
        scanDiscussions: false,
        state,
        onStateUpdate: (s) => {
          state = s;
        },
      });
      assert.strictEqual(mobileCalls, 1, '冷却到期恢复试探应仅请求 1 门课作为金丝雀探针');
      assert.strictEqual(c3.blockedCooldownActive, false);
      assert.strictEqual(state.blockedCooldownUntilMs, 0);
      assert.ok(logs.some((l) => l.eventType === 'sign_listener_recovered'), '恢复时必须写入 sign_listener_recovered 日志');
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 7/7 PASS] IP 封禁立即中断、15m 冷却与单课恢复试探验证通过');
  }

  console.log('\n🎉 签到回溯、看板渲染与 submitting 状态机全部 7 项测试 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
