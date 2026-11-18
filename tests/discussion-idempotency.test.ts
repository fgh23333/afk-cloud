import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { getDashboardData, renderDashboardHtml } from '../edge/src/dashboard';
import {
  approveAndPublishDiscussion,
  handleDiscussionStatusUpdate,
} from '../edge/src/discussions';
import { solvePendingDiscussions } from '../packages/adapters/chaoxing/discussions';

interface MockDiscussionRow {
  discussion_id: string;
  topic_id: string;
  course_id: string;
  class_id: string;
  course_name: string;
  author: string;
  title: string;
  prompt: string;
  chapter_label: string;
  topic_url: string;
  bbs_url: string;
  reply_params_json: string;
  status: string;
  draft_reply: string;
  posted_reply: string;
  model_used: string;
  reply_count: number;
  published_at: string;
  updated_at: string;
}

function createMockDiscussionDb(initialRows: MockDiscussionRow[]) {
  const rows = new Map<string, MockDiscussionRow>(
    initialRows.map((r) => [r.discussion_id, { ...r }])
  );
  const logs: Array<{ eventType: string; summary: string }> = [];
  const statusHistory: string[] = [];

  const replySession = {
    _uid: '149258490',
    _d: 'd',
    vc3: 'vc3',
    uf: 'uf',
    fid: '2893',
    cookie: '_uid=149258490; vc3=vc3;',
  };

  const db: any = {
    rows,
    logs,
    statusHistory,
    prepare(sql: string) {
      const execAll = async () => {
        if (sql.includes('FROM discussions')) {
          return { results: Array.from(rows.values()).map((r) => ({ ...r })) };
        }
        if (sql.includes('COUNT(*)')) {
          return { results: [{ cnt: 0 }] };
        }
        return { results: [] };
      };

      const makeBound = (args: unknown[]) => ({
        all: execAll,
        first: async () => {
          if (sql.includes('FROM sessions')) {
            return {
              cookie_json: JSON.stringify(replySession),
              expires_at: Date.now() + 3600 * 1000,
            };
          }
          if (sql.includes('FROM discussions WHERE discussion_id = ?')) {
            const id = String(args[0] || '');
            const row = rows.get(id);
            return row ? { ...row } : null;
          }
          const res = await execAll();
          return res.results?.[0] ?? null;
        },
        run: async () => {
          if (
            sql.includes('UPDATE discussions') &&
            sql.includes("SET status = 'publishing'") &&
            sql.includes('NOT IN')
          ) {
            const ts = String(args[0] || '');
            const id = String(args[1] || '');
            const row = rows.get(id);
            if (
              !row ||
              row.status === 'submitted' ||
              row.status === 'publishing' ||
              row.status === 'replied_externally'
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            row.status = 'publishing';
            row.updated_at = ts;
            statusHistory.push('publishing');
            return { success: true, meta: { changes: 1 } };
          }

          if (
            sql.includes('UPDATE discussions') &&
            sql.includes("SET status = 'awaiting_approval'") &&
            sql.includes("status = 'publishing'")
          ) {
            const ts = String(args[0] || '');
            const id = String(args[1] || '');
            const row = rows.get(id);
            if (!row || row.status !== 'publishing') {
              return { success: true, meta: { changes: 0 } };
            }
            row.status = 'awaiting_approval';
            row.updated_at = ts;
            statusHistory.push('awaiting_approval');
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes('UPDATE discussions') && sql.includes("SET status = 'submitted'")) {
            const postedReply = String(args[0] || '');
            const draftReply = String(args[1] || '');
            const publishedAt = String(args[2] || '');
            const updatedAt = String(args[3] || '');
            const id = String(args[4] || '');
            const row = rows.get(id);
            if (!row) return { success: true, meta: { changes: 0 } };
            row.status = 'submitted';
            row.posted_reply = postedReply;
            row.draft_reply = draftReply;
            row.published_at = publishedAt;
            row.updated_at = updatedAt;
            statusHistory.push('submitted');
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes('UPDATE discussions SET status = ?, updated_at = ? WHERE discussion_id = ?')) {
            const nextStatus = String(args[0] || '');
            const ts = String(args[1] || '');
            const id = String(args[2] || '');
            const row = rows.get(id);
            if (!row) return { success: true, meta: { changes: 0 } };
            row.status = nextStatus;
            row.updated_at = ts;
            statusHistory.push(nextStatus);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes('INSERT INTO execution_logs')) {
            logs.push({
              eventType: String(args[0] || ''),
              summary: String(args[2] || ''),
            });
          }

          return { success: true, meta: { changes: 1 } };
        },
      });

      return {
        bind: (...args: unknown[]) => makeBound(args),
        all: execAll,
        first: async () => {
          const res = await execAll();
          return res.results?.[0] ?? null;
        },
        run: async () => ({ success: true, meta: { changes: 0 } }),
      };
    },
    async batch(stmts: any[]) {
      const out = [];
      for (const s of stmts) {
        out.push(await s.all());
      }
      return out;
    },
  };

  return db;
}

function makeSampleRow(overrides: Partial<MockDiscussionRow> = {}): MockDiscussionRow {
  return {
    discussion_id: 'chaoxing-bbs-726151794',
    topic_id: '726151794',
    course_id: '266874983',
    class_id: '154101446',
    course_name: 'LabVIEW编程及应用',
    author: '张老师',
    title: 'LabVIEW 数据类型思考',
    prompt: '簇和数组有何区别？',
    chapter_label: '2.1',
    topic_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/gettopicdetail?topicid=726151794',
    bbs_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/grouptopic?courseId=266874983',
    reply_params_json: JSON.stringify({
      topicId: '726151794',
      clazzid: '154101446',
      cpi: '9988',
      ut: 's',
      showChooseClazzId: 'list_154101446',
      openc: 'openc_sig_123',
    }),
    status: 'awaiting_approval',
    draft_reply: '数组要求同构元素，簇可以组合不同数据类型。',
    posted_reply: '',
    model_used: 'gemini-4-hydrogen-xhigh',
    reply_count: 12,
    published_at: '',
    updated_at: '2026/11/13 13:00:00 (UTC+8)',
    ...overrides,
  };
}

async function runTests() {
  console.log('\n🚀 开始运行讨论发布幂等性与防重闭环测试...\n');
  const origFetch = globalThis.fetch;

  try {
    // --- Test 1: 并发重复调用 approveAndPublishDiscussion 只会发送一次 addreply ---
    {
      const db = createMockDiscussionDb([makeSampleRow()]);
      let addReplyCount = 0;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('/mooc-ans/bbscircle/addreply')) {
          addReplyCount++;
          await new Promise((r) => setTimeout(r, 30));
          return new Response(JSON.stringify({ result: 1, msg: 'success' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch;

      const env = { DB: db, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' };
      const [resA, resB] = await Promise.all([
        approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794'),
        approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794'),
      ]);

      assert.strictEqual(addReplyCount, 1, '并发点击/请求绝只能向 addreply 发送 1 次 POST');
      assert.strictEqual(
        [resA.success, resB.success].filter(Boolean).length,
        1,
        '并发调用仅允许 1 个成功、另 1 个被拒绝'
      );
      assert.strictEqual(db.rows.get('chaoxing-bbs-726151794')?.status, 'submitted');
      assert.strictEqual(db.logs.length, 1, '仅应写入 1 条 discussion_replied 审计日志');
      console.log(' ✅ [Test 1/6 PASS] 并发调用 approveAndPublishDiscussion 仅触发 1 次 addreply');
    }

    // --- Test 2: submitted / publishing / replied_externally 状态直接拒绝发布 ---
    {
      let addReplyCount = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('/mooc-ans/bbscircle/addreply')) addReplyCount++;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;

      for (const blockedStatus of ['submitted', 'publishing', 'replied_externally'] as const) {
        const db = createMockDiscussionDb([makeSampleRow({ status: blockedStatus })]);
        const env = { DB: db, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' };
        const res = await approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794');
        assert.strictEqual(res.success, false, `状态为 ${blockedStatus} 时必须拒绝发布`);
        assert.strictEqual(db.rows.get('chaoxing-bbs-726151794')?.status, blockedStatus);
      }
      assert.strictEqual(addReplyCount, 0, '已提交/发布中/已外部回复的话题严禁调用 addreply');
      console.log(' ✅ [Test 2/6 PASS] submitted / publishing / replied_externally 状态直拒且零请求');
    }

    // --- Test 3: 发布失败时原子锁回退至 awaiting_approval，后续重试可成功 ---
    {
      const db = createMockDiscussionDb([makeSampleRow()]);
      let addReplyCount = 0;
      let shouldFail = true;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('/mooc-ans/bbscircle/addreply')) {
          addReplyCount++;
          if (shouldFail) {
            return new Response('server busy', { status: 500 });
          }
          return new Response('success', { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch;

      const env = { DB: db, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' };
      const failRes = await approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794');
      assert.strictEqual(failRes.success, false, 'addreply 返回 500 时应返回发布失败');
      assert.strictEqual(
        db.rows.get('chaoxing-bbs-726151794')?.status,
        'awaiting_approval',
        '发布失败后必须从 publishing 回退为 awaiting_approval'
      );
      assert.deepStrictEqual(db.statusHistory, ['publishing', 'awaiting_approval']);

      shouldFail = false;
      const retryRes = await approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794');
      assert.strictEqual(retryRes.success, true, '回退后再次人工审批应能正常发布');
      assert.strictEqual(addReplyCount, 2);
      assert.strictEqual(db.rows.get('chaoxing-bbs-726151794')?.status, 'submitted');
      console.log(' ✅ [Test 3/6 PASS] 发布失败自动回退 awaiting_approval 且重试闭环正常');
    }

    // --- Test 4: 看板数据统计与前端点击立即禁用按钮 + publishing 徽章 ---
    {
      const db = createMockDiscussionDb([
        makeSampleRow({ discussion_id: 'd-pub', status: 'publishing' }),
        makeSampleRow({ discussion_id: 'd-wait', status: 'awaiting_approval' }),
      ]);
      const dash = await getDashboardData({ DB: db });
      assert.strictEqual(dash.stats.discussionDraftCount, 2, 'publishing 应计入待审批/发布中队列');
      assert.strictEqual(dash.stats.discussionPendingCount, 0);
      assert.strictEqual(dash.stats.discussionSubmittedCount, 0);

      const html = renderDashboardHtml();
      assert.ok(html.includes('publishingDiscussionIds'), '看板 JS 必须维护进行中集合防连击');
      assert.ok(html.includes('data-discussion-status="publishing"'), '看板必须包含 publishing 徽章');
      assert.ok(html.includes('正在发布中'), '看板必须渲染发布中提示');

      const { JSDOM } = await import('jsdom');
      let resolveFetch!: (val: Response) => void;
      const pendingFetch = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      let publishFetchCalls = 0;

      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        url: 'https://afk.example.com/',
        beforeParse(window) {
          (window as any).tailwind = {};
          (window as any).confirm = () => true;
          (window as any).fetch = (url: string) => {
            if (String(url).includes('/publish')) {
              publishFetchCalls++;
              return pendingFetch;
            }
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  discussions: [],
                  homeworks: [],
                  exams: [],
                  notices: [],
                  signinHistory: [],
                  courses: [],
                  stats: {},
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }
              )
            );
          };
        },
      });
      const win = dom.window as any;

      win.eval(`
        state = {
          discussions: [
            {
              discussionId: 'chaoxing-bbs-726151794',
              courseName: 'LabVIEW编程及应用',
              title: 'LabVIEW 数据类型思考',
              prompt: '簇和数组有何区别？',
              status: 'awaiting_approval',
              draftReply: '这是草稿内容',
              replyCount: 3,
            },
          ],
          homeworks: [],
          exams: [],
          notices: [],
          signinHistory: [],
          courses: [],
          stats: {},
        };
        renderDiscussions();
      `);

      // 连续触发两次 publishDiscussionUI
      const p1 = win.publishDiscussionUI('chaoxing-bbs-726151794', 'disc-draft-chaoxing-bbs-726151794');
      const p2 = win.publishDiscussionUI('chaoxing-bbs-726151794', 'disc-draft-chaoxing-bbs-726151794');

      assert.strictEqual(publishFetchCalls, 1, '前端在请求未返回前双击只允许发出 1 次 /publish 请求');
      const pubBtn = win.document.getElementById('disc-pub-chaoxing-bbs-726151794') as HTMLButtonElement;
      const saveBtn = win.document.getElementById('disc-save-chaoxing-bbs-726151794') as HTMLButtonElement;
      const ignoreBtn = win.document.getElementById('disc-ignore-chaoxing-bbs-726151794') as HTMLButtonElement;
      assert.strictEqual(pubBtn.disabled, true, '点击发布后发布按钮必须立即禁用');
      assert.strictEqual(saveBtn.disabled, true, '点击发布后保存按钮必须立即禁用');
      assert.strictEqual(ignoreBtn.disabled, true, '点击发布后忽略按钮必须立即禁用');
      assert.ok(
        win.document.querySelector('[data-discussion-status="publishing"]'),
        '点击发布后必须立即渲染 publishing 徽章'
      );

      resolveFetch(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await Promise.all([p1, p2]);
      dom.window.close();
      console.log(' ✅ [Test 4/6 PASS] 看板点击即禁用按钮、渲染 publishing 徽章且防前端连击');
    }

    // --- Test 5: /api/discussions/:id/status 白名单校验与防覆盖 submitted ---
    {
      const edgeIndexCode = fs.readFileSync(path.join(__dirname, '../edge/src/index.ts'), 'utf8');
      assert.ok(
        edgeIndexCode.includes('discStatusMatch') &&
          edgeIndexCode.includes('handleDiscussionStatusUpdate') &&
          edgeIndexCode.includes('/status$/'),
        'edge/src/index.ts 必须挂载 POST /api/discussions/:id/status 路由'
      );

      const db = createMockDiscussionDb([
        makeSampleRow({ discussion_id: 'd-pending', status: 'pending' }),
        makeSampleRow({ discussion_id: 'd-sub', status: 'submitted' }),
      ]);
      const env = { DB: db };

      const badRes = await handleDiscussionStatusUpdate(env, 'd-pending', 'submitted');
      assert.strictEqual(badRes.ok, false);
      assert.strictEqual(badRes.statusCode, 400, 'status 白名单必须拒绝伪造 submitted');

      const missingRes = await handleDiscussionStatusUpdate(env, 'd-missing', 'replied_externally');
      assert.strictEqual(missingRes.ok, false);
      assert.strictEqual(missingRes.statusCode, 404);

      const okRes = await handleDiscussionStatusUpdate(env, 'd-pending', 'replied_externally');
      assert.strictEqual(okRes.ok, true);
      assert.strictEqual(okRes.statusCode, 200);
      assert.strictEqual(db.rows.get('d-pending')?.status, 'replied_externally');

      const keepSubmittedRes = await handleDiscussionStatusUpdate(env, 'd-sub', 'replied_externally');
      assert.strictEqual(keepSubmittedRes.ok, true);
      assert.strictEqual(keepSubmittedRes.unchanged, true);
      assert.strictEqual(db.rows.get('d-sub')?.status, 'submitted', '绝不能覆盖已 submitted 的记录');
      console.log(' ✅ [Test 5/6 PASS] /api/discussions/:id/status 白名单鉴权与状态保护通过');
    }

    // --- Test 6: CLI solvePendingDiscussions 检测到 detail.myReplied 时回写 Edge ---
    {
      const db = createMockDiscussionDb([
        makeSampleRow({ discussion_id: 'chaoxing-bbs-726151794', status: 'pending' }),
      ]);
      const origEdgeUrl = process.env.AFK_EDGE_WORKER_URL;
      const origEdgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
      process.env.AFK_EDGE_WORKER_URL = 'https://edge.mock.local';
      process.env.AFK_EDGE_BEARER_TOKEN = 'test-token';

      let statusPostCalls = 0;
      let addReplyCalls = 0;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.includes('/mooc-ans/bbscircle/addreply')) {
          addReplyCalls++;
          return new Response('should-not-happen', { status: 500 });
        }
        if (u === 'https://edge.mock.local/api/discussions?status=pending') {
          const items = Array.from((db.rows as Map<string, MockDiscussionRow>).values()).filter(
            (r) => r.status === 'pending'
          );
          return new Response(JSON.stringify({ ok: true, discussions: items }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.includes('gettopicdetail')) {
          // 模拟详情页已包含主题作者 + 本人姓名的回复
          const html = `
            <h3 class="bt">LabVIEW 数据类型思考</h3>
            <p id="topicContent">簇和数组有何区别？</p>
            <span class="name">张老师</span>
            <div class="reply_item"><span class="name">王同学</span><p>已回复内容</p></div>
            <input type="hidden" id="openc" value="openc_sig_123" />
            <a onclick="form_rep_submit2(726151794, 154101446, '9988', 's', 'list_154101446')">发布</a>
          `;
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
        if (u === 'https://edge.mock.local/api/discussions/chaoxing-bbs-726151794/status') {
          statusPostCalls++;
          const body = JSON.parse(String(init?.body || '{}'));
          const res = await handleDiscussionStatusUpdate({ DB: db }, 'chaoxing-bbs-726151794', body.status);
          return new Response(JSON.stringify(res), {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      try {
        const summary = await solvePendingDiscussions(
          [
            {
              courseId: '266874983',
              classId: '154101446',
              courseName: 'LabVIEW编程及应用',
              cpi: '9988',
            },
          ],
          { _uid: '1', _d: 'd', vc3: 'v', uf: 'u', fid: 'f', cookieStr: '_uid=1;' },
          { realname: '王同学' }
        );

        assert.strictEqual(summary.scanned, 1);
        assert.strictEqual(summary.skipped, 1);
        assert.strictEqual(summary.drafted, 0);
        assert.strictEqual(summary.submitted, 0);
        assert.strictEqual(addReplyCalls, 0, 'CLI 默认绝不调用 addreply');
        assert.strictEqual(statusPostCalls, 1, '检测到 myReplied 时必须向 Edge 回写一次状态');
        assert.strictEqual(
          db.rows.get('chaoxing-bbs-726151794')?.status,
          'replied_externally',
          'D1 状态必须更新为 replied_externally'
        );
      } finally {
        if (origEdgeUrl === undefined) delete process.env.AFK_EDGE_WORKER_URL;
        else process.env.AFK_EDGE_WORKER_URL = origEdgeUrl;
        if (origEdgeToken === undefined) delete process.env.AFK_EDGE_BEARER_TOKEN;
        else process.env.AFK_EDGE_BEARER_TOKEN = origEdgeToken;
      }
      console.log(' ✅ [Test 6/6 PASS] CLI 检测到 myReplied 自动回写 replied_externally 到 Edge D1');
    }

    // --- Test 7: autoSubmit=true 时自动保存草稿并调用 Edge /publish 完成闭环 ---
    {
      const edgeIndexCode = fs.readFileSync(path.resolve(process.cwd(), 'edge/src/index.ts'), 'utf8');
      assert.ok(
        edgeIndexCode.includes('/discussions/process') &&
          edgeIndexCode.includes('dispatchDiscussionProcessingToShim') &&
          edgeIndexCode.includes("status = 'awaiting_approval'"),
        'edge/src/index.ts scheduled() 必须自动处理 pending 与 awaiting_approval 讨论并免审发布'
      );

      const shimCode = fs.readFileSync(path.resolve(process.cwd(), 'packages/shim/src/index.ts'), 'utf8');
      assert.ok(shimCode.includes("pathname === '/discussions/process'"), 'shim 必须挂载 /discussions/process 路由');

      const adapterCode = fs.readFileSync(
        path.resolve(process.cwd(), 'packages/adapters/chaoxing/discussions.ts'),
        'utf8'
      );
      assert.ok(
        adapterCode.includes('publishDiscussionOnEdge'),
        'autoSubmit=true 且配置 Edge 时必须走 publishDiscussionOnEdge 原子加锁发布并同步 D1 状态'
      );
      console.log(' ✅ [Test 7/7 PASS] 讨论区自动下发与免审批自动发布契约验证通过');
    }

    // --- Test 8: 已结束或过截止时间的讨论回复失败时自动归档为 ignored，避免 Edge Cron 无限重试 ---
    {
      for (const closedReplyBody of ['error;话题已结束，无法回复', 'error;该话题已到回复截止时间']) {
        const db = createMockDiscussionDb([makeSampleRow()]);
        let addReplyCount = 0;

        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input);
          if (u.includes('/mooc-ans/bbscircle/addreply')) {
            addReplyCount++;
            return new Response(closedReplyBody, { status: 200 });
          }
          return new Response('unexpected', { status: 500 });
        }) as typeof fetch;

        const env = { DB: db, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' };
        const res = await approveAndPublishDiscussion(env, 'chaoxing-bbs-726151794');
        assert.strictEqual(res.success, false, `${closedReplyBody} 应返回失败`);
        assert.strictEqual(addReplyCount, 1);
        assert.strictEqual(
          db.rows.get('chaoxing-bbs-726151794')?.status,
          'ignored',
          `${closedReplyBody} 必须自动归档为 ignored，而非回退 awaiting_approval`
        );
        assert.deepStrictEqual(db.statusHistory, ['publishing', 'ignored']);
      }
      console.log(' ✅ [Test 8/8 PASS] 已结束/过截止时间的讨论发布失败后自动归档为 ignored');
    }

    console.log('\n🎉 讨论发布幂等性与防重测试 8/8 全部通过！\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
