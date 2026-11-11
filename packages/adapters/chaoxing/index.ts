import { blue, green, red, yellow } from 'kolorist';
import { syncTasksToEdgeDashboard } from '../../core/d1-bridge';
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

export * from './des';
export * from './homework';
export * from './materials';
export * from './notice';
export * from './photo';
export * from './session';

export class ChaoxingAdapter implements PlatformAdapter, PlatformPlugin {
  public readonly name = 'chaoxing' as const;
  public readonly manifest: PluginManifest = {
    id: 'chaoxing',
    name: '超星学习通自适应插件 (Skill)',
    version: '1.1.0',
    description: '超星协议原生适配器，涵盖登录态缓存、全类型签到、18门课程课件RAG拉取、双轨作业求解与安全草稿暂存',
    capabilities: ['courses', 'materials', 'homework', 'signin'],
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
        allPending.map((pw) => ({
          taskId: `chaoxing-hw-${pw.workId}`,
          platform: 'chaoxing',
          courseId: pw.courseId,
          classId: pw.classId,
          courseName: pw.courseName || '',
          title: pw.title,
          status: 'pending',
          deadline: pw.endDate,
        }))
      );
    }

    return allPending;
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
        const pendingWorks = works.filter((w) => w.isPending);
        if (pendingWorks.length === 0) continue;

        console.log(blue(`\n>>> 正在处理课程 《${c.courseName}》 的 ${pendingWorks.length} 个待做作业...`));

        // 1. 拉取课程课件供 RAG 检索
        const { dir: materialsDir, downloaded } = await downloadCourseMaterials(c, cookies);
        console.log(green(`[1/3 课件就绪] 已同步 ${downloaded.length} 个参考资料至: ${materialsDir}`));

        for (const hw of pendingWorks) {
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
        }
      } catch (err: any) {
        console.log(red(`[课程处理异常] 《${c.courseName}》: ${err?.message || err}`));
      }
    }

    return results;
  }
}
