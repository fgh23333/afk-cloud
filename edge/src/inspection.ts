import {
  checkHomeworkPendingCourses,
  fetchNoticeList,
  getCourses,
  login,
  performSign,
  resolveSignLocations,
  scanCourseActivitiesWithMeta,
  UserSession,
} from './chaoxing';
import { scanDiscussionsBatch } from './discussions';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import {
  getCachedSession,
  hasTrackedHomeworkForCourse,
  logExecution,
  nowUtc8,
  saveCachedSession,
  saveEnrolledCourses,
  saveNotices,
} from './store';

export interface SignState {
  lastCheckedAt?: string;
  lastSignAt?: string;
  activeActivitiesCount: number;
  recentSignedIds?: string[];
  rateLimitUntilMs?: number;
  rateLimitNotifiedAtMs?: number;
  roundRobinCursor?: number;
  discussionCursor?: number;
  lastNoticeCheckMs?: number;
  lastHomeworkCheckMs?: number;
  lastDiscussionCheckMs?: number;
  lastNightMobileCheckMs?: number;
  lastCourseSyncMs?: number;
  seenClassActivityIds?: string[];
}

export interface InspectionOptions {
  force?: boolean;
  bypassCooldown?: boolean;
  scanDiscussions?: boolean;
  checkHomework?: boolean;
  state?: SignState;
  onStateUpdate?: (nextState: SignState) => void;
}

