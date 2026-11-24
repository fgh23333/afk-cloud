import { blue, green, red, yellow } from 'kolorist';
import { syncCourseChapterProgressToEdge, syncTasksToEdgeDashboard } from '../../core/d1-bridge';
import { PlatformPlugin, PluginContext, PluginManifest } from '../../core/plugin';
import { solveHomeworkDualTrack } from '../../core/solver';
import {
  CourseInfo,
  HomeworkSummary,
  PlatformAdapter,
  SolveOptions,
  SolveResult,
} from '../../core/types';
import { getCourseHomeworkList, getHomeworkDetail, submitHomework } from './homework';
import {
  downloadCourseMaterials,
  getCourseMaterialsList,
  searchCourseMaterialsContext,
} from './materials';
import { ExamNoticeItem, fetchNoticeList, NoticeItem } from './notice';
import { getOrUploadPhotoObject, submitPhotoSign } from './photo';
import { ChaoxingCookies, chaoxingLogin, getChaoxingCourses } from './session';
import { DEFAULT_SHOU_LOCATIONS, performChaoxingSign, scanCourseActivities, SignLocation } from './signin';
import { DiscussionRunSummary, solvePendingDiscussions } from './discussions';
import { CourseChapterProgressSummary, scanCourseChapterProgress } from './webim';

export * from './des';
export * from './discussions';
export * from './homework';
export * from './materials';
export * from './notice';
export * from './photo';
export * from './session';
export * from './signin';
export * from './webim';

export class ChaoxingAdapter implements PlatformAdapter, PlatformPlugin {
  public readonly name = 'chaoxing' as const;
  public readonly manifest: PluginManifest = {
    id: 'chaoxing',
    name: '超星学习通自适应插件 (Skill)',
    version: '1.2.0',
    description: '超星协议原生适配器，涵盖登录态缓存、全类型签到、18门课程课件RAG拉取、双轨作业求解、讨论区拟稿与安全草稿暂存',
    capabilities: ['courses', 'materials', 'homework', 'signin', 'discussions'],
  };

  private phone: string;
  private password: string;
  private cachedCookies: ChaoxingCookies | null = null;

  constructor(phone?: string, password?: string) {
    this.phone = phone || process.env.CHAOXING_PHONE || '';
    this.password = password || process.env.CHAOXING_PASSWORD || '';
  }

  public async init(ctx: PluginContext): Promise<void> {
    if (ctx.env.CHAOXING_PHONE) this.phone = ctx.env.CHAOXING_PHONE;
    if (ctx.env.CHAOXING_PASSWORD) this.password = ctx.env.CHAOXING_PASSWORD;
  }

  public async authenticate(): Promise<boolean> {
    try {
      const cookies = await this.ensureAuth();
      return !!(cookies && cookies._uid);
    } catch {
      return false;
    }
  }

  private async ensureAuth(): Promise<ChaoxingCookies> {
    if (this.cachedCookies) return this.cachedCookies;
    if (!this.phone || !this.password) {
      throw new Error('未配置 CHAOXING_PHONE 或 CHAOXING_PASSWORD，请在 .env 中配置后重试');
    }
    console.log(blue(`[ChaoxingAdapter] 正在验证账号 ${this.phone} 登录态...`));
    this.cachedCookies = await chaoxingLogin(this.phone, this.password);
    return this.cachedCookies;
  }

  public async scanNotices(limit = 20): Promise<NoticeItem[]> {
    const cookies = await this.ensureAuth();
    return fetchNoticeList(cookies, limit);
  }

  public async scanCourses(): Promise<CourseInfo[]> {
    const cookies = await this.ensureAuth();
    return getChaoxingCourses(cookies);
  }

