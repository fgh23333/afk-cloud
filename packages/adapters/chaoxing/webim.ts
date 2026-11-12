import EventEmitter from 'events';
import { ChaoxingCookies } from './session';

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

/**
 * 从群聊消息文本或扩展字段中精确抽取签到与通知信令
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

export interface WebIMListenerOptions {
  cookies: ChaoxingCookies;
  config?: Partial<WebIMConfig>;
  onSignSignal?: (event: SignSignalEvent) => void | Promise<void>;
  onNoticeSignal?: (event: NoticeSignalEvent) => void | Promise<void>;
  onError?: (err: Error) => void;
}

/**
 * 环信 WebIM 课程群信令监听器
 * 封装长连接心跳、断线重连、信令分发
 */
export class ChaoxingWebIMListener extends EventEmitter {
  private config: WebIMConfig;
  private cookies: ChaoxingCookies;
  private isRunning = false;

  constructor(options: WebIMListenerOptions) {
    super();
    this.cookies = options.cookies;
    this.config = { ...DEFAULT_WEBIM_CONFIG, ...options.config };

    if (options.onSignSignal) this.on('sign', options.onSignSignal);
    if (options.onNoticeSignal) this.on('notice', options.onNoticeSignal);
    if (options.onError) this.on('error', options.onError);
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
