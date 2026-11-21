import {
  CHAOXING_MOBILE_UA,
  classifyPreSignHtml,
  fetchCourseSignHistoryCandidates,
  fetchNoticeList,
  getChaoxingSignTypeLabel,
  getCourses,
  login,
  performSign,
  resolveSignLocations,
  scanCourseActivitiesWithMeta,
  scanCourseHomeworksWeb,
  UserSession,
} from './chaoxing';
import { scanDiscussionsBatch } from './discussions';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import {
  formatUtc8FromMs,
  getCachedSession,
  getRecordedSignActivityIds,
  logExecution,
  nowUtc8,
  saveCachedSession,
  saveEnrolledCourses,
  saveNoticesWithEvents,
  upsertPendingTaskWithOutcome,
} from './store';

export const RATE_LIMIT_BACKOFF_MINUTES = [15, 30, 60, 120] as const;

export function escalateRateLimitBackoff(currentLevel = 0): { level: number; minutes: number } {
  const normalized = Number.isFinite(currentLevel) ? Math.max(0, Math.floor(currentLevel)) : 0;
  const nextLevel = Math.min(normalized + 1, RATE_LIMIT_BACKOFF_MINUTES.length);
  return {
    level: nextLevel,
    minutes: RATE_LIMIT_BACKOFF_MINUTES[nextLevel - 1],
  };
}

export interface Utc8TimeWindow {
  startMinutes: number;
  endMinutes: number;
}

export const DEFAULT_SIGN_LISTEN_WINDOWS = '08:15-11:40,13:00-16:20,18:00-19:35';

/**
 * 解析 UTC+8 签到监听时段列表（格式：HH:MM-HH:MM，逗号分隔；'*' 或 'all' 返回空数组表示不限时）
 */