  public async scanPendingHomework(): Promise<HomeworkSummary[]> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);

    console.log(blue(`\n======================================================`));
    console.log(blue(` 📋 正在扫描在读 ${courses.length} 门课程的作业任务与课件资料 📋`));
    console.log(blue(`======================================================\n`));

    const allPending: HomeworkSummary[] = [];

    for (const c of courses) {
      try {
        const works = await getCourseHomeworkList(c, cookies);
        const materials = await getCourseMaterialsList(c, cookies);
        const pendingWorks = works.filter((w) => w.isPending);
        allPending.push(...pendingWorks);

        const tag =
          pendingWorks.length > 0 ? yellow(`[⚠️ ${pendingWorks.length} 个待做]`) : green('[暂无待做]');
        console.log(
          `${tag} 课程 《${c.courseName}》 (ID: ${c.courseId}) | 作业总数: ${works.length} | 资料数: ${materials.length}`
        );

        for (const pw of pendingWorks) {
          console.log(
            yellow(`    👉 待完成: 《${pw.title}》 | 截止: ${pw.endDate || '无'} | 状态: ${pw.statusText}`)
          );
        }
      } catch (e: any) {
        console.log(red(`[课程扫描跳过] 《${c.courseName}》: ${e?.message || e}`));
      }
    }

    console.log(green(`\n[扫描完毕] 共检索到 ${allPending.length} 个待做作业。\n`));

    if (allPending.length > 0) {
      await syncTasksToEdgeDashboard(
        allPending.map((pw) => {
          const isReturned =
            pw.statusText.includes('重做') || pw.statusText.includes('打回') || pw.statusText.includes('退回');
          return {
            taskId: `chaoxing-hw-${pw.workId}`,
            platform: 'chaoxing',
            courseId: pw.courseId,
            classId: pw.classId,
            courseName: pw.courseName || '',
            title: pw.title,
            status: pw.statusText.includes('暂存') ? 'draft_saved' : 'pending',
            deadline: pw.endDate,
            reopened: isReturned,
            resultSummary: isReturned ? `学习通状态: ${pw.statusText}，需重新处理` : undefined,
          };
        })
      );
    }

    return allPending;
  }

  public async queryTaskStatus(task: HomeworkSummary): Promise<'pending' | 'draft_saved' | 'submitted' | 'unknown'> {
    try {
      const cookies = await this.ensureAuth();
      const course = { courseId: task.courseId, classId: task.classId, courseName: task.courseName || '' };
      const list = await getCourseHomeworkList(course, cookies);
      const found = list.find((w) => w.workId === task.workId || w.title === task.title);
      if (!found) return 'unknown';

      const st = found.statusText || '';
      if (st.includes('暂存')) return 'draft_saved';
      if (st.includes('已交') || st.includes('待批') || st.includes('已批')) return 'submitted';
      if (
        st.includes('待做') ||
        st.includes('未交') ||
        st.includes('重新编辑') ||
        st.includes('打回') ||
        st.includes('重做') ||
        st.includes('退回')
      ) {
        return 'pending';
      }
      return found.isPending ? 'pending' : 'submitted';
    } catch {
      return 'unknown';
    }
  }

  public async downloadAllMaterials(): Promise<void> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);

    console.log(blue(`\n======================================================`));
    console.log(blue(` 📥 开始批量下载全部在读 ${courses.length} 门课程资料与课件 📥`));
    console.log(blue(`======================================================\n`));

    for (const c of courses) {
      try {
        const { downloaded, dir } = await downloadCourseMaterials(c, cookies);
        console.log(green(`[资料就绪] 《${c.courseName}》: ${downloaded.length} 个文件 -> ${dir}`));
      } catch (e: any) {
        console.log(red(`[资料下载跳过] 《${c.courseName}》: ${e?.message || e}`));
      }
    }
  }

  public async solveAllPendingHomework(
    autoSubmit = false,
    options?: SolveOptions
  ): Promise<SolveResult[]> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);
    const isAutoSubmit = autoSubmit || process.env.CHAOXING_AUTO_SUBMIT === 'true';

    console.log(blue(`\n======================================================`));
    console.log(blue(` 🚀 启动 afk-cloud 双轨作业完成引擎 (Flash 批量 + Pro 深度) 🚀`));
    console.log(
      blue(
        ` 提交模式: ${isAutoSubmit ? red('【自动正式提交 pyFlag=3】') : green('【安全草稿暂存 pyFlag=1】')}`
      )
    );
    console.log(blue(`======================================================\n`));

    const results: SolveResult[] = [];

    for (const c of courses) {
      try {
        const works = await getCourseHomeworkList(c, cookies);
        const pendingWorks = works.filter(
          (w) => w.isPending && (options?.force || !(w.statusText || '').includes('暂存'))
        );
        if (pendingWorks.length === 0) continue;

        console.log(blue(`\n>>> 正在处理课程 《${c.courseName}》 的 ${pendingWorks.length} 个待做作业...`));

        // 1. 拉取课程课件供 RAG 检索
        const { dir: materialsDir, downloaded } = await downloadCourseMaterials(c, cookies);
        console.log(green(`[1/3 课件就绪] 已同步 ${downloaded.length} 个参考资料至: ${materialsDir}`));

        for (const hw of pendingWorks) {
          try {
            console.log(blue(`\n[2/3 提取题目] 正在加载作业: 《${hw.title}》...`));
            let detail;
            try {
              detail = await getHomeworkDetail(hw, cookies);
            } catch (err: any) {
              console.log(yellow(`[作业跳过] 《${hw.title}》: ${err?.message || err}`));
              continue;
            }

            if (!detail.questions || detail.questions.length === 0) {
              console.log(yellow(`[作业跳过] 《${hw.title}》未提取到在线表单题目`));
              continue;
            }

            // 2. 双轨认知求解 (D1/本地缓存 -> Flash 批量客观题 -> Pro 复杂推理)
            const solveRes = await solveHomeworkDualTrack(
              hw,
              detail.questions,
              (keywords) => searchCourseMaterialsContext(keywords, materialsDir),
              { ...options, platform: 'chaoxing', materialsDir }
            );

            // 3. 提交或暂存草稿
            console.log(
              blue(`[3/3 平台回写] 正在将答案写入学习通 (${isAutoSubmit ? '正式提交' : '草稿暂存'})...`)
            );
            const submitRes = await submitHomework(
              hw,
              solveRes.answers,
              detail.formParams,
              cookies,
              !isAutoSubmit,
              detail.formAction
            );

            if (submitRes.success) {
              console.log(green(`🎉 作业 《${hw.title}》 ${submitRes.msg}`));
            } else {
              console.log(red(`❌ 作业 《${hw.title}》 响应异常: ${submitRes.msg}`));
            }

            await syncTasksToEdgeDashboard([
              {
                taskId: `chaoxing-hw-${hw.workId}`,
                platform: 'chaoxing',
                courseId: hw.courseId,
                classId: hw.classId,
                courseName: c.courseName,
                title: hw.title,
                status: submitRes.success ? (isAutoSubmit ? 'submitted' : 'draft_saved') : 'failed',
                deadline: hw.endDate,
                resultSummary: `共${solveRes.stats.total}题 (⚡缓存${solveRes.stats.cacheHits}/🚀Flash${solveRes.stats.flashSolved}/🧠Pro${solveRes.stats.proSolved})`,
              },
            ]);

            console.log(blue(`📄 作答报告: ${solveRes.reportPath}`));
            results.push(solveRes);
          } catch (hwErr: any) {
            console.log(red(`[作业处理异常] 《${hw.title}》: ${hwErr?.message || hwErr}`));
            await syncTasksToEdgeDashboard([
              {
                taskId: `chaoxing-hw-${hw.workId}`,
                platform: 'chaoxing',
                courseId: hw.courseId,
                classId: hw.classId,
                courseName: c.courseName,
                title: hw.title,
                status: 'failed',
                deadline: hw.endDate,
                resultSummary: `处理异常: ${String(hwErr?.message || hwErr).slice(0, 120)}`,
              },
            ]).catch(() => {});
          }
        }
      } catch (err: any) {
        console.log(red(`[课程处理异常] 《${c.courseName}》: ${err?.message || err}`));
      }
    }

    return results;
  }

  /**
   * 巡检全部在读课程并执行自动化签到（完全对齐 chaoxing-signin 原生实现：多坐标重试、自动上传打卡照片、手势与签到码）
   */
  public async scanAndSignIn(realname = '同学', customLocs?: SignLocation[]): Promise<string[]> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);
    const results: string[] = [];

    console.log(blue(`\n======================================================`));
    console.log(blue(` 📍 正在巡检在读 ${courses.length} 门课程的有效签到活动 (对齐 chaoxing-signin) 📍`));
    console.log(blue(`======================================================\n`));

    for (const c of courses) {
      try {
        const activities = await scanCourseActivities(c, cookies);
        for (const act of activities) {
          console.log(yellow(`[发现签到] 课程 《${c.courseName}》 正在进行活动: ${act.name} (ID: ${act.id})`));
          const res = await performChaoxingSign(act, c, cookies, realname, customLocs);
          console.log(green(`[签到结果] ${res}`));
          results.push(`《${c.courseName}》: ${res}`);
        }
      } catch (err: any) {
        console.log(red(`[课程签到扫描跳过] 《${c.courseName}》: ${err?.message || err}`));
      }
    }

    if (results.length === 0) {
      console.log(green('✨ 当前所有在读课程均无正在进行的签到活动。\n'));
    }

    return results;
  }

  /**
   * 扫描并生成课程话题讨论 AI 拟稿，推送至云端看板 awaiting_approval（默认绝不自动公开提交）
   */
  public async solveDiscussions(options?: {
    realname?: string;
    autoSubmit?: boolean;
    regenerate?: boolean;
    courseFilter?: string;
    solveOptions?: SolveOptions;
  }): Promise<DiscussionRunSummary> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);
    return solvePendingDiscussions(courses, cookies, options);
  }

  /**
   * 扫描全部在读课程的章节任务点完成进度并同步至 Edge 看板
   */
  public async scanAllCourseChapterProgress(
    syncToEdge = true
  ): Promise<CourseChapterProgressSummary[]> {
    const cookies = await this.ensureAuth();
    const courses = await getChaoxingCourses(cookies);
    const summaries: CourseChapterProgressSummary[] = [];

    console.log(blue(`\n======================================================`));
    console.log(blue(` 📊 正在巡检在读 ${courses.length} 门课程的章节任务点进度 📊`));
    console.log(blue(`======================================================\n`));

    for (const c of courses) {
      try {
        const summary = await scanCourseChapterProgress(c, cookies);
        summaries.push(summary);
        const badge =
          summary.pendingChapters > 0
            ? yellow(`[待完成 ${summary.pendingChapters}/${summary.totalChapters} 章 · ${summary.totalUnfinishedPoints} 任务点]`)
            : green(`[已完成 ${summary.completionRate}%]`);
        console.log(`${badge} 《${c.courseName}》 (ID: ${c.courseId}) | 完成率: ${summary.completionRate}%`);
      } catch (err: any) {
        console.log(red(`[章节进度跳过] 《${c.courseName}》: ${err?.message || err}`));
      }
    }

    if (syncToEdge && summaries.length > 0) {
      await syncCourseChapterProgressToEdge(
        summaries.map((s) => ({
          courseId: s.courseId,
          classId: s.classId,
          courseName: s.courseName,
          totalChapters: s.totalChapters,
          completedChapters: s.completedChapters,
          pendingChapters: s.pendingChapters,
          totalUnfinishedPoints: s.totalUnfinishedPoints,
          completionRate: s.completionRate,
        }))
      );
    }

    return summaries;
  }
}
