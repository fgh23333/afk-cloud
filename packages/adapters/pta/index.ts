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
  StandardQuestion,
} from '../../core/types';
import {
  fetchAllPtaExamProblems,
  getPtaProblemSetExam,
  getPtaProblemStatus,
  PtaAuthError,
  PtaProblemMeta,
  PtaProblemSetOverview,
  PTA_ORIGIN,
  resolvePtaCookieHeader,
  savePtaProblemDrafts,
  scanPtaOverviews,
  startPtaExam,
  submitPtaProblemAnswers,
  buildPtaTaskSummaryPayload,
} from './protocol';

export * from './protocol';
export * from './login';

export interface PtaSolveProblemSetOutcome {
  problemSetId: string;
  examId: string;
  title: string;
  solveResult: SolveResult;
  mode: 'draft' | 'submit';
  savedDraftCount: number;
  submittedCount: number;
  acceptedCount: number;
  submissionIds: string[];
  verdicts: Array<{ label: string; problemType: string; status: string; score: number }>;
  qa: Array<{ id: string; type: string; title: string; answer: string; solvedBy?: string }>;
  summary: string;
}

/**
 * 从 jobId 或 taskUrl 解析 PTA problemSetId
 */
export function parsePtaTaskIdentifiers(task: { jobId?: string; taskUrl?: string; workId?: string }): {
  problemSetId: string;
} {
  if (task.workId && /^\d{10,}$/.test(task.workId.trim())) {
    return { problemSetId: task.workId.trim() };
  }
  const jobMatch = String(task.jobId || '').match(/^pta-(?:ps-)?(\d{10,})$/);
  if (jobMatch) return { problemSetId: jobMatch[1] };

  if (task.taskUrl) {
    try {
      const u = new URL(task.taskUrl);
      const m = u.pathname.match(/\/problem-sets\/(\d{10,})/);
      if (m) return { problemSetId: m[1] };
    } catch {
      // ignore invalid URL
    }
  }
  return { problemSetId: '' };
}

/**
 * PTA (程序设计类实验辅助教学平台 pintia.cn) 原生 HTTP + 沙箱自愈插件 (Skill)
 */
export class PtaAdapter implements PlatformAdapter, PlatformPlugin {
  public readonly name = 'pta' as const;
  public readonly manifest: PluginManifest = {
    id: 'pta',
    name: 'PTA 拼题 A 编程评测与监听插件 (Skill)',
    version: '0.0.1',
    description:
      '基于 PTA 原生 REST API 与 D1/本地 Profile Cookie 持久化的自治插件，支持题目集实时监听、多题型批量/沙箱求解、草稿暂存与防覆盖整组提交',
    capabilities: ['courses', 'homework', 'sandbox'],
  };

  private explicitCookie?: string;
  private cachedCookieHeader: string | null = null;

  constructor(cookieHeader?: string) {
    if (cookieHeader && cookieHeader.trim()) {
      this.explicitCookie = cookieHeader.trim();
    }
  }

  public async init(ctx: PluginContext): Promise<void> {
    if (ctx.env.PTA_SESSION_COOKIE && !this.explicitCookie) {
      this.explicitCookie = ctx.env.PTA_SESSION_COOKIE.trim();
    }
  }

  private async ensureCookie(forceRefresh = false): Promise<string> {
    if (this.cachedCookieHeader && !forceRefresh) return this.cachedCookieHeader;
    const hdr = await resolvePtaCookieHeader(this.explicitCookie);
    if (!hdr) {
      throw new PtaAuthError(
        '未检测到 PTA 登录态，请先执行 `pnpm afk profile import-cookie --platform pta --cookie "..."` 导入Cookie'
      );
    }
    this.cachedCookieHeader = hdr;
    return hdr;
  }

  public async authenticate(): Promise<boolean> {
    try {
      const cookie = await this.ensureCookie(true);
      await scanPtaOverviews(cookie, { maxDetails: 1 });
      return true;
    } catch {
      return false;
    }
  }

  public async scanOverviews(options?: {
    includeExpired?: boolean;
    maxDetails?: number;
  }): Promise<{ totalSets: number; activeSets: PtaProblemSetOverview[] }> {
    const cookie = await this.ensureCookie(true);
    return scanPtaOverviews(cookie, options);
  }

  public async scanCourses(): Promise<CourseInfo[]> {
    const { activeSets } = await this.scanOverviews({ includeExpired: true, maxDetails: 20 });
    const seen = new Map<string, CourseInfo>();
    for (const ov of activeSets) {
      const cid = ov.problemSet.organizationId || 'pta';
      if (!seen.has(cid)) {
        seen.set(cid, {
          courseId: cid,
          classId: ov.problemSet.type || 'EXERCISE',
          courseName: ov.problemSet.organizationName || 'PTA 拼题 A 评测平台',
        });
      }
    }
    if (seen.size === 0) {
      seen.set('pta', {
        courseId: 'pta',
        classId: 'EXERCISE',
        courseName: 'PTA 拼题 A 评测平台',
      });
    }
    return Array.from(seen.values());
  }

