import assert from 'assert';
import {
  escalateRateLimitBackoff,
  RATE_LIMIT_BACKOFF_MINUTES,
  runChaoxingInspectionCycle,
  SignState,
} from '../edge/src/inspection';

interface LoggedEvent {
  eventType: string;
  platform: string;
  summary: string;
  details: string;
}

function createMockDb(logsOut: LoggedEvent[]) {
  return {
    prepare(sql: string) {
      const makeBound = (args: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM sessions')) {
            return {
              cookie_json: JSON.stringify({
                _uid: '149258490',
                _d: 'd',
                vc3: 'vc3',
                uf: 'uf',
                fid: '2893',
                cookie: '_uid=149258490; vc3=vc3;',
              }),
              expires_at: Date.now() + 3600 * 1000,
            };
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.includes('INSERT INTO execution_logs')) {
            logsOut.push({
              eventType: String(args[0] || ''),
              platform: String(args[1] || ''),
              summary: String(args[2] || ''),
              details: String(args[3] || ''),
            });
          }
          return { success: true };
        },
      });

      return {
        bind: (...args: unknown[]) => makeBound(args),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
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
}

function buildCoursesHtml(count: number): string {
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const courseId = 1000 + i;
    const classId = 2000 + i;
    items.push(
      `<li class="course" courseId="${courseId}" clazzId="${classId}" personId="9988"><span class="course-name" title="测试课程${i}">测试课程${i}</span></li>`
    );
  }
  return items.join('\n');
}

