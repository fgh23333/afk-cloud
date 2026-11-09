import { solveHomeworkDualTrack } from '../../core/solver';
import {
  CourseInfo,
  HomeworkSummary,
  PlatformAdapter,
  SolveOptions,
  SolveResult,
  StandardQuestion,
} from '../../core/types';

/**
 * PTA (程序设计类实验辅助教学平台 pintia.cn) 适配器
 * 支持编程题提取、Gemini Pro 代码生成、本地/Cloud Run 沙箱样例自测与多轮自愈
 */
export class PtaAdapter implements PlatformAdapter {
  public readonly name = 'pta' as const;

  public async scanCourses(): Promise<CourseInfo[]> {
    return [];
  }

  public async scanPendingHomework(): Promise<HomeworkSummary[]> {
    return [];
  }

  public async downloadAllMaterials(): Promise<void> {
    // PTA 题目自带题面与样例输入输出
  }

  /**
   * 针对给定的 PTA 题目集执行双轨求解与沙箱验证
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

  public async solveAllPendingHomework(
    _autoSubmit = false,
    _options?: SolveOptions
  ): Promise<SolveResult[]> {
    return [];
  }
}
