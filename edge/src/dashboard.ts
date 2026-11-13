import { EdgeEnv, listDiscussions, nowUtc8 } from './store';
import { extractInfoFromContent, parseTimeToMs } from './chaoxing';

export interface DashboardData {
  time: string;
  lastSync?: string;
  daemonStatus?: string;
  stats: {
    pendingCount: number;
    dispatchedCount?: number;
    submittingCount?: number;
    draftCount: number;
    submittedCount: number;
    failedCount: number;
    signinCount: number;
    questionBankCount: number;
    discussionPendingCount?: number;
    discussionDraftCount?: number;
    discussionSubmittedCount?: number;
  };
  sessions: Array<{
    platform: string;
    account: string;
    expires_at: number;
    updated_at: string;
    valid: boolean;
  }>;
  tasks: Array<{
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
    updated_at: string;
    payload_json?: string;
  }>;
  homeworks?: Array<{
    taskId: string;
    title: string;
    courseName: string;
    courseId?: string;
    classId?: string;
    endDate: string;
    isPending: boolean;
    status: string;
    statusLabel?: string;
    platform: string;
    computeTier: string;
    resultSummary: string;
    aiSolved: boolean;
    url?: string;
    directUrl?: string;
    noticeUrl?: string;
    courseUrl?: string;
  }>;
  exams?: Array<{
    examId?: string;
    title: string;
    courseName: string;
    startTime: string;
    endTime: string;
    isExpired: boolean;
    url?: string;
  }>;
  notices?: Array<{
    title: string;
    createrName: string;
    sendTime: string;
    content: string;
  }>;
  signinHistory?: Array<{
    time: string;
    courseName: string;
    type: string;
    address: string;
    result: string;
  }>;
  courses?: Array<{
    courseName: string;
    courseId: string;
    classId: string;
    cpi?: string;
    teacherName?: string;
  }>;
  discussions?: Array<{
    discussionId: string;
    topicId: string;
    courseId: string;
    classId: string;
    courseName: string;
    author: string;
    title: string;
    prompt: string;
    chapterLabel: string;
    topicUrl: string;
    bbsUrl: string;
    status: string;
    draftReply: string;
    postedReply: string;
    modelUsed: string;
    replyCount: number;
    publishedAt: string;
    updatedAt: string;
  }>;
  logs: Array<{
    id: number;
    event_type: string;
    platform: string;
    summary: string;
    created_at: string;
  }>;
}

/**
 * 从 Cloudflare D1 聚合查询看板所需的全量状态数据（0 云主机开销，直接走 D1 免费读配额）
 */
