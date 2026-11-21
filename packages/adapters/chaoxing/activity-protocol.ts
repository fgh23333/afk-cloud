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
  /** 接口原始返回的活动条数（用于区分“真的没有活动”与“接口被拦截/返回空”） */
  rawCount?: number;
  /** 超星返回 IP 被封禁/代理拦截等非频控类拒绝（不会触发退避冷却，但必须对外告警） */
  blocked?: boolean;
}

export function isChaoxingBlockedMessage(msg?: string): boolean {
  if (!msg) return false;
  return /已被封禁|API_ACCESS_BLOCKED|请勿使用vpn|请勿使用.*代理/i.test(String(msg));
}

export interface ParsedSignHistoryCandidate {
  id: string;
  name: string;
  courseId: string;
  classId: string;
  courseName: string;
  status: number;
  activeType: number;
  otherId?: number;
  ifphoto?: number;
  startTimeMs?: number;
  endTimeMs?: number;
}

export interface PreSignInspectionResult {
  state: 'already_signed' | 'expired' | 'auth_required' | 'pending';
  message: string;
  title?: string;
}

export function stripChaoxingHtmlTags(input: string): string {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getChaoxingSignTypeLabel(otherId?: number, ifphoto?: number, actName = ''): string {
  if (otherId === 4 || actName.includes('位置')) return '位置';
  if (ifphoto === 1 || actName.includes('拍照')) return '拍照';
  if (otherId === 3 || actName.includes('手势')) return '手势';
  if (otherId === 5 || actName.includes('签到码')) return '签到码';
  if (otherId === 2 || actName.includes('二维码')) return '二维码';
  return '通用';
}

export function isSignSubmissionSuccess(text: string): boolean {
  const plain = stripChaoxingHtmlTags(text);
  if (!plain) return false;
  if (/success|成功|您已签到|重复签到|已经签到/i.test(plain)) return true;
  return /(?:^|[^未尚])已签/.test(plain);
}

export function classifyPreSignHtml(html: string): PreSignInspectionResult {
  const titleMatch = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripChaoxingHtmlTags(titleMatch[1]) : undefined;
  const plain = stripChaoxingHtmlTags(html);

  if (!plain) {
    return { state: 'pending', message: '', title };
  }
  if (/请先登录|登录超时|重新登录/.test(plain)) {
    return { state: 'auth_required', message: '登录状态已失效', title };
  }
  if (/签到成功|您已签到|重复签到|已经签到/.test(plain) || /(?:^|[^未尚])已签到/.test(plain)) {
    return { state: 'already_signed', message: '已完成签到', title };
  }
  if (/已过教师设置的截止时间|签到已结束|已过期|活动已结束|已截止/.test(plain)) {
    return { state: 'expired', message: '已过教师设置的截止时间', title };
  }
  return { state: 'pending', message: plain.slice(0, 80), title };
}

function isChaoxingSignItem(item: any): { isSign: boolean; activeType: number; nameOne: string } {
  const activeType = Number(item?.activeType ?? item?.type ?? 0);
  const nameOne = String(item?.nameOne || item?.name || '').trim();
  const isSign =
    activeType === 2 ||
    nameOne.includes('签到') ||
    (item?.otherId !== undefined && item?.otherId !== null && String(item.otherId) !== '');
  return { isSign, activeType, nameOne };
}

function toOptionalMs(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    const numId = Number(item.id);
    if (!Number.isFinite(numId) || numId <= 0) continue;

    const id = String(item.id);
    if (seenIds.has(id) || item.status !== 1) continue;
    seenIds.add(id);

    const { isSign, activeType, nameOne } = isChaoxingSignItem(item);

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
    } else if (activeType !== 19 && activeType !== 5) {
      // 跳过作业/考试聚合占位 (type=19) 与已由 bbscircle 单独追踪的课程讨论贴 (type=5)
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

export function extractSignHistoryCandidates(
  rawList: any[],
  course: ChaoxingActivityTarget
): ParsedSignHistoryCandidate[] {
  const result: ParsedSignHistoryCandidate[] = [];
  const seenIds = new Set<string>();

  for (const item of rawList) {
    if (!item || item.id === undefined || item.id === null) continue;
    const numId = Number(item.id);
    if (!Number.isFinite(numId) || numId <= 0) continue;

    const id = String(item.id);
    const status = Number(item.status ?? 0);
    if (seenIds.has(id) || (status !== 1 && status !== 2)) continue;

    const { isSign, activeType, nameOne } = isChaoxingSignItem(item);
    if (!isSign) continue;
    seenIds.add(id);

    result.push({
      id,
      name: nameOne || '签到',
      courseId: course.courseId,
      classId: course.classId,
      courseName: course.courseName || `课程_${course.courseId}`,
      status,
      activeType: activeType || 2,
      otherId: item.otherId !== undefined ? Number(item.otherId) : undefined,
      ifphoto: item.ifphoto !== undefined ? Number(item.ifphoto) : undefined,
      startTimeMs: toOptionalMs(item.startTime ?? item.starttime),
      endTimeMs: toOptionalMs(item.endTime ?? item.endtime),
    });
  }

  return result;
}

export async function fetchCourseSignHistoryCandidates(
  course: ChaoxingActivityTarget,
  cookieStr: string,
  uid: string,
  mobileUa: string
): Promise<{ candidates: ParsedSignHistoryCandidate[]; rateLimited: boolean; errorMsg?: string }> {
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
      return {
        candidates: extractSignHistoryCandidates(json.activeList, course),
        rateLimited: false,
      };
    }

    const errMsg = json?.errorMsg || json?.msg ? String(json.errorMsg || json.msg) : undefined;
    if (isChaoxingRateLimitMessage(errMsg, res.status)) {
      return {
        candidates: [],
        rateLimited: true,
        errorMsg: errMsg || `HTTP ${res.status}`,
      };
    }
    return { candidates: [], rateLimited: false, errorMsg: errMsg };
  } catch (err: any) {
    return {
      candidates: [],
      rateLimited: false,
      errorMsg: err?.message || String(err),
    };
  }
}

