import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkAuth, isAllowedTaskUrl, parseCookies } from '../edge/src/auth';
import { isWithinSignListenWindows, runChaoxingInspectionCycle } from '../edge/src/inspection';
import { sendDigestNotification, sendNotification } from '../edge/src/notify';

async function runTests() {
  console.log('\n🧪 开始运行 CI 完整性、Edge 鉴权与通知溢出/冷却覆盖率专项测试...\n');

  // Test 1: URL SSRF 白名单与 Fail-Closed 鉴权深度边界测试
  {
    assert.strictEqual(isAllowedTaskUrl('https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1'), true);
    assert.strictEqual(isAllowedTaskUrl('https://mooc1.chaoxing.com/work/doHomeWorkNew'), true);
    assert.strictEqual(isAllowedTaskUrl('https://pintia.cn/problem-sets'), true);

    assert.strictEqual(isAllowedTaskUrl('http://mooc1.chaoxing.com/work'), false, '必须拒绝非 https');
    assert.strictEqual(isAllowedTaskUrl('https://user:pass@chaoxing.com/work'), false, '必须拒绝携带凭证的 URL');
    assert.strictEqual(isAllowedTaskUrl('https://mooc1.chaoxing.com:8443/work'), false, '必须拒绝非 443 端口');
    assert.strictEqual(isAllowedTaskUrl('https://evil-chaoxing.com/work'), false, '必须拒绝形近钓鱼域名');
    assert.strictEqual(isAllowedTaskUrl('https://custom.edu.cn/task', 'custom.edu.cn'), true);

    assert.strictEqual(checkAuth(new Request('https://edge.example.com/api/tasks'), {}), false, '未配置密钥时必须 Fail-Closed');
    assert.strictEqual(
      checkAuth(new Request('https://edge.example.com/api/tasks?token=changeme'), { AFK_EDGE_BEARER_TOKEN: 'changeme' }),
      false,
      '已知占位弱口令 changeme 必须被拒绝'
    );
    assert.strictEqual(
      checkAuth(
        new Request('https://edge.example.com/api/tasks?token=super-secret-real-token-123456'),
        { AFK_EDGE_BEARER_TOKEN: 'super-secret-real-token-123456' },
        { allowQueryToken: false }
      ),
      false,
      'allowQueryToken=false 时必须拦截 URL 查询参数 token'
    );
    assert.strictEqual(
      checkAuth(
        new Request('https://edge.example.com/api/tasks', {
          headers: { Authorization: 'Bearer super-secret-real-token-123456' },
        }),
        { AFK_EDGE_BEARER_TOKEN: 'super-secret-real-token-123456' },
        { allowQueryToken: false }
      ),
      true
    );
    assert.strictEqual(
      checkAuth(
        new Request('https://edge.example.com/dashboard', {
          headers: { Cookie: 'afk_token=super-secret-real-token-123456; foo=bar' },
        }),
        { AFK_EDGE_BEARER_TOKEN: 'super-secret-real-token-123456' },
        { allowQueryToken: false }
      ),
      true
    );
    assert.deepStrictEqual(parseCookies(new Request('https://x.test', { headers: { Cookie: 'a=hello%20world; b=2' } })), {
      a: 'hello world',
      b: '2',
    });
    console.log(' ✅ [Test 1/5 PASS] Edge URL SSRF 白名单、弱口令屏蔽与 Fail-Closed 鉴权验证通过');
  }

  // Test 2: 多通道通知并行派发与定时简报格式覆盖
  {
    const calledUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calledUrls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await sendNotification('测试标题', '正文内容', {
        WEBHOOK_URL: 'https://hooks.example.com/robot',
        SERVERCHAN_KEY: 'sct_key_123',
        PUSHPLUS_TOKEN: 'pp_tok_456',
        BARK_KEY: 'bark_789',
        TELEGRAM_BOT_TOKEN: '123456:fakeTokenForUnitTest',
        TELEGRAM_CHAT_ID: '42',
      });
      assert.strictEqual(calledUrls.length, 5, '必须同时覆盖全部 5 条通知通道');
      assert.ok(calledUrls.some((u) => u.includes('hooks.example.com')));
      assert.ok(calledUrls.some((u) => u.includes('sctapi.ftqq.com')));
      assert.ok(calledUrls.some((u) => u.includes('pushplus.plus')));
      assert.ok(calledUrls.some((u) => u.includes('api.day.app')));
      assert.ok(calledUrls.some((u) => u.includes('api.telegram.org')));

      calledUrls.length = 0;
      const summary = await sendDigestNotification(
        { TELEGRAM_BOT_TOKEN: '123456:fakeTokenForUnitTest', TELEGRAM_CHAT_ID: '42' },
        {
          pendingCount: 2,
          draftCount: 1,
          submittedCount: 10,
          signinCount: 5,
          questionBankCount: 40,
          recentTasks: [
            { platform: 'chaoxing', course_name: '离散数学', title: '图论作业', status: 'pending', deadline: '周五' },
            { platform: 'chaoxing', course_name: '物理', title: '实验报告', status: 'submitted' },
          ],
        },
        '单元测试简报'
      );
      assert.ok(summary.includes('待完成 2'));
      assert.ok(summary.includes('《离散数学》- 图论作业'));
      assert.strictEqual(calledUrls.length, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 2/5 PASS] 五通道通知并发派发与每日简报生成验证通过');
  }

  // Test 3: 超过 5 条新通知批量合并补发 + mobilelearn 12 小时封禁告警冷却 + 失败签到仅首推异常
  {
    const notifications: Array<{ title: string; content: string }> = [];
    const logs: Array<{ eventType: string; summary: string }> = [];
    const seenNotices = new Set<string>();
    const pendingTasks = new Map<string, any>();

    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes('FROM sessions')) {
              return {
                cookie_json: JSON.stringify({ _uid: '100', _d: 'd', vc3: 'v', uf: 'u', fid: '2893', cookie: '_uid=100;' }),
                expires_at: Date.now() + 3600_000,
              };
            }
            if (sql.includes('FROM notices WHERE id_code')) {
              return seenNotices.has(String(args[0])) ? { id_code: String(args[0]) } : null;
            }
            if (sql.includes('FROM pending_tasks WHERE task_id')) {
              return pendingTasks.get(String(args[0])) || null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes('INSERT INTO execution_logs')) {
              logs.push({ eventType: String(args[0]), summary: String(args[2]) });
            } else if (sql.includes('INSERT INTO notices')) {
              seenNotices.add(String(args[0]));
            } else if (sql.includes('INSERT INTO pending_tasks')) {
              pendingTasks.set(String(args[0]), { status: 'pending', payload_json: '{}' });
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    };

    const env = {
      DB: mockDb as any,
      CHAOXING_PHONE: '13800000000',
      CHAOXING_PASSWORD: 'test-password',
      WEBHOOK_URL: 'https://notify.test.local/hook',
      MOBILE_SCAN_JITTER_SEC: '0',
      SIGN_LISTEN_WINDOWS: '*',
    };

    const origFetch = globalThis.fetch;
    let mobileBlockedMode = false;
    let signResultFail = false;

    const sevenNotices = Array.from({ length: 7 }, (_, i) => ({
      idCode: `N_BATCH_${i + 1}`,
      title: `课程通知 ${i + 1}: 教室调整`,
      createrName: '教务/任课教师',
      sendTime: new Date(Date.UTC(2026, 10, 23, 2, 0, 0) - i * 60_000).toISOString(),
      content: `请各位同学注意第 ${i + 1} 条调课安排`,
    }));

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://notify.test.local/hook') {
        const body = JSON.parse(String(init?.body || '{}'));
        const text = String(body?.text?.content || '');
        const m = text.match(/^【([^】]+)】\n([\s\S]*)$/);
        notifications.push({ title: m?.[1] || text, content: m?.[2] || '' });
        return new Response('ok', { status: 200 });
      }
      if (url.includes('mooc1-1.chaoxing.com/visit/courselistdata')) {
        return new Response(
          '<ul><li courseId="1001" clazzId="2001" personId="1"><span class="course-name" title="软件工程">软件工程</span></li></ul>',
          { status: 200 }
        );
      }
      if (url.includes('mooc1-api.chaoxing.com/mycourse/backclazzdata')) {
        return new Response(
          JSON.stringify({
            result: 1,
            channelList: [{ key: 2001, content: { roletype: 3, course: { data: [{ id: 1001, name: '软件工程' }] }, id: 2001 } }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('mobilelearn.chaoxing.com/v2/apis/active/student/activelist')) {
        if (mobileBlockedMode) {
          return new Response(
            JSON.stringify({ result: 0, msg: '当前ip [1.2.3.4] 已被封禁，请勿使用vpn、代理等网络' }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            result: 1,
            data: {
              activeList: signResultFail
                ? [{ id: '80009999', name: '课堂手势签到', activeType: 2, status: 1, otherId: 3 }]
                : [],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('mobilelearn.chaoxing.com/newsign/preSign')) {
        return new Response('<html>手势签到</html>', { status: 200 });
      }
      if (url.includes('pptSign/stuSignajax')) {
        return new Response('请输入手势图案或签到失败', { status: 200 });
      }
      if (url.includes('notice.chaoxing.com')) {
        return new Response(JSON.stringify({ notices: { list: sevenNotices } }), { status: 200 });
      }
      if (url.includes('work/getAllWork') || url.includes('getTopCategoryList')) {
        return new Response('<html></html>', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const t0 = Date.UTC(2026, 10, 23, 2, 10, 0);
      // 1) 验证 7 条新通知 -> 5 条逐条 + 1 条其余 2 条合并汇总
      const s1 = await runChaoxingInspectionCycle(env, {
        nowMs: t0,
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
      });
      assert.strictEqual(s1.newNoticesNotified, 7, '7 条新通知必须全部会计数推送，不能截断丢弃第 6、7 条');
      assert.strictEqual(notifications.length, 6, '前 5 条单独推送 + 后 2 条合并 1 条汇总');
      assert.ok(notifications[5].title.includes('其余 2 条新通知汇总'));
      assert.ok(logs.some((l) => l.eventType === 'notice_overflow_batch'));

      // 2) 验证同一个 failed 签到：首次告警，15m 后重试失败但不再重复推送异常消息
      notifications.length = 0;
      signResultFail = true;
      let state: any = { activeActivitiesCount: 0, recentSignedIds: [] };
      await runChaoxingInspectionCycle(env, {
        nowMs: t0 + 5 * 60_000,
        bypassCooldown: true,
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
        state,
        onStateUpdate: (next) => (state = next),
      });
      assert.strictEqual(notifications.filter((n) => n.title.includes('签到异常')).length, 1, '首次失败应推送异常告警');

      notifications.length = 0;
      await runChaoxingInspectionCycle(env, {
        nowMs: t0 + 25 * 60_000, // 超过 15m 重试冷却
        bypassCooldown: true,
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
        state,
        onStateUpdate: (next) => (state = next),
      });
      assert.strictEqual(
        notifications.filter((n) => n.title.includes('签到异常')).length,
        0,
        '同一 activeId 后续重试失败不得重复推送轰炸'
      );

      // 3) 验证 IP 封禁告警 12 小时冷却（20 分钟后不重推，12 小时+1 分钟后恢复重推）
      notifications.length = 0;
      signResultFail = false;
      mobileBlockedMode = true;
      state.blockedCooldownUntilMs = 0;
      state.lastScanErrorLoggedMs = 0;
      await runChaoxingInspectionCycle(env, {
        nowMs: t0 + 60 * 60_000,
        bypassCooldown: true,
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
        state,
        onStateUpdate: (next) => (state = next),
      });
      assert.strictEqual(notifications.filter((n) => n.title.includes('被拦截')).length, 1);

      notifications.length = 0;
      await runChaoxingInspectionCycle(env, {
        nowMs: t0 + 80 * 60_000, // 20 分钟后再次触发封禁探针
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
        state,
        onStateUpdate: (next) => (state = next),
      });
      assert.strictEqual(notifications.filter((n) => n.title.includes('被拦截')).length, 0, '12 小时内不得重复推封禁告警');

      await runChaoxingInspectionCycle(env, {
        nowMs: t0 + (13 * 60 + 5) * 60_000, // 超过 12 小时
        checkHomework: false,
        scanDiscussions: false,
        skipSleep: true,
        state,
        onStateUpdate: (next) => (state = next),
      });
      assert.strictEqual(notifications.filter((n) => n.title.includes('被拦截')).length, 1, '超过 12 小时后可再次提示');
    } finally {
      globalThis.fetch = origFetch;
    }
    console.log(' ✅ [Test 3/5 PASS] 溢出通知合并补发、失败签到去重与 12h 封禁告警冷却验证通过');
  }

  // Test 4: SIGN_LISTEN_WINDOWS 边界与通配符行为校验
  {
    assert.strictEqual(isWithinSignListenWindows(Date.parse('2026-11-23T08:15:00+08:00')), true);
    assert.strictEqual(isWithinSignListenWindows(Date.parse('2026-11-23T11:41:00+08:00')), false);
    assert.strictEqual(isWithinSignListenWindows(Date.parse('2026-11-23T19:36:00+08:00'), '*'), true);
    assert.strictEqual(isWithinSignListenWindows(Date.parse('2026-11-23T21:10:00+08:00'), '21:00-22:00'), true);
    console.log(' ✅ [Test 4/5 PASS] SIGN_LISTEN_WINDOWS 自定义时段与通配符验证通过');
  }

  // Test 5: 仓库测试完整性与运维 Shell 脚本静态语法检查
  {
    const rootDir = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const testScript = String(pkg.scripts?.test || '');
    const testFiles = fs
      .readdirSync(path.join(rootDir, 'tests'))
      .filter((f) => f.endsWith('.test.ts'))
      .sort();
    const orphaned = testFiles.filter((f) => !testScript.includes(`tests/${f}`));
    assert.deepStrictEqual(orphaned, [], '所有 tests/*.test.ts 都必须纳入 package.json scripts.test');

    const gcpDir = path.join(rootDir, 'infra', 'gcp');
    const shFiles = fs.readdirSync(gcpDir).filter((f) => f.endsWith('.sh'));
    assert.ok(shFiles.length > 0);
    for (const sh of shFiles) {
      execFileSync('bash', ['-n', path.join(gcpDir, sh)]);
    }
    console.log(` ✅ [Test 5/5 PASS] CI 测试纳管完整性 (${testFiles.length} 个文件) 与 ${shFiles.length} 个运维脚本 bash -n 校验通过`);
  }

  console.log('\n🎉 全部 5 项 CI/Edge 覆盖率与防漏推防重专项测试 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
