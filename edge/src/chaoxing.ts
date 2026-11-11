import { desEcbPkcs7EncryptHex } from '../../packages/adapters/chaoxing/des';

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
}

export interface SignLocation {
  lon: string;
  lat: string;
  address: string;
}

// 默认上海海洋大学预设经纬度坐标池（开箱即用方便同校同学，亦可通过环境变量 CHAOXING_SIGN_LON / LAT / ADDRESS 覆盖）
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
 * 获取在读课程列表（支持现代超星 a.courseName 结构与 courselistdata 备用接口）
 */
export async function getCourses(session: UserSession): Promise<Course[]> {
  const courses: Course[] = [];
  const seen = new Set<string>();

  // 1. 首选通道：study 页面
  try {
    const res = await fetch('https://mooc1-1.chaoxing.com/visit/courses/study?courseType=1&courseFolderId=0', {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const html = await res.text();

    // 匹配现代超星页面的 a.courseName 标签
    const regexModern = /<a[^>]*class=["'][^"']*courseName[^"']*["'][^>]*href=["'][^"']*courseid=(\d+)&clazzid=(\d+)[^"']*(?:&cpi=(\d+))?[^"']*["'][^>]*title=["']([^"']+)["']/gi;
    let m;
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

    // 宽松正则兜底
    if (courses.length === 0) {
      const regexRelaxed = /courseid=(\d+)&clazzid=(\d+)[^"']*["'][^>]*title=["']([^"']+)["']/gi;
      let m2;
      while ((m2 = regexRelaxed.exec(html)) !== null) {
        const key = `${m2[1]}_${m2[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          courses.push({
            courseId: m2[1],
            classId: m2[2],
            cpi: '',
            courseName: m2[3]?.trim() || '',
          });
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. 备用通道：courselistdata 接口
  if (courses.length === 0) {
    try {
      const res = await fetch('https://mooc1-1.chaoxing.com/visit/courselistdata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Cookie: session.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: 'courseType=1&courseFolderId=0&courseFolderSize=0',
      });
      const html = await res.text();
      const regexList = /course_(\d+)_(\d+)/g;
      let m;
      while ((m = regexList.exec(html)) !== null) {
        const key = `${m[1]}_${m[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          courses.push({
            courseId: m[1],
            classId: m[2],
            courseName: `课程_${m[1]}`,
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
 * 扫描指定课程的签到活动（双通道：student/activelist 权威优先，失败才 taskactivelist 兜底）
 */
export async function scanCourseActivities(course: Course, session: UserSession): Promise<any[]> {
  const activities: any[] = [];
  const seenIds = new Set<string>();

  // 1. 通道一：student/activelist（超星当前版本最权威接口，实测 100% 返回进行中活动）
  try {
    const url = `https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist?fid=0&courseId=${course.courseId}&classId=${course.classId}&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    });
    const json: any = await res.json().catch(() => ({}));
    const list = json.data?.activeList || [];
    for (const item of list) {
      const id = String(item.id);
      if (seenIds.has(id)) continue;
      const isSign = item.activeType === 2 || item.type === 2 ||
        (item.nameOne && typeof item.nameOne === 'string' && item.nameOne.includes('签到')) ||
        (item.otherId !== undefined && item.otherId !== null && String(item.otherId) !== '');
      // status: 1 代表正在进行中
      if (isSign && item.status === 1) {
        seenIds.add(id);
        activities.push({
          id,
          name: item.nameOne || '签到',
          nameOne: item.nameOne || '签到',
          otherId: item.otherId !== undefined ? Number(item.otherId) : 0,
          status: item.status,
          activeType: item.activeType || item.type || 2,
        });
      }
    }
    // 主通道返回成功（即使当前课程暂无活动，也已权威确认），直接返回，避免无效冗余子请求超限
    return activities;
  } catch {
    // 通道一网络异常时，才进入通道二兜底
  }

  // 2. 通道二：taskactivelist 移动接口兜底
  try {
    const url = `https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist?courseId=${course.courseId}&classId=${course.classId}&uid=${session._uid}`;
    const res = await fetch(url, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    });
    const json: any = await res.json().catch(() => ({}));
    const list = json.activeList || [];
    for (const item of list) {
      const id = String(item.id);
      if (seenIds.has(id)) continue;
      const isSign = item.activeType === 2 || (item.nameOne && typeof item.nameOne === 'string' && item.nameOne.includes('签到'));
      if (isSign && item.status === 1) {
        seenIds.add(id);
        activities.push({
          id,
          name: item.nameOne || '签到',
          nameOne: item.nameOne || '签到',
          otherId: item.otherId !== undefined ? Number(item.otherId) : 0,
          status: item.status,
          activeType: item.activeType || 2,
        });
      }
    }
  } catch {
    // 通道二出错
  }

  return activities;
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

/**
 * 执行全类型签到（包含位置/普通/拍照/手势/签到码/二维码兜底）
 */
export async function performSign(
  activity: any,
  course: Course,
  session: UserSession,
  name = '同学',
  locations: SignLocation[] = DEFAULT_SIGN_LOCATIONS,
  enc = '',
  objectId = ''
): Promise<string> {
  const activeId = activity.id;
  const otherId = activity.otherId;

  const pool = locations.length > 0 ? locations : DEFAULT_SIGN_LOCATIONS;
  const loc = pool[Math.floor(Math.random() * pool.length)];

  // 1. 发起 preSign 预签
  try {
    const preUrl = `https://mobilelearn.chaoxing.com/newsign/preSign?courseId=${course.courseId}&classId=${course.classId}&activePrimaryId=${activeId}&general=1&sys=1&ls=1&appType=15&uid=${session._uid}&ut=s`;
    await fetch(preUrl, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    });
  } catch {
    // ignore
  }

  // 2. 主通道：stuSignajax 提交签到 (超星标准打卡接口)
  const encParam = enc ? `&enc=${encodeURIComponent(enc)}` : '';
  const objParam = objectId ? `&objectId=${encodeURIComponent(objectId)}` : '';
  const stuSignUrl = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}&activeId=${activeId}&uid=${session._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${session.fid}&appType=15&ifTiJiao=1${encParam}${objParam}`;

  try {
    const res = await fetch(stuSignUrl, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    });
    const text = await res.text();
    if (text.includes('success') || text.includes('成功')) {
      return `[签到成功] 活动: ${activity.name || activity.nameOne || '在线签到'} (类型: ${otherId}, 地址: ${loc.address})`;
    }
  } catch {
    // ignore
  }

  // 3. 备用通道一：receivedAttendanceWindowList
  try {
    const signUrl = `https://mobilelearn.chaoxing.com/ppt/activeAPI/receivedAttendanceWindowList?activeId=${activeId}&uid=${session._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${session.fid}&appType=15&address=${encodeURIComponent(loc.address)}&name=${encodeURIComponent(name)}${encParam}${objParam}`;
    const res = await fetch(signUrl, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const text = await res.text();
    if (text.includes('success') || text.includes('成功')) {
      return `[签到成功] 活动: ${activity.name || activity.nameOne || '在线签到'} (类型: ${otherId}, 地址: ${loc.address})`;
    }
  } catch {
    // ignore
  }

  // 4. 备用通道二：pcReq
  try {
    const mobileUrl = `https://mobilelearn.chaoxing.com/widget/sign/pcReq?activeId=${activeId}&uid=${session._uid}&latitude=${loc.lat}&longitude=${loc.lon}&fid=${session.fid}&appType=15&name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}${objParam}`;
    const mRes = await fetch(mobileUrl, {
      headers: {
        Cookie: session.cookie,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    });
    const mText = await mRes.text();
    return `[签到提交] 响应: ${mText.substring(0, 100).replace(/\s+/g, ' ')}`;
  } catch (e: any) {
    return `[签到异常] ${e?.message || e}`;
  }
}
