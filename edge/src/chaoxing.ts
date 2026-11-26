import { desEcbPkcs7EncryptHex } from '../../packages/adapters/chaoxing/des';
import {
  classifyPreSignHtml,
  executeChaoxingSignProtocol,
  fetchCourseSignHistoryCandidates,
  getChaoxingSignTypeLabel,
  scanCourseActivitiesShared,
  stripChaoxingHtmlTags,
  type ParsedClassActivity,
  type ParsedSignActivity,
  type ParsedSignHistoryCandidate,
  type PreSignInspectionResult,
  type ScanActivitiesResult,
} from '../../packages/adapters/chaoxing/activity-protocol';
export {
  fetchCourseBbsUrl,
  fetchTopicDetail,
  postTopicReply,
  scanCourseBbsTopics,
  type BbsReplyParams,
  type BbsTopicCard,
  type BbsTopicDetail,
} from '../../packages/adapters/chaoxing/bbs-protocol';
export {
  classifyPreSignHtml,
  fetchCourseSignHistoryCandidates,
  getChaoxingSignTypeLabel,
  stripChaoxingHtmlTags,
};
export type {
  ParsedClassActivity,
  ParsedSignActivity,
  ParsedSignHistoryCandidate,
  PreSignInspectionResult,
  ScanActivitiesResult,
};

export interface UserSession {
  _uid: string;
  _d: string;
  vc3: string;
  uf: string;
  fid: string;
  cookie: string;
}

export interface Course {
  courseId: string;
  classId: string;
  courseName: string;
  cpi?: string;
  teacherName?: string;
}

export interface SignLocation {
  lon: string;
  lat: string;
  address: string;
}

// 默认上海海洋大学预设经纬度坐标池（开箱即用方便同校同学，亦可通过环境变量 CHAOXING_SIGN_LON / LAT / ADDRESS 覆盖）
export const CHAOXING_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ChaoXingStudy/ChaoXingStudy_3_5.3.4_ios_phone_202011241926_118 (@Kalimdor)_13264426514748197793';

export const DEFAULT_SIGN_LOCATIONS: SignLocation[] = [
  { lon: '121.898500', lat: '30.883500', address: '上海市浦东新区沪城环路999号上海海洋大学信息学院' },
  { lon: '121.904800', lat: '30.889200', address: '上海市浦东新区沪城环路999号上海海洋大学信息学院' },
  { lon: '121.897800', lat: '30.883000', address: '上海市浦东新区沪城环路999号上海海洋大学信息工程大楼' },
  { lon: '121.896500', lat: '30.884000', address: '上海市浦东新区沪城环路999号上海海洋大学现代信息与实验中心' },
  { lon: '121.897000', lat: '30.884500', address: '上海市浦东新区沪城环路999号上海海洋大学公共实验室' },
  { lon: '121.899000', lat: '30.885000', address: '上海市浦东新区沪城环路999号上海海洋大学第一教学楼' },
  { lon: '121.899500', lat: '30.885500', address: '上海市浦东新区沪城环路999号上海海洋大学第二教学楼' },
  { lon: '121.900000', lat: '30.886000', address: '上海市浦东新区沪城环路999号上海海洋大学第三教学楼' },
  { lon: '121.900500', lat: '30.886500', address: '上海市浦东新区沪城环路999号上海海洋大学第四教学楼' },
];

