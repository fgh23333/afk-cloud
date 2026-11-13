/**
 * 超星学习通移动端课堂活动（签到、课堂讨论、抢答、问卷等）跨运行时扫描协议
 * 零 Node 专有依赖，供 Cloudflare Workers Edge 与本地 Node Adapter 共同复用。
 */

export interface ChaoxingActivityTarget {
  courseId: string;
  classId: string;
  courseName?: string;
}

export interface ParsedSignActivity {
  id: string;
  name: string;
  nameOne: string;
  courseId: string;
  classId: string;
  otherId?: number;
  status: number;
  activeType: number;
  ifphoto?: number;
}

export interface ParsedClassActivity {
  id: string;
  name: string;
  activeType: number;
  courseId: string;
  classId: string;
  courseName: string;
  url: string;
}

export interface ScanActivitiesResult {
  activities: ParsedSignActivity[];
  classActivities: ParsedClassActivity[];
  rateLimited: boolean;
  errorMsg?: string;
}

export function isChaoxingRateLimitMessage(msg?: string, statusCode?: number): boolean {
  if (statusCode === 429) return true;
  if (!msg) return false;
  return /频繁|请稍后|操作过快|rate\s*limit|too\s*many/i.test(String(msg));
}

export function classifyActiveList(
  rawList: any[],
  course: ChaoxingActivityTarget
): { activities: ParsedSignActivity[]; classActivities: ParsedClassActivity[] } {
  const activities: ParsedSignActivity[] = [];
  const classActivities: ParsedClassActivity[] = [];
  const seenIds = new Set<string>();

  for (const item of rawList) {
    if (!item || item.id === undefined || item.id === null) continue;
    const id = String(item.id);
    if (seenIds.has(id) || item.status !== 1) continue;
    seenIds.add(id);

    const activeType = Number(item.activeType ?? item.type ?? 0);
    const nameOne = String(item.nameOne || item.name || '').trim();
    const isSign =
      activeType === 2 ||
      nameOne.includes('签到') ||
      (item.otherId !== undefined && item.otherId !== null && String(item.otherId) !== '');

    if (isSign) {
      activities.push({
        id,
        name: nameOne || '签到',
        nameOne: nameOne || '签到',
        courseId: course.courseId,
        classId: course.classId,
        otherId: item.otherId !== undefined ? Number(item.otherId) : undefined,
        status: item.status,
        activeType: activeType || 2,
        ifphoto: item.ifphoto !== undefined ? Number(item.ifphoto) : undefined,
      });
    } else {
      classActivities.push({
        id,
        name: nameOne || `课堂活动(type=${activeType})`,
        activeType,
        courseId: course.courseId,
        classId: course.classId,
        courseName: course.courseName || `课程_${course.courseId}`,
        url: `https://mobilelearn.chaoxing.com/page/active/student/activeDetail?activePrimaryId=${id}&courseId=${course.courseId}&classId=${course.classId}`,
      });
    }
  }

  return { activities, classActivities };
}

/**
 * 扫描单门课程的课堂活动：
 * 1. 首选 taskactivelist；若返回“请勿频繁操作”或 HTTP 429，立即熔断返回 rateLimited=true（绝不二次请求 student/activelist 加剧风控）。
 * 2. 仅当首选通道出现非频控网络/解析失败时，才尝试备选通道 student/activelist。
 */
export async function scanCourseActivitiesShared(
  course: ChaoxingActivityTarget,
  cookieStr: string,
  uid: string,
  mobileUa: string
): Promise<ScanActivitiesResult> {
  // 1. 首选通道：taskactivelist
  try {
    const url = `https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist?courseId=${course.courseId}&classId=${course.classId}&uid=${uid}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const json: any = await res.json().catch(() => ({}));

    if (json?.result === 1 && Array.isArray(json?.activeList)) {
      const classified = classifyActiveList(json.activeList, course);
      return { ...classified, rateLimited: false };
    }

    const errMsg = json?.errorMsg ? String(json.errorMsg) : undefined;
    if (isChaoxingRateLimitMessage(errMsg, res.status)) {
      return {
        activities: [],
        classActivities: [],
        rateLimited: true,
        errorMsg: errMsg || `HTTP ${res.status}`,
      };
    }

    if (errMsg) {
      console.warn(
        `[scanCourseActivities] taskactivelist 响应提示: ${errMsg} (课程: ${course.courseName || course.courseId})`
      );
    }
  } catch (err: any) {
    console.warn(`[scanCourseActivities] taskactivelist 异常: ${err?.message || err}，尝试降级通道`);
  }

  // 2. 备选通道：仅在非频控场景下回退至 student/activelist
  try {
    const url = `https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist?fid=0&courseId=${course.courseId}&classId=${course.classId}&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const json: any = await res.json().catch(() => ({}));

    if (json?.result === 1 && Array.isArray(json?.data?.activeList)) {
      const classified = classifyActiveList(json.data.activeList, course);
      return { ...classified, rateLimited: false };
    }

    const errMsg = json?.errorMsg ? String(json.errorMsg) : undefined;
    if (isChaoxingRateLimitMessage(errMsg, res.status)) {
      return {
        activities: [],
        classActivities: [],
        rateLimited: true,
        errorMsg: errMsg || `HTTP ${res.status}`,
      };
    }

    return {
      activities: [],
      classActivities: [],
      rateLimited: false,
      errorMsg: errMsg,
    };
  } catch (err: any) {
    return {
      activities: [],
      classActivities: [],
      rateLimited: false,
      errorMsg: err?.message || String(err),
    };
  }
}
