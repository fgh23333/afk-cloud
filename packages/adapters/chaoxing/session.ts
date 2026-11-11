import { CourseInfo } from '../../core/types';
import { desEcbPkcs7EncryptHex } from './des';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface ChaoxingCookies {
  _uid: string;
  _d: string;
  vc3: string;
  uf: string;
  fid: string;
  lv?: string;
  cookieStr: string;
}

export interface CourseSessionInfo {
  courseCookie: string;
  enc: string;
  cpi: string;
  openc: string;
  studentCourseHtml: string;
}

/**
 * 学习通 DES-ECB 密码加密 (纯 TS 实现，兼容所有 Node 与 Edge 版本)
 */
export function encryptChaoxingPassword(password: string): string {
  return desEcbPkcs7EncryptHex(password, 'u2oh6Vu^HWe40fj');
}

function getSetCookieList(res: Response): string[] {
  if (typeof (res.headers as any).getSetCookie === 'function') {
    return (res.headers as any).getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * 登录超星学习通（优先复用 Cloudflare Edge D1 缓存的 Session，失效再请求登录接口）
 */
export async function chaoxingLogin(phone: string, rawPassword: string): Promise<ChaoxingCookies> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;

  // 1. 尝试从 Edge Worker D1 缓存拉取有效 Session
  if (edgeUrl) {
    try {
      const headers: Record<string, string> = {};
      if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;
      const r = await fetch(
        `${edgeUrl.replace(/\/+$/, '')}/api/session?platform=chaoxing&account=${encodeURIComponent(phone)}`,
        { headers }
      );
      if (r.ok) {
        const data: any = await r.json();
        if (data?.session?._uid && data?.session?.vc3) {
          const s = data.session;
          const defaultFid = process.env.CHAOXING_FID || '2893';
          return {
            _uid: s._uid,
            _d: s._d,
            vc3: s.vc3,
            uf: s.uf,
            fid: s.fid || defaultFid,
            cookieStr:
              s.cookie ||
              `_uid=${s._uid}; UID=${s._uid}; _d=${s._d}; vc3=${s.vc3}; uf=${s.uf}; fid=${s.fid || defaultFid}`,
          };
        }
      }
    } catch {
      // 忽略远端缓存读取异常，降级为直接登录
    }
  }

  // 2. 直接请求超星登录接口
  const encPass = encryptChaoxingPassword(rawPassword);
  const body = `uname=${encodeURIComponent(phone)}&password=${encPass}&fid=-1&t=true&refer=https%253A%252F%252Fi.chaoxing.com&forbidotherlogin=0&validate=`;

  const res = await fetch('https://passport2.chaoxing.com/fanyalogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': BROWSER_UA,
    },
    body,
  });

  const json: any = await res.json().catch(() => ({}));
  if (!json.status) {
    throw new Error(`学习通登录失败: ${json.msg2 || json.msg || '请检查账号密码'}`);
  }

  const cookieMap = new Map<string, string>();
  for (const c of getSetCookieList(res)) {
    if (!c) continue;
    const kv = c.split(';')[0].split('=');
    if (kv.length >= 2) {
      cookieMap.set(kv[0].trim(), kv.slice(1).join('=').trim());
    }
  }

  const _uid = cookieMap.get('_uid') || cookieMap.get('UID') || '';
  const _d = cookieMap.get('_d') || '';
  const vc3 = cookieMap.get('vc3') || '';
  const uf = cookieMap.get('uf') || '';
  const fid = cookieMap.get('fid') || process.env.CHAOXING_FID || '2893';
  const lv = cookieMap.get('lv') || '2';

  const cookieStr = `fid=${fid}; _uid=${_uid}; UID=${_uid}; _d=${_d}; vc3=${vc3}; uf=${uf}; lv=${lv}`;
  return { _uid, _d, vc3, uf, fid, lv, cookieStr };
}

/**
 * 获取全部在读课程列表（优先走无需浏览器跳转的 courselistdata 接口）
 */