  public async scanPendingHomework(syncToEdge = true): Promise<HomeworkSummary[]> {
    const { activeSets } = await this.scanOverviews();
    console.log(blue(`\n======================================================`));
    console.log(blue(` 💻 正在扫描 PTA (pintia.cn) 活跃题目集 (共 ${activeSets.length} 个未过期) 💻`));
    console.log(blue(`======================================================\n`));

    const pending: HomeworkSummary[] = [];
    const syncItems: Array<ReturnType<typeof buildPtaTaskSummaryPayload>> = [];

    for (const ov of activeSets) {
      const ps = ov.problemSet;
      const syncPayload = buildPtaTaskSummaryPayload(ov);
      syncItems.push(syncPayload);

      const hw: HomeworkSummary = {
        workId: ps.id,
        workAnswerId: ov.exam?.id || '0',
        title: ps.name,
        statusText: ov.isCompleted
          ? '已完成'
          : ov.exam
            ? `待完成 (${ov.noAnswerCount}/${ov.totalProblems})`
            : '待做',
        isPending: ov.isPending,
        canEdit: !ov.isEnded && !ov.isExpired,
        startDate: ov.problemSet.startAt,
        endDate: ov.deadlineUtc8,
        courseId: ps.organizationId || 'pta',
        classId: ps.type || 'EXERCISE',
        courseName: ps.organizationName || 'PTA 拼题 A',
      };

      const badge = ov.isPending ? yellow(`[⚠️ 待做 ${ov.noAnswerCount || '未开始'}]`) : green('[✅ 已完成]');
      console.log(
        `${badge} ${ps.name} (${ps.id}) | 机构: ${hw.courseName} | 截止: ${ov.deadlineUtc8} | ${syncPayload.resultSummary}`
      );

      if (ov.isPending) {
        pending.push(hw);
      }
    }

    console.log(green(`\n[PTA 扫描完毕] 活跃题目集 ${activeSets.length} 个，其中待完成 ${pending.length} 个。\n`));

    if (syncToEdge && syncItems.length > 0) {
      await syncTasksToEdgeDashboard(
        syncItems.map((it) => ({
          taskId: it.taskId,
          platform: it.platform,
          courseId: it.courseId,
          classId: it.classId,
          courseName: it.courseName,
          title: it.title,
          status: it.status,
          deadline: it.deadline,
          resultSummary: it.resultSummary,
          url: it.url,
          workId: it.workId,
          problemSetId: it.problemSetId,
          examId: it.examId,
        }) as any)
      ).catch(() => false);
    }

    return pending;
  }

  public async scanTasks(): Promise<HomeworkSummary[]> {
    return this.scanPendingHomework(true);
  }

  public async queryTaskStatus(
    task: HomeworkSummary
  ): Promise<'pending' | 'draft_saved' | 'submitted' | 'unknown'> {
    try {
      const { problemSetId } = parsePtaTaskIdentifiers({ workId: task.workId, jobId: `pta-ps-${task.workId}` });
      if (!problemSetId) return 'unknown';
      const cookie = await this.ensureCookie();
      const { exam } = await getPtaProblemSetExam(problemSetId, cookie);
      if (!exam) return 'pending';
      if (exam.ended || String(exam.status || '').toUpperCase() === 'END') return 'submitted';

      const statuses = await getPtaProblemStatus(problemSetId, exam.id, cookie);
      if (statuses.length === 0) return 'pending';
      const noAns = statuses.filter((s) => s.problemSubmissionStatus === 'PROBLEM_NO_ANSWER').length;
      if (noAns === 0) return 'submitted';
      if (noAns < statuses.length) return 'draft_saved';
      return 'pending';
    } catch {
      return 'unknown';
    }
  }

  public async inspectAndSign(): Promise<{ executed: string[] }> {
    const pending = await this.scanPendingHomework(true);
    return {
      executed: pending.map((p) => `[PTA] ${p.title} (${p.statusText})`),
    };
  }

  public async downloadAllMaterials(): Promise<void> {
    // PTA 题目自带题面与样例输入输出
  }

  /**
   * 针对给定的 PTA 问题列表执行双轨求解与沙箱验证（纯内存通用接口）
   */
  public async solveProblemSet(
    problemSetTitle: string,
    questions: StandardQuestion[],
    options?: SolveOptions
  ): Promise<SolveResult> {
    const summary: HomeworkSummary = {
      workId: `pta-${Date.now()}`,
      workAnswerId: '0',
      title: problemSetTitle,
      statusText: '待评测',
      isPending: true,
      canEdit: true,
      courseId: 'pta',
      classId: 'pta',
      courseName: 'PTA 程序设计评测',
    };

    return solveHomeworkDualTrack(summary, questions, () => '', {
      ...options,
      platform: 'pta',
      enableSandboxTest: true,
    });
  }

