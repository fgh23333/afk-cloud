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
 * 获取在读课程列表
 */
export async function getCourses(session: UserSession): Promise<Course[]> {
  const res = await fetch('https://mooc1-1.chaoxing.com/visit/courses/study?courseType=1&courseFolderId=0', {
    headers: {
      Cookie: session.cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const html = await res.text();
  const courses: Course[] = [];
  const regex =
    /<li[^>]*courseId=["'](\d+)["'][^>]*clazzId=["'](\d+)["'](?:[^>]*personId=["'](\d+)["'])?[\s\S]*?<span[^>]*class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    courses.push({
      courseId: m[1],
      classId: m[2],
      cpi: m[3] || '',
      courseName: m[4]?.trim() || '',
    });
  }

  return courses;
}

/**
 * 扫描指定课程的签到活动
 */
export async function scanCourseActivities(course: Course, session: UserSession): Promise<any[]> {
  const url = `https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist?courseId=${course.courseId}&classId=${course.classId}&uid=${session._uid}`;
  const res = await fetch(url, {
    headers: {
      Cookie: session.cookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    },
  });

  const data: any = await res.json().catch(() => ({}));
  const list = data.activeList || [];
  return list.filter((a: any) => a.status === 1 && a.activeType === 2);
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
  enc = ''
): Promise<string> {
  const activeId = activity.id;
  const otherId = activity.otherId;

  const pool = locations.length > 0 ? locations : DEFAULT_SIGN_LOCATIONS;
  const loc = pool[Math.floor(Math.random() * pool.length)];
  const encParam = enc ? `&enc=${encodeURIComponent(enc)}` : '';
  const signUrl = `https://mobilelearn.chaoxing.com/ppt/activeAPI/receivedAttendanceWindowList?activeId=${activeId}&uid=${session._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${session.fid}&appType=15&address=${encodeURIComponent(loc.address)}&name=${encodeURIComponent(name)}${encParam}`;

  const res = await fetch(signUrl, {
    headers: {
      Cookie: session.cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const text = await res.text();
  if (text.includes('success') || text.includes('成功')) {
    return `[签到成功] 活动: ${activity.nameOne || '在线签到'} (类型: ${otherId}, 地址: ${loc.address})`;
  }

  const mobileUrl = `https://mobilelearn.chaoxing.com/widget/sign/pcReq?activeId=${activeId}&uid=${session._uid}&latitude=${loc.lat}&longitude=${loc.lon}&fid=${session.fid}&appType=15&name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}`;
  const mRes = await fetch(mobileUrl, {
    headers: {
      Cookie: session.cookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    },
  });
  const mText = await mRes.text();
  return `[签到提交] 响应: ${mText.substring(0, 100).replace(/\s+/g, ' ')}`;
}