export function resolveSignLocations(env?: {
  CHAOXING_SIGN_LON?: string;
  CHAOXING_SIGN_LAT?: string;
  CHAOXING_SIGN_ADDRESS?: string;
  CHAOXING_LOCATIONS_JSON?: string;
}): SignLocation[] {
  if (env?.CHAOXING_LOCATIONS_JSON) {
    try {
      const parsed = JSON.parse(env.CHAOXING_LOCATIONS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // ignore
    }
  }
  if (env?.CHAOXING_SIGN_LON && env?.CHAOXING_SIGN_LAT) {
    return [
      {
        lon: env.CHAOXING_SIGN_LON,
        lat: env.CHAOXING_SIGN_LAT,
        address: env.CHAOXING_SIGN_ADDRESS || '教学楼',
      },
    ];
  }
  return DEFAULT_SIGN_LOCATIONS;
}

/**
 * 学习通 DES 加密密码 (纯 TS 零依赖实现，兼容 Cloudflare Workers V8 Isolate)
 */
export function encryptPassword(password: string): string {
  return desEcbPkcs7EncryptHex(password, 'u2oh6Vu^HWe40fj');
}

/**
 * 用户登录获取 Cookie
 */
export async function login(phone: string, rawPass: string): Promise<UserSession | null> {
  const encPass = encryptPassword(rawPass);
  const formdata = `uname=${phone}&password=${encPass}&fid=-1&t=true&refer=https%253A%252F%252Fi.chaoxing.com&forbidotherlogin=0&validate=`;

  const res = await fetch('https://passport2.chaoxing.com/fanyalogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: formdata,
  });

  const json: any = await res.json().catch(() => ({}));
  if (!json.status) return null;

  const setCookies = (res.headers as any).getSetCookie
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const cookieMap = new Map<string, string>();
  for (const c of setCookies) {
    if (!c) continue;
    const parts = c.split(';')[0].split('=');
    if (parts.length >= 2) cookieMap.set(parts[0].trim(), parts[1].trim());
  }

  const _uid = cookieMap.get('_uid') || cookieMap.get('UID') || '';
  const _d = cookieMap.get('_d') || '';
  const vc3 = cookieMap.get('vc3') || '';
  const uf = cookieMap.get('uf') || '';
  const fid = cookieMap.get('fid') || '2893';

  const fullCookie = `_uid=${_uid}; UID=${_uid}; _d=${_d}; vc3=${vc3}; uf=${uf}; fid=${fid}`;

  return { _uid, _d, vc3, uf, fid, cookie: fullCookie };
}

/**
 * 获取在读课程全量列表（涵盖主修、实验与在线选修）
 */