async function runTests() {
  console.log('🧪 Running rate-limit exponential backoff & canary probe tests...');

  // 1. Unit test: backoff schedule 15 -> 30 -> 60 -> 120 (cap 120)
  assert.deepStrictEqual([...RATE_LIMIT_BACKOFF_MINUTES], [15, 30, 60, 120]);
  assert.deepStrictEqual(escalateRateLimitBackoff(0), { level: 1, minutes: 15 });
  assert.deepStrictEqual(escalateRateLimitBackoff(1), { level: 2, minutes: 30 });
  assert.deepStrictEqual(escalateRateLimitBackoff(2), { level: 3, minutes: 60 });
  assert.deepStrictEqual(escalateRateLimitBackoff(3), { level: 4, minutes: 120 });
  assert.deepStrictEqual(escalateRateLimitBackoff(4), { level: 4, minutes: 120 });
  assert.deepStrictEqual(escalateRateLimitBackoff(99), { level: 4, minutes: 120 });

  const origFetch = globalThis.fetch;
  const logs: LoggedEvent[] = [];
  const mockEnv: any = {
    DB: createMockDb(logs),
    CHAOXING_PHONE: '13800000000',
    CHAOXING_PASSWORD: 'pwd',
  };

  let mobileRequestedCourseIds: string[] = [];
  let shouldRateLimitCourse = (_courseId: string, _callNum: number) => false;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/visit/courselistdata')) {
        return new Response(buildCoursesHtml(8), { status: 200 });
      }
      if (u.includes('mobilelearn.chaoxing.com') && u.includes('taskactivelist')) {
        const parsed = new URL(u);
        const courseId = parsed.searchParams.get('courseId') || '';
        mobileRequestedCourseIds.push(courseId);
        if (shouldRateLimitCourse(courseId, mobileRequestedCourseIds.length)) {
          return new Response(JSON.stringify({ result: 0, errorMsg: '请勿频繁操作' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ result: 1, activeList: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('workTestPendingNew')) {
        return new Response('[]', { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    // Use a deterministic daytime UTC+8 timestamp (14:00 UTC+8) so quiet-night throttling does not interfere
    const baseTime = Date.parse('2026-11-13T14:00:00+08:00');
    let state: SignState | undefined;

    // Cycle 1: Normal batch of 6 starts at course 0; course 2 (1002) triggers rate limit -> 15 min (L1)
    mobileRequestedCourseIds = [];
    shouldRateLimitCourse = (courseId) => courseId === '1002';
    const c1 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: baseTime,
      checkHomework: false,
      scanDiscussions: false,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c1.rateLimited, true);
    assert.strictEqual(c1.cooldownActive, true);
    assert.strictEqual(c1.canaryProbe, false);
    assert.strictEqual(c1.rateLimitBackoffLevel, 1);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1000', '1001', '1002']);
    assert.ok(state);
    assert.strictEqual(state.rateLimitBackoffLevel, 1);
    assert.strictEqual(state.rateLimitUntilMs, baseTime + 15 * 60 * 1000);
    assert.strictEqual(state.roundRobinCursor, 3);
    assert.strictEqual(logs.filter((l) => l.eventType === 'rate_limit').length, 1);

    // Cycle 2: During 15-min cooldown (+5 min) -> zero mobilelearn requests
    mobileRequestedCourseIds = [];
    const c2 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: baseTime + 5 * 60 * 1000,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c2.cooldownActive, true);
    assert.strictEqual(c2.rateLimited, false);
    assert.strictEqual(mobileRequestedCourseIds.length, 0, 'During cooldown zero mobilelearn requests must be made');
    assert.strictEqual(state!.rateLimitBackoffLevel, 1);
    assert.strictEqual(state!.rateLimitUntilMs, baseTime + 15 * 60 * 1000);

    // Cycle 3: Cooldown 1 ends (+15 min) -> Canary probe ONE course (1003), fails -> escalate to 30 min (L2)
    const t2 = baseTime + 15 * 60 * 1000;
    mobileRequestedCourseIds = [];
    shouldRateLimitCourse = () => true;
    const c3 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t2,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c3.canaryProbe, true);
    assert.strictEqual(c3.rateLimited, true);
    assert.strictEqual(c3.cooldownActive, true);
    assert.strictEqual(c3.rateLimitBackoffLevel, 2);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1003'], 'Canary probe must check only ONE course');
    assert.strictEqual(state!.rateLimitBackoffLevel, 2);
    assert.strictEqual(state!.rateLimitUntilMs, t2 + 30 * 60 * 1000);
    assert.strictEqual(state!.roundRobinCursor, 4);
    assert.strictEqual(logs.filter((l) => l.eventType === 'rate_limit').length, 2);

    // Cycle 4: During 30-min cooldown (+20 min) -> zero mobilelearn requests
    mobileRequestedCourseIds = [];
    const c4 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t2 + 20 * 60 * 1000,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c4.cooldownActive, true);
    assert.strictEqual(mobileRequestedCourseIds.length, 0);

    // Cycle 5: Cooldown 2 ends (+30 min) -> Canary probe (1004) fails -> escalate to 60 min (L3)
    const t3 = t2 + 30 * 60 * 1000;
    mobileRequestedCourseIds = [];
    const c5 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t3,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c5.canaryProbe, true);
    assert.strictEqual(c5.rateLimited, true);
    assert.strictEqual(c5.rateLimitBackoffLevel, 3);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1004']);
    assert.strictEqual(state!.rateLimitBackoffLevel, 3);
    assert.strictEqual(state!.rateLimitUntilMs, t3 + 60 * 60 * 1000);
    assert.strictEqual(state!.roundRobinCursor, 5);

    // Cycle 6: Cooldown 3 ends (+60 min) -> Canary probe (1005) fails -> escalate to 120 min (L4)
    const t4 = t3 + 60 * 60 * 1000;
    mobileRequestedCourseIds = [];
    const c6 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t4,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c6.canaryProbe, true);
    assert.strictEqual(c6.rateLimited, true);
    assert.strictEqual(c6.rateLimitBackoffLevel, 4);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1005']);
    assert.strictEqual(state!.rateLimitBackoffLevel, 4);
    assert.strictEqual(state!.rateLimitUntilMs, t4 + 120 * 60 * 1000);
    assert.strictEqual(state!.roundRobinCursor, 6);

    // Cycle 7: During 120-min cooldown (+90 min) -> zero mobilelearn requests
    mobileRequestedCourseIds = [];
    const c7 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t4 + 90 * 60 * 1000,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c7.cooldownActive, true);
    assert.strictEqual(mobileRequestedCourseIds.length, 0);

    // Cycle 8: Cooldown 4 ends (+120 min) -> Canary probe (1006) fails -> stays capped at 120 min (L4)
    const t5 = t4 + 120 * 60 * 1000;
    mobileRequestedCourseIds = [];
    const c8 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t5,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c8.canaryProbe, true);
    assert.strictEqual(c8.rateLimited, true);
    assert.strictEqual(c8.rateLimitBackoffLevel, 4);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1006']);
    assert.strictEqual(state!.rateLimitBackoffLevel, 4);
    assert.strictEqual(state!.rateLimitUntilMs, t5 + 120 * 60 * 1000);
    assert.strictEqual(state!.roundRobinCursor, 7);

    // Cycle 9: Cooldown ends (+120 min) -> Canary probe (1007) SUCCEEDS -> probes ONLY 1 course, resets level to 0
    const t6 = t5 + 120 * 60 * 1000;
    mobileRequestedCourseIds = [];
    shouldRateLimitCourse = () => false;
    const c9 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t6,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c9.canaryProbe, true);
    assert.strictEqual(c9.rateLimited, false);
    assert.strictEqual(c9.cooldownActive, false);
    assert.strictEqual(c9.rateLimitBackoffLevel, 0);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1007'], 'Canary success cycle still only probes 1 course');
    assert.strictEqual(state!.rateLimitBackoffLevel, 0);
    assert.strictEqual(state!.rateLimitUntilMs, 0);
    assert.strictEqual(state!.roundRobinCursor, 0);

    // Cycle 10: Next cycle resumes normal round-robin batch of 6 courses (1000..1005)
    mobileRequestedCourseIds = [];
    const c10 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t6 + 60 * 1000,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c10.canaryProbe, false);
    assert.strictEqual(c10.rateLimited, false);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1000', '1001', '1002', '1003', '1004', '1005']);
    assert.strictEqual(state!.roundRobinCursor, 6);

    // Cycle 11: Notification throttling preserved (< 14 min window does not emit duplicate rate_limit log)
    const logCountBefore = logs.filter((l) => l.eventType === 'rate_limit').length;
    const t7 = t6 + 20 * 60 * 1000;
    shouldRateLimitCourse = () => true;
    await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t7,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(logs.filter((l) => l.eventType === 'rate_limit').length, logCountBefore + 1);

    // Trigger again 5 min later with bypassCooldown=true -> escalates to L2, but notification throttled
    await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t7 + 5 * 60 * 1000,
      bypassCooldown: true,
      checkHomework: false,
      scanDiscussions: false,
      state,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(state!.rateLimitBackoffLevel, 2);
    assert.strictEqual(
      logs.filter((l) => l.eventType === 'rate_limit').length,
      logCountBefore + 1,
      'Notification throttling must suppress duplicate rate_limit logs within 14 minutes'
    );

    // Cycle 12: force=true without bypassCooldown after cooldown expires still probes only 1 course
    const legacyState: SignState = {
      activeActivitiesCount: 0,
      roundRobinCursor: 2,
      rateLimitUntilMs: t7, // already expired relative to t7 + 60 min
      rateLimitNotifiedAtMs: t7,
    };
    mobileRequestedCourseIds = [];
    shouldRateLimitCourse = () => true;
    const c12 = await runChaoxingInspectionCycle(mockEnv, {
      nowMs: t7 + 60 * 60 * 1000,
      force: true,
      checkHomework: false,
      scanDiscussions: false,
      state: legacyState,
      onStateUpdate: (s) => {
        state = s;
      },
    });
    assert.strictEqual(c12.canaryProbe, true);
    assert.deepStrictEqual(mobileRequestedCourseIds, ['1002']);
    assert.strictEqual(state!.rateLimitBackoffLevel, 2, 'Legacy expired state without level should escalate 1 -> 2');

    console.log('✅ All rate-limit exponential backoff & canary probe tests passed!');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
