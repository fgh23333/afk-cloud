import { blue, green, red, yellow } from 'kolorist';
import fs from 'fs';
import path from 'path';
import { getLinuxMemAvailableMb } from '../../core/agy-invoke';
import {
  BrowserCookie,
  detectChromiumExecutable,
  getBrowserProfilePaths,
  launchHeadlessBrowserWithProfile,
  pullBrowserProfileFromCloud,
  pushBrowserProfileToCloud,
  readLocalStorageState,
  writeLocalStorageState,
} from '../../core/browser-profile';
import { PlatformPlugin, PluginContext, PluginManifest } from '../../core/plugin';
import { triggerCloudBurst } from '../../core/sandbox';
import {
  CourseInfo,
  HomeworkSummary,
  PlatformAdapter,
  PlatformName,
  SolveOptions,
  SolveResult,
} from '../../core/types';
import { CdpClient } from '../web-agent/cdp-client';

export const ZHIHUISHU_DEFAULT_STUDY_URL = 'https://studyvideoh5.zhihuishu.com/stuStudy';
export const ZHIHUISHU_ALLOWED_RATES = [1.0, 1.25, 1.5] as const;

export type ZhihuishuPlaybackStatus =
  | 'auth_required'
  | 'captcha_required'
  | 'quiz_paused'
  | 'playing'
  | 'switching_next'
  | 'completed'
  | 'loading';

export interface ZhihuishuDomInspection {
  status: ZhihuishuPlaybackStatus;
  url: string;
  currentLessonTitle: string;
  completedLessons: number;
  totalLessons: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
  muted: boolean;
  ended: boolean;
  action?: string;
  message?: string;
  quizTitle?: string;
  quizOptions?: string[];
}

export interface ZhihuishuWatchOptions {
  studyUrl: string;
  targetRate?: number;
  maxMinutes?: number;
  headless?: boolean;
  debuggingPort?: number;
  pollIntervalMs?: number;
  tier?: 'local' | 'gce';
  dryRun?: boolean;
  ignoreMemGuard?: boolean;
}

export interface ZhihuishuWatchResult {
  status: 'completed' | 'auth_required' | 'captcha_required' | 'quiz_paused' | 'timeout' | 'aborted';
  completedLessons: number;
  totalLessons: number;
  lastLessonTitle: string;
  screenshotPath?: string;
  message: string;
}

/**
 * 将请求倍率收敛到平台原生支持的播放档位 (1.0x / 1.25x / 1.5x)
 */
export function clampZhihuishuRate(rate?: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 1.0) return 1.0;
  if (rate >= 1.45) return 1.5;
  if (rate >= 1.2) return 1.25;
  return 1.0;
}

/**
 * 校验智慧树学习 URL 必须为 https://*.zhihuishu.com
 */
export function isValidZhihuishuStudyUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host === 'zhihuishu.com' || host.endsWith('.zhihuishu.com');
  } catch {
    return false;
  }
}

/**
 * 在浏览器页面上下文中执行的合规定时巡检与播放控制表达式：
 * - 不修改 document.hidden / visibilityState，不拦截失焦事件
 * - 不触碰、不绕过滑块验证码（#captchaYidun / .yidun_popup）
 * - 不伪造后端心跳接口，仅按合法 UI 倍速真实播放、静音、自然播完后切换下一未完成小节
 */
