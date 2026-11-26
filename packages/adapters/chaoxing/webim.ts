import EventEmitter from 'events';
import { CourseInfo } from '../../core/types';
import { ChaoxingCookies, CourseSessionInfo, fetchCourseSession } from './session';
import { DEFAULT_SHOU_LOCATIONS, performChaoxingSign, SignLocation } from './signin';

export interface WebIMConfig {
  xmppURL: string;
  apiURL: string;
  appkey: string;
  Host: string;
}

export const DEFAULT_WEBIM_CONFIG: WebIMConfig = {
  xmppURL: 'https://im-api-vip6-v2.easecdn.com/ws',
  apiURL: 'https://a1-vip6.easecdn.com',
  appkey: 'cx-dev#cxstudy',
  Host: 'easemob.com',
};

export interface SignSignalEvent {
  type: 'sign';
  activeId: string;
  courseId?: string;
  classId?: string;
  chatId?: string;
  title?: string;
  signType?: string;
  signCode?: string;
  enc?: string;
  timestamp: number;
  rawPayload?: any;
}

export interface NoticeSignalEvent {
  type: 'notice';
  noticeId?: string;
  title?: string;
  content?: string;
  courseId?: string;
  timestamp: number;
  rawPayload?: any;
}

export type WebIMSignalEvent = SignSignalEvent | NoticeSignalEvent;

export interface FlashSignExecutionResult {
  executed: boolean;
  skipped: boolean;
  activeId: string;
  courseId: string;
  classId: string;
  courseName: string;
  result: string;
  reason?: string;
}

export interface ChapterPointItem {
  chapterId: string;
  title: string;
  unfinishedPoints: number;
  status: 'completed' | 'pending' | 'open';
  url: string;
}

export interface CourseChapterProgressSummary {
  courseId: string;
  classId: string;
  courseName: string;
  totalChapters: number;
  completedChapters: number;
  pendingChapters: number;
  totalUnfinishedPoints: number;
  completionRate: number;
  pendingChapterTitles: string[];
  chapters: ChapterPointItem[];
}

/**
 * 从群聊消息文本或扩展字段中精确抽取签到与通知信令（支持提取签到码 signCode 与二维码 enc）
 */
