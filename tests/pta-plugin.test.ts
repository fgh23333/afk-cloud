import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildPtaSubmissionDetail,
  hasPtaAuthCookie,
  normalizePtaProblem,
  parseBlankAnswers,
  parsePtaTaskIdentifiers,
  PtaAdapter,
  savePtaProblemDrafts,
  stripMarkdownCodeFence,
  submitPtaProblemAnswers,
} from '../packages/adapters/pta';
import { WebBrowserAdapter } from '../packages/adapters/web-agent';
import { PluginRegistry } from '../packages/core/plugin';
import { runCodeInLocalSandbox } from '../packages/core/sandbox';
import { runPtaInspectionCycle } from '../edge/src/pta';
import { processPtaTask } from '../packages/shim/src/runner';
import { runPtaMonitorCycle } from '../packages/shim/src/pta-monitor';

async function runTests() {
  console.log('\n🧪 开始运行 PTA 插件、防覆盖提交、Java 沙箱与双端监听专项测试...\n');

  // Test 1: 插件注册、ID 解析、PTASession 校验与防不完整 Cookie 误覆写 D1
  {
    const adapter = new PtaAdapter();
    assert.strictEqual(adapter.manifest.id, 'pta');
    assert.ok(adapter.manifest.capabilities.includes('homework'));
    assert.ok(adapter.manifest.capabilities.includes('sandbox'));

    const reg = PluginRegistry.getInstance();
    reg.register(adapter);
    assert.ok(reg.has('pta'), 'PtaAdapter 应成功注册进 PluginRegistry');

    assert.deepStrictEqual(
      parsePtaTaskIdentifiers({ jobId: 'pta-ps-2123357435736915968' }),
      { problemSetId: '2123357435736915968' }
    );
    assert.deepStrictEqual(
      parsePtaTaskIdentifiers({ taskUrl: 'https://pintia.cn/problem-sets/2123358844309991424/exam/problems' }),
      { problemSetId: '2123358844309991424' }
    );
    assert.strictEqual(hasPtaAuthCookie('_ga=GA1.1; _bl_uid=abc'), false);
    assert.strictEqual(hasPtaAuthCookie('_ga=GA1.1; PTASession=mock_session_val'), true);

    const tmpProfiles = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pta-profile-'));
    const origDir = process.env.AFK_BROWSER_PROFILES_DIR;
    const origEdge = process.env.AFK_EDGE_WORKER_URL;
    let cloudPushCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      cloudPushCalls++;
      return new Response(JSON.stringify({ saved: true }), { status: 200 });
    }) as typeof fetch;

    try {
      process.env.AFK_BROWSER_PROFILES_DIR = tmpProfiles;
      process.env.AFK_EDGE_WORKER_URL = 'https://edge.test.local';
      const web = new WebBrowserAdapter('pta');
      await web.importCookieString('_ga=GA1.1.123; _bl_uid=xyz', '.pintia.cn');
      assert.strictEqual(cloudPushCalls, 0, '缺少 HttpOnly PTASession 时禁止覆盖云端 D1 有效会话');

      await web.importCookieString('PTASession=mock_pta_session_val', '.pintia.cn');
      assert.strictEqual(cloudPushCalls, 1, '包含 PTASession 后应正常同步云端 D1');
    } finally {
      globalThis.fetch = origFetch;
      if (origDir === undefined) delete process.env.AFK_BROWSER_PROFILES_DIR;
      else process.env.AFK_BROWSER_PROFILES_DIR = origDir;
      if (origEdge === undefined) delete process.env.AFK_EDGE_WORKER_URL;
      else process.env.AFK_EDGE_WORKER_URL = origEdge;
      fs.rmSync(tmpProfiles, { recursive: true, force: true });
    }
    console.log(' ✅ [Test 1/5 PASS] PTA 插件契约、ID 解析与 PTASession 防误覆盖守卫通过');
  }

  // Test 2: 全部 7 种 PTA 题型归一化、代码围栏清洗、多空解析与 submissionDetail 构建
  {
    assert.strictEqual(stripMarkdownCodeFence('```java\nclass Main {}\n```'), 'class Main {}');
    assert.deepStrictEqual(parseBlankAnswers('["Killer,Miller", "Miller,Killer"]', 2), [
      'Killer,Miller',
      'Miller,Killer',
    ]);
    assert.deepStrictEqual(parseBlankAnswers('line1\nline2', 2), ['line1', 'line2']);

    const { question: tfQ, meta: tfMeta } = normalizePtaProblem({
      id: '1001',
      label: '1-1',
      score: 2,
      type: 'TRUE_OR_FALSE',
      content: 'Java 字节码平台无关。',
    });
    assert.strictEqual(tfQ.type, 'judgement');
    assert.deepStrictEqual(buildPtaSubmissionDetail(tfMeta, 'true'), {
      problemId: '0',
      problemSetProblemId: '1001',
      trueOrFalseSubmissionDetail: { answer: 'TRUE' },
    });

    const { question: mcQ, meta: mcMeta } = normalizePtaProblem({
      id: '1002',
      label: '2-1',
      score: 2,
      type: 'MULTIPLE_CHOICE',
      content: '下列选项正确的是？',
      problemConfig: { multipleChoiceProblemConfig: { choices: ['optA', 'optB', 'optC', 'optD'] } },
    });
    assert.strictEqual(mcQ.type, 'single');
    assert.strictEqual(mcQ.options?.length, 4);
    assert.deepStrictEqual(buildPtaSubmissionDetail(mcMeta, 'B'), {
      problemId: '0',
      problemSetProblemId: '1002',
      multipleChoiceSubmissionDetail: { answer: 'B' },
    });

    const { question: mmQ, meta: mmMeta } = normalizePtaProblem({
      id: '1003',
      label: '3-1',
      score: 3,
      type: 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER',
      content: '多选题',
      problemConfig: { multipleChoiceMoreThanOneAnswerProblemConfig: { choices: ['A1', 'B1', 'C1'] } },
    });
    assert.strictEqual(mmQ.type, 'multiple');
    assert.deepStrictEqual(buildPtaSubmissionDetail(mmMeta, 'C,A'), {
      problemId: '0',
      problemSetProblemId: '1003',
      multipleChoiceMoreThanOneAnswerSubmissionDetail: { answers: ['A', 'C'] },
    });

    const { question: fbQ, meta: fbMeta } = normalizePtaProblem({
      id: '1004',
      label: '4-1',
      score: 5,
      type: 'FILL_IN_THE_BLANK',
      content: '请写出输出：\n@@[](2)\n@@[](2)',
      problemConfig: {
        fillInTheBlankProblemConfig: {
          blanks: [
            { index: 1, length: 13 },
            { index: 2, length: 13 },
          ],
        },
      },
    });
    assert.strictEqual(fbQ.type, 'blank');
    assert.ok(fbQ.title.includes('预期长度=13'));
    assert.deepStrictEqual(buildPtaSubmissionDetail(fbMeta, '["Killer,Miller", "Miller,Killer"]'), {
      problemId: '0',
      problemSetProblemId: '1004',
      fillInTheBlankSubmissionDetail: { answers: ['Killer,Miller', 'Miller,Killer'] },
    });

    const { question: fbpQ, meta: fbpMeta } = normalizePtaProblem(
      {
        id: '1005',
        label: '5-1',
        score: 7,
        type: 'FILL_IN_THE_BLANK_FOR_PROGRAMMING',
        compiler: 'JAVAC',
        content: 'public Rectangle() {}',
        problemConfig: {
          fillInTheBlankForProgrammingProblemConfig: {
            blanks: [
              { index: 1, length: 10 },
              { index: 2, length: 17 },
            ],
          },
        },
      },
      ['JAVAC']
    );
    assert.strictEqual(fbpQ.languageHint, 'java');
    assert.deepStrictEqual(buildPtaSubmissionDetail(fbpMeta, '["this(5,6);", "String toString()"]'), {
      problemId: '0',
      problemSetProblemId: '1005',
      fillInTheBlankForProgrammingSubmissionDetail: { answers: ['this(5,6);', 'String toString()'] },
    });

    const { meta: ccMeta } = normalizePtaProblem({
      id: '1006',
      label: '6-1',
      score: 7,
      type: 'CODE_COMPLETION',
      compiler: 'JAVAC',
      content: 'class Book {}',
    });
    assert.deepStrictEqual(buildPtaSubmissionDetail(ccMeta, '```java\nclass Book {}\n```'), {
      problemId: '0',
      problemSetProblemId: '1006',
      codeCompletionSubmissionDetail: { program: 'class Book {}' },
    });

    const { question: progQ, meta: progMeta } = normalizePtaProblem(
      {
        id: '1007',
        label: '7-1',
        score: 10,
        type: 'PROGRAMMING',
        compiler: 'NO_COMPILER',
        content: '```in\n1 2\n```\n```out\n3\n```',
      },
      ['JAVAC']
    );
    assert.strictEqual(progQ.languageHint, 'java');
    assert.strictEqual(progQ.sampleInput, '1 2\n');
    assert.strictEqual(progQ.sampleOutput, '3\n');
    assert.deepStrictEqual(buildPtaSubmissionDetail(progMeta, '```java\npublic class Main {}\n```', ['JAVAC']), {
      problemId: '0',
      problemSetProblemId: '1007',
      programmingSubmissionDetail: { program: 'public class Main {}', compiler: 'JAVAC' },
    });
    console.log(' ✅ [Test 2/5 PASS] PTA 7 大题型归一化、预期宽度提取与 submissionDetail 构建通过');
  }

  // Test 3: clustered 题型防 OVERRIDDEN 合并提交、草稿暂存与严禁调用 /end 验证
  {
    const postedUrls: string[] = [];
    const postedBodies: any[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/end')) {
        throw new Error('绝不允许在未授权时调用 /end 锁卷');
      }
      if (method === 'POST') {
        postedUrls.push(url);
        postedBodies.push(JSON.parse(String(init?.body || '{}')));
        if (url.includes('/exam-draft')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ submissionId: `sub_${postedBodies.length}` }), { status: 200 });
      }
      if (url.includes('/submissions?limit=50')) {
        return new Response(
          JSON.stringify({
            submissions: [
              { id: 'old_mc_sub', problemType: 'MULTIPLE_CHOICE', problemSetProblemId: '0', status: 'WAITING' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/submissions/old_mc_sub')) {
        return new Response(
          JSON.stringify({
            submission: {
              id: 'old_mc_sub',
              problemType: 'MULTIPLE_CHOICE',
              submissionDetails: [
                { problemId: '0', problemSetProblemId: 'p1', multipleChoiceSubmissionDetail: { answer: 'A' } },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/submissions/sub_')) {
        return new Response(
          JSON.stringify({
            submission: { id: 'sub_2', problemType: 'PROGRAMMING', status: 'ACCEPTED', score: 10 },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const draftRes = await savePtaProblemDrafts(
        [{ problemSetProblemId: 'p2', label: '2-2', problemType: 'MULTIPLE_CHOICE', maxScore: 2 }],
        { p2: 'B' },
        'PTASession=mock_cookie',
        'ps_1',
        ['JAVAC']
      );
      assert.strictEqual(draftRes.savedCount, 1);
      assert.ok(postedUrls[0].endsWith('/api/problem-sets/problems/p2/exam-draft'));

      postedUrls.length = 0;
      postedBodies.length = 0;

      const subRes = await submitPtaProblemAnswers({
        psId: 'ps_1',
        examId: 'ex_1',
        metas: [
          { problemSetProblemId: 'p2', label: '2-2', problemType: 'MULTIPLE_CHOICE', maxScore: 2 },
          { problemSetProblemId: 'p7', label: '7-1', problemType: 'PROGRAMMING', maxScore: 10 },
        ],
        answers: {
          p2: 'B',
          p7: 'public class Main { public static void main(String[] a){ System.out.println(42); } }',
        },
        cookieHeader: 'PTASession=mock_cookie',
        problemSetCompilers: ['JAVAC'],
      });

      assert.strictEqual(postedUrls.length, 2);
      assert.ok(!postedUrls.some((u) => u.includes('/end')), '绝不可触发 /end');
      const mcPost = postedBodies.find((b) => b.problemType === 'MULTIPLE_CHOICE');
      assert.ok(mcPost, '应发送整组 MULTIPLE_CHOICE 提交');
      assert.strictEqual(mcPost.details.length, 2, '必须合并历史 p1 与新题 p2，防止 OVERRIDDEN 覆盖丢失 p1');
      assert.strictEqual(subRes.acceptedCount, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 3/5 PASS] 草稿暂存、clustered 整组合并防 OVERRIDDEN 与禁用 /end 通过');
  }

  // Test 4: Java 本地沙箱编译运行与编译报错自检验证
  {
    let hasJavac = true;
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' });
    } catch {
      hasJavac = false;
    }

    if (hasJavac) {
      const okRes = await runCodeInLocalSandbox({
        language: 'java',
        code: `import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    int a = sc.nextInt(), b = sc.nextInt();
    System.out.println(a + b);
  }
}`,
        sampleInput: '19 23\n',
        expectedOutput: '42',
      });
      assert.strictEqual(okRes.passed, true, 'Java 沙箱应正确编译运行并匹配 42');

      const badRes = await runCodeInLocalSandbox({
        language: 'java',
        code: 'public class Main { public static void main(String[] a){ broken syntax } }',
        sampleInput: '',
        expectedOutput: '',
      });
      assert.strictEqual(badRes.passed, false);
      assert.strictEqual(badRes.stage, 'compile', 'Java 语法错误应被分类为 compile 阶段以便模型自愈');
      console.log(` ✅ [Test 4/5 PASS] Java 沙箱编译运行 (${okRes.durationMs}ms) 与编译错误捕获通过`);
    } else {
      console.log(' ⏭️ [Test 4/5 SKIP] 当前环境无 javac，跳过真实 Java 执行');
    }
  }

  // Test 5: Edge PTA 监听 (已完成去重 / 新题单次告警 / 会话过期 12h 冷却 / 403 委托 Shim) 与 Shim runner/monitor 验证
  {
    const notifications: Array<{ title: string; content: string }> = [];
    const logs: Array<{ eventType: string; summary: string }> = [];
    const tasksMap = new Map<string, any>();
    const sessionsMap = new Map<string, any>();
    sessionsMap.set('web-profile:pta::default', {
      cookie_json: JSON.stringify({
        cookies: [{ name: 'PTASession', value: 'mock_pta_session_val', domain: '.pintia.cn', path: '/' }],
      }),
      expires_at: Date.now() + 3600_000,
    });

    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) {
              return sessionsMap.get(`${args[0]}::${args[1]}`) || null;
            }
            if (sql.includes('FROM pending_tasks WHERE task_id')) {
              return tasksMap.get(String(args[0])) || null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes('INSERT INTO sessions')) {
              sessionsMap.set(`${args[0]}::${args[1]}`, { cookie_json: String(args[2]), expires_at: Number(args[3]) });
            } else if (sql.includes('INSERT INTO execution_logs')) {
              logs.push({ eventType: String(args[0]), summary: String(args[2]) });
            } else if (sql.includes('INSERT INTO pending_tasks')) {
              tasksMap.set(String(args[0]), {
                task_id: String(args[0]),
                status: String(args[6]),
                payload_json: String(args[10] || '{}'),
              });
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    };

    let scenario: 'normal' | 'expired' | 'blocked' = 'normal';
    let shimDelegatedCalled = 0;
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://notify.test.local/hook') {
        const body = JSON.parse(String(init?.body || '{}'));
        const text = String(body?.text?.content || '');
        const m = text.match(/^【([^】]+)】\n([\s\S]*)$/);
        notifications.push({ title: m?.[1] || text, content: m?.[2] || '' });
        return new Response('ok', { status: 200 });
      }
      if (url === 'https://shim.test.local/pta/inspect') {
        shimDelegatedCalled++;
        return new Response(JSON.stringify({ ok: true, msg: 'shim scanned' }), { status: 200 });
      }
      if (url.includes('pintia.cn/api/problem-sets?')) {
        if (scenario === 'expired') {
          return new Response(JSON.stringify({ error: { code: 'USER_NOT_LOGGED_IN' } }), { status: 401 });
        }
        if (scenario === 'blocked') {
          return new Response('Forbidden', { status: 403 });
        }
        return new Response(
          JSON.stringify({
            total: 2,
            problemSets: [
              {
                id: '2123357435736915968',
                name: '已完成模拟测试1',
                type: 'EXERCISE',
                status: 'PENDING',
                organizationName: '测试学校',
                endAt: '2026-12-16T12:05:00Z',
              },
              {
                id: '2129999999999999999',
                name: '新发布实验2',
                type: 'EXERCISE',
                status: 'PENDING',
                organizationName: '测试学校',
                endAt: '2026-12-20T12:05:00Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/problem-sets/2123357435736915968/exams')) {
        return new Response(
          JSON.stringify({ exam: { id: 'ex_done', score: 35, ended: false, status: 'PROCESSING' } }),
          { status: 200 }
        );
      }
      if (url.includes('/problem-sets/2123357435736915968/exam-problem-status')) {
        return new Response(
          JSON.stringify({
            problemStatus: [
              { id: '1', label: '2-1', score: 2, problemSubmissionStatus: 'PROBLEM_SUBMITTED', problemType: 'MULTIPLE_CHOICE' },
              { id: '2', label: '7-1', score: 5, problemSubmissionStatus: 'PROBLEM_ACCEPTED', problemType: 'PROGRAMMING' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/problem-sets/2129999999999999999/exams')) {
        return new Response(JSON.stringify({ exam: { id: 'ex_new', score: 0, ended: false, status: 'PROCESSING' } }), {
          status: 200,
        });
      }
      if (url.includes('/problem-sets/2129999999999999999/exam-problem-status')) {
        return new Response(
          JSON.stringify({
            problemStatus: [
              { id: '10', label: '7-1', score: 10, problemSubmissionStatus: 'PROBLEM_NO_ANSWER', problemType: 'PROGRAMMING' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/tasks')) {
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (url.endsWith('/api/tasks/sync')) {
        return new Response(JSON.stringify({ synced: 2 }), { status: 200 });
      }
      if (url.endsWith('/api/notify')) {
        const body = JSON.parse(String(init?.body || '{}'));
        notifications.push({ title: body.title, content: body.content });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const env = {
      DB: mockDb as any,
      WEBHOOK_URL: 'https://notify.test.local/hook',
      AFK_SHIM_URL: 'https://shim.test.local',
      AFK_SHIM_SECRET: 'test-shim-secret-at-least-32-chars-long',
    };

    try {
      const t0 = Date.UTC(2026, 10, 24, 13, 0, 0);
      const r1 = await runPtaInspectionCycle(env, { nowMs: t0 });
      assert.strictEqual(r1.success, true);
      assert.strictEqual(r1.activeCount, 2);
      assert.strictEqual(r1.pendingCount, 1);
      assert.strictEqual(r1.newTasksNotified, 1, '仅新出现的未完成 PTA 题目集应推送通知');
      assert.strictEqual(tasksMap.get('pta-ps-2123357435736915968')?.status, 'submitted');
      assert.strictEqual(tasksMap.get('pta-ps-2129999999999999999')?.status, 'pending');
      assert.strictEqual(notifications.length, 1);
      assert.ok(notifications[0].content.includes('新发布实验2'));

      // 重复运行不应重复告警
      notifications.length = 0;
      const r2 = await runPtaInspectionCycle(env, { nowMs: t0 + 600_000 });
      assert.strictEqual(r2.newTasksNotified, 0);
      assert.strictEqual(notifications.length, 0, '已建档待办不得重复告警');

      // Cookie 失效 12h 冷却防刷屏
      scenario = 'expired';
      const rExp1 = await runPtaInspectionCycle(env, { nowMs: t0 + 1200_000 });
      assert.strictEqual(rExp1.sessionExpired, true);
      assert.strictEqual(notifications.length, 1);
      notifications.length = 0;
      const rExp2 = await runPtaInspectionCycle(env, { nowMs: t0 + 1800_000 });
      assert.strictEqual(rExp2.sessionExpired, true);
      assert.strictEqual(notifications.length, 0, '12h 冷却期内不得重复推送会话过期告警');

      // 403 WAF 拦截降级委托 Shim /pta/inspect
      scenario = 'blocked';
      const rBlk = await runPtaInspectionCycle(env, { nowMs: t0 + 2400_000, force: true });
      assert.strictEqual(rBlk.delegatedToShim, true);
      assert.strictEqual(shimDelegatedCalled, 1);

      // 测试 Shim pta-monitor 与 processPtaTask (已完成同步 submitted)
      scenario = 'normal';
      const tmpMon = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pta-mon-'));
      process.env.AFK_PTA_MONITOR_STATE_FILE = path.join(tmpMon, 'state.json');
      process.env.PTA_SESSION_COOKIE = 'PTASession=mock_pta_session_val';
      process.env.AFK_EDGE_WORKER_URL = 'https://edge.test.local';
      process.env.AFK_EDGE_BEARER_TOKEN = 'test-edge-bearer-token-123456';
      notifications.length = 0;
      try {
        const monRes = await runPtaMonitorCycle({ force: true });
        assert.strictEqual(monRes.ok, true);
        assert.strictEqual(monRes.pendingCount, 1);
        assert.strictEqual(monRes.newAlertsSent, 1);

        const job = {
          jobId: 'pta-ps-2123357435736915968',
          platform: 'pta',
          taskUrl: 'https://pintia.cn/problem-sets/2123357435736915968/exam',
          mode: 'draft' as const,
          phase: 'running' as const,
          createdAt: '',
          updatedAt: '',
        };
        await processPtaTask(job, 'draft');
        assert.strictEqual(job.phase, 'submitted', '已在 PTA 作答完毕的题目集应自动对齐为 submitted');
      } finally {
        delete process.env.AFK_PTA_MONITOR_STATE_FILE;
        delete process.env.PTA_SESSION_COOKIE;
        delete process.env.AFK_EDGE_WORKER_URL;
        delete process.env.AFK_EDGE_BEARER_TOKEN;
        fs.rmSync(tmpMon, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 5/5 PASS] Edge/Shim 双端 PTA 监听、去重、12h 冷却与 WAF 降级委托通过');
  }

  console.log('\n🎉 PTA 插件、Java 沙箱与双端监听全部 5 项测试 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ PTA 插件测试失败:', err);
  process.exit(1);
});