export function buildZhihuishuInspectExpression(targetRate = 1.5): string {
  const safeRate = clampZhihuishuRate(targetRate);
  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return !rect || (rect.width > 5 && rect.height > 5) || st.position === 'fixed';
    };

    const href = String(window.location.href || '');
    const bodyText = String(document.body && document.body.innerText ? document.body.innerText : '').slice(0, 1200);
    const lessonNodes = Array.from(document.querySelectorAll('.clearfix.video'));
    const video = document.querySelector('#container video, video');

    // 1. 登录态失效或停留在登录页/扫码页
    const loginMarker = document.querySelector('.login-ewm, .qr-login, #lUsername, .wall-main');
    if (
      href.includes('passport.zhihuishu.com') ||
      ((loginMarker || /扫码登录|密码登录|请先登录/.test(bodyText)) && !video && lessonNodes.length === 0)
    ) {
      return {
        status: 'auth_required',
        url: href,
        currentLessonTitle: '',
        completedLessons: 0,
        totalLessons: 0,
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        muted: false,
        ended: false,
        message: '需要登录智慧树（扫码或导入 Cookie）',
      };
    }

    // 2. 检测到网易易盾/253 滑块或人机验证码：立即暂停视频并返回，绝不触碰或尝试绕过
    const captchaSelectors = [
      '#captchaYidun .yidun_panel',
      '#captchaYidun .yidun_popup',
      '.yidun_popup.yidun_popup--light',
      '.yidun_modal',
      '.yidun_panel',
      '#captchaYidun iframe',
    ];
    for (const sel of captchaSelectors) {
      const capEl = document.querySelector(sel);
      if (isVisible(capEl)) {
        if (video && !video.paused) {
          try { video.pause(); } catch {}
        }
        return {
          status: 'captcha_required',
          url: href,
          currentLessonTitle: '',
          completedLessons: 0,
          totalLessons: lessonNodes.length,
          currentTime: video ? Number(video.currentTime || 0) : 0,
          duration: video ? Number(video.duration || 0) : 0,
          playbackRate: video ? Number(video.playbackRate || 1) : 1,
          muted: video ? Boolean(video.muted) : false,
          ended: false,
          message: '检测到易盾滑块/人机验证，已暂停等待人工处理',
        };
      }
    }

    // 3. 统计课程小节与已完成数（.time_icofinish）
    let totalLessons = lessonNodes.length;
    let completedLessons = 0;
    let activeIdx = -1;
    let firstUnfinishedIdx = -1;
    let currentLessonTitle = '';

    lessonNodes.forEach((node, idx) => {
      const finished = Boolean(node.querySelector('.time_icofinish'));
      if (finished) completedLessons++;
      else if (firstUnfinishedIdx < 0) firstUnfinishedIdx = idx;

      if (node.classList.contains('current_play') || node.querySelector('.current_play')) {
        activeIdx = idx;
        currentLessonTitle = String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      }
    });

    if (!currentLessonTitle) {
      const curEl = document.querySelector('.current_play .catalogue_title, .current_play, .videotop_lesson_tit');
      if (curEl) currentLessonTitle = String(curEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    }

    // 4. 检测视频内随堂弹题弹窗（.dialog-test），提取题干与选项并暂停提醒
    const dialogCandidates = Array.from(document.querySelectorAll('.dialog-test, .el-dialog__wrapper'));
    for (const dlg of dialogCandidates) {
      if (!isVisible(dlg)) continue;
      if (dlg.closest && dlg.closest('#captchaYidun')) continue;
      const topics = Array.from(dlg.querySelectorAll('.topic-item'));
      const dlgText = String(dlg.textContent || '').replace(/\\s+/g, ' ').trim();
      if (dlg.classList.contains('dialog-test') || topics.length > 0 || /弹题|随堂测试/.test(dlgText)) {
        const titleEl = dlg.querySelector('.topic-title, .dialog-header-title, .el-dialog__title');
        return {
          status: 'quiz_paused',
          url: href,
          currentLessonTitle,
          completedLessons,
          totalLessons,
          currentTime: video ? Number(video.currentTime || 0) : 0,
          duration: video ? Number(video.duration || 0) : 0,
          playbackRate: video ? Number(video.playbackRate || 1) : 1,
          muted: video ? Boolean(video.muted) : false,
          ended: false,
          quizTitle: (titleEl ? titleEl.textContent : dlgText).replace(/\\s+/g, ' ').trim().slice(0, 180),
          quizOptions: topics.map((t) => String(t.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
          message: '检测到视频随堂弹题弹窗，已暂停等待处理',
        };
      }
    }

    // 5. 尚未加载出 <video> 元素
    if (!video) {
      if (totalLessons > 0 && completedLessons >= totalLessons) {
        return {
          status: 'completed',
          url: href,
          currentLessonTitle,
          completedLessons,
          totalLessons,
          currentTime: 0,
          duration: 0,
          playbackRate: 1,
          muted: false,
          ended: false,
          message: '全部视频小节已完成 (.time_icofinish)',
        };
      }
      return {
        status: 'loading',
        url: href,
        currentLessonTitle,
        completedLessons,
        totalLessons,
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        muted: false,
        ended: false,
        message: '等待课程视频组件加载',
      };
    }

    const currentTime = Number(video.currentTime || 0);
    const duration = Number(video.duration || 0);
    const ended = Boolean(video.ended);

    // 6. 当前小节自然播放完毕（video.ended）-> 切换至下一未完成小节
    if (ended) {
      let nextIdx = -1;
      for (let i = Math.max(0, activeIdx + 1); i < lessonNodes.length; i++) {
        if (!lessonNodes[i].querySelector('.time_icofinish')) {
          nextIdx = i;
          break;
        }
      }
      if (nextIdx < 0 && firstUnfinishedIdx >= 0 && firstUnfinishedIdx !== activeIdx) {
        nextIdx = firstUnfinishedIdx;
      }

      if (nextIdx >= 0) {
        const targetNode = lessonNodes[nextIdx];
        const clickTarget = targetNode.querySelector('.catalogue_title, .file-name, span') || targetNode;
        clickTarget.click();
        return {
          status: 'switching_next',
          url: href,
          currentLessonTitle: String(targetNode.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          completedLessons,
          totalLessons,
          currentTime,
          duration,
          playbackRate: Number(video.playbackRate || 1),
          muted: Boolean(video.muted),
          ended: true,
          action: 'clicked_next_unfinished',
        };
      }

      if (totalLessons > 0 && completedLessons >= totalLessons) {
        return {
          status: 'completed',
          url: href,
          currentLessonTitle,
          completedLessons,
          totalLessons,
          currentTime,
          duration,
          playbackRate: Number(video.playbackRate || 1),
          muted: Boolean(video.muted),
          ended: true,
          message: '所有课程视频小节均已播完并标记完成',
        };
      }

      const nextBtn = document.querySelector('#nextBtn, .nextButton');
      if (nextBtn) {
        nextBtn.click();
        return {
          status: 'switching_next',
          url: href,
          currentLessonTitle,
          completedLessons,
          totalLessons,
          currentTime,
          duration,
          playbackRate: Number(video.playbackRate || 1),
          muted: Boolean(video.muted),
          ended: true,
          action: 'clicked_next_btn',
        };
      }
    }

    // 7. 正常真实播放控制：静音 + 点选平台合法倍速 + 启动播放
    let action = 'watching';
    if (!video.muted) {
      video.muted = true;
    }

    if (Math.abs(Number(video.playbackRate || 1) - ${safeRate}) > 0.05) {
      const rateStr = ${JSON.stringify(String(safeRate))};
      const rateTab =
        document.querySelector('.speedBox .speedTab[rate="' + rateStr + '"]') ||
        document.querySelector(
          rateStr === '1.5' ? '.speedTab15' : rateStr === '1.25' ? '.speedTab10' : '.speedTab05'
        );
      if (rateTab) {
        const box = document.querySelector('.speedBox');
        if (box) try { box.click(); } catch {}
        try { rateTab.click(); } catch {}
      }
      if (Math.abs(Number(video.playbackRate || 1) - ${safeRate}) > 0.05) {
        try { video.playbackRate = ${safeRate}; } catch {}
      }
      action = 'adjusted_rate_' + rateStr;
    }

    if (video.paused && !ended) {
      const playBtn = document.querySelector('#playButton, .playButton');
      if (playBtn && isVisible(playBtn)) {
        try { playBtn.click(); } catch {}
      }
      if (video.paused) {
        try { Promise.resolve(video.play()).catch(() => {}); } catch {}
      }
      action = 'resumed_play';
    }

    return {
      status: 'playing',
      url: href,
      currentLessonTitle,
      completedLessons,
      totalLessons,
      currentTime,
      duration,
      playbackRate: Number(video.playbackRate || 1),
      muted: Boolean(video.muted),
      ended,
      action,
    };
  })()`;
}

async function notifyEdge(title: string, content: string): Promise<void> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  if (!edgeUrl || !edgeToken) return;
  try {
    await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/notify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${edgeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, content }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // best-effort alert
  }
}

/**
 * 智慧树 / 知到合规真实浏览器学习插件
 * 通过 Chrome DevTools Protocol 驱动真实 Chromium 播放视频（1.0x/1.25x/1.5x 合法倍速、自动切换下一未完成小节），
 * 遇到登录/扫码、易盾滑块验证或弹题时立即暂停并发起 Edge Telegram 提醒，不绕过任何验证或伪造后端进度接口。
 */
export class ZhihuishuAdapter implements PlatformAdapter, PlatformPlugin {
  public readonly name: PlatformName = 'zhihuishu';
  public readonly manifest: PluginManifest = {
    id: 'zhihuishu',
    name: '智慧树 / 知到合规真实播放插件 (Skill)',
    version: '0.0.1',
    description:
      '适配新版 studyvideoh5.zhihuishu.com/stuStudy，通过真实 Chromium CDP 控制合法倍速播放、进度追踪及验证码/登录/弹题人工接管提醒',
    capabilities: ['courses', 'homework', 'browser-cdp'],
  };

  private studyUrl: string = ZHIHUISHU_DEFAULT_STUDY_URL;

  public async init(ctx: PluginContext): Promise<void> {
    if (ctx.env.ZHIHUISHU_STUDY_URL && isValidZhihuishuStudyUrl(ctx.env.ZHIHUISHU_STUDY_URL)) {
      this.studyUrl = ctx.env.ZHIHUISHU_STUDY_URL;
    }
  }

  public async authenticate(): Promise<boolean> {
    const local = readLocalStorageState('zhihuishu');
    if (local && local.cookies.length > 0) return true;
    const remote = await pullBrowserProfileFromCloud('zhihuishu').catch(() => null);
    return Boolean(remote && remote.cookies.length > 0);
  }

  public async scanCourses(): Promise<CourseInfo[]> {
    return [
      {
        courseId: 'zhihuishu-study',
        classId: 'default',
        courseName: '智慧树在学视频课程',
      },
    ];
  }

  public async scanPendingHomework(): Promise<HomeworkSummary[]> {
    return [];
  }

  public async downloadAllMaterials(): Promise<void> {
    // 智慧树视频课程无需预下载静态课件
  }

  public async solveAllPendingHomework(_autoSubmit = false, _options?: SolveOptions): Promise<SolveResult[]> {
    return [];
  }

  /**
   * 启动真实浏览器会话并按合法倍速持续播放智慧树视频课程
   */
  public async watchCourse(options: ZhihuishuWatchOptions): Promise<ZhihuishuWatchResult> {
    const targetUrl = options.studyUrl || this.studyUrl;
    if (!isValidZhihuishuStudyUrl(targetUrl)) {
      throw new Error(`非法或非智慧树域名 URL: ${targetUrl}`);
    }

    const rate = clampZhihuishuRate(options.targetRate ?? 1.5);
    const maxMinutes = Math.max(1, options.maxMinutes ?? 120);
    const pollMs = Math.max(2000, options.pollIntervalMs ?? 5000);

    if (options.tier === 'gce') {
      const cmd = `zhihuishu --url "${targetUrl}" --rate ${rate} --max-minutes ${maxMinutes}`;
      const res = await triggerCloudBurst({
        mode: 'gce',
        taskCommand: cmd,
        machineType: process.env.GCE_BURST_MACHINE_TYPE || 'e2-small',
        ttlMinutes: Math.min(360, maxMinutes + 15),
        dryRun: options.dryRun,
      });
      console.log(green(`[智慧树 GCE 调度]\n${res.command}\n${res.output}`));
      return {
        status: 'completed',
        completedLessons: 0,
        totalLessons: 0,
        lastLessonTitle: '',
        message: res.output,
      };
    }

    const exe = detectChromiumExecutable();
    if (!exe) {
      throw new Error(
        '未检测到系统 Chrome/Chromium 可执行文件。请在装有 Chrome/Chromium 的电脑上运行，或安装 chromium 后重试。'
      );
    }

    const memMb = getLinuxMemAvailableMb();
    if (!options.ignoreMemGuard && memMb > 0 && memMb < 220) {
      throw new Error(
        `当前主机可用内存仅 ${memMb} MB (< 220 MB)，为防 OOM 拒绝在本机拉起浏览器。请在本地电脑运行或使用 --tier gce。`
      );
    }

    const savedState = await pullBrowserProfileFromCloud('zhihuishu').catch(() => readLocalStorageState('zhihuishu'));
    if (savedState && savedState.cookies.length > 0) {
      console.log(green(`[Zhihuishu] 已加载浏览器会话 (${savedState.cookies.length} Cookies)`));
    } else {
      console.log(yellow('[Zhihuishu] 未检测到已保存的 Cookie，首次访问将弹出登录提醒'));
    }

    const port = options.debuggingPort || 9222;
    const headless = options.headless !== false;
    const launched = launchHeadlessBrowserWithProfile({
      platform: 'zhihuishu',
      targetUrl: 'about:blank',
      debuggingPort: port,
      headless,
    });

    const paths = getBrowserProfilePaths('zhihuishu');
    let client: CdpClient | null = null;
    const deadlineMs = Date.now() + maxMinutes * 60 * 1000;
    let lastLogKey = '';
    let lastAlertAtMs = 0;
    let lastCookieSyncMs = 0;
    let lastState: ZhihuishuDomInspection | null = null;

    const cleanupBrowser = () => {
      try {
        client?.close();
      } catch {}
      try {
        if (launched.process.pid) {
          process.kill(-launched.process.pid, 'SIGTERM');
        }
      } catch {
        try {
          launched.process.kill('SIGTERM');
        } catch {}
      }
    };

    const syncCookies = async (cdp: CdpClient) => {
      try {
        const allCookies = await cdp.getAllCookies();
        const zhsCookies: BrowserCookie[] = allCookies.filter((c) => c.domain.includes('zhihuishu.com'));
        if (zhsCookies.length > 0) {
          writeLocalStorageState('zhihuishu', { cookies: zhsCookies, origins: [] });
          await pushBrowserProfileToCloud('zhihuishu').catch(() => {});
        }
      } catch {
        // ignore cookie sync glitch
      }
    };

    try {
      const conn = await CdpClient.connectToFirstPage(launched.cdpUrl);
      client = conn.client;

      if (savedState?.cookies?.length) {
        await client.setCookies(savedState.cookies);
      }
      const entryUrl =
        savedState?.cookies?.length && targetUrl.includes('studyvideoh5.zhihuishu.com')
          ? `https://studyservice-api.zhihuishu.com/login/gologin?fromurl=${encodeURIComponent(targetUrl)}`
          : targetUrl;
      await client.navigate(entryUrl);
      await new Promise((r) => setTimeout(r, 5000));

      const expr = buildZhihuishuInspectExpression(rate);
      console.log(blue(`[Zhihuishu] 已连接真机播放器，目标倍速: ${rate}x | 最大时长: ${maxMinutes} 分钟`));

      let homepageBounceCount = 0;
      while (Date.now() < deadlineMs) {
        const info = await client.evaluate<ZhihuishuDomInspection>(expr);
        lastState = info;

        if (info.url.startsWith('https://www.zhihuishu.com') && homepageBounceCount < 2) {
          homepageBounceCount++;
          console.log(yellow(`[Zhihuishu] 检测到跳转回官网首页，重新进入课程播放页 (第 ${homepageBounceCount} 次)...`));
          await client.navigate(targetUrl);
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        if (Date.now() - lastCookieSyncMs >= 120_000) {
          lastCookieSyncMs = Date.now();
          await syncCookies(client);
        }

        if (info.status === 'auth_required' || info.status === 'captcha_required' || info.status === 'quiz_paused') {
          let shotPath: string | undefined;
          try {
            const b64 = await client.captureScreenshotBase64();
            if (b64) {
              shotPath = path.join(paths.baseDir, `alert_${info.status}.png`);
              fs.writeFileSync(shotPath, Buffer.from(b64, 'base64'));
            }
          } catch {}

          const titleMap = {
            auth_required: '智慧树需要重新登录/扫码 🔐',
            captcha_required: '智慧树触发滑块验证码，已暂停 ⏸️',
            quiz_paused: '智慧树出现随堂弹题，已暂停 📝',
          };
          const detailLines = [
            `状态：${info.message || info.status}`,
            info.currentLessonTitle ? `小节：${info.currentLessonTitle}` : '',
            info.quizTitle ? `题目：${info.quizTitle}` : '',
            info.quizOptions?.length ? `选项：${info.quizOptions.join(' | ')}` : '',
            `进度：${info.completedLessons}/${info.totalLessons}`,
            shotPath ? `截图：${shotPath}` : '',
            headless
              ? '当前为无头模式，请在本地打开课程页完成验证后重新导入 Cookie，或使用 --headed 模式运行。'
              : '请在已打开的浏览器窗口中手动完成后，程序将在数秒内自动继续播放。',
          ].filter(Boolean);

          console.log(yellow(`[Zhihuishu 需人工处理] ${titleMap[info.status]} -> ${info.message || ''}`));
          if (Date.now() - lastAlertAtMs >= 5 * 60 * 1000) {
            lastAlertAtMs = Date.now();
            await notifyEdge(titleMap[info.status], detailLines.join('\n'));
          }

          // 无头模式下无法人工扫码/拖拽滑块，直接保存截图与提示后优雅退出，避免空转
          if (headless) {
            return {
              status: info.status,
              completedLessons: info.completedLessons,
              totalLessons: info.totalLessons,
              lastLessonTitle: info.currentLessonTitle,
              screenshotPath: shotPath,
              message: info.message || info.status,
            };
          }

          // 有界面（--headed）模式下等待用户手工处理后自动恢复播放
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }

        if (info.status === 'completed') {
          await syncCookies(client);
          const msg = `全部视频小节已完成 (${info.completedLessons}/${info.totalLessons})`;
          console.log(green(`🎉 [Zhihuishu] ${msg}`));
          await notifyEdge('智慧树课程视频已完成 🎉', `进度：${info.completedLessons}/${info.totalLessons}\n课程链接：${targetUrl}`);
          return {
            status: 'completed',
            completedLessons: info.completedLessons,
            totalLessons: info.totalLessons,
            lastLessonTitle: info.currentLessonTitle,
            message: msg,
          };
        }

        const logKey = `${info.status}|${info.url}|${info.currentLessonTitle}|${info.completedLessons}/${info.totalLessons}|${info.playbackRate}`;
        if (logKey !== lastLogKey || info.action !== 'watching') {
          lastLogKey = logKey;
          const pct = info.duration > 0 ? `${Math.round((info.currentTime / info.duration) * 100)}%` : '0%';
          const extraUrl = info.status === 'loading' ? ` (${info.url})` : '';
          console.log(
            blue(
              `[Zhihuishu] ${info.status} (${info.completedLessons}/${info.totalLessons}) ` +
                `[${info.currentLessonTitle || '加载中'}] ${pct} @ ${info.playbackRate}x${extraUrl}`
            )
          );
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }

      await syncCookies(client);
      const timeoutMsg = `达到最大运行时长 ${maxMinutes} 分钟后安全退出 (当前进度 ${lastState?.completedLessons || 0}/${lastState?.totalLessons || 0})`;
      console.log(yellow(`[Zhihuishu] ${timeoutMsg}`));
      return {
        status: 'timeout',
        completedLessons: lastState?.completedLessons || 0,
        totalLessons: lastState?.totalLessons || 0,
        lastLessonTitle: lastState?.currentLessonTitle || '',
        message: timeoutMsg,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(red(`[Zhihuishu] 运行异常: ${errMsg}`));
      return {
        status: 'aborted',
        completedLessons: lastState?.completedLessons || 0,
        totalLessons: lastState?.totalLessons || 0,
        lastLessonTitle: lastState?.currentLessonTitle || '',
        message: errMsg,
      };
    } finally {
      cleanupBrowser();
    }
  }
}