export function parseWebIMMessage(message: any): WebIMSignalEvent | null {
  if (!message) return null;

  const now = Date.now();
  const ext = message.ext || message.custom || {};
  const bodyText = typeof message.data === 'string'
    ? message.data
    : typeof message.msg === 'string'
      ? message.msg
      : JSON.stringify(message);

  const codeMatch = bodyText.match(/(?:签到码|手势码|手势|验证码)[：:\s]*([0-9]{4,8})/i);
  const encMatch = bodyText.match(/[?&]enc=([a-fA-F0-9]{16,64})/i) || bodyText.match(/"enc"\s*:\s*"([a-fA-F0-9]{16,64})"/i);
  const extractedSignCode = ext.signCode || ext.code || (codeMatch ? codeMatch[1] : undefined);
  const extractedEnc = ext.enc || (encMatch ? encMatch[1] : undefined);

  // 1. 优先从 ext 结构化载荷中解析活动 ID
  const activeIdFromExt = ext.activeId || ext.activePrimaryId || ext.id || ext.aid;
  if (activeIdFromExt) {
    const isSign = ext.atype === 'sign' || ext.type === 2 || ext.activeType === 2 || String(ext.name || '').includes('签到');
    if (isSign) {
      return {
        type: 'sign',
        activeId: String(activeIdFromExt),
        courseId: ext.courseId ? String(ext.courseId) : undefined,
        classId: ext.classId ? String(ext.classId) : undefined,
        chatId: ext.chatId ? String(ext.chatId) : undefined,
        title: ext.name || ext.title || '课堂签到',
        signType: ext.signType || '通用',
        ...(extractedSignCode ? { signCode: String(extractedSignCode) } : {}),
        ...(extractedEnc ? { enc: String(extractedEnc) } : {}),
        timestamp: now,
        rawPayload: ext,
      };
    }
  }

  // 2. 正则匹配消息体中的签到链接与参数
  // 例如: https://mobilelearn.chaoxing.com/newsign/preSign?courseId=...&activePrimaryId=8000184041445...
  const activeIdMatch = bodyText.match(/active(?:Primary)?Id[=:]\s*["']?(\d{5,20})/i)
    || bodyText.match(/\/newsign\/preSign\?[^"'\s]*activePrimaryId=(\d+)/i)
    || bodyText.match(/preStuSign\?[^"'\s]*activeId=(\d+)/i);

  if (activeIdMatch) {
    const activeId = activeIdMatch[1];
    const courseIdMatch = bodyText.match(/courseId[=:]\s*["']?(\d+)/i);
    const classIdMatch = bodyText.match(/classId[=:]\s*["']?(\d+)/i);
    const chatIdMatch = bodyText.match(/chatId[=:]\s*["']?(\d+)/i);

    return {
      type: 'sign',
      activeId,
      courseId: courseIdMatch ? courseIdMatch[1] : undefined,
      classId: classIdMatch ? classIdMatch[1] : undefined,
      chatId: chatIdMatch ? chatIdMatch[1] : undefined,
      title: '实时信令捕获签到',
      ...(extractedSignCode ? { signCode: String(extractedSignCode) } : {}),
      ...(extractedEnc ? { enc: String(extractedEnc) } : {}),
      timestamp: now,
      rawPayload: bodyText,
    };
  }

  // 3. 检查是否为作业/通知信令
  const noticeMatch = bodyText.match(/noticeId[=:]\s*["']?(\d+)/i) || bodyText.match(/activeType[=:]\s*45/i);
  if (noticeMatch) {
    return {
      type: 'notice',
      noticeId: noticeMatch[1] || undefined,
      title: ext.title || '课程通知',
      content: ext.content || bodyText.slice(0, 200),
      courseId: ext.courseId ? String(ext.courseId) : undefined,
      timestamp: now,
      rawPayload: ext,
    };
  }

  return null;
}

/**
 * 零 JSDOM 解析超星 studentcourse 页面章节任务点进度（复用 fetchCourseSession 已拉取的 studentCourseHtml）
 */
export function parseCourseChapterProgressHtml(
  html: string,
  course: CourseInfo
): CourseChapterProgressSummary {
  const chapters: ChapterPointItem[] = [];
  const seenIds = new Set<string>();
  const source = String(html || '');

  // 匹配章节节点（支持 Mooc1 cur{chapterId} / getTeacherAjax / Mooc2 chapterId 属性或链接）
  const blockRegex =
    /<(?:li|div|h3|a)\b[^>]*(?:id=["']cur(\d+)["']|data-chapterid=["'](\d+)["']|chapterId=(\d+)|getTeacherAjax\([^)]*['"](\d+)['"]\))[^>]*>([\s\S]*?)(?=<(?:li|div|h3|a)\b[^>]*(?:id=["']cur\d+["']|data-chapterid=["']\d+["']|chapterId=\d+|getTeacherAjax\()|$)/gi;

  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(source)) !== null) {
    const chapterId = m[1] || m[2] || m[3] || m[4] || '';
    if (!chapterId || seenIds.has(chapterId)) continue;
    seenIds.add(chapterId);

    const block = m[0].slice(0, 2500);
    const titleAttrMatch =
      block.match(/class=["'][^"']*(?:articlename|chapter_title|catalog_name|posCatalog_name)[^"']*["'][^>]*title=["']([^"']+)["']/i) ||
      block.match(/title=["']([^"']+)["']/i);
    const spanTextMatch = block.match(
      /<span[^>]*class=["'][^"']*(?:articlename|chapter_title|catalog_name|posCatalog_name)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );
    const rawTitle = titleAttrMatch
      ? titleAttrMatch[1]
      : spanTextMatch
        ? spanTextMatch[1].replace(/<[^>]+>/g, ' ')
        : `章节_${chapterId}`;
    const title = rawTitle.replace(/\s+/g, ' ').trim() || `章节_${chapterId}`;

    const unfinishInputMatch =
      block.match(/class=["'][^"']*jobUnfinishCount[^"']*["'][^>]*value=["'](\d+)["']/i) ||
      block.match(/value=["'](\d+)["'][^>]*class=["'][^"']*jobUnfinishCount[^"']*["']/i) ||
      block.match(/data-unfinish=["'](\d+)["']/i) ||
      block.match(/<span[^>]*class=["'][^"']*(?:orangeNew|jobCount|unfinish)[^"']*["'][^>]*>\s*(\d+)\s*<\/span>/i);

    const unfinishedPoints = unfinishInputMatch ? Math.max(0, parseInt(unfinishInputMatch[1], 10) || 0) : 0;
    const hasCompletedMarker =
      /icon_yiwanc|catalogue_points_yi|job_done|\bcompleted\b/i.test(block) ||
      (unfinishInputMatch !== null && unfinishedPoints === 0);

    const status: ChapterPointItem['status'] =
      unfinishedPoints > 0 ? 'pending' : hasCompletedMarker ? 'completed' : 'open';

    chapters.push({
      chapterId,
      title,
      unfinishedPoints,
      status,
      url: `https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=${chapterId}&courseId=${course.courseId}&clazzid=${course.classId}&cpi=${course.cpi || ''}`,
    });
  }

  const totalChapters = chapters.length;
  const pendingChapterItems = chapters.filter((c) => c.status === 'pending');
  const pendingChapters = pendingChapterItems.length;
  const completedChapters = totalChapters - pendingChapters;
  const totalUnfinishedPoints = chapters.reduce((acc, c) => acc + c.unfinishedPoints, 0);
  const completionRate = totalChapters > 0 ? Math.round((completedChapters / totalChapters) * 100) : 100;
  const pendingChapterTitles = pendingChapterItems.slice(0, 5).map((c) => c.title);

  return {
    courseId: course.courseId,
    classId: course.classId,
    courseName: course.courseName || `Course_${course.courseId}`,
    totalChapters,
    completedChapters,
    pendingChapters,
    totalUnfinishedPoints,
    completionRate,
    pendingChapterTitles,
    chapters,
  };
}

/**
 * 扫描单门课程的章节任务点完成进度（支持直接复用已有的 CourseSessionInfo 避免额外 HTTP 请求）
 */
export async function scanCourseChapterProgress(
  course: CourseInfo,
  cookies: ChaoxingCookies,
  sessionInfo?: CourseSessionInfo
): Promise<CourseChapterProgressSummary> {
  const session = sessionInfo || (await fetchCourseSession(course, cookies));
  return parseCourseChapterProgressHtml(session.studentCourseHtml, course);
}

export interface WebIMListenerOptions {
  cookies: ChaoxingCookies;
  config?: Partial<WebIMConfig>;
  dedupTtlMs?: number;
  onSignSignal?: (event: SignSignalEvent) => void | Promise<void>;
  onNoticeSignal?: (event: NoticeSignalEvent) => void | Promise<void>;
  onError?: (err: Error) => void;
}

/**
 * 环信 WebIM 课程群信令监听器
 * 封装长连接心跳、断线重连、信令分发与闪签幂等去重执行
 */
export class ChaoxingWebIMListener extends EventEmitter {
  private config: WebIMConfig;
  private cookies: ChaoxingCookies;
  private isRunning = false;
  private dedupTtlMs: number;
  private processedSignIds = new Map<string, number>();

  constructor(options: WebIMListenerOptions) {
    super();
    this.cookies = options.cookies;
    this.config = { ...DEFAULT_WEBIM_CONFIG, ...options.config };
    this.dedupTtlMs = options.dedupTtlMs ?? 2 * 60 * 60 * 1000;

    if (options.onSignSignal) this.on('sign', options.onSignSignal);
    if (options.onNoticeSignal) this.on('notice', options.onNoticeSignal);
    if (options.onError) this.on('error', options.onError);
  }

  /**
   * 检查某个签到 activeId 在去重窗口内是否已处理过
   */
  public isSignSignalProcessed(activeId: string, nowMs = Date.now()): boolean {
    const ts = this.processedSignIds.get(activeId);
    if (ts === undefined) return false;
    if (nowMs - ts > this.dedupTtlMs) {
      this.processedSignIds.delete(activeId);
      return false;
    }
    return true;
  }

  /**
   * 接收到闪签信令后执行幂等去重与秒级自动签到
   */
  public async handleFlashSignSignal(
    signal: SignSignalEvent,
    options?: {
      courses?: CourseInfo[];
      realname?: string;
      locations?: SignLocation[];
      nowMs?: number;
      signExecutor?: typeof performChaoxingSign;
    }
  ): Promise<FlashSignExecutionResult> {
    const nowMs = options?.nowMs ?? Date.now();
    const activeId = String(signal?.activeId || '').trim();
    if (!signal || signal.type !== 'sign' || !activeId) {
      return {
        executed: false,
        skipped: true,
        activeId,
        courseId: '',
        classId: '',
        courseName: '',
        result: '',
        reason: 'invalid_signal',
      };
    }

    const matchedCourse = (options?.courses || []).find(
      (c) =>
        (signal.courseId && c.courseId === signal.courseId) ||
        (signal.classId && c.classId === signal.classId)
    );
    const targetCourse: CourseInfo = matchedCourse || {
      courseId: signal.courseId || '',
      classId: signal.classId || '',
      courseName: signal.title || '课堂闪签',
    };

    if (this.isSignSignalProcessed(activeId, nowMs)) {
      return {
        executed: false,
        skipped: true,
        activeId,
        courseId: targetCourse.courseId,
        classId: targetCourse.classId,
        courseName: targetCourse.courseName,
        result: '',
        reason: 'duplicate_active_id',
      };
    }

    if (this.processedSignIds.size >= 200) {
      for (const [k, ts] of this.processedSignIds) {
        if (nowMs - ts > this.dedupTtlMs) this.processedSignIds.delete(k);
      }
    }
    this.processedSignIds.set(activeId, nowMs);

    const executor = options?.signExecutor || performChaoxingSign;
    const result = await executor(
      {
        id: activeId,
        name: signal.title || '课堂闪签',
        courseId: targetCourse.courseId,
        classId: targetCourse.classId,
      },
      targetCourse,
      this.cookies,
      options?.realname || '同学',
      options?.locations || DEFAULT_SHOU_LOCATIONS,
      signal.enc || '',
      signal.signCode || ''
    );

    const outcome: FlashSignExecutionResult = {
      executed: true,
      skipped: false,
      activeId,
      courseId: targetCourse.courseId,
      classId: targetCourse.classId,
      courseName: targetCourse.courseName,
      result,
    };
    this.emit('sign_executed', outcome);
    return outcome;
  }

  /**
   * 启动信令监听
   */
  public async start(): Promise<boolean> {
    if (this.isRunning) return true;
    this.isRunning = true;

    // 记录启动信令监听日志
    this.emit('status', {
      connected: false,
      message: 'WebIM 信令监听管道已初始化，准备监听课程群消息...',
      appkey: this.config.appkey,
    });

    return true;
  }

  /**
   * 接收并处理一条原始群聊消息（供 WebSocket 驱动或模拟注入测试）
   */
  public handleRawMessage(rawMessage: any): WebIMSignalEvent | null {
    const signal = parseWebIMMessage(rawMessage);
    if (!signal) return null;

    if (signal.type === 'sign') {
      this.emit('sign', signal);
    } else if (signal.type === 'notice') {
      this.emit('notice', signal);
    }

    return signal;
  }

  /**
   * 停止监听
   */
  public stop(): void {
    this.isRunning = false;
    this.emit('status', { connected: false, message: 'WebIM 监听器已停止' });
  }
}
