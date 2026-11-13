import { blue, green, red, yellow } from 'kolorist';
import { CourseInfo } from '../../core/types';
import { scanCourseActivitiesShared, type ScanActivitiesResult } from './activity-protocol';
import { getOrUploadPhotoObject } from './photo';
import { ChaoxingCookies } from './session';

export interface SignLocation {
  lon: string;
  lat: string;
  address: string;
}

// 预设上海海洋大学经纬度坐标池 (完全对齐 chaoxing-signin 原生实现)
export const DEFAULT_SHOU_LOCATIONS: SignLocation[] = [
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

export interface ChaoxingActivity {
  id: string;
  name: string;
  courseId: string;
  classId: string;
  otherId?: number;
  ifphoto?: number;
}

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ChaoXingStudy/ChaoXingStudy_3_5.3.4_ios_phone_202011241926_118 (@Kalimdor)_13264426514748197793';

/**
 * 扫描单门课程的有效活动（含频控熔断检测）
 */
export async function scanCourseActivitiesWithMeta(
  course: CourseInfo,
  cookies: ChaoxingCookies
): Promise<ScanActivitiesResult> {
  return scanCourseActivitiesShared(course, cookies.cookieStr, cookies._uid, MOBILE_UA);
}

/**
 * 扫描单门课程的有效签到活动（共享核心通道，具备“请勿频繁操作”熔断保护）
 */
export async function scanCourseActivities(
  course: CourseInfo,
  cookies: ChaoxingCookies
): Promise<ChaoxingActivity[]> {
  const res = await scanCourseActivitiesWithMeta(course, cookies);
  return res.activities.map((a) => ({
    id: a.id,
    name: a.name,
    courseId: a.courseId,
    classId: a.classId,
    otherId: a.otherId,
    ifphoto: a.ifphoto,
  }));
}

/**
 * 查询活动详细信息 (获取准确 otherId 和 ifphoto)
 */
export async function getPPTActiveInfo(activeId: string, cookies: ChaoxingCookies): Promise<any> {
  try {
    const url = `https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${activeId}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookies.cookieStr,
        'User-Agent': MOBILE_UA,
      },
    });
    const json: any = await res.json().catch(() => ({}));
    return json?.data || {};
  } catch {
    return {};
  }
}

/**
 * 执行全类型超星签到（完整照搬 chaoxing-signin 原生实现：位置多坐标重试、拍照自动上传打卡图、手势、签到码、二维码与多级兜底）
 */
export async function performChaoxingSign(
  activity: ChaoxingActivity,
  course: CourseInfo,
  cookies: ChaoxingCookies,
  name = '同学',
  locations: SignLocation[] = DEFAULT_SHOU_LOCATIONS,
  enc = '',
  signCode = ''
): Promise<string> {
  const activeId = activity.id;
  const actName = activity.name || '在线签到';

  // 1. 查询活动精确属性 (otherId 与 ifphoto)
  let otherId = activity.otherId !== undefined ? Number(activity.otherId) : 0;
  let ifphoto = activity.ifphoto !== undefined ? Number(activity.ifphoto) : 0;

  try {
    const pptInfo = await getPPTActiveInfo(activeId, cookies);
    if (pptInfo?.otherId !== undefined) otherId = Number(pptInfo.otherId);
    if (pptInfo?.ifphoto !== undefined) ifphoto = Number(pptInfo.ifphoto);
  } catch {
    // 降级使用传入属性
  }

  // 2. 发起 preSign 预签到
  try {
    const preUrl = `https://mobilelearn.chaoxing.com/newsign/preSign?courseId=${course.courseId}&classId=${course.classId}&activePrimaryId=${activeId}&general=1&sys=1&ls=1&appType=15&uid=${cookies._uid}&ut=s`;
    await fetch(preUrl, {
      headers: {
        Cookie: cookies.cookieStr,
        'User-Agent': MOBILE_UA,
      },
    });
  } catch {
    // ignore
  }

  const pool = locations.length > 0 ? locations : DEFAULT_SHOU_LOCATIONS;

  // 3. 针对不同类型分发（完全对齐 chaoxing-signin 逻辑）

  // A. 位置签到 (otherId === 4 或名称包含位置)：轮询尝试预设坐标池
  if (otherId === 4 || actName.includes('位置')) {
    let lastMsg = '';
    for (let i = 0; i < pool.length; i++) {
      const loc = pool[i];
      const stuSignUrl = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}&activeId=${activeId}&uid=${cookies._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${cookies.fid}&appType=15&ifTiJiao=1`;
      try {
        const res = await fetch(stuSignUrl, {
          headers: {
            Cookie: cookies.cookieStr,
            'User-Agent': MOBILE_UA,
          },
        });
        const text = await res.text();
        if (text.includes('success') || text.includes('成功')) {
          return `[位置签到成功] 活动: 《${actName}》 (匹配坐标: ${loc.address})`;
        }
        lastMsg = text;
      } catch (e: any) {
        lastMsg = e?.message || '网络异常';
      }
    }
    return `[位置签到未匹配] 活动: 《${actName}》 (已尝试 ${pool.length} 处预设坐标，响应: ${lastMsg})`;
  }

  // B. 拍照签到 (ifphoto === 1 或活动名称包含拍照)：自动生成并上传打卡图获取 objectId
  let objectId = '';
  if (ifphoto === 1 || actName.includes('拍照')) {
    console.log(`[拍照签到] 活动 ${activeId} 需上传照片，自动上传 1x1 打卡图片...`);
    try {
      objectId = (await getOrUploadPhotoObject(cookies)) || '';
    } catch {
      // ignore
    }
  }

  const loc = pool[Math.floor(Math.random() * pool.length)];
  const encParam = enc ? `&enc=${encodeURIComponent(enc)}` : '';
  const objParam = objectId ? `&objectId=${encodeURIComponent(objectId)}` : '';
  const signCodeParam = signCode ? `&signCode=${encodeURIComponent(signCode)}` : '';

  // 4. 主通道：stuSignajax 提交
  const stuSignUrl = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}&activeId=${activeId}&uid=${cookies._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${cookies.fid}&appType=15&ifTiJiao=1${encParam}${objParam}${signCodeParam}`;

  try {
    const res = await fetch(stuSignUrl, {
      headers: {
        Cookie: cookies.cookieStr,
        'User-Agent': MOBILE_UA,
      },
    });
    const text = await res.text();
    if (text.includes('success') || text.includes('成功')) {
      const typeLabel = objectId ? '拍照' : otherId === 3 ? '手势' : otherId === 5 ? '签到码' : otherId === 2 ? '二维码' : '通用';
      return `[${typeLabel}签到成功] 活动: 《${actName}》 (ID: ${activeId})`;
    }
  } catch {
    // ignore
  }

  // 5. 备用通道一：receivedAttendanceWindowList
  try {
    const signUrl = `https://mobilelearn.chaoxing.com/ppt/activeAPI/receivedAttendanceWindowList?activeId=${activeId}&uid=${cookies._uid}&clientip=&latitude=${loc.lat}&longitude=${loc.lon}&fid=${cookies.fid}&appType=15&address=${encodeURIComponent(loc.address)}&name=${encodeURIComponent(name)}${encParam}${objParam}${signCodeParam}`;
    const res = await fetch(signUrl, {
      headers: {
        Cookie: cookies.cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const text = await res.text();
    if (text.includes('success') || text.includes('成功')) {
      return `[签到成功(备用通道)] 活动: 《${actName}》 (ID: ${activeId})`;
    }
  } catch {
    // ignore
  }

  // 6. 备用通道二：pcReq (移动端原生直通)
  try {
    const mobileUrl = `https://mobilelearn.chaoxing.com/widget/sign/pcReq?activeId=${activeId}&uid=${cookies._uid}&latitude=${loc.lat}&longitude=${loc.lon}&fid=${cookies.fid}&appType=15&name=${encodeURIComponent(name)}&address=${encodeURIComponent(loc.address)}${objParam}`;
    const mRes = await fetch(mobileUrl, {
      headers: {
        Cookie: cookies.cookieStr,
        'User-Agent': MOBILE_UA,
      },
    });
    const mText = await mRes.text();
    return `[签到提交] 响应: ${mText.substring(0, 100).replace(/\s+/g, ' ')}`;
  } catch (e: any) {
    return `[签到异常] ${e?.message || e}`;
  }
}