export async function getCourses(session: UserSession): Promise<Course[]> {
  const courses: Course[] = [];
  const seen = new Set<string>();

  // 1. 权威首选通道：courselistdata POST 接口（实测 100% 返回全部在读课程且包含真实课程名与教师信息）
  try {
    const res = await fetch('https://mooc1-1.chaoxing.com/visit/courselistdata', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: session.cookie,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: 'courseType=1&courseFolderId=0&courseFolderSize=1',
    });

    const html = await res.text();

    // 权威正则：精确匹配 li 属性中的 courseId, clazzId, personId 及内部的 course-name 真实课程名
    const regexLi =
      /<li[^>]*courseId=["'](\d+)["'][^>]*clazzId=["'](\d+)["'](?:[^>]*personId=["'](\d+)["'])?[\s\S]*?<span[^>]*class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = regexLi.exec(html)) !== null) {
      const key = `${m[1]}_${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        courses.push({
          courseId: m[1],
          classId: m[2],
          cpi: m[3] || '',
          courseName: m[4]?.trim() || `课程_${m[1]}`,
        });
      }
    }

    // 备用正则 1：若 course-name 标签属性顺序不同，按 li 块逐个切割提取
    if (courses.length === 0) {
      const liBlocks = html.split(/<li\s+class=["'][^"']*course\b/gi);
      for (const block of liBlocks) {
        const idMatch = block.match(/courseId=["'](\d+)["'][^>]*clazzId=["'](\d+)["']/i);
        const nameMatch = block.match(/title=["']([^"']+)["']/i);
        const personMatch = block.match(/personId=["'](\d+)["']/i);
        if (idMatch && nameMatch) {
          const key = `${idMatch[1]}_${idMatch[2]}`;
          if (!seen.has(key)) {
            seen.add(key);
            courses.push({
              courseId: idMatch[1],
              classId: idMatch[2],
              cpi: personMatch ? personMatch[1] : '',
              courseName: nameMatch[1]?.trim() || `课程_${idMatch[1]}`,
            });
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[getCourses] courselistdata 通道异常: ${e?.message || e}`);
  }

  // 2. 备用通道：study 页面与老版 a.courseName 匹配
  if (courses.length === 0) {
    try {
      const res = await fetch('https://mooc1-1.chaoxing.com/visit/courses/study?courseType=1&courseFolderId=0', {
        headers: {
          Cookie: session.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const regexModern =
        /<a[^>]*class=["'][^"']*courseName[^"']*["'][^>]*href=["'][^"']*courseid=(\d+)&clazzid=(\d+)[^"']*(?:&cpi=(\d+))?[^"']*["'][^>]*title=["']([^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = regexModern.exec(html)) !== null) {
        const key = `${m[1]}_${m[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          courses.push({
            courseId: m[1],
            classId: m[2],
            cpi: m[3] || '',
            courseName: m[4]?.trim() || '',
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return courses;
}

/**
 * 扫描指定课程的课堂活动（含签到与课堂讨论/问答元数据，具备频控熔断防放大风暴机制）
 */
export async function scanCourseActivitiesWithMeta(
  course: Course,
  session: UserSession
): Promise<ScanActivitiesResult> {
  return scanCourseActivitiesShared(course, session.cookie, session._uid, CHAOXING_MOBILE_UA);
}

/**
 * 扫描指定课程的签到活动（向后兼容接口）
 */
export async function scanCourseActivities(course: Course, session: UserSession): Promise<ParsedSignActivity[]> {
  const res = await scanCourseActivitiesWithMeta(course, session);
  return res.activities;
}

/**
 * 边缘极速探测课程是否存在未交作业红点 (workTestPendingNew)
 * 只需 1 次批量 HTTP 请求即可检测所有班级是否有待做作业！
 */
export async function checkHomeworkPendingCourses(
  courses: Course[],
  session: UserSession
): Promise<Course[]> {
  if (courses.length === 0) return [];
  const classIds = courses.map((c) => c.classId).join(',');
  const url = `https://mooc1-1.chaoxing.com/work/workTestPendingNew?classIds=${encodeURIComponent(classIds)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const list = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(list)) return [];

    const pendingClassIds = new Set(
      list.filter((item) => item && item.hasWorkMsg).map((item) => String(item.classId || item.id || ''))
    );

    return courses.filter((c) => pendingClassIds.has(String(c.classId)));
  } catch {
    return [];
  }
}

export interface ChaoxingWebHomeworkItem {
  workId: string;
  workAnswerId: string;
  title: string;
  statusText: string;
  startDate: string;
  endDate: string;
  isPending: boolean;
  isDone: boolean;
  isExpired: boolean;
  isReturned: boolean;
  courseId: string;
  classId: string;
  courseName: string;
  taskUrl: string;
}

const CHAOXING_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 零 JSDOM 解析超星课程 /work/getAllWork HTML，提取待做、打回、已过期与已提交作业状态
 */
export function parseCourseWorkListHtml(
  html: string,
  course: Course,
  nowMs = Date.now()
): ChaoxingWebHomeworkItem[] {
  if (!html) return [];
  const items: ChaoxingWebHomeworkItem[] = [];
  const seen = new Set<string>();
  const rawChunks = html.split(/(?=<div[^>]*class=["']titTxt["'])/i);

  for (const rawChunk of rawChunks) {
    if (!/^<div[^>]*class=["']titTxt["']/i.test(rawChunk)) continue;
    const endLiIdx = rawChunk.search(/<\/li>/i);
    const chunk = endLiIdx >= 0 ? rawChunk.slice(0, endLiIdx) : rawChunk;

    let workId = '';
    let workAnswerId = '0';
    let statusType = '0';
    let title = '';
    let hasInspectTask = false;

    const inspectTagMatch = chunk.match(/<a\b[^>]*class=["'][^"']*inspectTask[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (inspectTagMatch) {
      hasInspectTask = true;
      const tag = inspectTagMatch[0];
      const innerText = stripChaoxingHtmlTags(inspectTagMatch[1] || '');
      workId = tag.match(/\bdata=["'](\d+)["']/i)?.[1] || '';
      workAnswerId = tag.match(/\bdata2=["'](\d+)["']/i)?.[1] || '0';
      statusType = tag.match(/\bdata3=["'](\d+)["']/i)?.[1] || '0';
      title = (tag.match(/\btitle=["']([^"']+)["']/i)?.[1] || innerText || '').trim();
    } else {
      const linkMatch = chunk.match(/<a\b[^>]*href=["'][^"']*workId=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) {
        workId = linkMatch[1];
        const tag = linkMatch[0];
        const innerText = stripChaoxingHtmlTags(linkMatch[2] || '');
        workAnswerId = tag.match(/workAnswerId=(\d+)/i)?.[1] || '0';
        title = (tag.match(/\btitle=["']([^"']+)["']/i)?.[1] || innerText || '').trim();
      }
    }

    if (!workId || seen.has(workId)) continue;
    seen.add(workId);

    const plain = stripChaoxingHtmlTags(chunk);
    const startDate =
      plain.match(/开始时间：\s*([\d\-/:]+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/)?.[1]?.trim() || '';
    const endDate =
      plain.match(/截止时间：\s*([\d\-/:]+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/)?.[1]?.trim() || '';
    const parsedStatus = plain.match(/作业状态：\s*([^\s]+)/)?.[1]?.trim();
    const statusText = parsedStatus || (statusType === '1' ? '待批阅' : hasInspectTask ? '待做' : '');

    const isDone = /待批|已批|已交|完成/.test(statusText);
    const endMs = parseTimeToMs(endDate);
    const isExpired = /过期|截止/.test(statusText) || (endMs !== null && endMs < nowMs);
    const isReturned = /打回|重做|退回/.test(statusText);
    const isPending =
      !isDone &&
      !isExpired &&
      (isReturned || /待做|未交|重新编辑/.test(statusText) || (hasInspectTask && statusType === '0'));

    const taskUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${course.courseId}&classId=${course.classId}&cpi=${course.cpi || ''}&workId=${workId}`;

    items.push({
      workId,
      workAnswerId,
      title: title || `作业_${workId}`,
      statusText,
      startDate,
      endDate,
      isPending,
      isDone,
      isExpired,
      isReturned,
      courseId: course.courseId,
      classId: course.classId,
      courseName: course.courseName,
      taskUrl,
    });
  }

  return items;
}

/**
 * 通过超星网页端 stucoursemiddle -> /work/getAllWork 扫描单门课程的作业列表（替代已失效的 404 红点接口）
 */
export async function scanCourseHomeworksWeb(
  course: Course,
  session: UserSession,
  nowMs = Date.now()
): Promise<ChaoxingWebHomeworkItem[]> {
  try {
    let cookieStr = session.cookie;
    const stuUrl = `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${encodeURIComponent(
      course.courseId
    )}&clazzid=${encodeURIComponent(course.classId)}&cpi=${encodeURIComponent(course.cpi || '')}&vc=1`;
    const stuCtrl = new AbortController();
    const stuTimer = setTimeout(() => stuCtrl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(stuUrl, {
        headers: {
          Cookie: cookieStr,
          'User-Agent': CHAOXING_WEB_UA,
        },
        signal: stuCtrl.signal,
      });
    } finally {
      clearTimeout(stuTimer);
    }
    if (!res.ok) return [];

    const setCookies: string[] = (res.headers as any).getSetCookie
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')!]
        : [];
    for (const c of setCookies) {
      if (c) cookieStr += '; ' + c.split(';')[0];
    }

    const html = await res.text();
    let workUrl = '';
    const match = html.match(/['"]([^'"]*\/work\/getAllWork[^'"]*)['"]/i);
    if (match) {
      const rawPath = match[1].replace(/&amp;/g, '&').trim();
      if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
        workUrl = rawPath;
      } else if (rawPath.startsWith('/mooc-ans/')) {
        workUrl = `https://mooc1-1.chaoxing.com${rawPath}`;
      } else if (rawPath.startsWith('/work/')) {
        workUrl = `https://mooc1-1.chaoxing.com/mooc-ans${rawPath}`;
      } else {
        workUrl = `https://mooc1-1.chaoxing.com/${rawPath.replace(/^\/+/, '')}`;
      }
    } else {
      const encMatch = html.match(/\benc=([a-f0-9]{16,})/i);
      const opencMatch = html.match(/\bopenc=([a-f0-9]{16,})/i);
      if (encMatch) {
        const cpi = html.match(/\bcpi=(\d+)/i)?.[1] || course.cpi || '';
        const openc = opencMatch?.[1] || '';
        workUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/getAllWork?classId=${encodeURIComponent(
          course.classId
        )}&courseId=${encodeURIComponent(course.courseId)}&isdisplaytable=2&mooc=1&ut=s&enc=${encMatch[1]}&cpi=${encodeURIComponent(cpi)}&openc=${openc}`;
      }
    }

    if (!workUrl) return [];

    const workCtrl = new AbortController();
    const workTimer = setTimeout(() => workCtrl.abort(), 10_000);
    let workRes: Response;
    try {
      workRes = await fetch(workUrl, {
        headers: {
          Cookie: cookieStr,
          'User-Agent': CHAOXING_WEB_UA,
        },
        signal: workCtrl.signal,
      });
    } finally {
      clearTimeout(workTimer);
    }
    if (!workRes.ok) return [];
    const workHtml = await workRes.text();
    return parseCourseWorkListHtml(workHtml, course, nowMs);
  } catch {
    return [];
  }
}

/**
 * 获取超星活动详细信息 (otherId, ifphoto 等)
 */
export async function getPPTActiveInfo(activeId: string, session: UserSession): Promise<any> {
  try {
    const res = await fetch(`https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${activeId}`, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': CHAOXING_MOBILE_UA,
      },
    });
    const json: any = await res.json().catch(() => ({}));
    return json?.data || {};
  } catch {
    return {};
  }
}

/**
 * 自动生成 1x1 像素临时打卡图片并上传至超星云盘获取 objectId (对齐 chaoxing-signin 原生实现)
 */
export async function getOrUploadPhotoObject(session: UserSession): Promise<string | null> {
  try {
    // 1. 获取云盘 Token
    const tokenRes = await fetch('https://pan-yz.chaoxing.com/api/token/uservalid', {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const tokenData: any = await tokenRes.json().catch(() => ({}));
    const token = tokenData?._token;
    if (!token) return null;

    // 2. 构造 1x1 极简透明 PNG 二进制并上传
    const sampleBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const binaryStr = atob(sampleBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/png' });

    const formData = new FormData();
    formData.append('file', blob, '1.png');
    formData.append('puid', session._uid);

    const uploadRes = await fetch(`https://pan-yz.chaoxing.com/upload?_from=mobilelearn&_token=${token}`, {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
      },
      body: formData,
    });
    const uploadData: any = await uploadRes.json().catch(() => ({}));
    if (uploadData?.objectId) {
      console.log(`[PhotoSign] 自动生成打卡照片成功 (objectId: ${uploadData.objectId})`);
      return String(uploadData.objectId);
    }
  } catch (err: any) {
    console.warn(`[PhotoSign] 自动上传打卡照片异常: ${err?.message || err}`);
  }
  return null;
}

/**
 * 执行全类型签到（完全对齐 chaoxing-signin 项目实现：支持位置多点轮询、拍照自动获取 objectId、手势、签到码与二维码）
 */
export async function performSign(
  activity: any,
  course: Course,
  session: UserSession,
  name = '同学',
  locations: SignLocation[] = DEFAULT_SIGN_LOCATIONS,
  enc = '',
  objectId = '',
  signCode = ''
): Promise<string> {
  const activeId = String(activity.id || activity.activeId);
  const actName = activity.name || activity.nameOne || '在线签到';

  // 1. 获取活动详细属性 (otherId 与 ifphoto)
  let otherId = activity.otherId !== undefined ? Number(activity.otherId) : 0;
  let ifphoto = activity.ifphoto !== undefined ? Number(activity.ifphoto) : 0;

  try {
    const pptInfo = await getPPTActiveInfo(activeId, session);
    if (pptInfo?.otherId !== undefined) otherId = Number(pptInfo.otherId);
    if (pptInfo?.ifphoto !== undefined) ifphoto = Number(pptInfo.ifphoto);
  } catch {
    // 降级使用传入属性
  }

  const pool = locations.length > 0 ? locations : DEFAULT_SIGN_LOCATIONS;

  return executeChaoxingSignProtocol({
    activeId,
    actName,
    courseId: course.courseId,
    classId: course.classId,
    uid: session._uid,
    fid: session.fid,
    cookieStr: session.cookie,
    mobileUa: CHAOXING_MOBILE_UA,
    name,
    locations: pool,
    otherId,
    ifphoto,
    enc,
    objectId,
    signCode,
    resolvePhotoObjectId: () => getOrUploadPhotoObject(session),
  });
}

export interface ChaoxingNoticeItem {
  idCode: string;
  title: string;
  createrName: string;
  sendTime: string;
  content: string;
  tag?: string;
  sourceType?: number;
  rawJson?: string;
  examInfo?: {
    examId: string;
    title: string;
    courseId: string;
    courseName: string;
    classId: string;
    url: string;
    startTime: string;
    endTime: string;
    isExpired: boolean;
  };
  workInfo?: {
    workId: string;
    title: string;
    courseId: string;
    courseName: string;
    classId: string;
    url: string;
    startTime: string;
    endTime: string;
    isExpired?: boolean;
    isReturned?: boolean;
  };
  activityInfo?: {
    activeId?: string;
    title: string;
    courseName: string;
    url: string;
  };
}

/**
 * 健壮地解析各类中文/超星时间字符串为 UTC+8 毫秒时间戳
 */
export function parseTimeToMs(timeStr?: string, fallbackYear?: number): number | null {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  if (!s || s === '无截止时间' || s === '无' || s === '近期' || s === '无截止限制') return null;

  // 纯数字毫秒/秒时间戳
  if (/^\d{10,13}$/.test(s)) {
    return Number(s.padEnd(13, '0'));
  }

  const currentYear = fallbackYear || new Date().getFullYear();

  // 1. 中文日期格式，如 "11月8号 14:30" 或 "2026年11月08日 14:30:00"
  const cnMatch = s.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[号日]?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (cnMatch) {
    const y = cnMatch[1] ? Number(cnMatch[1]) : currentYear;
    const m = Number(cnMatch[2]);
    const d = Number(cnMatch[3]);
    const hh = Number(cnMatch[4]);
    const mm = Number(cnMatch[5]);
    const ss = cnMatch[6] ? Number(cnMatch[6]) : 0;
    const pad = (n: number) => String(n).padStart(2, '0');
    const parsed = Date.parse(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}+08:00`);
    if (!isNaN(parsed)) return parsed;
  }

  // 2. 标准分隔符格式，如 "2026/11/08 14:30:00" 或 "11-08 14:30:00" 或 "2026-11-08 14:30"
  const stdMatch = s.match(/(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (stdMatch) {
    const y = stdMatch[1] ? Number(stdMatch[1]) : currentYear;
    const m = Number(stdMatch[2]);
    const d = Number(stdMatch[3]);
    const hh = Number(stdMatch[4]);
    const mm = Number(stdMatch[5]);
    const ss = stdMatch[6] ? Number(stdMatch[6]) : 0;
    const pad = (n: number) => String(n).padStart(2, '0');
    const parsed = Date.parse(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}+08:00`);
    if (!isNaN(parsed)) return parsed;
  }

  // 3. 通用 Date.parse 兜底
  const normalized = s.replace(/年|月/g, '-').replace(/日|号/g, '').replace(/\//g, '-').trim();
  let ms = Date.parse(normalized);
  if (isNaN(ms)) {
    ms = Date.parse(normalized + ' GMT+0800');
  }
  return isNaN(ms) ? null : ms;
}

/**
 * 从通知文本内容中智能提取考试/作业的起止时间、课程名称、考试/作业名称
 */
export function extractInfoFromContent(content?: string, referenceYear?: number): {
  startTime?: string;
  endTime?: string;
  courseName?: string;
  examName?: string;
} {
  if (!content) return {};
  const res: { startTime?: string; endTime?: string; courseName?: string; examName?: string } = {};

  // 提取课程名称: 课程名称：高等数学（二） 或 《高等数学（二）》
  const courseMatch = content.match(/课程名称[:：]\s*([^\s,，。；\n\r]+)/) || content.match(/《([^》]+)》/);
  if (courseMatch) res.courseName = courseMatch[1].trim();

  // 提取试卷/考试/作业名称
  const examMatch = content.match(/(?:试卷|考试|作业)名称[:：]\s*([^\s,，。；\n\r]+)/);
  if (examMatch) res.examName = examMatch[1].trim();

  // 模式1：标准起止时间
  const endMatch = content.match(/(?:结束时间|截止时间)[:：]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2}(?::\d{2})?)/);
  if (endMatch) res.endTime = endMatch[1].trim();

  const startMatch = content.match(/开始时间[:：]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}[-/月]\d{1,2}[日号]?\s+\d{1,2}:\d{2}(?::\d{2})?)/);
  if (startMatch) res.startTime = startMatch[1].trim();

  // 模式2：考试时间：11-09 13:00:00 至 11-09 14:35:00
  const rangeMatch = content.match(/考试时间[:：]\s*([^\s至~～—]+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*(?:至|~|～|——|-)\s*([^\s,，。；\n\r]+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
  if (rangeMatch) {
    if (!res.startTime) res.startTime = rangeMatch[1].trim();
    if (!res.endTime) res.endTime = rangeMatch[2].trim();
  }

  // 模式3：中文跨时间，如 "11月8号13:00——14:30"
  const cnRange = content.match(/(\d{1,2}月\d{1,2}[号日]?)\s*(\d{1,2}:\d{2})\s*(?:至|~|～|——|-)\s*(\d{1,2}:\d{2})/);
  if (cnRange && !res.endTime) {
    const dayStr = cnRange[1].trim();
    res.startTime = `${dayStr} ${cnRange[2].trim()}`;
    res.endTime = `${dayStr} ${cnRange[3].trim()}`;
  }

  return res;
}

/**
 * 抓取超星通知中心消息列表（包含全量班级通知、随堂考试/测验、新作业发布通知）
 */
export async function fetchNoticeList(session: UserSession, limit = 20): Promise<ChaoxingNoticeItem[]> {
  const url = 'https://notice.chaoxing.com/pc/notice/getNoticeList';
  const body = new URLSearchParams({
    type: '2', // 我接收的通知
    notice_type: '',
    lastValue: '',
    sort: '0',
    folderUUID: '',
    kw: '',
    startTime: '',
    endTime: '',
    gKw: '',
    gName: '',
    year: '',
    tag: '',
    fidsCode: '',
    queryFolderNoticePrevYear: '',
    filterSenderPuids: '',
    filterTags: '',
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://notice.chaoxing.com/pc/notice/myNotice',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) return [];

    const data: any = await res.json().catch(() => ({}));
    const rawList: any[] = data.notices?.list || [];
    const notices: ChaoxingNoticeItem[] = [];

    for (const n of rawList.slice(0, limit)) {
      let examInfo: ChaoxingNoticeItem['examInfo'] | undefined = undefined;
      let workInfo: ChaoxingNoticeItem['workInfo'] | undefined = undefined;
      let activityInfo: ChaoxingNoticeItem['activityInfo'] | undefined = undefined;

      // 解析附件中的随堂考试、作业或课堂活动 (att_subject)
      if (n.attachment) {
        try {
          const attachList = JSON.parse(n.attachment);
          const sendYear = n.sendTime ? new Date(n.sendTime).getFullYear() : new Date().getFullYear();
          const subjAtt = Array.isArray(attachList)
            ? attachList.find(
                (a: any) => a && a.att_subject && (a.att_subject.subjectTitle || a.att_subject.subjectLink)
              )
            : undefined;
          if (subjAtt?.att_subject) {
            const subjectLink = String(subjAtt.att_subject.subjectLink || '');
            const activeIdMatch = subjectLink.match(/active(?:Primary)?Id=(\d+)/i);
            const extractedSubj = extractInfoFromContent(n.content, sendYear);
            activityInfo = {
              activeId: activeIdMatch?.[1],
              title: String(subjAtt.att_subject.subjectTitle || n.title || '随堂活动').trim(),
              courseName: extractedSubj.courseName || '',
              url: subjectLink,
            };
          }

          const att = Array.isArray(attachList)
            ? attachList.find(
                (a: any) =>
                  a.att_web &&
                  (a.att_web.examOrWork === 'exam' || a.att_web.examOrWork === 'work')
              )
            : undefined;
          if (att && att.att_web) {
            const w = att.att_web;
            let startTime = '';
            let endTime = '';
            let courseName = '';

            if (n.extendParam && n.extendParam.cparams) {
              try {
                const cparams =
                  typeof n.extendParam.cparams === 'string'
                    ? JSON.parse(n.extendParam.cparams)
                    : n.extendParam.cparams;
                const cnt = cparams.funConfig?.content || {};
                if (cnt.startTime) {
                  startTime = new Date(Number(cnt.startTime)).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  });
                }
                if (cnt.endTime) {
                  endTime = new Date(Number(cnt.endTime)).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  });
                }
                courseName = cnt.courseName || '';
              } catch {
                // ignore
              }
            }

            const extracted = extractInfoFromContent(n.content, sendYear);

            if (!endTime || endTime === '无截止时间' || endTime === '无') {
              if (extracted.endTime) endTime = extracted.endTime;
            }
            if (!startTime || startTime === '近期') {
              if (extracted.startTime) startTime = extracted.startTime;
            }
            if (!courseName || courseName.startsWith('课程_') || courseName === '在线课程') {
              if (extracted.courseName) courseName = extracted.courseName;
            }

            // 规范化年份
            if (endTime && !/^\d{4}/.test(endTime) && sendYear) {
              const clean = endTime.replace(/年|月/g, '/').replace(/日|号/g, '').replace(/-/g, '/');
              endTime = `${sendYear}/${clean}`;
            }
            if (startTime && !/^\d{4}/.test(startTime) && sendYear) {
              const clean = startTime.replace(/年|月/g, '/').replace(/日|号/g, '').replace(/-/g, '/');
              startTime = `${sendYear}/${clean}`;
            }

            let isExpired = false;
            const endMs = parseTimeToMs(endTime, sendYear);
            if (endMs !== null && endMs < Date.now()) {
              isExpired = true;
            }

            const itemTitle = w.title || n.title || '在线评测';
            const courseIdStr = String(w.courseId || '');
            const classIdStr = String(w.clazzId || '');
            const targetUrl = w.url || '';

            if (w.examOrWork === 'exam') {
              examInfo = {
                examId: String(w.examOrWorkId || att.examOrTextId || ''),
                title: itemTitle,
                courseId: courseIdStr,
                courseName: courseName || `课程_${courseIdStr}`,
                classId: classIdStr,
                url: targetUrl,
                startTime: startTime || '近期',
                endTime: endTime || '无截止时间',
                isExpired,
              };
            } else if (w.examOrWork === 'work') {
              const rawContent = String(n.content || '');
              const rawTitle = String(n.title || '');
              const isReturned =
                rawTitle.includes('打回') ||
                rawTitle.includes('退回') ||
                rawContent.includes('打回重做');
              workInfo = {
                workId: String(w.examOrWorkId || att.examOrTextId || ''),
                title: itemTitle,
                courseId: courseIdStr,
                courseName: courseName || `课程_${courseIdStr}`,
                classId: classIdStr,
                url: targetUrl,
                startTime: startTime || '近期',
                endTime: endTime || '无截止时间',
                isExpired,
                ...(isReturned ? { isReturned: true } : {}),
              };
            }
          }
        } catch {
          // ignore JSON parse error
        }
      }

      const idCode = String(n.idCode || n.id || '');
      const sendTime =
        n.sendTime ||
        (n.insertTime
          ? new Date(Number(n.insertTime)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '近期');

      const noticeItem: ChaoxingNoticeItem = {
        idCode,
        title: n.title || '无标题通知',
        createrName: n.createrName || '通知助手',
        sendTime,
        content: n.content ? String(n.content).replace(/[\r\n]+/g, ' ').trim() : '',
        tag: n.tag || '',
        sourceType: n.sourceType || 0,
        examInfo,
        workInfo,
        ...(activityInfo ? { activityInfo } : {}),
      };
      noticeItem.rawJson = JSON.stringify(noticeItem);
      notices.push(noticeItem);
    }

    return notices;
  } catch {
    return [];
  }
}
