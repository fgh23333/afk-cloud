import { blue, green, yellow } from 'kolorist';
import {
  getBrowserProfilePaths,
  launchHeadlessBrowserWithProfile,
  pullBrowserProfileFromCloud,
  pushBrowserProfileToCloud,
  readLocalStorageState,
  writeLocalStorageState,
} from '../../core/browser-profile';
import { PlatformPlugin, PluginContext, PluginManifest } from '../../core/plugin';
import { solveHomeworkDualTrack } from '../../core/solver';
import {
  CourseInfo,
  HomeworkSummary,
  PlatformAdapter,
  PlatformName,
  SolveOptions,
  SolveResult,
  StandardQuestion,
} from '../../core/types';

export interface WebPlatformPreset {
  name: PlatformName;
  displayName: string;
  homeUrl: string;
  studyUrl?: string;
  todoSelectorHint: string;
  editorSelectorHint: string;
}

export const WEB_PLATFORM_PRESETS: Record<string, WebPlatformPreset> = {
  pta: {
    name: 'pta',
    displayName: 'PTA 程序设计类实验辅助教学平台 (pintia.cn)',
    homeUrl: 'https://pintia.cn/problem-sets',
    todoSelectorHint: '题目集列表 -> 活跃题目集 -> 函数题/编程题/单选题列表',
    editorSelectorHint: '.cm-content, .monaco-editor textarea, input[type="radio"], input[type="checkbox"]',
  },
  zhihuishu: {
    name: 'zhihuishu',
    displayName: '智慧树 / 知到在线教育平台 (zhihuishu.com)',
    homeUrl: 'https://studyvideoh5.zhihuishu.com/stuStudy',
    studyUrl: 'https://studyvideoh5.zhihuishu.com/stuStudy',
    todoSelectorHint: '我的学堂 -> 课程视频树 (.clearfix.video / .time_icofinish) -> 章节测试',
    editorSelectorHint: '.exam-question-item, .el-radio, .el-checkbox, textarea, .dialog-test',
  },
};

/**
 * 智慧树 / 知到 Web 播放器合规辅助脚本（安全静音、官方 UI 倍速、自然播完切下一节、遇滑块暂停）
 * 不拦截页面可见性/失焦检测，不绕过任何验证码或进度上报机制。
 */
export const ZHIHUISHU_INJECT_SCRIPT = `
(function afkZhihuishuWatchDog() {
  if (window.__afk_zhs_hooked) return;
  window.__afk_zhs_hooked = true;

  setInterval(() => {
    const captcha = document.querySelector('#captchaYidun .yidun_panel, .yidun_popup, .yidun_modal');
    const video = document.querySelector('#container video, video');
    if (captcha && window.getComputedStyle(captcha).display !== 'none') {
      if (video && !video.paused) video.pause();
      return;
    }

    if (video) {
      if (!video.muted) video.muted = true;
      const rateTab = document.querySelector('.speedBox .speedTab[rate="1.5"], .speedTab15');
      if (Math.abs(video.playbackRate - 1.5) > 0.05 && rateTab) {
        rateTab.click();
      }
      if (video.paused && !video.ended) {
        video.play().catch(() => {});
      }
      if (video.ended) {
        const nextBtn = document.querySelector('#nextBtn, .nextButton');
        if (nextBtn) nextBtn.click();
      }
    }
  }, 3000);
  console.log('[afk-cloud] 智慧树 / 知到合规真实播放守护已启动');
})();
`;

/**
 * 通用无头浏览器 Web 平台适配器（适用于 PTA、智慧树等一切基于 Web 的高校教务/评测系统）
 * 核心设计：
 * 1. 登录态与 Profile 持久化：本地采用 `--user-data-dir` 完整保留 Chromium Profile，
 *    跨容器/跨机器通过 `storage-state.json` <-> Cloudflare D1 (`sessions` 表) 自动同步 Cookies 与 LocalStorage。
 * 2. 原生 CDP / MCP 操控：拉起带 `--remote-debugging-port=9222` 的无头浏览器，
 *    直接由 Antigravity (`chrome-devtools` MCP) 或 Playwright 进行 DOM 快照提取与表单回填。
 * 3. 双轨模型决策：DOM 提取出的客观题走 Gemini Flash 批量 JSON 秒答，编程题/主观题走 Gemini Pro + 本地沙箱评测自愈。
 */
export class WebBrowserAdapter implements PlatformAdapter, PlatformPlugin {
  public readonly name: PlatformName;
  public readonly preset: WebPlatformPreset;
  public readonly manifest: PluginManifest;