export interface InspectionSummary {
  success: boolean;
  msg: string;
  time: string;
  sessionFromCache: boolean;
  coursesCount: number;
  signsFound: number;
  signsExecuted: string[];
  classActivitiesFound: number;
  homeworkFound: number;
  homeworkCoursesDetected: string[];
  noticesFound: number;
  discussionsFound: number;
  newDiscussionsFound: number;
  rateLimited: boolean;
  cooldownActive: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runChaoxingInspectionCycle(
  env: ExtendedNotifyEnv,
  options: InspectionOptions = {}
): Promise<InspectionSummary> {
  const phone = env.CHAOXING_PHONE || env.PHONE || '';
  const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
  const realname = env.CHAOXING_REALNAME || '同学';

  const baseResult: InspectionSummary = {
    success: false,
    msg: '',
    time: nowUtc8(),
    sessionFromCache: false,
    coursesCount: 0,
    signsFound: 0,
    signsExecuted: [],
    classActivitiesFound: 0,
    homeworkFound: 0,
    homeworkCoursesDetected: [],
    noticesFound: 0,
    discussionsFound: 0,
    newDiscussionsFound: 0,
    rateLimited: false,
    cooldownActive: false,
  };

  if (!phone || !password) {
    return {
      ...baseResult,
      msg: '未配置学习通账号凭据 (CHAOXING_PHONE/CHAOXING_PASSWORD)',
    };
  }

  let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
  let sessionFromCache = true;
  if (!session) {
    session = await login(phone, password);
    sessionFromCache = false;
    if (!session) {
      await logExecution(env, 'error', 'chaoxing', '登录失败，请检查账号密码');
      return { ...baseResult, msg: '学习通登录失败' };
    }
    await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
  }

  let courses = await getCourses(session);
  if (courses.length === 0 && sessionFromCache) {
    const fresh = await login(phone, password);
    if (fresh) {
      session = fresh;
      sessionFromCache = false;
      await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
      courses = await getCourses(session);
    }
  }

  if (courses.length === 0) {
    return {
      ...baseResult,
      success: true,
      sessionFromCache,
      msg: '未获取到学期课程列表',
    };
  }

  const nowMs = Date.now();
  const prevState: SignState = options.state || { activeActivitiesCount: 0, recentSignedIds: [] };
  const force = Boolean(options.force);
  const bypassCooldown = Boolean(options.bypassCooldown);

  // 每 60 分钟同步一次在读课程快照到 D1，减少无效写操作
  let lastCourseSyncMs = prevState.lastCourseSyncMs || 0;
  if (force || nowMs - lastCourseSyncMs >= 60 * 60 * 1000) {
    await saveEnrolledCourses(env, courses).catch(() => 0);
    lastCourseSyncMs = nowMs;
  }

  const recentSigned = new Set(prevState.recentSignedIds || []);
  const seenClassActs = new Set(prevState.seenClassActivityIds || []);
  let roundRobinCursor = prevState.roundRobinCursor || 0;
  let rateLimitUntilMs = prevState.rateLimitUntilMs || 0;
  let rateLimitNotifiedAtMs = prevState.rateLimitNotifiedAtMs || 0;
  let lastNightMobileCheckMs = prevState.lastNightMobileCheckMs || 0;

  const utc8 = new Date(nowMs + 8 * 3600 * 1000);
  const hhmm = utc8.getUTCHours() * 100 + utc8.getUTCMinutes();
  const isQuietNight = hhmm >= 0 && hhmm < 715; // 00:00 - 07:14 UTC+8

  let cooldownActive = !bypassCooldown && rateLimitUntilMs > nowMs;
  let shouldScanMobile = !cooldownActive;
  if (shouldScanMobile && isQuietNight && !force) {
    if (nowMs - lastNightMobileCheckMs < 15 * 60 * 1000) {
      shouldScanMobile = false;
    }
  }

  let signsHandled = 0;
  let classActivitiesFound = 0;
  let hitRateLimit = false;
  const signsExecuted: string[] = [];

  if (shouldScanMobile) {
    const customLocations = resolveSignLocations(env);
    const targetCourses = courses.length > 20 ? courses.slice(0, 20) : courses;
    const batchSize = force ? targetCourses.length : Math.min(6, targetCourses.length);
    const startIdx = force ? 0 : roundRobinCursor % targetCourses.length;
    if (isQuietNight) {
      lastNightMobileCheckMs = nowMs;
    }

    for (let step = 0; step < batchSize; step++) {
      const idx = (startIdx + step) % targetCourses.length;
      const course = targetCourses[idx];

      if (step > 0) {
        await sleep(180);
      }

      try {
        const scanRes = await scanCourseActivitiesWithMeta(course, session);
        if (scanRes.rateLimited) {
          hitRateLimit = true;
          cooldownActive = true;
          roundRobinCursor = (idx + 1) % targetCourses.length;
          rateLimitUntilMs = nowMs + 15 * 60 * 1000;

          if (!rateLimitNotifiedAtMs || nowMs - rateLimitNotifiedAtMs >= 14 * 60 * 1000) {
            rateLimitNotifiedAtMs = nowMs;
            await logExecution(
              env,
              'rate_limit',
              'chaoxing',
              `移动端活动接口触发频控 (${scanRes.errorMsg || '请勿频繁操作'})，已启动 15 分钟自动退避冷却`,
              { courseId: course.courseId, nextRetryAfterMin: 15 }
            );
          }
          break;
        }

        // 处理签到活动
        for (const act of scanRes.activities) {
          const actIdStr = String(act.id);
          if (recentSigned.has(actIdStr)) continue;

          console.log(`[Inspection] 发现课程《${course.courseName}》签到活动: ${act.name} (ID: ${act.id})`);
          const signRes = await performSign(act, course, session, realname, customLocations);
          const success = signRes.includes('成功') || signRes.includes('已签');
          signsHandled++;
          signsExecuted.push(`《${course.courseName}》: ${signRes}`);

          if (success) {
            recentSigned.add(actIdStr);
          }

          await logExecution(
            env,
            success ? 'sign_success' : 'sign_fail',
            'chaoxing',
            `课程《${course.courseName}》[${act.name}]: ${signRes}`,
            { courseId: course.courseId, classId: course.classId, activeId: act.id }
          );

          await sendNotification(
            `学习通签到${success ? '成功 ✅' : '异常 ⚠️'}`,
            `课程：《${course.courseName}》\n活动：${act.name}\n状态：${signRes}\n时间：${nowUtc8()}`,
            env
          );
        }

        // 处理随堂非签到互动（如课堂主题讨论/抢答/问卷）
        for (const cAct of scanRes.classActivities) {
          if (seenClassActs.has(cAct.id)) continue;
          seenClassActs.add(cAct.id);
          classActivitiesFound++;

          await logExecution(
            env,
            'class_activity_detected',
            'chaoxing',
            `发现随堂课堂活动：《${cAct.courseName}》[${cAct.name}]`,
            cAct
          );
          await sendNotification(
            '发现学习通随堂课堂活动 🔔',
            `课程：《${cAct.courseName}》\n活动：${cAct.name} (type=${cAct.activeType})\n入口：${cAct.url}`,
            env
          );
        }
      } catch (err: any) {
        console.warn(`[Inspection] 扫描课程《${course.courseName}》异常: ${err?.message || err}`);
      }
    }

    if (!hitRateLimit && targetCourses.length > 0) {
      roundRobinCursor = (startIdx + batchSize) % targetCourses.length;
      if (rateLimitUntilMs && rateLimitUntilMs <= nowMs) {
        rateLimitUntilMs = 0;
      }
    }
  }

  // 作业红点探测（按间隔节流，避免每分钟重复打红点接口或写入虚假占位任务）
  const hwIntervalMin = Math.max(1, parseInt(env.HOMEWORK_SCAN_INTERVAL_MINUTES || '10', 10));
  const hwIntervalMs = hwIntervalMin * 60 * 1000;
  let lastHomeworkCheckMs = prevState.lastHomeworkCheckMs || 0;
  let homeworkCount = 0;
  const homeworkCoursesDetected: string[] = [];

  if (force || options.checkHomework || nowMs - lastHomeworkCheckMs >= hwIntervalMs) {
    lastHomeworkCheckMs = nowMs;
    try {
      const pendingCourses = await checkHomeworkPendingCourses(courses, session);
      for (const pc of pendingCourses) {
        homeworkCoursesDetected.push(pc.courseName);
        const alreadyTracked = await hasTrackedHomeworkForCourse(env, pc.courseId);
        if (alreadyTracked) continue;

        if ((env.AFK_SHIM_URL || env.SHIM_URL) && env.SOLVER_AGENT) {
          const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
          const jobId = `chaoxing-hw-${pc.courseId}-${pc.classId || Date.now()}`;
          const taskUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${pc.courseId}&classId=${pc.classId}&cpi=${pc.cpi || ''}&workId=`;
          const title = `《${pc.courseName}》待办作业`;

          const enqueueRes: any = await (solverStub as any).enqueue({
            jobId,
            platform: 'chaoxing',
            taskUrl,
            courseName: pc.courseName,
            title,
          });

          if (enqueueRes?.accepted) {
            homeworkCount++;
            await sendNotification(
              'afk-cloud 发现新作业待办',
              `课程：《${pc.courseName}》\n作业：${title}\n任务已自动入队派发求解。`,
              env
            );
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Inspection] 作业红点探测异常: ${err?.message || err}`);
    }
  }

  // 通知箱抓取（每 5 分钟节流一次，避免无意义高频刷通知接口）
  let lastNoticeCheckMs = prevState.lastNoticeCheckMs || 0;
  let noticesFound = 0;
  if (force || nowMs - lastNoticeCheckMs >= 5 * 60 * 1000) {
    lastNoticeCheckMs = nowMs;
    try {
      const noticeList = await fetchNoticeList(session, 20);
      if (noticeList.length > 0) {
        noticesFound = await saveNotices(env, noticeList);
      }
    } catch (err: any) {
      console.warn(`[Inspection] 通知箱抓取异常: ${err?.message || err}`);
    }
  }

  // 课程讨论区（bbscircle）轮转巡检（不走 mobilelearn，不受移动端限流影响）
  let discussionCursor = prevState.discussionCursor || 0;
  let lastDiscussionCheckMs = prevState.lastDiscussionCheckMs || 0;
  let discussionsFound = 0;
  let newDiscussionsFound = 0;

  if (force || options.scanDiscussions || nowMs - lastDiscussionCheckMs >= hwIntervalMs) {
    lastDiscussionCheckMs = nowMs;
    try {
      const discSummary = await scanDiscussionsBatch(env, session, courses, {
        realname,
        offset: discussionCursor,
        limit: force ? 9 : 6,
        notifyOnNew: true,
      });
      discussionCursor = discSummary.nextOffset;
      discussionsFound = discSummary.topicsFound;
      newDiscussionsFound = discSummary.newPendingTopics;
    } catch (err: any) {
      console.warn(`[Inspection] 课程讨论区巡检异常: ${err?.message || err}`);
    }
  }

  if (options.onStateUpdate) {
    options.onStateUpdate({
      lastCheckedAt: nowUtc8(),
      lastSignAt: signsHandled > 0 ? nowUtc8() : prevState.lastSignAt,
      activeActivitiesCount: signsHandled,
      recentSignedIds: Array.from(recentSigned).slice(-50),
      seenClassActivityIds: Array.from(seenClassActs).slice(-50),
      roundRobinCursor,
      discussionCursor,
      rateLimitUntilMs,
      rateLimitNotifiedAtMs,
      lastNoticeCheckMs,
      lastHomeworkCheckMs,
      lastDiscussionCheckMs,
      lastNightMobileCheckMs,
      lastCourseSyncMs,
    });
  }

  const msgParts = [
    `签到 ${signsHandled} 次`,
    `课堂互动 ${classActivitiesFound} 项`,
    `讨论贴 ${discussionsFound} 项(新增待拟稿 ${newDiscussionsFound})`,
    `通知 ${noticesFound} 条`,
  ];
  if (cooldownActive) {
    msgParts.push('移动端处于频控退避冷却中');
  }

  return {
    success: true,
    msg: `巡检完成: ${msgParts.join(', ')}`,
    time: nowUtc8(),
    sessionFromCache,
    coursesCount: courses.length,
    signsFound: signsHandled,
    signsExecuted,
    classActivitiesFound,
    homeworkFound: homeworkCount,
    homeworkCoursesDetected,
    noticesFound,
    discussionsFound,
    newDiscussionsFound,
    rateLimited: hitRateLimit,
    cooldownActive,
  };
}