export function parseSignListenWindows(raw?: string): Utc8TimeWindow[] {
  const source = raw === undefined || raw.trim() === '' ? DEFAULT_SIGN_LISTEN_WINDOWS : raw.trim();
  if (source === '*' || source.toLowerCase() === 'all') {
    return [];
  }
  const windows: Utc8TimeWindow[] = [];
  for (const part of source.split(/[,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const sh = Number(m[1]);
    const sm = Number(m[2]);
    const eh = Number(m[3]);
    const em = Number(m[4]);
    if (sh < 0 || sh > 23 || sm < 0 || sm > 59 || eh < 0 || eh > 23 || em < 0 || em > 59) continue;
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    if (endMinutes >= startMinutes) {
      windows.push({ startMinutes, endMinutes });
    }
  }
  return windows;
}

/**
 * 判断指定毫秒时间戳在 UTC+8 下是否处于允许的签到监听时段内
 */
export function isWithinSignListenWindows(nowMs: number, rawWindows?: string): boolean {
  const trimmed = rawWindows?.trim();
  if (trimmed === '*' || trimmed?.toLowerCase() === 'all') {
    return true;
  }
  const windows = parseSignListenWindows(rawWindows);
  if (windows.length === 0) {
    return true;
  }
  const utc8 = new Date(nowMs + 8 * 3600 * 1000);
  const minuteOfDay = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
  return windows.some((w) => minuteOfDay >= w.startMinutes && minuteOfDay <= w.endMinutes);
}

export interface SignState {
  lastCheckedAt?: string;
  lastSignAt?: string;
  activeActivitiesCount: number;
  recentSignedIds?: string[];
  rateLimitUntilMs?: number;
  rateLimitNotifiedAtMs?: number;
  rateLimitBackoffLevel?: number;
  roundRobinCursor?: number;
  discussionCursor?: number;
  lastNoticeCheckMs?: number;
  lastHomeworkCheckMs?: number;
  lastDiscussionCheckMs?: number;
  lastNightMobileCheckMs?: number;
  lastCourseSyncMs?: number;
  lastScanErrorLoggedMs?: number;
  blockedCooldownUntilMs?: number;
  homeworkCursor?: number;
  nextMobileCheckAtMs?: number;
  seenClassActivityIds?: string[];
  recentFailedSignMap?: Record<string, number>;
}

export interface InspectionOptions {
  force?: boolean;
  bypassCooldown?: boolean;
  scanDiscussions?: boolean;
  checkHomework?: boolean;
  nowMs?: number;
  state?: SignState;
  onStateUpdate?: (nextState: SignState) => void;
  skipSleep?: boolean;
  randomFn?: () => number;
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
  homeworkScannedCourses?: number;
  noticesFound: number;
  newNoticesNotified?: number;
  discussionsFound: number;
  newDiscussionsFound: number;
  rateLimited: boolean;
  cooldownActive: boolean;
  blockedCooldownActive?: boolean;
  outsideSignWindow?: boolean;
  mobileScanThrottled?: boolean;
  rateLimitBackoffLevel?: number;
  canaryProbe?: boolean;
  scanErrors?: number;
  scanDiag?: Array<{ course: string; raw: number; sign: number; cls: number; error?: string; blocked?: boolean }>;
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
    homeworkScannedCourses: 0,
    noticesFound: 0,
    newNoticesNotified: 0,
    discussionsFound: 0,
    newDiscussionsFound: 0,
    rateLimited: false,
    cooldownActive: false,
    blockedCooldownActive: false,
    outsideSignWindow: false,
    mobileScanThrottled: false,
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

  const nowMs = options.nowMs ?? Date.now();
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
  const dbRecordedSignIds = await getRecordedSignActivityIds(env);
  for (const id of dbRecordedSignIds) {
    recentSigned.add(id);
  }
  const seenClassActs = new Set(prevState.seenClassActivityIds || []);
  const recentFailedSignMap: Record<string, number> = { ...(prevState.recentFailedSignMap || {}) };
  let roundRobinCursor = prevState.roundRobinCursor || 0;
  let rateLimitUntilMs = prevState.rateLimitUntilMs || 0;
  let rateLimitNotifiedAtMs = prevState.rateLimitNotifiedAtMs || 0;
  let rateLimitBackoffLevel = prevState.rateLimitBackoffLevel ?? (rateLimitUntilMs > 0 ? 1 : 0);
  const lastNightMobileCheckMs = prevState.lastNightMobileCheckMs || 0;
  let blockedCooldownUntilMs = prevState.blockedCooldownUntilMs || 0;
  let homeworkCursor = prevState.homeworkCursor || 0;
  let nextMobileCheckAtMs = prevState.nextMobileCheckAtMs || 0;
  const rand = options.randomFn ?? Math.random;

  const configuredBatch = parseInt(env.MOBILE_SCAN_BATCH_SIZE || '', 10);
  const defaultBatchSize =
    Number.isFinite(configuredBatch) && configuredBatch > 0 ? Math.min(20, configuredBatch) : 4;
  const intervalSecRaw = parseInt(env.MOBILE_SCAN_INTERVAL_SEC || '', 10);
  const mobileIntervalSec = Number.isFinite(intervalSecRaw) && intervalSecRaw >= 0 ? intervalSecRaw : 90;
  const jitterSecRaw = parseInt(env.MOBILE_SCAN_JITTER_SEC || '', 10);
  const mobileJitterSec = Number.isFinite(jitterSecRaw) && jitterSecRaw >= 0 ? jitterSecRaw : 60;

  const utc8 = new Date(nowMs + 8 * 3600 * 1000);
  const hhmm = utc8.getUTCHours() * 100 + utc8.getUTCMinutes();
  const isQuietNight = hhmm < 715 || hhmm >= 2230; // 22:30 - 07:14 UTC+8

  const inSignWindow = isWithinSignListenWindows(nowMs, env.SIGN_LISTEN_WINDOWS);
  const outsideSignWindow = !force && !inSignWindow;
  let cooldownActive = !bypassCooldown && rateLimitUntilMs > nowMs;
  let blockedCooldownActive = !bypassCooldown && blockedCooldownUntilMs > nowMs;
  const mobileScanThrottled =
    !force &&
    !bypassCooldown &&
    !cooldownActive &&
    !blockedCooldownActive &&
    !outsideSignWindow &&
    nextMobileCheckAtMs > nowMs;
  const shouldScanMobile = !cooldownActive && !blockedCooldownActive && !outsideSignWindow && !mobileScanThrottled;

  const isBlockedProbe = shouldScanMobile && !bypassCooldown && blockedCooldownUntilMs > 0;
  const isCanaryProbe = shouldScanMobile && !bypassCooldown && rateLimitBackoffLevel > 0;
  let signsHandled = 0;
  let classActivitiesFound = 0;
  let hitRateLimit = false;
  let scanException = false;
  const scanDiag: Array<{ course: string; raw: number; sign: number; cls: number; error?: string; blocked?: boolean }> = [];
  const scanErrors: string[] = [];
  let scanBlocked = false;
  let lastScanErrorLoggedMs = prevState.lastScanErrorLoggedMs || 0;
  const signsExecuted: string[] = [];

  if (shouldScanMobile) {
    const customLocations = resolveSignLocations(env);
    const targetCourses = courses.length > 20 ? courses.slice(0, 20) : courses;
    const batchSize =
      isCanaryProbe || isBlockedProbe
        ? 1
        : force
          ? targetCourses.length
          : Math.min(defaultBatchSize, targetCourses.length);
    const startIdx =
      isCanaryProbe || isBlockedProbe
        ? roundRobinCursor % targetCourses.length
        : force
          ? 0
          : roundRobinCursor % targetCourses.length;

    if (mobileIntervalSec > 0 || mobileJitterSec > 0) {
      const delaySec = mobileIntervalSec + Math.floor(rand() * (mobileJitterSec + 1));
      nextMobileCheckAtMs = delaySec > 0 ? nowMs + delaySec * 1000 : 0;
    } else {
      nextMobileCheckAtMs = 0;
    }

    if (!options.skipSleep && !force && mobileJitterSec > 0) {
      await sleep(500 + Math.floor(rand() * 2000));
    }

    for (let step = 0; step < batchSize; step++) {
      const idx = (startIdx + step) % targetCourses.length;
      const course = targetCourses[idx];

      if (step > 0 && !options.skipSleep) {
        const gapMs = mobileJitterSec > 0 ? 350 + Math.floor(rand() * 550) : 180;
        await sleep(gapMs);
      }

      try {
        const scanRes = await scanCourseActivitiesWithMeta(course, session);
        scanDiag.push({
          course: course.courseName,
          raw: scanRes.rawCount ?? -1,
          sign: scanRes.activities.length,
          cls: scanRes.classActivities.length,
          ...(scanRes.errorMsg ? { error: String(scanRes.errorMsg).slice(0, 120) } : {}),
          ...(scanRes.blocked ? { blocked: true } : {}),
        });
        if (scanRes.errorMsg && !scanRes.rateLimited) {
          scanErrors.push(`${course.courseName}: ${String(scanRes.errorMsg).slice(0, 120)}`);
          if (scanRes.blocked) scanBlocked = true;
        }
        if (scanRes.blocked && !scanRes.rateLimited) {
          scanBlocked = true;
          blockedCooldownActive = true;
          blockedCooldownUntilMs = nowMs + 15 * 60 * 1000;
          roundRobinCursor = (idx + 1) % targetCourses.length;
          break;
        }
        if (scanRes.rateLimited) {
          hitRateLimit = true;
          cooldownActive = true;
          roundRobinCursor = (idx + 1) % targetCourses.length;
          const nextBackoff = escalateRateLimitBackoff(rateLimitBackoffLevel);
          rateLimitBackoffLevel = nextBackoff.level;
          rateLimitUntilMs = nowMs + nextBackoff.minutes * 60 * 1000;

          if (!rateLimitNotifiedAtMs || nowMs - rateLimitNotifiedAtMs >= 14 * 60 * 1000) {
            rateLimitNotifiedAtMs = nowMs;
            await logExecution(
              env,
              'rate_limit',
              'chaoxing',
              `移动端活动接口触发频控 (${scanRes.errorMsg || '请勿频繁操作'})，已启动 ${nextBackoff.minutes} 分钟自动退避冷却 (L${rateLimitBackoffLevel})`,
              {
                courseId: course.courseId,
                nextRetryAfterMin: nextBackoff.minutes,
                backoffLevel: rateLimitBackoffLevel,
              }
            );
          }
          break;
        }

        // 处理签到活动
        for (const act of scanRes.activities) {
          const actIdStr = String(act.id);
          if (recentSigned.has(actIdStr)) continue;

          // 同一未完成签到若短时间内刚失败过（如缺签到码/不在范围），避免每分钟重复打扰与刷日志
          const lastFailedAt = recentFailedSignMap[actIdStr] || 0;
          const failSuppressWindow = lastFailedAt > 0 && nowMs - lastFailedAt < 15 * 60 * 1000;

          console.log(`[Inspection] 发现课程《${course.courseName}》签到活动: ${act.name} (ID: ${act.id})`);
          const signRes = await performSign(act, course, session, realname, customLocations);
          const isSuccess = signRes.includes('成功') || signRes.includes('已签');
          const isExpired = signRes.includes('已结束');
          const typeLabel = `${getChaoxingSignTypeLabel(act.otherId, act.ifphoto, act.name)}签到`;
          const addrMatch = signRes.match(/匹配坐标:\s*([^)]+)\)/);
          const signAddress = addrMatch
            ? addrMatch[1].trim()
            : isSuccess
              ? '学习通云端自动打卡'
              : isExpired
                ? '已过教师设置截止时间'
                : signRes.replace(/^\[[^\]]+\]\s*/, '').slice(0, 60);

          if (isSuccess || isExpired) {
            recentSigned.add(actIdStr);
            delete recentFailedSignMap[actIdStr];
          } else {
            if (failSuppressWindow) {
              continue;
            }
            recentFailedSignMap[actIdStr] = nowMs;
          }

          signsHandled++;
          signsExecuted.push(`《${course.courseName}》: ${signRes}`);

          const eventType = isSuccess ? 'sign_success' : isExpired ? 'sign_missed' : 'sign_fail';
          await logExecution(
            env,
            eventType,
            'chaoxing',
            `课程《${course.courseName}》[${act.name}]: ${signRes}`,
            {
              courseId: course.courseId,
              classId: course.classId,
              activeId: act.id,
              actName: act.name,
              signType: typeLabel,
              address: signAddress,
            }
          );

          if (!isExpired) {
            await sendNotification(
              `学习通签到${isSuccess ? '成功 ✅' : '异常 ⚠️'}`,
              `课程：《${course.courseName}》\n活动：${act.name}\n状态：${signRes}\n时间：${nowUtc8()}`,
              env
            );
          }
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
        scanException = true;
        console.warn(`[Inspection] 扫描课程《${course.courseName}》异常: ${err?.message || err}`);
      }
    }

    if (scanErrors.length > 0) {
      // 接口返回错误/被拦截绝不能被当作“没有签到”：标记异常、阻止退避复位，并限频告警（每 60 分钟一次）
      scanException = true;
      if (nowMs - lastScanErrorLoggedMs >= 60 * 60 * 1000) {
        lastScanErrorLoggedMs = nowMs;
        const failedCount = scanErrors.length;
        const total = scanDiag.length;
        await logExecution(
          env,
          'scan_error',
          'chaoxing',
          `签到监听异常：本轮 ${failedCount}/${total} 门课未能获取活动列表 (${scanErrors[0]})`,
          { failedCount, total, blocked: scanBlocked, errors: scanErrors.slice(0, 5) }
        );
        await sendNotification(
          scanBlocked ? '学习通签到监听被拦截 ⚠️' : '学习通签到监听异常 ⚠️',
          `本轮 ${failedCount}/${total} 门课未能获取活动列表，可能漏签！\n示例：${scanErrors[0]}\n时间：${nowUtc8()}`,
          env
        );
      }
    }

    if (isBlockedProbe && !hitRateLimit && !scanBlocked && !scanException) {
      blockedCooldownUntilMs = 0;
      blockedCooldownActive = false;
      await logExecution(
        env,
        'sign_listener_recovered',
        'chaoxing',
        `学习通签到监听已恢复正常 (${targetCourses[startIdx]?.courseName || 'Canary'})`
      );
      await sendNotification(
        '学习通签到监听已恢复 ✅',
        `边缘探测已恢复正常，将继续自动轮转扫描课程签到活动。\n时间：${nowUtc8()}`,
        env
      );
    } else if (!hitRateLimit && !scanBlocked && !scanException && blockedCooldownUntilMs > 0) {
      blockedCooldownUntilMs = 0;
      blockedCooldownActive = false;
    }

    if (!hitRateLimit && !scanBlocked && targetCourses.length > 0) {
      roundRobinCursor = (startIdx + batchSize) % targetCourses.length;
      if (!scanException) {
        rateLimitUntilMs = 0;
        rateLimitBackoffLevel = 0;
      }
    }
  }

  // 网页端作业轮转巡检（使用 stucoursemiddle -> /work/getAllWork 替代已 404 的 workTestPendingNew）
  const hwIntervalMin = Math.max(1, parseInt(env.HOMEWORK_SCAN_INTERVAL_MINUTES || '10', 10));
  const hwIntervalMs = hwIntervalMin * 60 * 1000;
  let lastHomeworkCheckMs = prevState.lastHomeworkCheckMs || 0;
  let homeworkCount = 0;
  let homeworkScannedCourses = 0;
  const homeworkCoursesDetected: string[] = [];

  if (force || options.checkHomework || nowMs - lastHomeworkCheckMs >= hwIntervalMs) {
    lastHomeworkCheckMs = nowMs;
    try {
      const hwBatchLimit = force ? Math.min(5, courses.length) : Math.min(4, courses.length);
      const hwStart = courses.length > 0 ? homeworkCursor % courses.length : 0;
      for (let i = 0; i < hwBatchLimit; i++) {
        const course = courses[(hwStart + i) % courses.length];
        const items = await scanCourseHomeworksWeb(course, session, nowMs);
        homeworkScannedCourses++;
        for (const hw of items) {
          if (!hw.isPending || hw.isExpired) continue;
          if (!homeworkCoursesDetected.includes(course.courseName)) {
            homeworkCoursesDetected.push(course.courseName);
          }
          const outcome = await upsertPendingTaskWithOutcome(env, {
            taskId: `chaoxing-notice-work-${hw.workId}-${course.classId}`,
            platform: 'chaoxing',
            courseId: course.courseId,
            classId: course.classId,
            courseName: course.courseName,
            title: hw.title,
            deadline: hw.endDate || '',
            payload: {
              url: hw.taskUrl,
              workId: hw.workId,
              type: 'homework_web_scan',
              statusText: hw.statusText,
            },
          });
          if (outcome.created) {
            homeworkCount++;
            await logExecution(
              env,
              'homework_detected',
              'chaoxing',
              `网页巡检发现新待做作业：《${course.courseName} - ${hw.title}》 (截止: ${hw.endDate || '无'})`,
              { taskId: outcome.taskId, workId: hw.workId, courseId: course.courseId, classId: course.classId }
            );
            await sendNotification(
              'afk-cloud 发现新作业 📚',
              `课程：《${course.courseName}》\n作业：${hw.title}\n状态：${hw.statusText}\n截止：${hw.endDate || '无截止时间'}\n已写入待办队列准备自动处理。`,
              env
            );
          }
        }
      }
      if (courses.length > 0) {
        homeworkCursor = (hwStart + hwBatchLimit) % courses.length;
      }
    } catch (err: any) {
      console.warn(`[Inspection] 网页端作业巡检异常: ${err?.message || err}`);
    }
  }

  // 通知箱抓取（白天每 2 分钟 / 夜间每 5 分钟）
  const noticeIntervalMs = isQuietNight ? 5 * 60 * 1000 : 2 * 60 * 1000;
  let lastNoticeCheckMs = prevState.lastNoticeCheckMs || 0;
  let noticesFound = 0;
  let newNoticesNotified = 0;
  if (force || nowMs - lastNoticeCheckMs >= noticeIntervalMs) {
    lastNoticeCheckMs = nowMs;
    try {
      const noticeList = await fetchNoticeList(session, 20);
      if (noticeList.length > 0) {
        const noticeOutcome = await saveNoticesWithEvents(env, noticeList, nowMs);
        noticesFound = noticeOutcome.savedCount;

        for (const rt of noticeOutcome.reopenedTasks) {
          homeworkCount++;
          if (env.SOLVER_AGENT) {
            try {
              const solverStub = env.SOLVER_AGENT.get(env.SOLVER_AGENT.idFromName('default'));
              await (solverStub as any).syncExternalTaskStatus(rt.taskId, 'pending', rt.reason);
            } catch {
              // ignore DO sync error
            }
          }
          await logExecution(
            env,
            'homework_returned',
            'chaoxing',
            `检测到作业被打回重做：《${rt.courseName} - ${rt.title}》 (截止: ${rt.endTime || '未知'})`,
            rt
          );
          await sendNotification(
            '⚠️ 学习通作业被打回重做',
            `课程：《${rt.courseName}》\n作业：${rt.title}\n截止：${rt.endTime || '请登录查看'}\n已重新激活待处理状态，请及时确认！`,
            env
          );
        }

        const kindMeta: Record<string, { event: string; title: string }> = {
          activity: { event: 'notice_activity', title: '学习通随堂活动提醒 🔔' },
          exam: { event: 'notice_exam', title: '学习通考试/测验通知 📝' },
          homework: { event: 'notice_homework', title: '学习通新作业通知 📚' },
          important: { event: 'notice_important', title: '学习通重要课程通知 📢' },
        };
        for (const nn of noticeOutcome.newNotices.slice(0, 5)) {
          const meta = kindMeta[nn.kind] || kindMeta.important;
          await logExecution(
            env,
            meta.event,
            'chaoxing',
            `${nn.courseName ? `《${nn.courseName}》` : ''}${nn.title}: ${nn.content.slice(0, 100)}`,
            nn
          );
          const lines = [
            nn.courseName ? `课程：《${nn.courseName}》` : '',
            `标题：${nn.title}`,
            nn.deadline ? `截止：${nn.deadline}` : '',
            `内容：${nn.content}`,
            nn.url ? `入口：${nn.url}` : '',
            `发布时间：${nn.sendTime}`,
          ].filter(Boolean);
          await sendNotification(meta.title, lines.join('\n'), env);
          newNoticesNotified++;
        }
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
        limit: force ? 6 : 5,
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
    const prunedFailedMap: Record<string, number> = {};
    for (const [k, ts] of Object.entries(recentFailedSignMap).slice(-30)) {
      if (nowMs - ts < 2 * 60 * 60 * 1000) {
        prunedFailedMap[k] = ts;
      }
    }
    options.onStateUpdate({
      lastCheckedAt: nowUtc8(),
      lastSignAt: signsHandled > 0 ? nowUtc8() : prevState.lastSignAt,
      activeActivitiesCount: signsHandled,
      recentSignedIds: Array.from(recentSigned).slice(-50),
      seenClassActivityIds: Array.from(seenClassActs).slice(-50),
      recentFailedSignMap: prunedFailedMap,
      roundRobinCursor,
      discussionCursor,
      homeworkCursor,
      rateLimitUntilMs,
      rateLimitNotifiedAtMs,
      rateLimitBackoffLevel,
      lastNoticeCheckMs,
      lastHomeworkCheckMs,
      lastDiscussionCheckMs,
      lastNightMobileCheckMs,
      lastCourseSyncMs,
      lastScanErrorLoggedMs,
      blockedCooldownUntilMs,
      nextMobileCheckAtMs,
    });
  }

  const msgParts = [
    `签到 ${signsHandled} 次`,
    `课堂互动 ${classActivitiesFound} 项`,
    `讨论贴 ${discussionsFound} 项(新增待拟稿 ${newDiscussionsFound})`,
    `通知 ${noticesFound} 条`,
  ];
  if (outsideSignWindow) {
    msgParts.push('非上课监听时段(仅巡检作业/讨论/通知)');
  } else if (cooldownActive) {
    msgParts.push(`移动端处于频控退避冷却中(L${rateLimitBackoffLevel})`);
  } else if (blockedCooldownActive) {
    msgParts.push('移动端 IP 封禁冷却中(15m 自动试探)');
  } else if (mobileScanThrottled) {
    msgParts.push('移动端随机间隔等待中');
  } else if (isCanaryProbe && !hitRateLimit && !scanException) {
    msgParts.push('移动端 Canary 试探成功并恢复轮转');
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
    homeworkScannedCourses,
    noticesFound,
    newNoticesNotified,
    discussionsFound,
    newDiscussionsFound,
    rateLimited: hitRateLimit,
    cooldownActive,
    blockedCooldownActive,
    outsideSignWindow,
    mobileScanThrottled,
    rateLimitBackoffLevel,
    canaryProbe: isCanaryProbe,
    scanErrors: scanErrors.length,
    scanDiag,
  };
}

export interface SignHistorySyncResult {
  success: boolean;
  msg: string;
  scannedCourses: number;
  totalCourses: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
  syncedCount: number;
  alreadyKnownCount: number;
  rateLimited: boolean;
  records: Array<{
    activeId: string;
    courseName: string;
    name: string;
    type: string;
    result: string;
    time: string;
  }>;
}

/**
 * 分批回溯学习通全课历史签到记录（基于 taskactivelist status=1/2 + preSign 状态检查）
 * 控制单次子请求在 Cloudflare Workers 免费额度上限内（每批 <= 6 门课、<= 15 次 preSign 探测）。
 */
export async function syncChaoxingSignHistory(
  env: ExtendedNotifyEnv,
  options: { offset?: number; limit?: number } = {}
): Promise<SignHistorySyncResult> {
  const phone = env.CHAOXING_PHONE || env.PHONE || '';
  const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));

  const empty: SignHistorySyncResult = {
    success: false,
    msg: '',
    scannedCourses: 0,
    totalCourses: 0,
    offset,
    nextOffset: offset,
    hasMore: false,
    syncedCount: 0,
    alreadyKnownCount: 0,
    rateLimited: false,
    records: [],
  };

  if (!phone || !password) {
    return { ...empty, msg: '未配置学习通账号凭据' };
  }

  let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
  if (!session) {
    session = await login(phone, password);
    if (session) await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
  }
  if (!session) {
    return { ...empty, msg: '学习通登录失败' };
  }

  let courses = await getCourses(session);
  if (courses.length === 0) {
    const fresh = await login(phone, password);
    if (fresh) {
      session = fresh;
      await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
      courses = await getCourses(session);
    }
  }
  if (courses.length === 0) {
    return { ...empty, success: true, msg: '未获取到学期课程列表' };
  }

  const targetSlice = courses.slice(offset, offset + limit);
  const knownIds = await getRecordedSignActivityIds(env, 300);
  let scannedCourses = 0;
  let alreadyKnownCount = 0;
  let rateLimited = false;
  let preSignBudget = 16;
  const records: SignHistorySyncResult['records'] = [];

  for (let i = 0; i < targetSlice.length; i++) {
    if (preSignBudget <= 0) break;
    if (i > 0) await sleep(180);
    const course = targetSlice[i];
    const scanRes = await fetchCourseSignHistoryCandidates(
      course,
      session.cookie,
      session._uid,
      CHAOXING_MOBILE_UA
    );
    if (scanRes.rateLimited) {
      rateLimited = true;
      break;
    }

    // 最新活动优先，避免旧记录挤占 preSign 预算
    const sorted = [...scanRes.candidates].sort((a, b) => (b.startTimeMs || 0) - (a.startTimeMs || 0));
    let exhaustedMidCourse = false;
    for (const act of sorted) {
      if (knownIds.has(act.id)) {
        alreadyKnownCount++;
        continue;
      }
      if (preSignBudget <= 0) {
        exhaustedMidCourse = true;
        break;
      }
      preSignBudget--;

      await sleep(120);
      const preUrl = `https://mobilelearn.chaoxing.com/newsign/preSign?courseId=${course.courseId}&classId=${course.classId}&activePrimaryId=${act.id}&general=1&sys=1&ls=1&appType=15&uid=${session._uid}&ut=s`;
      let preHtml = '';
      try {
        const preRes = await fetch(preUrl, {
          headers: {
            Cookie: session.cookie,
            'User-Agent': CHAOXING_MOBILE_UA,
          },
        });
        preHtml = await preRes.text().catch(() => '');
      } catch {
        continue;
      }

      const preStatus = classifyPreSignHtml(preHtml);
      if (preStatus.state === 'pending' && act.status === 1) {
        // 仍在进行中的签到交给自动巡检执行，不提前写为历史记录
        continue;
      }

      const isSigned = preStatus.state === 'already_signed';
      const eventType = isSigned ? 'sign_success' : 'sign_missed';
      const typeLabel = `${getChaoxingSignTypeLabel(act.otherId, act.ifphoto, act.name)}签到`;
      const resultText = isSigned ? '签到成功' : '已截止未签到';
      const address = isSigned ? '历史同步 · 已完成签到' : '已过教师设置截止时间';
      const createdAt = formatUtc8FromMs(act.startTimeMs) || nowUtc8();

      knownIds.add(act.id);
      await logExecution(
        env,
        eventType,
        'chaoxing',
        `[历史同步] 课程《${course.courseName}》[${act.name}]: [${typeLabel}] ${resultText} (${address})`,
        {
          courseId: course.courseId,
          classId: course.classId,
          activeId: act.id,
          actName: act.name,
          signType: typeLabel,
          address,
          source: 'history_sync',
          startTimeMs: act.startTimeMs,
        },
        createdAt
      );

      records.push({
        activeId: act.id,
        courseName: course.courseName,
        name: act.name,
        type: typeLabel,
        result: resultText,
        time: createdAt,
      });
    }

    if (!exhaustedMidCourse || scannedCourses === 0) {
      scannedCourses++;
    }
    if (preSignBudget <= 0) break;
  }

  const nextOffset = offset + scannedCourses;
  const hasMore = !rateLimited && nextOffset < courses.length;
  const msg = rateLimited
    ? `同步触发超星频控，已暂停（已扫描 ${scannedCourses} 门课，新增 ${records.length} 条记录）`
    : `已扫描 ${scannedCourses} 门课，新同步 ${records.length} 条历史签到记录（已存在 ${alreadyKnownCount} 条）`;

  return {
    success: !rateLimited || records.length > 0,
    msg,
    scannedCourses,
    totalCourses: courses.length,
    offset,
    nextOffset,
    hasMore,
    syncedCount: records.length,
    alreadyKnownCount,
    rateLimited,
    records,
  };
}