  /**
   * 完整拉取并作答/提交指定 PTA 题目集（绝不调用 /end 锁卷）
   */
  public async solveProblemSetById(
    problemSetId: string,
    autoSubmit = false,
    options?: SolveOptions
  ): Promise<PtaSolveProblemSetOutcome> {
    const cookie = await this.ensureCookie(true);
    let { exam, problemSet } = await getPtaProblemSetExam(problemSetId, cookie);
    if (!exam) {
      exam = await startPtaExam(problemSetId, cookie);
    }

    const title = String(problemSet?.name || `PTA_${problemSetId}`);
    const cfg = problemSet?.problemSetConfig || {};
    const compilers: string[] = Array.isArray(cfg.compilers) ? cfg.compilers : [];

    const statuses = await getPtaProblemStatus(problemSetId, exam.id, cookie);
    const items = await fetchAllPtaExamProblems(problemSetId, exam.id, statuses, cookie, compilers);

    const pendingItems = options?.force
      ? items
      : items.filter((it) => it.meta.submissionStatus === 'PROBLEM_NO_ANSWER');
    const targetItems = pendingItems.length > 0 ? pendingItems : items;

    const hwSummary: HomeworkSummary = {
      workId: problemSetId,
      workAnswerId: exam.id,
      title,
      statusText: '待做',
      isPending: true,
      canEdit: !exam.ended,
      endDate: exam.endAt || problemSet?.endAt,
      courseId: String(problemSet?.organizationId || 'pta'),
      classId: String(problemSet?.type || 'EXERCISE'),
      courseName: String(problemSet?.organizationName || 'PTA 拼题 A'),
    };

    const questions = targetItems.map((it) => it.question);
    const metas: PtaProblemMeta[] = targetItems.map((it) => it.meta);
    const solveResult = await solveHomeworkDualTrack(hwSummary, questions, () => '', {
      ...options,
      platform: 'pta',
      enableSandboxTest: true,
    });

    const qa = targetItems.map((it) => ({
      id: it.question.id,
      type: it.question.type,
      title: it.meta.label + ' ' + it.question.title.slice(0, 120),
      answer: String(solveResult.answers[it.question.id] || ''),
      solvedBy: it.question.solvedByTier || 'agy',
    }));

    if (!autoSubmit) {
      const draftRes = await savePtaProblemDrafts(metas, solveResult.answers, cookie, problemSetId, compilers);
      const summary = `已通过 PTA 原生协议暂存 ${draftRes.savedCount}/${metas.length} 道题草稿（未锁卷）`;
      return {
        problemSetId,
        examId: exam.id,
        title,
        solveResult,
        mode: 'draft',
        savedDraftCount: draftRes.savedCount,
        submittedCount: 0,
        acceptedCount: 0,
        submissionIds: [],
        verdicts: [],
        qa,
        summary,
      };
    }

    const submitRes = await submitPtaProblemAnswers({
      psId: problemSetId,
      examId: exam.id,
      metas,
      answers: solveResult.answers,
      cookieHeader: cookie,
      problemSetCompilers: compilers,
    });

    const summary = `已提交 ${submitRes.submittedCount} 道 PTA 题目（即时编程通过 ${submitRes.acceptedCount} 题，整组客/填空已防覆盖提交，未调 /end 锁卷）`;
    return {
      problemSetId,
      examId: exam.id,
      title,
      solveResult,
      mode: 'submit',
      savedDraftCount: 0,
      submittedCount: submitRes.submittedCount,
      acceptedCount: submitRes.acceptedCount,
      submissionIds: submitRes.submissionIds,
      verdicts: submitRes.verdicts,
      qa,
      summary,
    };
  }

  public async solveTask(
    task: HomeworkSummary,
    autoSubmit = false,
    options?: SolveOptions
  ): Promise<SolveResult> {
    const { problemSetId } = parsePtaTaskIdentifiers({ workId: task.workId, jobId: `pta-ps-${task.workId}` });
    if (!problemSetId) {
      throw new Error(`无法从任务解析 PTA 题目集 ID: ${task.workId}`);
    }
    const outcome = await this.solveProblemSetById(problemSetId, autoSubmit, options);
    return outcome.solveResult;
  }

  public async solveAllPendingHomework(
    autoSubmit = false,
    options?: SolveOptions
  ): Promise<SolveResult[]> {
    const pending = await this.scanPendingHomework(true);
    const results: SolveResult[] = [];
    for (const hw of pending) {
      try {
        console.log(blue(`\n🚀 [PTA 自动求解] 开始处理题目集: ${hw.title} (${hw.workId})`));
        const outcome = await this.solveProblemSetById(hw.workId, autoSubmit, options);
        console.log(green(`✅ ${outcome.summary}`));
        results.push(outcome.solveResult);
      } catch (err: any) {
        console.log(red(`❌ [PTA 处理失败] ${hw.title}: ${err?.message || err}`));
      }
    }
    return results;
  }
}
