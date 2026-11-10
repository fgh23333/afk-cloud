import { ChaoxingCookies } from './session';

function buildCookieString(cookies: Record<string, any>): string {
  return Object.entries(cookies)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 获取超星云盘有效上传凭据 Token
 */
export async function getPanToken(cookies: ChaoxingCookies): Promise<string | null> {
  try {
    const res = await fetch('https://pan-yz.chaoxing.com/api/token/uservalid', {
      headers: {
        Cookie: buildCookieString(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const data: any = await res.json().catch(() => ({}));
    if (data?.result && data?._token) {
      return data._token;
    }
  } catch (err: any) {
    console.warn(`[getPanToken] 获取云盘 Token 异常: ${err?.message || err}`);
  }
  return null;
}

/**
 * 自动生成 1x1 像素临时打卡图片并上传至超星云盘获取 objectId
 */
export async function getOrUploadPhotoObject(cookies: ChaoxingCookies): Promise<string | null> {
  const token = await getPanToken(cookies);
  if (!token) return null;

  try {
    // 1x1 blank PNG base64
    const sampleBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const binary = Buffer.from(sampleBase64, 'base64');

    const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="1.png"\r\nContent-Type: image/png\r\n\r\n`
    );
    const puidField = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="puid"\r\n\r\n${cookies._uid}\r\n--${boundary}--\r\n`
    );

    const bodyBuffer = Buffer.concat([header, binary, puidField]);

    const res = await fetch(`https://pan-yz.chaoxing.com/upload?_from=mobilelearn&_token=${token}`, {
      method: 'POST',
      headers: {
        Cookie: buildCookieString(cookies),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBuffer,
    });

    const data: any = await res.json().catch(() => ({}));
    if (data?.objectId) {
      console.log(`[PhotoSign] 自动生成打卡照片成功 (objectId: ${data.objectId})`);
      return String(data.objectId);
    }
  } catch (err: any) {
    console.warn(`[PhotoSign] 上传打卡照片失败: ${err?.message || err}`);
  }
  return null;
}

/**
 * 执行拍照签到提交
 */
export async function submitPhotoSign(options: {
  activeId: string;
  courseId: string;
  classId: string;
  fid: string;
  objectId: string;
  name?: string;
  cookies: ChaoxingCookies;
}): Promise<string> {
  const { activeId, fid, objectId, name = '同学', cookies } = options;
  const url = `https://mobilelearn.chaoxing.com/pptSign/stuSignajax?activeId=${activeId}&uid=${cookies._uid}&clientip=&useragent=&latitude=-1&longitude=-1&appType=15&fid=${fid}&objectId=${objectId}&name=${encodeURIComponent(name)}`;

  const res = await fetch(url, {
    headers: {
      Cookie: buildCookieString(cookies),
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    },
  });

  const text = await res.text();
  return text.includes('success') || text.includes('成功')
    ? `[拍照签到成功] 活动: ${activeId} (objectId: ${objectId})`
    : `[拍照签到响应] ${text.slice(0, 100)}`;
}