  constructor(platform: PlatformName = 'pta') {
    this.name = platform;
    this.preset = WEB_PLATFORM_PRESETS[platform] || WEB_PLATFORM_PRESETS.pta;
    this.manifest = {
      id: platform,
      name: `${this.preset.displayName} 真实浏览器自治插件 (Skill)`,
      version: '1.0.0',
      description: '通过真实 Chromium CDP 与持久化 Profile 操控 Web 平台，支持视频合规守护与 DOM 表单智能作答',
      capabilities: ['browser-cdp', 'homework'],
    };
  }

  public async init(_ctx: PluginContext): Promise<void> {}

  public async authenticate(): Promise<boolean> {
    return true;
  }

  /**
   * 准备持久化 Profile 并启动无头浏览器（自动从 Cloudflare D1 同步已有登录态）
   */
  public async prepareHeadlessSession(options?: {
    targetUrl?: string;
    port?: number;
    headless?: boolean;
  }): Promise<{
    userDataDir: string;
    storageStatePath: string;
    cdpUrl?: string;
    hasSavedState: boolean;
  }> {
    const paths = getBrowserProfilePaths(this.name);
    console.log(blue(`[WebBrowserAdapter:${this.name}] 正在检查持久化浏览器 Profile: ${paths.userDataDir}`));

    const state = await pullBrowserProfileFromCloud(this.name);
    const hasSavedState = !!(state && (state.cookies.length > 0 || state.origins.length > 0));

    if (hasSavedState) {
      console.log(
        green(
          `[Profile 就绪] 已加载 [${this.name}] 持久化登录态 (${state!.cookies.length} Cookies, 更新于 ${state!.updatedAt})`
        )
      );
    } else {
      console.log(
        yellow(
          `[Profile 提示] 尚未保存 [${this.name}] 的 storage-state.json，将直接使用持久化目录 ${paths.userDataDir}`
        )
      );
    }

    try {
      const launched = launchHeadlessBrowserWithProfile({
        platform: this.name,
        targetUrl: options?.targetUrl || this.preset.homeUrl,
        debuggingPort: options?.port || 9222,
        headless: options?.headless !== false,
      });
      console.log(
        green(
          `🌐 无头浏览器已启动并挂载 Profile！CDP 端口: ${launched.cdpUrl} -> ${options?.targetUrl || this.preset.homeUrl}`
        )
      );
      return {
        userDataDir: paths.userDataDir,
        storageStatePath: paths.storageStatePath,
        cdpUrl: launched.cdpUrl,
        hasSavedState,
      };
    } catch (err: any) {
      console.log(yellow(`[无头浏览器启动提示] ${err?.message || err}`));
      return {
        userDataDir: paths.userDataDir,
        storageStatePath: paths.storageStatePath,
        hasSavedState,
      };
    }
  }

  /**
   * 导入 Cookie 字符串到持久化 Profile 并同步至 Cloudflare D1
   */
  public async importCookieString(cookieHeader: string, domain: string): Promise<void> {
    const existing = readLocalStorageState(this.name) || {
      cookies: [] as Array<{ name: string; value: string; domain: string; path: string; secure?: boolean }>,
      origins: [] as Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>,
    };
    const pairs = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.substring(0, eq).trim();
      const value = pair.substring(eq + 1).trim();
      const idx = existing.cookies.findIndex((c) => c.name === name && c.domain === domain);
      if (idx >= 0) {
        existing.cookies[idx].value = value;
      } else {
        existing.cookies.push({
          name,
          value,
          domain,
          path: '/',
          secure: true,
        });
      }
    }

    writeLocalStorageState(this.name, existing);
    const syncRes = await pushBrowserProfileToCloud(this.name);
    console.log(green(`[Cookie 导入完成] ${syncRes.msg}`));
  }

  public async scanCourses(): Promise<CourseInfo[]> {
    return [];
  }

  public async scanPendingHomework(): Promise<HomeworkSummary[]> {
    return [];
  }

  public async downloadAllMaterials(): Promise<void> {
    // Web 平台通过浏览器 DOM 快照实时提取上下文
  }

  /**
   * 对无头浏览器从 DOM 快照中提取出的题目列表执行双轨求解 + 编程沙箱自检
   */
  public async solveExtractedWebQuestions(
    taskTitle: string,
    questions: StandardQuestion[],
    pageContextText = '',
    options?: SolveOptions
  ): Promise<SolveResult> {
    const summary: HomeworkSummary = {
      workId: `${this.name}-${Date.now()}`,
      workAnswerId: '0',
      title: taskTitle,
      statusText: '待完成',
      isPending: true,
      canEdit: true,
      courseId: this.name,
      classId: this.name,
      courseName: this.preset.displayName,
    };

    return solveHomeworkDualTrack(summary, questions, () => pageContextText, {
      ...options,
      platform: this.name,
      enableSandboxTest: true,
    });
  }

  public async solveAllPendingHomework(
    _autoSubmit = false,
    _options?: SolveOptions
  ): Promise<SolveResult[]> {
    await this.prepareHeadlessSession();
    return [];
  }
}
