import { ChaoxingCookies } from './session';

export interface ExamNoticeItem {
  examId: string;
  title: string;
  courseId: string;
  courseName: string;
  classId: string;
  url: string;
  startTime: string;
  endTime: string;
  isExpired: boolean;
}

export interface NoticeItem {
  id: string;
  title: string;
  content: string;
  creatorName: string;
  createTime: string;
  tag: string;
  examInfo?: ExamNoticeItem;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function buildCookieString(cookies: Record<string, any>): string {
  return Object.entries(cookies)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 获取超星通知列表（包含全量学习通知、班级通知、随堂考试/测验通知等）
 */
export async function fetchNoticeList(cookies: ChaoxingCookies, limit = 20): Promise<NoticeItem[]> {
  const cookieStr = buildCookieString(cookies);
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookieStr,
      'User-Agent': BROWSER_UA,
      Referer: 'https://notice.chaoxing.com/pc/notice/myNotice',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`获取通知列表 HTTP 错误: ${res.status}`);
  }

  const data: any = await res.json();
  const rawList: any[] = data.notices?.list || [];

  const notices: NoticeItem[] = [];

  for (const n of rawList.slice(0, limit)) {
    let examInfo: ExamNoticeItem | undefined = undefined;

    // 解析附件中的考试/随堂练习对象
    if (n.attachment) {
      try {
        const attachList = JSON.parse(n.attachment);
        const examAttach = attachList.find((a: any) => a.att_web && a.att_web.examOrWork === 'exam');
        if (examAttach && examAttach.att_web) {
          const w = examAttach.att_web;
          let startTime = '';
          let endTime = '';
          let courseName = '';

          // 尝试从 extendParam.cparams 中提取精准时段
          if (n.extendParam && n.extendParam.cparams) {
            try {
              const cparams = JSON.parse(n.extendParam.cparams);
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

          let isExpired = false;
          if (endTime) {
            const endMs = new Date(endTime).getTime();
            if (!isNaN(endMs) && endMs < Date.now()) {
              isExpired = true;
            }
          }

          examInfo = {
            examId: String(w.examOrWorkId || examAttach.examOrTextId || ''),
            title: w.title || n.title,
            courseId: String(w.courseId || ''),
            courseName: courseName || `Course_${w.courseId}`,
            classId: String(w.clazzId || ''),
            url: w.url || '',
            startTime: startTime || '未指定开始时间',
            endTime: endTime || '未指定截止时间',
            isExpired,
          };
        }
      } catch {
        // ignore JSON parse error
      }
    }

    notices.push({
      id: String(n.id || ''),
      title: n.title || '无标题通知',
      content: n.content || '',
      creatorName: n.createrName || '任课教师',
      createTime: n.inserttime
        ? new Date(Number(n.inserttime)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '近期',
      tag: n.tag || '课程通知',
      examInfo,
    });
  }

  return notices;
}