export interface ChaoxingSignExecInput {
  activeId: string;
  actName: string;
  courseId: string;
  classId: string;
  uid: string;
  fid: string;
  cookieStr: string;
  mobileUa: string;
  name: string;
  locations: Array<{ lon: string; lat: string; address: string }>;
  otherId?: number;
  ifphoto?: number;
  enc?: string;
  objectId?: string;
  signCode?: string;
  resolvePhotoObjectId?: () => Promise<string | null>;
}

/**
 * 跨运行时共享的超星全类型签到协议执行器（preSign 状态前置识别 + 位置多坐标 / 拍照 / 备用通道兜底）
 */
export async function executeChaoxingSignProtocol(input: ChaoxingSignExecInput): Promise<string> {
  const {
    activeId,
    actName,
    courseId,
    classId,
    uid,
    fid,
    cookieStr,
    mobileUa,
    name,
    locations,
    enc = '',
    signCode = '',
  } = input;
  const otherId = Number(input.otherId ?? 0);
  const ifphoto = Number(input.ifphoto ?? 0);
  const typeLabel = getChaoxingSignTypeLabel(otherId, ifphoto, actName);

  // 1. 发起 preSign 预签到并检查是否已完成或已过期（避免对已签到活动误调用 pcReq 产生异常日志）
  try {
    const preUrl = `https://mobilelearn.chaoxing.com/newsign/preSign?courseId=${courseId}&classId=${classId}&activePrimaryId=${activeId}&general=1&sys=1&ls=1&appType=15&uid=${uid}&ut=s`;
    const preRes = await fetch(preUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const preHtml = await preRes.text().catch(() => '');
    const preStatus = classifyPreSignHtml(preHtml);
    if (preStatus.state === 'already_signed') {
      return `[${typeLabel}已签到] 活动: 《${actName}》 (ID: ${activeId})`;
    }
    if (preStatus.state === 'expired') {
      return `[签到已结束] 活动: 《${actName}》 (${preStatus.message})`;
    }
  } catch {
    // ignore preSign network blip and proceed to sign endpoints
  }

  // 2. 位置签到 (otherId === 4 或名称包含位置)：轮询尝试预设坐标池
  if (otherId === 4 || actName.includes('位置')) {
    let lastMsg = '';
    for (const loc of locations) {
      const stuSignUrl = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}&activeId=${activeId}&uid=${uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${fid}&appType=15&ifTiJiao=1`;
      try {
        const res = await fetch(stuSignUrl, {
          headers: {
            Cookie: cookieStr,
            'User-Agent': mobileUa,
          },
        });
        const text = await res.text();
        if (isSignSubmissionSuccess(text)) {
          const verb = /(?:已签|重复签到|已经签到)/.test(stripChaoxingHtmlTags(text)) ? '已签到' : '签到成功';
          return `[位置${verb}] 活动: 《${actName}》 (匹配坐标: ${loc.address})`;
        }
        lastMsg = stripChaoxingHtmlTags(text).slice(0, 60) || `HTTP ${res.status}`;
      } catch (e: any) {
        lastMsg = e?.message || '网络异常';
      }
    }
    return `[位置签到未匹配] 活动: 《${actName}》 (已尝试 ${locations.length} 处坐标，响应: ${lastMsg})`;
  }

  // 3. 拍照签到 (ifphoto === 1 或名称包含拍照)：上传打卡图片获取 objectId
  let targetObjectId = input.objectId || '';
  if (!targetObjectId && (ifphoto === 1 || actName.includes('拍照')) && input.resolvePhotoObjectId) {
    try {
      targetObjectId = (await input.resolvePhotoObjectId()) || '';
    } catch {
      // ignore
    }
  }

  const loc = locations[Math.floor(Math.random() * locations.length)];
  const encParam = enc ? `&enc=${encodeURIComponent(enc)}` : '';
  const objParam = targetObjectId ? `&objectId=${encodeURIComponent(targetObjectId)}` : '';
  const signCodeParam = signCode ? `&signCode=${encodeURIComponent(signCode)}` : '';
  const finalLabel = targetObjectId ? '拍照' : typeLabel;

  // 4. 主通道：stuSignajax
  const stuSignUrl = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}&activeId=${activeId}&uid=${uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${fid}&appType=15&ifTiJiao=1${encParam}${objParam}${signCodeParam}`;
  try {
    const res = await fetch(stuSignUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const text = await res.text();
    if (isSignSubmissionSuccess(text)) {
      const verb = /(?:已签|重复签到|已经签到)/.test(stripChaoxingHtmlTags(text)) ? '已签到' : '签到成功';
      return `[${finalLabel}${verb}] 活动: 《${actName}》 (ID: ${activeId})`;
    }
  } catch {
    // ignore
  }

  // 5. 备用通道一：receivedAttendanceWindowList
  try {
    const signUrl = `https://mobilelearn.chaoxing.com/ppt/activeAPI/receivedAttendanceWindowList?activeId=${activeId}&uid=${uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${fid}&appType=15&address=${encodeURIComponent(loc.address)}&name=${encodeURIComponent(name)}${encParam}${objParam}${signCodeParam}`;
    const res = await fetch(signUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const text = await res.text();
    if (isSignSubmissionSuccess(text)) {
      return `[${finalLabel}签到成功(备用通道)] 活动: 《${actName}》 (ID: ${activeId})`;
    }
  } catch {
    // ignore
  }

  // 6. 备用通道二：pcReq (移动直通)
  try {
    const mobileUrl = `https://mobilelearn.chaoxing.com/widget/sign/pcReq?activeId=${activeId}&uid=${uid}&latitude=${loc.lat}&longitude=${loc.lon}&fid=${fid}&appType=15&name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}${objParam}`;
    const mRes = await fetch(mobileUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': mobileUa,
      },
    });
    const mText = await mRes.text();
    if (mRes.ok && isSignSubmissionSuccess(mText)) {
      return `[${finalLabel}签到成功(pcReq)] 活动: 《${actName}》 (ID: ${activeId})`;
    }
    const cleanErr = stripChaoxingHtmlTags(mText).slice(0, 80);
    return `[签到异常] ${cleanErr || `HTTP ${mRes.status}`}`;
  } catch (e: any) {
    return `[签到异常] ${e?.message || e}`;
  }
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
  let primaryError: string | undefined;
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
      return { ...classified, rateLimited: false, rawCount: json.activeList.length };
    }

    const errMsg = json?.errorMsg || json?.msg ? String(json.errorMsg || json.msg) : undefined;
    if (isChaoxingRateLimitMessage(errMsg, res.status)) {
      return {
        activities: [],
        classActivities: [],
        rateLimited: true,
        errorMsg: errMsg || `HTTP ${res.status}`,
      };
    }
    primaryError = errMsg || (res.ok ? 'taskactivelist 返回异常结构' : `HTTP ${res.status}`);

    if (errMsg) {
      console.warn(
        `[scanCourseActivities] taskactivelist 响应提示: ${errMsg} (课程: ${course.courseName || course.courseId})`
      );
    }
  } catch (err: any) {
    primaryError = `taskactivelist 异常: ${err?.message || err}`;
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
      return { ...classified, rateLimited: false, rawCount: json.data.activeList.length };
    }

    const errMsg = json?.errorMsg || json?.msg ? String(json.errorMsg || json.msg) : undefined;
    if (isChaoxingRateLimitMessage(errMsg, res.status)) {
      return {
        activities: [],
        classActivities: [],
        rateLimited: true,
        errorMsg: errMsg || `HTTP ${res.status}`,
      };
    }

    // 两个通道都没拿到活动列表：必须返回明确错误，绝不能伪装成“没有签到”
    const finalErr = errMsg || primaryError || (res.ok ? 'activelist 返回异常结构' : `HTTP ${res.status}`);
    return {
      activities: [],
      classActivities: [],
      rateLimited: false,
      errorMsg: finalErr,
      blocked: isChaoxingBlockedMessage(finalErr) || isChaoxingBlockedMessage(primaryError),
    };
  } catch (err: any) {
    const finalErr = err?.message || String(err);
    return {
      activities: [],
      classActivities: [],
      rateLimited: false,
      errorMsg: primaryError ? `${primaryError}; ${finalErr}` : finalErr,
      blocked: isChaoxingBlockedMessage(primaryError),
    };
  }
}
