export type PlatformName = 'chaoxing' | 'pta' | 'zhihuishu';

export type QuestionType = 'single' | 'multiple' | 'judgement' | 'blank' | 'essay' | 'programming' | 'unknown';

export type ComputeTier = 'local' | 'cloud-run' | 'gce-burst';

export interface CourseInfo {
  courseId: string;
  classId: string;
  courseName: string;
  cpi?: string;
}

export interface MaterialItem {
  id: string;
  name: string;
  size?: string;
  uploadDate?: string;
  localPath?: string;
}

export interface HomeworkSummary {
  workId: string;
  workAnswerId: string;
  title: string;
  statusText: string;
  isPending: boolean;
  canEdit: boolean;
  startDate?: string;
  endDate?: string;
  courseId: string;
  classId: string;
  courseName?: string;
  enc?: string;
  cpi?: string;
  openc?: string;
}

export interface QuestionOption {
  key: string;
  text: string;
}

export interface StandardQuestion {
  id: string;
  type: QuestionType;
  typeName: string;
  title: string;
  options?: QuestionOption[];
  score?: number;
  sampleInput?: string;
  sampleOutput?: string;
  languageHint?: 'cpp' | 'c' | 'python' | 'java' | 'javascript';
  userAnswer?: string;
  solvedByTier?: 'cache' | 'flash' | 'pro' | 'heuristic';
}

export interface HomeworkDetail {
  questions: StandardQuestion[];
  formParams: Record<string, string>;
  formAction: string;
  rawHtml?: string;
}

export interface SolveOptions {
  platform?: PlatformName;
  flashModel?: string;
  proModel?: string;
  provider?: 'agy' | 'openai';
  apiKey?: string;
  apiUrl?: string;
  materialsDir?: string;
  reportOutputDir?: string;
  enableSandboxTest?: boolean;
  force?: boolean;
}

export interface SolveResult {
  answers: Record<string, string>;
  stats: {
    total: number;
    cacheHits: number;
    flashSolved: number;
    proSolved: number;
    heuristicFallback: number;
  };
  reportPath: string;
  reportContent: string;
}

export interface PlatformAdapter {
  readonly name: PlatformName;
  scanCourses(): Promise<CourseInfo[]>;
  scanPendingHomework(): Promise<HomeworkSummary[]>;
  downloadAllMaterials(): Promise<void>;
  solveAllPendingHomework(autoSubmit?: boolean, options?: SolveOptions): Promise<SolveResult[]>;
}

export function formatUtc8Now(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)';
}