export async function getChaoxingCourses(cookies: ChaoxingCookies): Promise<CourseInfo[]> {
  const courses: CourseInfo[] = [];
  const seen = new Set<string>();

  // 1. 首选通道：courselistdata POST
  try {
    const res = await fetch('https://mooc1-1.chaoxing.com/visit/courselistdata', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookies.cookieStr,
        'User-Agent': BROWSER_UA,
      },
      body: 'courseType=1&courseFolderId=0&courseFolderSize=1',
    });

    const html = await res.text();
    const regex =
      /<li[^>]*courseId=["'](\d+)["'][^>]*clazzId=["'](\d+)["'](?:[^>]*personId=["'](\d+)["'])?[\s\S]*?<span[^>]*class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/gi;

    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      const key = `${m[1]}_${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        courses.push({
          courseId: m[1],
          classId: m[2],
          cpi: m[3] || '',
          courseName: m[4]?.trim() || `Course_${m[1]}`,
        });
      }
    }
  } catch {
    // ignore
  }

  // 2. 备选通道：study 页面
  if (courses.length === 0) {
    try {
      const res = await fetch('https://mooc1-1.chaoxing.com/visit/courses/study?courseType=1&courseFolderId=0', {
        headers: {
          Cookie: cookies.cookieStr,
          'User-Agent': BROWSER_UA,
        },
      });

      const html = await res.text();
      const regex =
        /<li[^>]*courseId=["'](\d+)["'][^>]*clazzId=["'](\d+)["'](?:[^>]*personId=["'](\d+)["'])?[\s\S]*?<span[^>]*class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/gi;

      let m;
      while ((m = regex.exec(html)) !== null) {
        const key = `${m[1]}_${m[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          courses.push({
            courseId: m[1],
            classId: m[2],
            cpi: m[3] || '',
            courseName: m[4]?.trim() || `Course_${m[1]}`,
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
 * 访问 stucoursemiddle 获取单门课程的完整加密会话参数 (enc, cpi, openc 与附加 Cookie)
 */
export async function fetchCourseSession(
  course: CourseInfo,
  cookies: ChaoxingCookies
): Promise<CourseSessionInfo> {
  let courseCookie = cookies.cookieStr;
  const middleUrl = `https://mooc1-1.chaoxing.com/mycourse/studentcourse?courseid=${course.courseId}&clazzid=${course.classId}&cpi=${course.cpi || ''}&ut=s`;
  const stuMiddle = `https://mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=${course.courseId}&clazzid=${course.classId}&vc=1&cpi=${course.cpi || ''}`;

  const middleRes = await fetch(stuMiddle, {
    headers: {
      Cookie: courseCookie,
      'User-Agent': BROWSER_UA,
    },
    redirect: 'manual',
  });

  for (const c of getSetCookieList(middleRes)) {
    if (c) courseCookie += '; ' + c.split(';')[0];
  }

  const nextUrl = middleRes.headers.get('location') || middleUrl;
  const courseRes = await fetch(nextUrl, {
    headers: {
      Cookie: courseCookie,
      'User-Agent': BROWSER_UA,
    },
    redirect: 'manual',
  });

  for (const c of getSetCookieList(courseRes)) {
    if (c) courseCookie += '; ' + c.split(';')[0];
  }

  const studentCourseHtml = await courseRes.text();

  const encMatch = nextUrl.match(/enc=([a-f0-9]+)/i) || studentCourseHtml.match(/enc=([a-f0-9]+)/i);
  const enc = encMatch ? encMatch[1] : '';

  const cpiMatch = nextUrl.match(/cpi=([0-9]+)/i) || studentCourseHtml.match(/cpi=([0-9]+)/i);
  const cpi = cpiMatch ? cpiMatch[1] : course.cpi || '';

  const opencMatch = nextUrl.match(/openc=([a-f0-9]+)/i) || studentCourseHtml.match(/openc=([a-f0-9]+)/i);
  const openc = opencMatch ? opencMatch[1] : '';

  return {
    courseCookie,
    enc,
    cpi,
    openc,
    studentCourseHtml,
  };
}