export async function getDashboardData(env: EdgeEnv): Promise<DashboardData> {
  const currentTime = nowUtc8();
  const empty: DashboardData = {
    time: currentTime,
    lastSync: currentTime,
    daemonStatus: 'ONLINE',
    stats: {
      pendingCount: 0,
      dispatchedCount: 0,
      submittingCount: 0,
      draftCount: 0,
      submittedCount: 0,
      failedCount: 0,
      signinCount: 0,
      questionBankCount: 0,
      discussionPendingCount: 0,
      discussionDraftCount: 0,
      discussionSubmittedCount: 0,
    },
    sessions: [],
    tasks: [],
    homeworks: [],
    exams: [],
    notices: [],
    signinHistory: [],
    courses: [],
    discussions: [],
    logs: [],
  };

  if (!env.DB) return empty;

  try {
    const [tasksRes, logsRes, sessionsRes, qbRes, signinRes, noticesRes, enrolledCoursesRes, signinLogsRes] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM pending_tasks ORDER BY updated_at DESC LIMIT 100'),
      env.DB.prepare('SELECT id, event_type, platform, summary, created_at FROM execution_logs ORDER BY id DESC LIMIT 50'),
      env.DB.prepare('SELECT platform, account, expires_at, updated_at FROM sessions ORDER BY updated_at DESC'),
      env.DB.prepare('SELECT COUNT(*) as cnt FROM question_bank'),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM execution_logs WHERE event_type IN ('signin', 'sign_success')"),
      env.DB.prepare('SELECT id_code, title, creater_name, send_time, content, tag, source_type, raw_json FROM notices ORDER BY send_time DESC LIMIT 30'),
      env.DB.prepare('SELECT course_id, class_id, course_name, cpi, teacher_name FROM enrolled_courses ORDER BY course_name ASC'),
      env.DB.prepare("SELECT id, event_type, platform, summary, detail_json, created_at FROM execution_logs WHERE (event_type IN ('signin', 'sign_success', 'sign_fail') OR event_type = 'sign_missed') ORDER BY id DESC LIMIT 60"),
    ]);

    const tasks = (tasksRes.results || []) as DashboardData['tasks'];
    const logs = (logsRes.results || []) as DashboardData['logs'];
    const signinLogs = ((signinLogsRes?.results || []) as DashboardData['logs']);
    const rawNotices = (noticesRes?.results || []) as Array<any>;
    const now = Date.now();
    const sessions = ((sessionsRes.results || []) as Array<any>).map((s) => ({
      platform: s.platform,
      account: s.account ? String(s.account).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : 'default',
      expires_at: Number(s.expires_at),
      updated_at: s.updated_at,
      valid: Number(s.expires_at) > now,
    }));

    const qbCount = Number((qbRes.results?.[0] as any)?.cnt || 0);
    const signinCount = Number((signinRes.results?.[0] as any)?.cnt || 0);

    let pendingCount = 0;
    let dispatchedCount = 0;
    let submittingCount = 0;
    let draftCount = 0;
    let submittedCount = 0;
    let failedCount = 0;

    type HomeworkItem = NonNullable<DashboardData['homeworks']>[number];
    const homeworkMap = new Map<string, HomeworkItem>();
    const courseMap = new Map<
      string,
      { courseName: string; courseId: string; classId: string; cpi?: string; teacherName?: string }
    >();

    const getStatusPriority = (status: string): number => {
      switch (status) {
        case 'submitted':
          return 7;
        case 'submitting':
          return 6;
        case 'draft_saved':
          return 5;
        case 'awaiting_approval':
          return 4;
        case 'processing':
          return 3;
        case 'dispatched':
          return 2;
        case 'failed':
          return 1;
        default:
          return 0;
      }
    };

    const isRealDeadline = (d?: string): boolean =>
      Boolean(d && !['无截止限制', '无截止时间', '近期', '无', '未设置'].includes(d.trim()));
    const isRealCourseName = (c?: string): boolean =>
      Boolean(c && c.trim() !== '' && c !== '未命名课程' && c !== '未知课程');

    for (const t of tasks) {
      let statusLabel = '未派发';
      if (t.status === 'dispatched' || t.status === 'processing') {
        statusLabel = '已派发';
      } else if (t.status === 'draft_saved' || t.status === 'awaiting_approval') {
        statusLabel = '做完暂存';
      } else if (t.status === 'submitting') {
        statusLabel = '正式提交中';
      } else if (t.status === 'submitted') {
        statusLabel = '已提交';
      } else if (t.status === 'failed') {
        statusLabel = '求解失败';
      }

      const isPending = t.status === 'pending';

      let directUrl = '';
      let noticeUrl = '';
      let payloadWorkId = '';

      if (t.payload_json) {
        try {
          const parsed = JSON.parse(t.payload_json);
          if (parsed.url) directUrl = parsed.url;
          if (parsed.idCode) {
            noticeUrl = `https://notice.chaoxing.com/pc/notice/${parsed.idCode}/detail`;
          }
          if (parsed.workId) payloadWorkId = String(parsed.workId);
        } catch {
          // ignore
        }
      }

      // 兜底提取 workId（统一兼容 chaoxing-notice-work-<workId>-<classId> 与 chaoxing-hw-<workId>）
      const workIdMatch =
        t.task_id.match(/^chaoxing-(?:notice-)?work-(\d+)/) ||
        t.task_id.match(/^chaoxing-hw-(\d+)$/);
      const rawWorkId = workIdMatch ? workIdMatch[1] : payloadWorkId;
      if (!directUrl && rawWorkId && t.course_id && t.class_id) {
        directUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${t.course_id}&classId=${t.class_id}&cpi=&workId=${rawWorkId}`;
      }

      const courseUrl = t.course_id && t.class_id
        ? `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${t.course_id}&clazzid=${t.class_id}&vc=1`
        : '';

      // 核心免 403 路由铁律：
      // 1. 若有 noticeUrl，优先指向官方通知卡片入口。用户在浏览器点击即可带齐合法签名和 Cookie 答题，绝对不会触发 403 跨域盗链防护。
      // 2. 若无通知入口，回退到 directUrl (intoexamorwork / dowork 链接)。
      // 3. 若无直接作业链接，回退到超星课程学生空间 courseUrl。
      const primaryUrl = noticeUrl || directUrl || courseUrl;
      const candidate: HomeworkItem = {
        taskId: t.task_id,
        title: t.title,
        courseName: t.course_name || '未命名课程',
        courseId: t.course_id,
        classId: t.class_id,
        endDate: t.deadline || '无截止限制',
        isPending,
        status: t.status,
        statusLabel,
        platform: t.platform || 'chaoxing',
        computeTier: t.compute_tier || 'tier1-cloud-run',
        resultSummary: t.result_summary || '',
        aiSolved: t.status === 'draft_saved' || t.status === 'submitting' || t.status === 'submitted',
        url: primaryUrl,
        directUrl,
        noticeUrl,
        courseUrl,
      };

      const dedupKey = rawWorkId ? `work_${rawWorkId}` : t.task_id;
      const existing = homeworkMap.get(dedupKey);
      if (!existing) {
        homeworkMap.set(dedupKey, candidate);
      } else {
        const existingRank = getStatusPriority(existing.status);
        const candidateRank = getStatusPriority(candidate.status);
        const winner = candidateRank > existingRank ? candidate : existing;
        const loser = candidateRank > existingRank ? existing : candidate;

        const mergedNoticeUrl = existing.noticeUrl || candidate.noticeUrl || '';
        const mergedDirectUrl = existing.directUrl || candidate.directUrl || '';
        const mergedCourseUrl = existing.courseUrl || candidate.courseUrl || '';
        const preferredTaskId = existing.taskId.startsWith('chaoxing-notice-work-')
          ? existing.taskId
          : candidate.taskId.startsWith('chaoxing-notice-work-')
            ? candidate.taskId
            : winner.taskId;

        const mergedEndDate = isRealDeadline(winner.endDate)
          ? winner.endDate
          : isRealDeadline(loser.endDate)
            ? loser.endDate
            : winner.endDate;

        const mergedCourseName = isRealCourseName(existing.courseName)
          ? existing.courseName
          : isRealCourseName(candidate.courseName)
            ? candidate.courseName
            : winner.courseName;

        homeworkMap.set(dedupKey, {
          ...winner,
          taskId: preferredTaskId,
          title: winner.title || loser.title,
          courseName: mergedCourseName,
          courseId: existing.courseId || candidate.courseId,
          classId: existing.classId || candidate.classId,
          endDate: mergedEndDate,
          resultSummary: winner.resultSummary || loser.resultSummary || '',
          noticeUrl: mergedNoticeUrl,
          directUrl: mergedDirectUrl,
          courseUrl: mergedCourseUrl,
          url: mergedNoticeUrl || mergedDirectUrl || mergedCourseUrl,
        });
      }

      if (t.course_id && t.course_name && !courseMap.has(t.course_id)) {
        courseMap.set(t.course_id, {
          courseName: t.course_name,
          courseId: t.course_id,
          classId: t.class_id,
        });
      }
    }

    const homeworks: NonNullable<DashboardData['homeworks']> = Array.from(homeworkMap.values());
    for (const hw of homeworks) {
      if (hw.status === 'dispatched' || hw.status === 'processing') {
        dispatchedCount++;
      } else if (hw.status === 'draft_saved' || hw.status === 'awaiting_approval') {
        draftCount++;
      } else if (hw.status === 'submitting') {
        submittingCount++;
      } else if (hw.status === 'submitted') {
        submittedCount++;
      } else if (hw.status === 'failed') {
        failedCount++;
      } else {
        pendingCount++;
      }
    }

    const enrolledCourses = (enrolledCoursesRes?.results || []) as Array<any>;
    for (const ec of enrolledCourses) {
      if (ec.course_id) {
        courseMap.set(ec.course_id, {
          courseName: ec.course_name,
          courseId: ec.course_id,
          classId: ec.class_id,
          cpi: ec.cpi || '',
          teacherName: ec.teacher_name || '',
        });
      }
    }

    const signinMap = new Map<
      string,
      {
        rank: number;
        id: number;
        ms: number;
        item: NonNullable<DashboardData['signinHistory']>[number];
      }
    >();
    const notices: NonNullable<DashboardData['notices']> = [];
    const exams: NonNullable<DashboardData['exams']> = [];

    for (const log of signinLogs as Array<any>) {
      let detail: any = null;
      if (log.detail_json) {
        try {
          detail = JSON.parse(log.detail_json);
        } catch {
          detail = null;
        }
      }
      const summary = String(log.summary || '');
      const isSuccess =
        log.event_type === 'sign_success' ||
        (log.event_type === 'signin' && !summary.includes('异常') && !summary.includes('失败')) ||
        summary.includes('成功') ||
        summary.includes('已签');
      const isMissed =
        !isSuccess &&
        (log.event_type === 'sign_missed' || summary.includes('已截止未签到') || summary.includes('已结束'));
      const rank = isSuccess ? 3 : isMissed ? 2 : 1;
      const resultText = isSuccess ? '签到成功' : isMissed ? '已截止未签到' : '签到异常';

      const courseMatch = summary.match(/《(.*?)》/);
      const courseName = courseMatch ? courseMatch[1] : summary.split(':')[0] || '在线课程';
      const typeMatch = summary.match(/\[([^\]]*签到[^\]]*)\]/);
      const signTypeRaw = detail?.signType
        ? String(detail.signType)
        : summary.includes('位置')
          ? '位置签到'
          : summary.includes('拍照')
            ? '拍照签到'
            : summary.includes('手势')
              ? '手势签到'
              : summary.includes('签到码')
                ? '签到码签到'
                : summary.includes('二维码')
                  ? '二维码签到'
                  : typeMatch
                    ? typeMatch[1]
                    : '通用签到';
      const actName = detail?.actName
        ? String(detail.actName)
        : summary.match(/《[^》]*》\[([^\]]+)\]/)?.[1] || '';
      const signType = actName && actName !== signTypeRaw && !actName.includes(signTypeRaw)
        ? `${signTypeRaw} · ${actName}`
        : signTypeRaw;

      const parenMatch = summary.match(/\(([^()]{1,80})\)\s*$/);
      const parsedParen = parenMatch && !parenMatch[1].startsWith('ID:') ? parenMatch[1].trim() : '';
      const address =
        (detail?.address ? String(detail.address) : '') ||
        parsedParen ||
        (isSuccess ? '学习通自动打卡' : isMissed ? '已过截止时间' : '未匹配/等待凭证');

      const activeId = detail?.activeId
        ? String(detail.activeId)
        : summary.match(/\bID:\s*(\d{5,})\b/)?.[1] || '';
      const dedupKey = activeId ? `act_${activeId}` : `log_${log.id}`;
      const tsMs = parseTimeToMs(log.created_at) || 0;

      const prev = signinMap.get(dedupKey);
      if (!prev || rank > prev.rank || (rank === prev.rank && Number(log.id || 0) > prev.id)) {
        signinMap.set(dedupKey, {
          rank,
          id: Number(log.id || 0),
          ms: tsMs,
          item: {
            time: log.created_at,
            courseName,
            type: signType,
            address,
            result: resultText,
          },
        });
      }
    }

    const hasHistorySyncRow = (signinLogs as Array<any>).some((l) => {
      if (l.event_type === 'sign_missed') return true;
      if (typeof l.detail_json === 'string' && l.detail_json.includes('history_sync')) return true;
      return String(l.summary || '').includes('[历史同步]');
    });

    const signinEntries = Array.from(signinMap.values());
    if (hasHistorySyncRow) {
      signinEntries.sort((a, b) => (b.ms !== a.ms ? b.ms - a.ms : b.id - a.id));
    }
    const signinHistory: NonNullable<DashboardData['signinHistory']> = signinEntries.map((entry) => entry.item);

    const examMap = new Map<string, any>();

    for (const n of rawNotices) {
      notices.push({
        title: n.title,
        createrName: n.creater_name,
        sendTime: n.send_time,
        content: n.content,
      });

      if (n.raw_json) {
        try {
          const parsed = JSON.parse(n.raw_json);
          if (parsed.examInfo) {
            const raw = parsed.examInfo;
            const examId = String(raw.examId || '');
            let title = raw.title || '在线评测';
            let courseName = raw.courseName || '';
            let startTime = raw.startTime || '';
            let endTime = raw.endTime || '';
            const url = raw.url || '';
            const courseId = String(raw.courseId || '');

            const refYear = n.send_time ? new Date(n.send_time).getFullYear() : new Date().getFullYear();
            const extracted = extractInfoFromContent(n.content, refYear);

            // 补全截止时间
            if (!endTime || endTime === '无截止时间' || endTime === '无') {
              if (extracted.endTime) {
                endTime = extracted.endTime;
              }
            }
            if (endTime && !/^\d{4}/.test(endTime) && refYear) {
              const clean = endTime.replace(/年|月/g, '/').replace(/日|号/g, '').replace(/-/g, '/');
              endTime = `${refYear}/${clean}`;
            }

            // 补全开始时间
            if (!startTime || startTime === '近期') {
              if (extracted.startTime) {
                startTime = extracted.startTime;
              }
            }
            if (startTime && !/^\d{4}/.test(startTime) && refYear) {
              const clean = startTime.replace(/年|月/g, '/').replace(/日|号/g, '').replace(/-/g, '/');
              startTime = `${refYear}/${clean}`;
            }

            // 补全课程名称（优先课程映射表与正则提取）
            if (!courseName || courseName.startsWith('课程_') || courseName === '在线课程') {
              if (courseId && courseMap.has(courseId)) {
                courseName = courseMap.get(courseId)!.courseName;
              } else if (extracted.courseName) {
                courseName = extracted.courseName;
              }
            }

            if ((!title || title === '在线评测') && extracted.examName) {
              title = extracted.examName;
            }

            // 核心：基于现实当前时间（UTC+8）动态判定是否过期
            const endMs = parseTimeToMs(endTime, refYear);
            const isExpired = endMs !== null ? endMs < Date.now() : !!raw.isExpired;

            const examKey = examId ? `id_${examId}` : `title_${title}`;
            const existing = examMap.get(examKey);
            if (!existing) {
              examMap.set(examKey, {
                examId,
                title,
                courseName,
                startTime: startTime || '近期',
                endTime: endTime || '无截止时间',
                isExpired,
                url,
                endMs: endMs || 0,
              });
            } else {
              // 合并同一考试的多条通知数据，保留最完整信息
              if ((!existing.endTime || existing.endTime === '无截止时间') && endTime && endTime !== '无截止时间') {
                existing.endTime = endTime;
                existing.endMs = endMs || 0;
              }
              if ((!existing.courseName || existing.courseName.startsWith('课程_')) && courseName && !courseName.startsWith('课程_')) {
                existing.courseName = courseName;
              }
              if ((!existing.startTime || existing.startTime === '近期') && startTime && startTime !== '近期') {
                existing.startTime = startTime;
              }
              if (!existing.url && url) {
                existing.url = url;
              }
              if (isExpired) {
                existing.isExpired = true;
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const allExams = Array.from(examMap.values());
    allExams.sort((a, b) => {
      if (a.isExpired !== b.isExpired) {
        return a.isExpired ? 1 : -1;
      }
      return (b.endMs || 0) - (a.endMs || 0);
    });
    exams.push(...allExams.map(({ endMs, ...rest }) => rest));

    // 若通知箱为空，使用日志降级兜底展示
    if (notices.length === 0) {
      for (const log of logs) {
        if (log.event_type === 'homework_detected' || log.event_type === 'homework_solved') {
          notices.push({
            title: log.summary,
            createrName: 'AFK 云端守护',
            sendTime: log.created_at,
            content: log.summary,
          });
        }
      }
    }

    const rawDiscussions = await listDiscussions(env, undefined, 150);
    const discussions = rawDiscussions.map((d: any) => ({
      discussionId: String(d.discussion_id || ''),
      topicId: String(d.topic_id || ''),
      courseId: String(d.course_id || ''),
      classId: String(d.class_id || ''),
      courseName: String(d.course_name || ''),
      author: String(d.author || ''),
      title: String(d.title || ''),
      prompt: String(d.prompt || ''),
      chapterLabel: String(d.chapter_label || ''),
      topicUrl: String(d.topic_url || ''),
      bbsUrl: String(d.bbs_url || ''),
      status: String(d.status || 'pending'),
      draftReply: String(d.draft_reply || ''),
      postedReply: String(d.posted_reply || ''),
      modelUsed: String(d.model_used || ''),
      replyCount: Number(d.reply_count || 0),
      publishedAt: String(d.published_at || ''),
      updatedAt: String(d.updated_at || ''),
    }));

    const discussionPendingCount = discussions.filter((d) => d.status === 'pending').length;
    const discussionDraftCount = discussions.filter((d) => d.status === 'awaiting_approval').length;
    const discussionSubmittedCount = discussions.filter(
      (d) => d.status === 'submitted' || d.status === 'replied_externally'
    ).length;

    return {
      time: currentTime,
      lastSync: currentTime,
      daemonStatus: 'ONLINE',
      stats: {
        pendingCount,
        dispatchedCount,
        submittingCount,
        draftCount,
        submittedCount,
        failedCount,
        signinCount,
        questionBankCount: qbCount,
        discussionPendingCount,
        discussionDraftCount,
        discussionSubmittedCount,
      },
      sessions,
      tasks,
      homeworks,
      exams,
      notices,
      signinHistory,
      courses: Array.from(courseMap.values()),
      discussions,
      logs,
    };
  } catch {
    return empty;
  }
}

/**
 * 渲染零服务器成本的 Cloudflare Edge 全景监控看板 (Dark Glassmorphic UI)
 * 100% 契合 docs/cf-agent-architecture.md 架构规范：
 * - 纯深色科技拟物磨砂 (Dark Slate + Glassmorphism)
 * - 仅支持单账号守护 (零前端配置表单冗余)
 * - 支持 D7 提交门 (草稿暂存后由用户一键审批提交)
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>超星任务与学习监控看板 | Cloudflare Serverless</title>
  <link rel="icon" href="https://mooc1.chaoxing.com/favicon.ico">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 50: '#f0fdf4', 500: '#22c55e', 600: '#16a34a', 700: '#15803d' },
            dark: { 800: '#1e293b', 900: '#0f172a', 950: '#020617' }
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
    .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); }
    .glass-card { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.05); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 9999px; }
  </style>
</head>
<body class="bg-dark-950 text-slate-100 min-h-screen flex flex-col antialiased selection:bg-brand-500 selection:text-white">

  <!-- 顶部导航栏 -->
  <header class="glass sticky top-0 z-50 px-4 lg:px-8 py-3.5 flex items-center justify-between shadow-xl">
    <div class="flex items-center gap-3">
      <div class="h-9 w-9 rounded-xl bg-gradient-to-tr from-brand-600 to-emerald-400 flex items-center justify-center shadow-lg shadow-brand-500/20 text-white font-bold text-lg">
        🌿
      </div>
      <div>
        <h1 class="text-base font-bold tracking-tight text-white flex items-center gap-2">
          学习通全维智能监控看板 · afk-cloud 个人云端自治看板
          <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Cloudflare 边缘托管</span>
        </h1>
        <p class="text-xs text-slate-400">Google Cloud 守护 + agy 深度求解 + 7×24h 自动巡检</p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button onclick="triggerCheck()" id="checkBtn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-950/80 hover:bg-sky-900 border border-sky-800/80 active:scale-95 text-xs font-medium text-sky-200 transition">
        <span>⚡ 立即巡检</span>
      </button>
      <button onclick="triggerDigest()" id="digestBtn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-800/80 active:scale-95 text-xs font-medium text-emerald-200 transition">
        <span>📨 推送简报</span>
      </button>
      <button onclick="refreshData()" id="refreshBtn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-xs font-medium text-slate-200 transition border border-slate-700">
        <svg id="refreshIcon" class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        刷新看板
      </button>
    </div>
  </header>

  <!-- 提示条浮层 -->
  <div id="toastBox" class="fixed top-16 right-4 z-50 hidden transition-all duration-300"></div>

  <!-- 主内容区 -->
  <main class="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6">

    <!-- 顶栏概览指标卡片 -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
      <!-- 监控服务状态 -->
      <div class="glass-card rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span>云端守护状态</span>
          <span class="relative flex h-2.5 w-2.5">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
        </div>
        <div class="mt-2 text-xl lg:text-2xl font-bold text-white flex items-baseline gap-2">
          <span id="daemonStatusText">ONLINE</span>
          <span class="text-xs font-normal text-emerald-400">7×24h 守护中</span>
        </div>
        <div class="mt-2 text-[11px] text-slate-400 truncate" id="lastHeartbeat">最后同步: --</div>
      </div>

      <!-- 待做作业统计 -->
      <div class="glass-card rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span>待办作业与状态</span>
          <span class="text-amber-400">📝</span>
        </div>
        <div class="mt-2 text-xl lg:text-2xl font-bold text-amber-400 flex items-baseline gap-2">
          <span id="pendingHomeworkCount">0</span>
          <span class="text-xs font-normal text-slate-400">份未派发</span>
        </div>
        <div class="mt-2 text-[11px] text-slate-400 truncate" id="solvedHomeworkCount">0 已派发 · 0 做完暂存 · 0 提交中 · 0 已提交</div>
      </div>

      <!-- 考试与多平台任务 -->
      <div class="glass-card rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span>随堂测验/多平台</span>
          <span class="text-rose-400">🚨</span>
        </div>
        <div class="mt-2 text-xl lg:text-2xl font-bold text-rose-400 flex items-baseline gap-2">
          <span id="activeExamsCount">0</span>
          <span class="text-xs font-normal text-slate-400">项进行中</span>
        </div>
        <div class="mt-2 text-[11px] text-slate-400 truncate" id="totalNoticesCount">通知箱捕获: 0 条</div>
      </div>

      <!-- 自动签到累计 -->
      <div class="glass-card rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span>签到捕获 & 坐标</span>
          <span class="text-sky-400">📍</span>
        </div>
        <div class="mt-2 text-xl lg:text-2xl font-bold text-sky-400 flex items-baseline gap-2">
          <span id="signedCount">0</span>
          <span class="text-xs font-normal text-slate-400">次已成功</span>
        </div>
        <div class="mt-2 text-[11px] text-slate-400 truncate">上海海大 12 处坐标轮换</div>
      </div>
    </div>

    <!-- 标签切换页 -->
    <div class="space-y-4">
      <div class="flex border-b border-slate-800 gap-2 pb-1 overflow-x-auto text-xs font-medium text-slate-400">
        <button onclick="switchTab('homework')" id="tabBtn-homework" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-brand-500 text-white font-semibold flex items-center gap-1.5">
          <span>📝 作业与实验任务</span>
          <span id="badge-homework" class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300">0</span>
        </button>
        <button onclick="switchTab('discussions')" id="tabBtn-discussions" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-transparent hover:text-slate-200 flex items-center gap-1.5">
          <span>💬 话题讨论</span>
          <span id="badge-discussions" class="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300">0</span>
        </button>
        <button onclick="switchTab('exams')" id="tabBtn-exams" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-transparent hover:text-slate-200 flex items-center gap-1.5">
          <span>🚨 考试与随堂测验</span>
          <span id="badge-exams" class="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300">0</span>
        </button>
        <button onclick="switchTab('signs')" id="tabBtn-signs" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-transparent hover:text-slate-200 flex items-center gap-1.5">
          <span>📍 自动签到记录</span>
          <span id="badge-signs" class="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300">0</span>
        </button>
        <button onclick="switchTab('courses')" id="tabBtn-courses" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-transparent hover:text-slate-200 flex items-center gap-1.5">
          <span>📚 在读课程概况</span>
          <span id="badge-courses" class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">0</span>
        </button>
        <button onclick="switchTab('settings')" id="tabBtn-settings" class="tab-btn px-4 py-2 rounded-t-lg transition border-b-2 border-transparent hover:text-slate-200 flex items-center gap-1.5">
          <span>🔔 通知通道与架构</span>
        </button>
      </div>

      <!-- Tab 1: 作业任务 -->
      <section id="tab-homework" class="space-y-3">
        <!-- 过滤器与批量派发操作栏 -->
        <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
          <div class="flex items-center gap-1.5 overflow-x-auto py-0.5">
            <button onclick="setHomeworkFilter('all')" id="filter-all" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-800 text-white font-medium border border-slate-700 transition">全部 (<span id="cnt-all">0</span>)</button>
            <button onclick="setHomeworkFilter('pending')" id="filter-pending" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-amber-400 hover:bg-slate-800 border border-transparent transition">⏳ 未派发 (<span id="cnt-pending">0</span>)</button>
            <button onclick="setHomeworkFilter('dispatched')" id="filter-dispatched" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-sky-400 hover:bg-slate-800 border border-transparent transition">🚀 已派发 (<span id="cnt-dispatched">0</span>)</button>
            <button onclick="setHomeworkFilter('draft_saved')" id="filter-draft_saved" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-emerald-400 hover:bg-slate-800 border border-transparent transition">🛡️ 做完暂存 (<span id="cnt-draft">0</span>)</button>
            <button onclick="setHomeworkFilter('submitting')" id="filter-submitting" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-violet-400 hover:bg-slate-800 border border-transparent transition">📤 提交中 (<span id="cnt-submitting">0</span>)</button>
            <button onclick="setHomeworkFilter('submitted')" id="filter-submitted" class="hw-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-slate-400 hover:bg-slate-800 border border-transparent transition">✅ 已提交 (<span id="cnt-submitted">0</span>)</button>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="dispatchAllPendingTasks()" id="dispatchAllBtn" class="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium text-xs shadow-md shadow-brand-900/30 transition active:scale-95">
              <span>🚀 一键派发未派发作业</span>
            </button>
          </div>
        </div>

        <div id="homeworkList" class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          <div class="col-span-full py-12 text-center text-slate-500 text-sm">正在加载作业与实验任务...</div>
        </div>
      </section>

      <!-- Tab: 话题讨论 (人工审批后公开发布) -->
      <section id="tab-discussions" class="space-y-3 hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
          <div class="flex items-center gap-1.5 overflow-x-auto py-0.5">
            <button onclick="setDiscussionFilter('all')" id="disc-filter-all" class="disc-filter-btn px-2.5 py-1 rounded-lg bg-slate-800 text-white font-medium border border-slate-700 transition">全部 (<span id="disc-cnt-all">0</span>)</button>
            <button onclick="setDiscussionFilter('pending')" id="disc-filter-pending" class="disc-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-amber-400 hover:bg-slate-800 border border-transparent transition">⏳ 待AI拟稿 (<span id="disc-cnt-pending">0</span>)</button>
            <button onclick="setDiscussionFilter('awaiting_approval')" id="disc-filter-awaiting_approval" class="disc-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-cyan-400 hover:bg-slate-800 border border-transparent transition">🛡️ 待审批发布 (<span id="disc-cnt-awaiting">0</span>)</button>
            <button onclick="setDiscussionFilter('submitted')" id="disc-filter-submitted" class="disc-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-emerald-400 hover:bg-slate-800 border border-transparent transition">✅ 已回复 (<span id="disc-cnt-submitted">0</span>)</button>
            <button onclick="setDiscussionFilter('ignored')" id="disc-filter-ignored" class="disc-filter-btn px-2.5 py-1 rounded-lg bg-slate-900 text-slate-400 hover:bg-slate-800 border border-transparent transition">🚫 已忽略 (<span id="disc-cnt-ignored">0</span>)</button>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="scanDiscussionsUI()" id="scanDiscussionsBtn" class="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs shadow-md shadow-cyan-900/30 transition active:scale-95">
              <span>⚡ 扫描全课讨论区</span>
            </button>
          </div>
        </div>
        <div class="p-2.5 rounded-xl bg-amber-950/30 border border-amber-500/20 text-[11px] text-amber-200/90 leading-relaxed">
          🛡️ 话题讨论安全门：学习通讨论区 <code class="font-mono text-amber-300">addreply</code> 无官方草稿箱，因此 AI 生成的回复默认以「待审批」暂存至本看板；请确认或编辑修改后，手动点击【批准并发布至学习通】。可用 <code class="font-mono text-amber-300">pnpm afk discuss</code> 批量调用本地 agy 结合课件 RAG 生成拟稿。
        </div>
        <div id="discussionList" class="grid grid-cols-1 gap-3.5">
          <div class="py-12 text-center text-slate-500 text-sm">正在加载课程话题讨论...</div>
        </div>
      </section>

      <!-- Tab 2: 考试与测验 -->
      <section id="tab-exams" class="space-y-3 hidden">
        <div id="examList" class="space-y-3">
          <div class="py-12 text-center text-slate-500 text-sm">正在加载随堂测验与通知...</div>
        </div>
      </section>

      <!-- Tab 3: 签到记录 -->
      <section id="tab-signs" class="space-y-3 hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
          <span class="text-slate-300">
            共记录 <span id="totalSignCount" class="font-bold text-white">0</span> 条签到活动（成功 <span id="successSignCount" class="font-bold text-emerald-400">0</span> 条）
          </span>
          <button onclick="syncSigninsUI()" id="syncSigninsBtn" class="px-2.5 py-1 rounded-lg bg-sky-600/80 hover:bg-sky-500 text-white font-medium border border-sky-500/40 transition active:scale-95 flex items-center gap-1">
            <span>🔄 同步历史签到</span>
          </button>
        </div>
        <div class="glass-card rounded-2xl overflow-hidden border border-slate-800">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-900/80 text-slate-400 border-b border-slate-800">
              <tr>
                <th class="p-3 font-medium">打卡时间 (UTC+8)</th>
                <th class="p-3 font-medium">课程名称</th>
                <th class="p-3 font-medium">活动类型</th>
                <th class="p-3 font-medium">打卡位置 / 状态</th>
                <th class="p-3 font-medium text-right">结果</th>
              </tr>
            </thead>
            <tbody id="signinTableBody" class="divide-y divide-slate-800/60 text-slate-300">
              <tr><td colspan="5" class="p-8 text-center text-slate-500">暂无活动签到事件</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Tab 4: 课程列表 -->
      <section id="tab-courses" class="space-y-3 hidden">
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
          <span class="text-slate-300">共检索到 <span id="totalCourseCount" class="font-bold text-white">0</span> 门在读课程（已同步持久化至 D1 数据库）</span>
          <button onclick="refreshCourses()" id="syncCoursesBtn" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition active:scale-95 flex items-center gap-1">
            <span>🔄 刷新超星课程</span>
          </button>
        </div>
        <div id="courseList" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div class="col-span-full py-12 text-center text-slate-500 text-sm">正在加载课程...</div>
        </div>
      </section>

      <!-- Tab 5: 通知渠道配置与架构规范 -->
      <section id="tab-settings" class="space-y-4 hidden max-w-3xl">
        <div class="glass-card rounded-2xl p-5 space-y-4 text-xs">
          <div>
            <h3 class="text-sm font-semibold text-white">推送通道与 Cloudflare Agents 架构契约</h3>
            <p class="text-slate-400 mt-1">单账号常驻边缘守护，无客户端凭据泄露风险。在 Cloudflare Worker 的 Secrets 或 .env 中配置对应 Token 即可自动激活以下通知方式：</p>
          </div>

          <div class="space-y-3">
            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800 flex items-start gap-3">
              <span class="text-emerald-400 text-lg">💬</span>
              <div class="flex-1">
                <div class="font-medium text-white flex items-center justify-between">
                  <span>微信推送 (PushPlus / Server酱)</span>
                  <span class="text-[10px] text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-500/10">强烈推荐</span>
                </div>
                <p class="text-slate-400 mt-0.5">当出现新作业、草稿作答就绪或签到成功时，在微信中直接弹出卡片通知，点击直达审批提交。</p>
                <code class="mt-1 block text-[11px] text-slate-300 font-mono">PUSHPLUS_TOKEN = "your_token" 或 SERVERCHAN_KEY = "SCT..."</code>
              </div>
            </div>

            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800 flex items-start gap-3">
              <span class="text-blue-400 text-lg">🦅</span>
              <div class="flex-1">
                <div class="font-medium text-white">飞书 / 钉钉 / 企业微信 Webhook</div>
                <p class="text-slate-400 mt-0.5">群机器人富文本通知，包含题目预览与直链跳转。</p>
                <code class="mt-1 block text-[11px] text-slate-300 font-mono">WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/..."</code>
              </div>
            </div>

            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800 flex items-start gap-3">
              <span class="text-sky-400 text-lg">📱</span>
              <div class="flex-1">
                <div class="font-medium text-white">iOS Bark 推送</div>
                <p class="text-slate-400 mt-0.5">iPhone 原生级无延迟弹窗推送与自定义铃声提醒。</p>
                <code class="mt-1 block text-[11px] text-slate-300 font-mono">BARK_KEY = "your_bark_device_key"</code>
              </div>
            </div>

            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <div class="font-medium text-white mb-1">🛡️ 架构铁律与提交门规范 (D7 准则)</div>
              <p class="text-slate-400 leading-relaxed">
                遵循 <span class="text-slate-200 font-mono">cf-agent-architecture.md</span> 核心安全准则：所有作业解答默认以【安全草稿模式 (pyFlag=1)】写入，并在本看板标记为“草稿暂存”。
                用户可在本看板点击【审批提交】按钮一键正式提交，实现“草稿 → 通知 → 确认 → 提交”的确定性闭环。
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>

  <!-- 页脚 -->
  <footer class="mt-auto border-t border-slate-900 py-4 px-6 text-center text-xs text-slate-500 flex flex-col sm:flex-row items-center justify-between max-w-7xl w-full mx-auto">
    <div>上海海洋大学 · 智能教学助手平台</div>
    <div class="mt-1 sm:mt-0">运行环境: Cloudflare Workers Edge · 时区: UTC+8</div>
  </footer>

  <script>
    let state = null;

    function showToast(msg, isSuccess = true) {
      const box = document.getElementById('toastBox');
      box.className = 'fixed top-16 right-4 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl transition-all border flex items-center gap-2 ' +
        (isSuccess ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200' : 'bg-rose-950/90 border-rose-500/50 text-rose-200');
      box.innerHTML = (isSuccess ? '✅ ' : '❌ ') + msg;
      box.classList.remove('hidden');
      setTimeout(() => box.classList.add('hidden'), 4000);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    let currentDiscussionFilter = 'all';

    function setDiscussionFilter(filter) {
      currentDiscussionFilter = filter;
      document.querySelectorAll('.disc-filter-btn').forEach(btn => {
        btn.classList.remove('bg-slate-800', 'text-white', 'border-slate-700');
        btn.classList.add('bg-slate-900', 'border-transparent');
      });
      const activeBtn = document.getElementById('disc-filter-' + filter);
      if (activeBtn) {
        activeBtn.classList.add('bg-slate-800', 'text-white', 'border-slate-700');
        activeBtn.classList.remove('bg-slate-900', 'border-transparent');
      }
      renderDiscussions();
    }

    let currentHomeworkFilter = 'all';

    function setHomeworkFilter(filter) {
      currentHomeworkFilter = filter;
      document.querySelectorAll('.hw-filter-btn').forEach(btn => {
        btn.classList.remove('bg-slate-800', 'text-white', 'border-slate-700');
        btn.classList.add('bg-slate-900', 'border-transparent');
      });
      const activeBtn = document.getElementById('filter-' + filter);
      if (activeBtn) {
        activeBtn.classList.add('bg-slate-800', 'text-white', 'border-slate-700');
        activeBtn.classList.remove('bg-slate-900', 'border-transparent');
      }
      renderHomework();
    }

    function parseClientTimeMs(timeStr) {
      if (!timeStr) return null;
      const s = String(timeStr).trim();
      if (!s || s === '无截止时间' || s === '无' || s === '近期' || s === '无截止限制') return null;
      if (/^[0-9]{10,13}$/.test(s)) return Number(s.padEnd(13, '0'));
      const match = s.match(/(?:([0-9]{4})[-/年])?([0-9]{1,2})[-/月]([0-9]{1,2})[日号]?[ \t]+([0-9]{1,2}):([0-9]{1,2})(?::([0-9]{1,2}))?/);
      if (match) {
        const y = match[1] ? Number(match[1]) : new Date().getFullYear();
        const m = Number(match[2]);
        const d = Number(match[3]);
        const hh = Number(match[4]);
        const mm = Number(match[5]);
        const ss = match[6] ? Number(match[6]) : 0;
        const pad = function(n) { return String(n).padStart(2, '0'); };
        return Date.parse(y + '-' + pad(m) + '-' + pad(d) + 'T' + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + '+08:00');
      }
      const norm = s.replace(/年|月/g, '-').replace(/日|号/g, '').split('/').join('-').trim();
      const ms = Date.parse(norm);
      return isNaN(ms) ? Date.parse(norm + ' GMT+0800') : ms;
    }

    function checkExamIsActive(e) {
      if (e.isExpired) return false;
      const ms = parseClientTimeMs(e.endTime);
      if (ms !== null && !isNaN(ms)) {
        return ms > Date.now();
      }
      return !e.isExpired;
    }

    function renderUI() {
      if (!state) return;

      // 顶部指标
      document.getElementById('lastHeartbeat').innerText = '最后同步: ' + (state.lastSync || state.time || '刚刚');
      const hwList = state.homeworks || [];
      const pendingCount = hwList.filter(h => h.status === 'pending').length;
      const dispatchedCount = hwList.filter(h => h.status === 'dispatched' || h.status === 'processing').length;
      const draftCount = hwList.filter(h => h.status === 'draft_saved' || h.status === 'awaiting_approval').length;
      const submittingCount = hwList.filter(h => h.status === 'submitting').length;
      const submittedCount = hwList.filter(h => h.status === 'submitted').length;

      document.getElementById('pendingHomeworkCount').innerText = String(pendingCount);
      document.getElementById('solvedHomeworkCount').innerText = \`\${dispatchedCount} 已派发 · \${draftCount} 做完暂存 · \${submittingCount} 提交中 · \${submittedCount} 已提交\`;

      const cntAll = document.getElementById('cnt-all');
      if (cntAll) cntAll.innerText = String(hwList.length);
      const cntPending = document.getElementById('cnt-pending');
      if (cntPending) cntPending.innerText = String(pendingCount);
      const cntDispatched = document.getElementById('cnt-dispatched');
      if (cntDispatched) cntDispatched.innerText = String(dispatchedCount);
      const cntDraft = document.getElementById('cnt-draft');
      if (cntDraft) cntDraft.innerText = String(draftCount);
      const cntSubmitting = document.getElementById('cnt-submitting');
      if (cntSubmitting) cntSubmitting.innerText = String(submittingCount);
      const cntSubmitted = document.getElementById('cnt-submitted');
      if (cntSubmitted) cntSubmitted.innerText = String(submittedCount);

      const activeExams = (state.exams || []).filter(e => checkExamIsActive(e));
      document.getElementById('activeExamsCount').innerText = String(activeExams.length);
      document.getElementById('totalNoticesCount').innerText = '通知箱捕获: ' + (state.notices || []).length + ' 条';

      const signList = state.signinHistory || [];
      const successSignCount = signList.filter(s => s.result === '签到成功' || s.result === '已签到').length;
      const signedTotal = (typeof state.stats?.signinCount === 'number' && state.stats.signinCount >= successSignCount)
        ? state.stats.signinCount
        : successSignCount;
      document.getElementById('signedCount').innerText = String(signedTotal);

      document.getElementById('badge-homework').innerText = String(pendingCount);
      document.getElementById('badge-exams').innerText = String(activeExams.length);
      const badgeSigns = document.getElementById('badge-signs');
      if (badgeSigns) badgeSigns.innerText = String(signList.length);
      const totalSignEl = document.getElementById('totalSignCount');
      if (totalSignEl) totalSignEl.innerText = String(signList.length);
      const successSignEl = document.getElementById('successSignCount');
      if (successSignEl) successSignEl.innerText = String(successSignCount);

      const courseCount = (state.courses || []).length;
      const badgeCourses = document.getElementById('badge-courses');
      if (badgeCourses) badgeCourses.innerText = courseCount;
      const totalCourseEl = document.getElementById('totalCourseCount');
      if (totalCourseEl) totalCourseEl.innerText = courseCount;

      const discList = state.discussions || [];
      const discPending = discList.filter(d => d.status === 'pending').length;
      const discAwaiting = discList.filter(d => d.status === 'awaiting_approval').length;
      const discSubmitted = discList.filter(d => d.status === 'submitted' || d.status === 'replied_externally').length;
      const discIgnored = discList.filter(d => d.status === 'ignored').length;
      const badgeDisc = document.getElementById('badge-discussions');
      if (badgeDisc) badgeDisc.innerText = discPending + discAwaiting;
      const discAllEl = document.getElementById('disc-cnt-all');
      if (discAllEl) discAllEl.innerText = discList.length;
      const discPendEl = document.getElementById('disc-cnt-pending');
      if (discPendEl) discPendEl.innerText = discPending;
      const discWaitEl = document.getElementById('disc-cnt-awaiting');
      if (discWaitEl) discWaitEl.innerText = discAwaiting;
      const discSubEl = document.getElementById('disc-cnt-submitted');
      if (discSubEl) discSubEl.innerText = discSubmitted;
      const discIgnEl = document.getElementById('disc-cnt-ignored');
      if (discIgnEl) discIgnEl.innerText = discIgnored;

      renderHomework();
      renderDiscussions();
      renderExams();
      renderSignins();
      renderCourses();
    }

    function renderHomework() {
      const container = document.getElementById('homeworkList');
      const allList = state.homeworks || [];
      const list = allList.filter(hw => {
        if (currentHomeworkFilter === 'all') return true;
        if (currentHomeworkFilter === 'pending') return hw.status === 'pending';
        if (currentHomeworkFilter === 'dispatched') return hw.status === 'dispatched' || hw.status === 'processing';
        if (currentHomeworkFilter === 'draft_saved') return hw.status === 'draft_saved' || hw.status === 'awaiting_approval';
        if (currentHomeworkFilter === 'submitting') return hw.status === 'submitting';
        if (currentHomeworkFilter === 'submitted') return hw.status === 'submitted';
        return true;
      });

      if (list.length === 0) {
        container.innerHTML = '<div class="col-span-full py-12 text-center text-slate-500 text-sm">该分类下暂无作业任务</div>';
        return;
      }

      container.innerHTML = list.map(hw => {
        const isDraft = hw.status === 'draft_saved' || hw.status === 'awaiting_approval';
        const isSubmitting = hw.status === 'submitting';
        const isSubmitted = hw.status === 'submitted';
        const isDispatched = hw.status === 'dispatched' || hw.status === 'processing';
        const isFailed = hw.status === 'failed';
        const isPending = !isDraft && !isSubmitting && !isSubmitted && !isDispatched && !isFailed;

        let badge = '';
        let statusDesc = '';
        if (isDraft) {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-sky-500/20 text-sky-300 border-sky-500/30">🛡️ 做完暂存 · 待审批</span>';
          statusDesc = '双轨模型已完成解答，草稿已暂存平台，等待人工审批正式提交';
        } else if (isSubmitting) {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-violet-500/20 text-violet-300 border-violet-500/30">📤 正式提交中</span>';
          statusDesc = '已通过人工审批，正在等待 shim 执行正式提交并回执确认';
        } else if (isDispatched) {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-blue-500/20 text-blue-300 border-blue-500/30">🚀 已派发给 agy</span>';
          statusDesc = '任务已下发至云端 Antigravity Agent / 本地 shim 正在深度推理求解中';
        } else if (isSubmitted) {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-emerald-500/20 text-emerald-300 border-emerald-500/30">✅ 已正式提交</span>';
          statusDesc = '已完成审批并正式提交至超星学习通平台';
        } else if (isFailed) {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-rose-500/20 text-rose-300 border-rose-500/30">⚠️ 求解失败</span>';
          statusDesc = '上次求解遇到异常，支持重新派发给 agy';
        } else {
          badge = '<span class="text-xs px-2 py-0.5 rounded-full font-medium border bg-amber-500/20 text-amber-300 border-amber-500/30">⏳ 未派发</span>';
          statusDesc = '新探测作业，尚未派发给 agy Agent 执行作答';
        }

        const platformLabel = escapeHtml(hw.platform ? hw.platform.toUpperCase() : 'CHAOXING');
        const platformBadge = \`<span class="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-mono">\${platformLabel}</span>\`;

        const safeCourseName = escapeHtml(hw.courseName || '课程');
        const safeTitle = escapeHtml(hw.title);
        const safeEndDate = escapeHtml(hw.endDate || '无截止限制');
        const safeResultSummary = escapeHtml(hw.resultSummary || '');
        const safeTaskIdAttr = escapeHtml(hw.taskId || '');

        const courseLink = hw.courseUrl
          ? '<a href="' + escapeHtml(hw.courseUrl) + '" target="_blank" rel="noopener noreferrer" class="text-[11px] text-sky-400/90 hover:text-sky-300 hover:underline truncate max-w-[150px] inline-flex items-center gap-0.5" title="点击直达课程空间">' + safeCourseName + ' ↗</a>'
          : '<span class="text-[11px] text-slate-400 truncate max-w-[150px]">' + safeCourseName + '</span>';

        const answerBtn = hw.url
          ? '<a href="' + escapeHtml(hw.url) + '" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition active:scale-95 shadow-md shadow-sky-900/30 flex items-center gap-1" title="' + (hw.noticeUrl ? '在超星官方平台打开作业通知卡片作答（免403防阻断）' : '在超星平台打开作答界面') + '"><span>🔗 打开作答界面 &rarr;</span></a>'
          : '';

        return \`
          <div class="glass-card rounded-2xl p-4 space-y-3 transition hover:border-slate-700 flex flex-col justify-between">
            <div class="space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                  \${badge}
                  \${platformBadge}
                </div>
                \${courseLink}
              </div>
              <h3 class="text-sm font-bold text-white tracking-tight">\${safeTitle}</h3>
              <div class="text-xs text-slate-400 space-y-1">
                <p>📅 截止时间: <span class="text-slate-300 font-mono">\${safeEndDate}</span></p>
                <p class="text-[11px] text-slate-400">💡 状态说明: \${statusDesc}</p>
                \${safeResultSummary ? \`<p class="text-[11px] text-sky-300/90 truncate">📝 详情: \${safeResultSummary}</p>\` : ''}
              </div>
            </div>

            <div class="pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2 flex-wrap">
              <div class="text-[11px] text-slate-500">
                \${isDraft ? '<span class="text-amber-300/90">🛡️ 草稿检查点已保存</span>' : isSubmitting ? '<span class="text-violet-300/90">📤 正在向平台提交确认中</span>' : isDispatched ? '<span class="text-blue-300/80">⚡ 求解排队中</span>' : ''}
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                \${answerBtn}
                <button onclick="dispatchTask('\${safeTaskIdAttr}')" class="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition active:scale-95 flex items-center gap-1" title="派发至云端 agy / 本地 shim 求解">
                  <span>\${isPending ? '🚀 派发给 agy' : '🔄 重新派发 agy'}</span>
                </button>
                \${isDraft ? \`
                  <button onclick="approveSubmit('\${safeTaskIdAttr}')" class="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition active:scale-95 shadow-md shadow-emerald-900/30 flex items-center gap-1" title="确认并正式提交作业草稿">
                    <span>✅ 审批提交 &rarr;</span>
                  </button>
                \` : ''}
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderExams() {
      const container = document.getElementById('examList');
      const exams = state.exams || [];
      const notices = state.notices || [];

      if (exams.length === 0 && notices.length === 0) {
        container.innerHTML = '<div class="py-12 text-center text-slate-500 text-sm">通知箱暂无待办事项</div>';
        return;
      }

      let html = '';
      if (exams.length > 0) {
        html += '<h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">随堂测验与考试</h4>';
        const sortedExams = [...exams].sort((a, b) => {
          const aAct = checkExamIsActive(a);
          const bAct = checkExamIsActive(b);
          if (aAct !== bAct) return aAct ? -1 : 1;
          const aMs = parseClientTimeMs(a.endTime) || 0;
          const bMs = parseClientTimeMs(b.endTime) || 0;
          return bMs - aMs;
        });
        html += sortedExams.map(e => {
          const isAct = checkExamIsActive(e);
          return \`
            <div class="glass-card rounded-xl p-4 border \${isAct ? 'border-rose-500/40 bg-rose-950/20' : 'border-slate-800'}">
              <div class="flex items-center justify-between">
                <span class="text-xs px-2 py-0.5 rounded-md font-medium \${isAct ? 'bg-rose-500 text-white' : 'bg-slate-800 text-slate-400'}">
                  \${isAct ? '🚨 考试/测验进行中' : '⏳ 考试已截止'}
                </span>
                <span class="text-xs text-slate-400">\${e.courseName || ''}</span>
              </div>
              <h3 class="text-sm font-bold text-white mt-2">\${e.title}</h3>
              <p class="text-xs text-slate-300 mt-1">时段: \${e.startTime || '无'} 至 \${e.endTime || '无'}</p>
              \${(e.url || e.examId) ? ('<a href="' + (e.url || ('https://mooc1-api.chaoxing.com/examApi/intoexamorwork?taskrefId=' + e.examId + '&workOrExam=exam')) + '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-sky-400 hover:text-sky-300 hover:underline">🔗 跳转考试/测验作答界面 &rarr;</a>') : ''}
            </div>
          \`;
        }).join('');
      }

      if (notices.length > 0) {
        html += '<h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-5 mb-2">班级通知箱与云端守护日志</h4>';
        html += notices.slice(0, 10).map(n => \`
          <div class="glass-card rounded-xl p-3.5 space-y-1">
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span class="font-medium text-slate-200">\${n.createrName || '通知'}</span>
              <span>\${n.sendTime || ''}</span>
            </div>
            <h5 class="text-xs font-bold text-white">\${n.title}</h5>
            <p class="text-xs text-slate-400 line-clamp-2">\${n.content || ''}</p>
          </div>
        \`).join('');
      }

      container.innerHTML = html;
    }

    function renderSignins() {
      const tbody = document.getElementById('signinTableBody');
      const list = state.signinHistory || [];
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500">云端已就绪，点击右上角【🔄 同步历史签到】即可从学习通拉取过往签到记录</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => {
        const resultStr = String(item.result || '已完成');
        const isOk = resultStr.includes('成功') || resultStr.includes('已签') || resultStr.includes('已完成');
        const isMissed = resultStr.includes('未签到') || resultStr.includes('已截止') || resultStr.includes('已结束');
        const resultClass = isOk
          ? 'text-emerald-400'
          : isMissed
            ? 'text-amber-300'
            : 'text-rose-400';

        return \`
        <tr class="hover:bg-slate-800/30 transition">
          <td class="p-3 font-mono text-slate-400">\${escapeHtml(item.time || '')}</td>
          <td class="p-3 font-medium text-white">\${escapeHtml(item.courseName || '在线课程')}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded bg-sky-500/10 text-sky-300">\${escapeHtml(item.type || '普通签到')}</span></td>
          <td class="p-3 text-slate-300">\${escapeHtml(item.address || '学习通自动打卡')}</td>
          <td class="p-3 text-right \${resultClass} font-semibold">\${escapeHtml(resultStr)}</td>
        </tr>
      \`;
      }).join('');
    }

    function renderCourses() {
      const container = document.getElementById('courseList');
      const courses = state.courses || [];
      if (courses.length === 0) {
        container.innerHTML = '<div class="col-span-full py-12 text-center text-slate-500 text-sm">暂无在读课程记录，点击上方“刷新超星课程”按钮即可自动拉取！</div>';
        return;
      }

      container.innerHTML = courses.map(c => \`
        <div class="glass-card rounded-xl p-3.5 flex flex-col justify-between text-xs space-y-2.5 border border-slate-800 hover:border-slate-700 transition">
          <div class="space-y-1">
            <div class="font-bold text-white text-sm line-clamp-1" title="\${c.courseName}">\${c.courseName}</div>
            <div class="text-[11px] text-slate-400 font-mono">ID: \${c.courseId} · 班级: \${c.classId || '-'}</div>
            \${c.teacherName ? \`<div class="text-[11px] text-slate-400">授课教师: <span class="text-slate-300">\${c.teacherName}</span></div>\` : ''}
          </div>
          <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between">
            <span class="text-[10px] text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10">● 活跃监听中</span>
            <a href="https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=\${c.courseId}&clazzid=\${c.classId}&vc=1&cpi=\${c.cpi || ''}" target="_blank" class="text-[11px] text-sky-400 hover:underline">
              进入课程 &rarr;
            </a>
          </div>
        </div>
      \`).join('');
    }

    function renderDiscussions() {
      const container = document.getElementById('discussionList');
      if (!container) return;
      const allList = state.discussions || [];
      const list = allList.filter(d => {
        if (currentDiscussionFilter === 'all') return true;
        if (currentDiscussionFilter === 'submitted') return d.status === 'submitted' || d.status === 'replied_externally';
        return d.status === currentDiscussionFilter;
      });

      if (list.length === 0) {
        container.innerHTML = '<div class="py-12 text-center text-slate-500 text-sm">该分类下暂无课程话题讨论，可点击上方【⚡ 扫描全课讨论区】立即拉取。</div>';
        return;
      }

      container.innerHTML = list.map(d => {
        const safeId = escapeHtml(d.discussionId);
        const safeDomId = String(d.discussionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        let badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">⏳ 待AI拟稿</span>';
        if (d.status === 'awaiting_approval') {
          badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">🛡️ AI已拟稿 · 待审批发布</span>';
        } else if (d.status === 'submitted') {
          badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">✅ 已由看板批准发布</span>';
        } else if (d.status === 'replied_externally') {
          badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">✅ 检测到本人已回复</span>';
        } else if (d.status === 'ignored') {
          badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 border border-slate-600">🚫 已忽略</span>';
        } else if (d.status === 'failed') {
          badgeHtml = '<span class="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">❌ 发布失败</span>';
        }

        const isClosed = d.status === 'submitted' || d.status === 'replied_externally';
        const replyValue = isClosed ? (d.postedReply || d.draftReply || '') : (d.draftReply || '');
        const metaPieces = [
          d.author ? '发起人: ' + escapeHtml(d.author) : '',
          d.chapterLabel ? '章节: ' + escapeHtml(d.chapterLabel) : '',
          '总回帖: ' + Number(d.replyCount || 0) + ' 条',
          d.modelUsed ? '模型: ' + escapeHtml(d.modelUsed) : ''
        ].filter(Boolean).join(' · ');

        return \`
          <div class="glass-card rounded-2xl p-4 space-y-3 border border-slate-800/80 hover:border-slate-700 transition">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="space-y-1 min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-medium">\${escapeHtml(d.courseName || '未知课程')}</span>
                  \${badgeHtml}
                </div>
                <h3 class="text-sm font-semibold text-white leading-snug">\${escapeHtml(d.title || '无标题讨论')}</h3>
                <div class="text-[11px] text-slate-400">\${metaPieces}</div>
              </div>
              \${d.topicUrl ? \`<a href="\${escapeHtml(d.topicUrl)}" target="_blank" rel="noopener noreferrer" class="text-[11px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 shrink-0">打开原帖 ↗</a>\` : ''}
            </div>
            \${d.prompt ? \`<div class="p-3 rounded-xl bg-slate-900/70 border border-slate-800/80 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">\${escapeHtml(d.prompt)}</div>\` : ''}
            <div class="space-y-2">
              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <span>\${isClosed ? '最终已发布回复内容' : 'AI 拟稿 / 手动编辑回复内容（点击发布前不会公开提交）'}</span>
                <span class="text-slate-500">\${escapeHtml(d.publishedAt || d.updatedAt || '')}</span>
              </div>
              <textarea id="disc-draft-\${safeDomId}" rows="3" \${isClosed ? 'readonly' : ''} placeholder="等待运行 pnpm afk discuss 由 agy 结合课件生成草稿，或直接在此输入回复内容..." class="w-full rounded-xl bg-slate-950/80 border border-slate-700/80 focus:border-cyan-500 focus:outline-none p-2.5 text-xs text-slate-100 leading-relaxed resize-y">\${escapeHtml(replyValue)}</textarea>
              \${isClosed ? '' : \`
                <div class="flex flex-wrap items-center justify-end gap-2">
                  <button onclick="ignoreDiscussionUI('\${safeId}')" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition">🚫 忽略</button>
                  <button onclick="saveDiscussionDraftUI('\${safeId}', 'disc-draft-\${safeDomId}')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 text-xs transition">💾 保存草稿</button>
                  <button onclick="publishDiscussionUI('\${safeId}', 'disc-draft-\${safeDomId}')" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-md shadow-emerald-900/30 transition">✅ 批准并发布至学习通</button>
                </div>
              \`}
            </div>
          </div>
        \`;
      }).join('');
    }

    async function scanDiscussionsUI() {
      const btn = document.getElementById('scanDiscussionsBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerText = '扫描中...';
      }
      try {
        let offset = 0;
        let hasMore = true;
        let rounds = 0;
        let totalTopics = 0;
        let totalNew = 0;
        while (hasMore && rounds < 10) {
          rounds++;
          const res = await fetch('/api/discussions/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset, limit: 9, forceDetailRefresh: false }),
          });
          const json = await res.json();
          if (!res.ok || !json.ok) {
            throw new Error(json.error || '扫描接口返回失败');
          }
          totalTopics += Number(json.topicsFound || 0);
          totalNew += Number(json.newPendingTopics || 0);
          hasMore = Boolean(json.hasMore);
          offset = Number(json.nextOffset || 0);
          if (hasMore) {
            showToast(\`正在分批扫描讨论区... 已完成 \${rounds * 9}/\${json.totalCourses || '?'} 门课程\`);
          }
        }
        showToast(\`全课讨论区扫描完成：捕获 \${totalTopics} 条教师话题（新增待拟稿 \${totalNew} 条）\`);
        await refreshData();
      } catch (e) {
        showToast('扫描讨论区失败：' + (e.message || '网络异常'), false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ 扫描全课讨论区';
        }
      }
    }

    async function saveDiscussionDraftUI(discussionId, textareaId) {
      const el = document.getElementById(textareaId);
      const draftReply = el ? el.value.trim() : '';
      if (!draftReply) {
        showToast('请先填写回复草稿内容', false);
        return;
      }
      try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(discussionId) + '/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftReply }),
        });
        const json = await res.json();
        if (json.ok) {
          showToast('草稿已保存至待审批状态');
          await refreshData();
        } else {
          showToast('保存草稿失败：' + (json.error || '未知错误'), false);
        }
      } catch (e) {
        showToast('保存草稿网络异常', false);
      }
    }

    async function publishDiscussionUI(discussionId, textareaId) {
      const el = document.getElementById(textareaId);
      const draftReply = el ? el.value.trim() : '';
      if (!draftReply) {
        showToast('回复内容为空，无法发布', false);
        return;
      }
      if (!confirm('确认公开发布该回复到超星学习通讨论区？发布后同学与教师可见。')) return;
      try {
        showToast('正在安全提交回复至超星学习通...', true);
        const res = await fetch('/api/discussions/' + encodeURIComponent(discussionId) + '/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftReply }),
        });
        const json = await res.json();
        if (json.ok) {
          showToast('已成功公开发布到学习通讨论区！✅');
          await refreshData();
        } else {
          showToast('发布失败：' + (json.msg || json.error || '未知错误'), false);
        }
      } catch (e) {
        showToast('发布请求网络异常', false);
      }
    }

    async function ignoreDiscussionUI(discussionId) {
      try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(discussionId) + '/ignore', {
          method: 'POST',
        });
        const json = await res.json();
        if (json.ok) {
          showToast('已忽略该话题');
          await refreshData();
        } else {
          showToast('操作失败', false);
        }
      } catch (e) {
        showToast('网络请求异常', false);
      }
    }

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-brand-500', 'text-white', 'font-semibold');
        btn.classList.add('border-transparent');
      });
      document.getElementById('tabBtn-' + name).classList.add('border-brand-500', 'text-white', 'font-semibold');
      document.getElementById('tabBtn-' + name).classList.remove('border-transparent');

      ['homework', 'discussions', 'exams', 'signs', 'courses', 'settings'].forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) el.classList.toggle('hidden', t !== name);
      });
    }

    async function refreshData() {
      const icon = document.getElementById('refreshIcon');
      icon.classList.add('animate-spin');
      try {
        const res = await fetch('/api/dashboard');
        if (res.ok) {
          state = await res.json();
          renderUI();
          showToast('看板数据已同步最新状态');
        }
      } catch (e) {
        console.error(e);
        showToast('看板刷新失败', false);
      } finally {
        setTimeout(() => icon.classList.remove('animate-spin'), 600);
      }
    }

    async function triggerCheck() {
      const btn = document.getElementById('checkBtn');
      btn.disabled = true;
      btn.innerText = '巡检中...';
      try {
        const res = await fetch('/check');
        const json = await res.json();
        showToast(json.success ? '巡检完成：扫描 ' + (json.coursesCount || 0) + ' 门课程' : '巡检完成');
        await refreshData();
      } catch (e) {
        showToast('巡检触发异常', false);
      } finally {
        btn.disabled = false;
        btn.innerText = '⚡ 立即巡检';
      }
    }

    async function triggerDigest() {
      const btn = document.getElementById('digestBtn');
      btn.disabled = true;
      btn.innerText = '推送中...';
      try {
        const res = await fetch('/api/digest', { method: 'POST' });
        const json = await res.json();
        showToast(json.sent ? '已成功向各配置渠道推送即时简报通知！' : '推送请求已受理');
      } catch (e) {
        showToast('简报推送失败', false);
      } finally {
        btn.disabled = false;
        btn.innerText = '📨 推送简报';
      }
    }

    async function dispatchTask(taskId) {
      if (!confirm('确定将该作业主动派发给云端 agy / 本地 shim 求解吗？')) return;
      try {
        showToast('正在主动派发任务给 agy...', true);
        const res = await fetch(\`/api/tasks/\${taskId}/dispatch\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();
        if (json.success) {
          showToast('作业已成功派发给 agy 深度推理求解！🚀');
          await refreshData();
        } else {
          showToast('派发失败：' + (json.reason || '网络错误'), false);
        }
      } catch (e) {
        showToast('派发请求异常', false);
      }
    }

    async function dispatchAllPendingTasks() {
      const pendingTasks = (state.homeworks || []).filter(h => h.status === 'pending');
      if (pendingTasks.length === 0) {
        showToast('当前没有未派发的作业任务');
        return;
      }
      if (!confirm(\`确定一键将全部 \${pendingTasks.length} 份未派发作业派发给 agy 吗？\`)) return;

      const btn = document.getElementById('dispatchAllBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerText = '派发中...';
      }
      try {
        const res = await fetch('/api/tasks/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds: pendingTasks.map(t => t.taskId) })
        });
        const json = await res.json();
        if (json.success) {
          showToast(\`已成功派发 \${json.dispatchedCount} 份作业给 agy！🚀\`);
          await refreshData();
        } else {
          showToast('批量派发失败', false);
        }
      } catch (e) {
        showToast('批量派发网络异常', false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🚀 一键派发未派发作业';
        }
      }
    }

    async function approveSubmit(taskId) {
      if (!confirm('确定将该作业正式提交到平台吗？提交后将无法修改草稿。')) return;
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId })
        });
        const json = await res.json();
        if (json.success) {
          showToast(json.msg || '已下发正式提交指令！');
          await refreshData();
        } else {
          showToast('提交处理失败：' + (json.msg || json.reason || '未知错误'), false);
        }
      } catch (e) {
        showToast('网络请求异常', false);
      }
    }

    async function syncSigninsUI() {
      const btn = document.getElementById('syncSigninsBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerText = '同步历史签到中...';
      }
      try {
        let offset = 0;
        let totalSynced = 0;
        let rounds = 0;
        let lastMsg = '';
        let abortedByRateLimit = false;

        while (rounds < 6) {
          rounds++;
          const res = await fetch('/api/signins/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset, limit: 5 })
          });
          const json = await res.json();
          totalSynced += Number(json.syncedCount || 0);
          lastMsg = json.msg || '';
          if (json.rateLimited) {
            abortedByRateLimit = true;
            break;
          }
          if (!json.hasMore || typeof json.nextOffset !== 'number' || json.nextOffset <= offset) {
            break;
          }
          offset = json.nextOffset;
        }

        if (abortedByRateLimit && totalSynced === 0) {
          showToast(lastMsg || '触发学习通频控，请稍后再试', false);
        } else {
          showToast(totalSynced > 0 ? \`成功回溯同步 \${totalSynced} 条历史签到记录！\` : (lastMsg || '已完成全课签到记录核对'));
        }
        await refreshData();
      } catch (e) {
        showToast('同步历史签到请求异常', false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🔄 同步历史签到';
        }
      }
    }

    async function refreshCourses() {
      const btn = document.getElementById('syncCoursesBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerText = '同步中...';
      }
      try {
        const res = await fetch('/api/courses/refresh', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast(\`成功同步 \${json.count} 门在读课程！\`);
          await refreshData();
        } else {
          showToast('课程同步失败：' + (json.msg || '网络异常'), false);
        }
      } catch (e) {
        showToast('课程同步请求异常', false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🔄 刷新超星课程';
        }
      }
    }

    // 页面加载自动获取首次数据
    refreshData();
    // 每 30 秒自动轮询一次看板
    setInterval(refreshData, 30000);
  </script>
</body>
</html>`;
}
