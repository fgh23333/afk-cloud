import assert from 'node:assert/strict';
import { requiresManualAttachmentUpload } from '../packages/adapters/chaoxing/homework';
import { isEmptyShellSubjectiveQuestion } from '../packages/core/solver';
import { parseChaoxingTaskIdentifiers } from '../packages/shim/src/runner';
import { fetchNoticeList, parseCourseWorkListHtml } from '../edge/src/chaoxing';
import { hasTrackedHomeworkForCourse, mergeSyncedTaskPayload, saveNoticesWithEvents } from '../edge/src/store';

function createMockD1(initialTask?: {
  task_id: string;
  status: string;
  deadline?: string;
  payload_json?: string;
  result_summary?: string;
}) {
  const tasks = new Map<string, any>();
  const notices = new Map<string, any>();
  if (initialTask) {
    tasks.set(initialTask.task_id, { ...initialTask });
  }

  return {
    tasks,
    notices,
    prepare(sql: string) {
      let args: any[] = [];
      return {
        bind(...params: any[]) {
          args = params;
          return this;
        },
        async first<T = any>(): Promise<T | null> {
          if (sql.includes('SELECT id_code FROM notices WHERE id_code = ?')) {
            return (notices.get(args[0]) as T) || null;
          }
          if (sql.includes('SELECT status, payload_json FROM pending_tasks WHERE task_id = ?')) {
            return (tasks.get(args[0]) as T) || null;
          }
          if (sql.includes('SELECT task_id FROM pending_tasks') && sql.includes('course_id = ?')) {
            const cid = String(args[0] || '');
            const pid = String(args[1] || '');
            const hit = Array.from(tasks.values()).find(
              (r) =>
                (r.course_id === cid &&
                  ['pending', 'dispatched', 'processing', 'draft_saved', 'awaiting_approval', 'submitted'].includes(
                    r.status
                  )) ||
                r.task_id === pid
            );
            return (hit as T) || null;
          }
          return null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          if (sql.includes('SELECT task_id FROM pending_tasks')) {
            const matches = Array.from(tasks.values()).filter(
              (r) =>
                r.task_id === args[0] ||
                r.task_id.startsWith(String(args[1] || '').replace('%', '')) ||
                r.task_id === args[2] ||
                r.task_id === args[3]
            );
            return { results: matches as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO notices')) {
            notices.set(args[0], { id_code: args[0], title: args[1] });
          } else if (sql.includes('UPDATE pending_tasks') && sql.includes("SET status = 'pending'")) {
            const row = tasks.get(args[4]);
            if (row) {
              row.status = 'pending';
              if (args[0]) row.deadline = args[0];
              row.result_summary = args[1];
              row.payload_json = args[2];
              row.updated_at = args[3];
            }
          } else if (sql.includes('INSERT INTO pending_tasks')) {
            tasks.set(args[0], {
              task_id: args[0],
              status: args[6],
              deadline: args[8],
              result_summary: args[9],
              payload_json: args[10],
            });
          }
          return { success: true };
        },
      };
    },
  };
}

async function runTests() {
  console.log('\n🧪 开始运行打回重做激活与防误判测验守卫测试...\n');

  // Test 1: parseChaoxingTaskIdentifiers 不得将 notice-work / workOrExam=work 误判为 exam
  const workParsed = parseChaoxingTaskIdentifiers({
    jobId: 'chaoxing-notice-work-58496166-158750280',
    taskUrl:
      'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=58496166&courseId=268784887&classId=158750280&workOrExam=work&enc=53067f',
  });
  assert.strictEqual(workParsed.isExam, false, 'workOrExam=work 的 notice-work 绝不能被判为 isExam');
  assert.strictEqual(workParsed.workId, '58496166');
  assert.strictEqual(workParsed.courseId, '268784887');

  const examParsed = parseChaoxingTaskIdentifiers({
    jobId: 'chaoxing-notice-exam-11193458-154651310',
    taskUrl: 'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=11193458&workOrExam=exam',
  });
  assert.strictEqual(examParsed.isExam, true, 'chaoxing-notice-exam 应准确识别为 isExam');
  console.log(' ✅ [Test 1/3 PASS] parseChaoxingTaskIdentifiers 准确区分真作业与测验');

  // Test 2: requiresManualAttachmentUpload 识别上传源程序与截图作业
  assert.strictEqual(
    requiresManualAttachmentUpload([{ title: '1 请上传源程序及结果截图。' }]),
    true,
    '纯上传源程序及结果截图题目应识别为人工附件作业'
  );
  assert.strictEqual(
    requiresManualAttachmentUpload([{ title: '1 下列哪项是单选题目？', options: ['A', 'B'] }]),
    false,
    '常规客观题不应被误判为纯附件作业'
  );
  console.log(' ✅ [Test 2/3 PASS] requiresManualAttachmentUpload 准确识别人工上传附件类作业');

  // Test 3: 「作业打回通知」自动重开已 submitted 任务且同 idCode 不重复重开
  const taskId = 'chaoxing-notice-work-58366567-154101446';
  const db = createMockD1({
    task_id: taskId,
    status: 'submitted',
    deadline: '2026/11/19 16:05:04',
    payload_json: JSON.stringify({ type: 'homework_notice', idCode: 'OLD_NOTICE_1' }),
    result_summary: '已正式提交',
  });

  const returnedNotice = {
    idCode: 'RETURN_NOTICE_1',
    title: '作业打回通知',
    createrName: '学习通知',
    sendTime: '2026-11-18 19:41:26',
    content: '课程名称：LabVIEW编程及应用 作业名称：上机练习-不同类型函数的综合应用 作业形式：打回重做',
    workInfo: {
      workId: '58366567',
      title: '上机练习-不同类型函数的综合应用',
      courseId: '266874983',
      courseName: 'LabVIEW编程及应用',
      classId: '154101446',
      url: 'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=58366567&workOrExam=work',
      startTime: '2026-11-12 16:04',
      endTime: '2026-11-19 16:05',
      isReturned: true,
    },
  };

  const firstRun = await saveNoticesWithEvents({ DB: db as any }, [returnedNotice]);
  assert.strictEqual(firstRun.reopenedTasks.length, 1, '首次收到打回通知应重新激活为 pending');
  assert.strictEqual(db.tasks.get(taskId).status, 'pending');

  // 模拟学生重新提交后再次轮询到同一条历史打回通知 -> 不可再次重开
  db.tasks.get(taskId).status = 'submitted';
  const secondRun = await saveNoticesWithEvents({ DB: db as any }, [returnedNotice]);
  assert.strictEqual(secondRun.reopenedTasks.length, 0, '已处理过的同 idCode 打回通知不得反复重开');
  assert.strictEqual(db.tasks.get(taskId).status, 'submitted');

  // 模拟老师再次打回（新 idCode）-> 再次激活
  const thirdRun = await saveNoticesWithEvents(
    { DB: db as any },
    [{ ...returnedNotice, idCode: 'RETURN_NOTICE_2', sendTime: '2026-11-19 09:00:00' }]
  );
  assert.strictEqual(thirdRun.reopenedTasks.length, 1, '全新 idCode 打回通知应再次激活任务');
  assert.strictEqual(db.tasks.get(taskId).status, 'pending');
  console.log(' ✅ [Test 3/3 PASS] 打回重做通知自动激活与幂等去重逻辑通过');

  // Test 4: 无 workId 红点占位任务 chaoxing-hw-${courseId}-${classId} 解析时不误把 courseId 当作 workId
  const placeholderParsed = parseChaoxingTaskIdentifiers({
    jobId: 'chaoxing-hw-268784887-158750280',
    taskUrl: 'https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=268784887&classId=158750280&cpi=&workId=',
  });
  assert.strictEqual(placeholderParsed.courseId, '268784887');
  assert.strictEqual(placeholderParsed.classId, '158750280');
  assert.strictEqual(
    placeholderParsed.workId,
    '',
    'chaoxing-hw-courseId-classId 占位任务的 workId 必须保持为空以触发 list.find(w => w.isPending)'
  );
  console.log(' ✅ [Test 4/6 PASS] 红点占位任务 chaoxing-hw-courseId-classId 绝不误把 courseId 解析为 workId');

  // Test 5: 已截止的历史作业通知（含历史打回通知）不重新入队或触发重做提醒，且 hasTrackedHomeworkForCourse 识别已提交/占位任务
  const expiredNotice = {
    idCode: 'EXPIRED_RETURN_NOTICE_99',
    title: '作业打回通知',
    createrName: '学习通知',
    sendTime: '2026-10-10 10:00:00',
    content: '已截止旧作业打回重做',
    workInfo: {
      workId: '58366567',
      title: '上机练习-不同类型函数的综合应用',
      courseId: '266874983',
      courseName: 'LabVIEW编程及应用',
      classId: '154101446',
      url: 'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=58366567&workOrExam=work',
      startTime: '2026-10-01 08:00',
      endTime: '2026-10-15 23:59',
      isExpired: true,
      isReturned: true,
    },
  };
  db.tasks.get(taskId).status = 'submitted';
  const expiredRun = await saveNoticesWithEvents({ DB: db as any }, [expiredNotice]);
  assert.strictEqual(expiredRun.reopenedTasks.length, 0, '已截止(isExpired=true)的旧打回通知绝不可重新激活任务或发通知');
  assert.strictEqual(db.tasks.get(taskId).status, 'submitted');

  db.tasks.get(taskId).course_id = '266874983';
  const trackedByCourse = await hasTrackedHomeworkForCourse({ DB: db as any }, '266874983', '154101446');
  assert.strictEqual(trackedByCourse, true, '已存在 submitted 作业的课程应被视为已跟踪，不再重复入队红点占位任务');
  console.log(' ✅ [Test 5/6 PASS] 已截止作业通知防刷屏拦截与课程红点去重验证通过');

  // Test 6: 空壳短题干主观题前置守卫（拦截无正文/无附件/无讲义的空壳题干，放行含讲义或缓存附件的题目）
  assert.strictEqual(
    isEmptyShellSubjectiveQuestion({ id: '1', type: 'essay', typeName: '简答题', title: '1. （100.0分）\n[附件: 实验1.doc (https://p.ananas.chaoxing.com/a.doc)]' }, ''),
    true,
    '仅含题号且未缓存附件正文的空壳主观题应被前置拦截'
  );
  assert.strictEqual(
    isEmptyShellSubjectiveQuestion(
      {
        id: '1',
        type: 'essay',
        typeName: '简答题',
        title: '1. （100.0分）\n[附件: 实验1.doc (https://p.ananas.chaoxing.com/a.doc | 本地已缓存: /tmp/att_1.doc | 附件摘要: 顺序表的基本操作实验要求实现插入与删除算法)]',
      },
      ''
    ),
    false,
    '已预下载缓存附件摘要的题目必须放行进入 Pro 求解'
  );
  console.log(' ✅ [Test 6/7 PASS] 空壳主观题前置守卫与附件摘要放行测试通过');

  // Test 7: shim /api/tasks/sync 覆盖 payload 时必须保留打回通知去重清单，防止同一旧打回通知被反复重新激活并重复推送
  const merged = JSON.parse(
    mergeSyncedTaskPayload(
      JSON.stringify({ returnedNoticeIds: ['N1', 'N2'], lastReturnedNoticeIdCode: 'N2', url: 'u' }),
      { workId: '58366567', status: 'submitted' }
    )
  );
  assert.deepStrictEqual(merged.returnedNoticeIds, ['N1', 'N2'], 'sync 覆盖 payload 后 returnedNoticeIds 必须保留');
  assert.strictEqual(merged.lastReturnedNoticeIdCode, 'N2');
  assert.strictEqual(merged.status, 'submitted', '同步上来的新字段仍应生效');
  const mergedFresh = JSON.parse(mergeSyncedTaskPayload(null, { workId: '1' }));
  assert.strictEqual(mergedFresh.returnedNoticeIds, undefined);
  assert.doesNotThrow(() => mergeSyncedTaskPayload('not-json{', { a: 1 }));
  console.log(' ✅ [Test 7/9 PASS] tasks/sync 合并 payload 保留打回通知去重清单');

  // Test 8: parseCourseWorkListHtml 零 JSDOM 解析网页端 getAllWork 列表
  const sampleWorkHtml = `
    <ul>
      <li>
        <div class="titTxt" data="0">
          <p class="clearfix">
            <a href="javascript:void(0);" class="inspectTask" data="58496166" data2="55677561" data3="0" title="微分方程作业笔记">微分方程作业笔记</a>
          </p>
          <span class="pt5"><span class="fl">开始时间：</span>2026-11-15 14:42</span>
          <span class="pt5"><span class="fl">截止时间：</span>2026-11-23 15:42</span>
          <span class="pt5"><span class="fl">作业状态：</span><strong> 待做 </strong></span>
        </div>
      </li>
      <li class="lookLi">
        <div class="titTxt" data="0">
          <p><a href="/mooc-ans/work/selectWorkQuestionYiPiYue?workId=58464301&workAnswerId=55674098" title="常微分方程作业习题">常微分方程作业习题</a></p>
          <span>开始时间：2026-11-14 09:54</span>
          <span>截止时间：2026-11-18 10:54</span>
          <span>作业状态：<strong> 待批阅 </strong></span>
        </div>
      </li>
      <li>
        <div class="titTxt" data="0">
          <p><a class="inspectTask" data="58366567" data2="100" data3="0" title="过期实验">过期实验</a></p>
          <span>截止时间：2026-11-19 16:05</span>
          <span>作业状态：<strong> 已过期 </strong></span>
        </div>
      </li>
      <li>
        <div class="titTxt" data="0">
          <p><a class="inspectTask" data="58999001" data2="200" data3="4" title="重新编辑作业">重新编辑作业</a></p>
          <span>截止时间：2026-11-28 23:59</span>
          <span>作业状态：<strong> 重新编辑 </strong></span>
        </div>
      </li>
    </ul>
  `;
  const nowTest8 = Date.parse('2026-11-21T20:00:00+08:00');
  const parsedWorks = parseCourseWorkListHtml(
    sampleWorkHtml,
    { courseId: '268784887', classId: '158750280', courseName: '高等数学(二)', cpi: '340100029' },
    nowTest8
  );
  assert.strictEqual(parsedWorks.length, 4);
  assert.strictEqual(parsedWorks[0].workId, '58496166');
  assert.strictEqual(parsedWorks[0].isPending, true);
  assert.strictEqual(parsedWorks[0].isExpired, false);
  assert.strictEqual(parsedWorks[0].isDone, false);
  assert.strictEqual(parsedWorks[1].workId, '58464301');
  assert.strictEqual(parsedWorks[1].isDone, true);
  assert.strictEqual(parsedWorks[1].isPending, false);
  assert.strictEqual(parsedWorks[2].workId, '58366567');
  assert.strictEqual(parsedWorks[2].isExpired, true);
  assert.strictEqual(parsedWorks[2].isPending, false);
  assert.strictEqual(parsedWorks[3].workId, '58999001');
  assert.strictEqual(parsedWorks[3].isPending, true);
  console.log(' ✅ [Test 8/9 PASS] parseCourseWorkListHtml 零 JSDOM 解析待做/待批阅/已过期/重编辑作业通过');

  // Test 9: fetchNoticeList 解析 att_subject 随堂活动通知 + saveNoticesWithEvents 仅对首次见到的 48h 内新通知发出告警
  const origFetch = globalThis.fetch;
  try {
    const nowTest9 = Date.parse('2026-11-21T16:00:00+08:00');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          notices: {
            list: [
              {
                idCode: 'SUBJ_ACT_01',
                title: '活动结束提醒',
                createrName: '学习通',
                sendTime: '2026-11-21 15:50:00',
                content: '课程名称：LabVIEW编程及应用\n活动名称：随堂练习-章节4\n还有10分钟就要结束，请尽快作答!',
                attachment: JSON.stringify([
                  {
                    attachmentType: 3,
                    att_subject: {
                      subjectTitle: '随堂练习-章节4',
                      subjectLink: 'https://mobilelearn.chaoxing.com/widget/quiz/proxyTestAttendUrl?activeId=8000180082238',
                    },
                  },
                ]),
              },
              {
                idCode: 'OLD_ACT_02',
                title: '活动结束提醒',
                createrName: '学习通',
                sendTime: '2026-11-10 10:00:00',
                content: '课程名称：LabVIEW编程及应用\n活动名称：旧随堂练习',
              },
              {
                idCode: 'EXP_WORK_03',
                title: '过期作业提醒',
                createrName: '学习通',
                sendTime: '2026-11-21 15:00:00',
                content: '课程名称：物理\r作业名称：旧作业\r结束时间：2026-11-18 12:00',
                attachment: JSON.stringify([
                  {
                    attachmentType: 25,
                    att_web: {
                      examOrWork: 'work',
                      examOrWorkId: 999888,
                      courseId: 11,
                      clazzId: 22,
                      title: '旧作业',
                      url: 'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=999888',
                    },
                  },
                ]),
              },
            ],
          },
        }),
        { status: 200 }
      )) as typeof fetch;

    const fetched = await fetchNoticeList(
      { _uid: '1', _d: 'd', vc3: 'v', uf: 'u', fid: '2', cookie: '_uid=1;' },
      10
    );
    assert.strictEqual(fetched.length, 3);
    assert.ok(fetched[0].activityInfo, '必须解析 att_subject 为 activityInfo');
    assert.strictEqual(fetched[0].activityInfo?.activeId, '8000180082238');
    assert.strictEqual(fetched[0].activityInfo?.courseName, 'LabVIEW编程及应用');

    const res1 = await saveNoticesWithEvents({ DB: db as any }, fetched, nowTest9);
    assert.strictEqual(res1.newNotices.length, 1, '仅 48h 内未过期的新随堂活动通知应触发告警');
    assert.strictEqual(res1.newNotices[0].kind, 'activity');
    assert.strictEqual(res1.newNotices[0].idCode, 'SUBJ_ACT_01');

    const res2 = await saveNoticesWithEvents({ DB: db as any }, fetched, nowTest9 + 60_000);
    assert.strictEqual(res2.newNotices.length, 0, '同一 idCode 再次抓取不得重复告警');
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log(' ✅ [Test 9/9 PASS] att_subject 活动通知解析与 48h 新通知去重告警验证通过');

  // Test 10: Telegram Markdown 400 自动降级纯文本 + 教室上课通知防漏推 + 同 workId 作业防重复推送
  {
    const { sendNotification } = await import('../edge/src/notify');
    const tgPayloads: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      tgPayloads.push(body);
      if (body.parse_mode === 'Markdown') {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "can't parse entities" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await sendNotification('测试通知', '课程：《课程_267082295》请尽快处理', {
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_CHAT_ID: '999',
      });
      assert.strictEqual(tgPayloads.length, 2, 'Markdown 400 时必须自动降级纯文本重发');
      assert.strictEqual(tgPayloads[0].parse_mode, 'Markdown');
      assert.strictEqual(tgPayloads[1].parse_mode, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }

    const { saveNoticesWithEvents, upsertPendingTaskWithOutcome } = await import('../edge/src/store');
    const insertedNotices = new Set<string>();
    const pendingTasks = new Map<string, { status: string; payload_json?: string }>();
    const db2 = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes('FROM notices WHERE id_code')) {
              return insertedNotices.has(String(args[0])) ? { id_code: args[0] } : null;
            }
            if (sql.includes('FROM pending_tasks WHERE task_id')) {
              return pendingTasks.get(String(args[0])) || null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes('INSERT INTO notices')) insertedNotices.add(String(args[0]));
            if (sql.includes('INSERT INTO pending_tasks')) {
              pendingTasks.set(String(args[0]), { status: String(args[6] || 'pending'), payload_json: String(args[10] || '{}') });
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    };

    const now10 = Date.now();
    // 网页端先扫到作业 777
    await upsertPendingTaskWithOutcome(
      { DB: db2 as any },
      {
        taskId: 'chaoxing-notice-work-777-888',
        platform: 'chaoxing',
        courseId: '111',
        classId: '888',
        courseName: '数字图像处理',
        title: '实验报告1',
      }
    );

    const outcome10 = await saveNoticesWithEvents(
      { DB: db2 as any },
      [
        {
          idCode: 'CLS_NOTICE_1',
          title: '《数字图像处理》请大家速来教室1207上课',
          createrName: '老师',
          sendTime: new Date(now10 - 60_000).toISOString(),
          content: '请大家速来教室1207上课',
        },
        {
          idCode: 'WORK_NOTICE_777',
          title: '作业: 实验报告1',
          createrName: '老师',
          sendTime: new Date(now10 - 30_000).toISOString(),
          content: '课程名称：数字图像处理 作业名称：实验报告1',
          workInfo: {
            workId: '777',
            title: '实验报告1',
            courseId: '111',
            courseName: '数字图像处理',
            classId: '888',
            url: 'https://mooc1.chaoxing.com/work',
            startTime: '',
            endTime: '2099-01-01 00:00',
            isExpired: false,
          },
        },
      ],
      now10
    );
    assert.strictEqual(outcome10.newNotices.length, 1, '应推送教室上课通知并跳过已由网页端建档的重复作业通知');
    assert.strictEqual(outcome10.newNotices[0].idCode, 'CLS_NOTICE_1');
    assert.strictEqual(outcome10.newNotices[0].kind, 'important');
    console.log(' ✅ [Test 10/10 PASS] Telegram 400 降级重发、教室通知防漏推与同 workId 去重验证通过');
  }

  console.log('\n🎉 全部 10 项打回重做、网页作业扫描与新通知守卫测试 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
