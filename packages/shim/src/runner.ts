import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireLock,
  AgyLockData,
  cleanStaleAgyWorkspace,
  DEFAULT_PRO_MODEL,
  extractLastJsonObject,
  getActiveLock,
  getLinuxMemAvailableMb,
  invokeAgy,
  isProcessAlive,
  killProcessGroup,
  normalizeAgyModelName,
  releaseLock,
  runWithAgyLock,
  UNTRUSTED_CONTENT_RULES,
  updateLockAgyPid,
  wrapUntrusted,
} from '../../core/agy-invoke';
import { signRequest } from '../../core/request-signing';
import { formatUtc8Now } from '../../core/types';
import { startManagedBrowser, touchBrowser } from './browser';

export { acquireLock, AgyLockData, getActiveLock, isProcessAlive, releaseLock, updateLockAgyPid };

export interface TaskJob {
  jobId: string;
  platform: string;
  taskUrl: string;
  deadline?: string;
  mode: 'draft' | 'submit';
  phase: 'pending' | 'running' | 'draft_saved' | 'awaiting_approval' | 'submitted' | 'failed' | 'ignored';
  qa?: Array<{
    id: string;
    type: string;
    title: string;
    answer: string;
    solvedBy?: string;
  }>;
  summary?: string;
  error?: string;
  attemptCount?: number;
  lastFailedAtMs?: number;
  createdAt: string;
  updatedAt: string;
}

/** 本地任务持久化文件，服务重启状态不丢失（测试模式或未显式指定 AFK_JOBS_FILE 时隔离于生产缓存） */
function getJobsPersistPath(): string {
  if (process.env.AFK_JOBS_FILE) return process.env.AFK_JOBS_FILE;
  if (process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `afk-shim-jobs-test-${process.pid}.json`);
  }
  return path.join(os.homedir(), '.cache', 'afk-shim-jobs.json');
}

/** 内存中最多保留的任务数（超出后淘汰最早的已终结任务，避免常驻进程内存无限增长） */
const MAX_JOBS_RETAINED = 200;

const jobStore = new Map<string, TaskJob>();
const executionQueue: TaskJob[] = [];
let isWorkerRunning = false;

// 启动时从磁盘加载历史任务状态
loadJobsFromDisk();

function saveJobsToDisk(): void {
  if (process.env.NODE_ENV === 'test' && !process.env.AFK_JOBS_FILE) {
    return;
  }
  try {
    const persistPath = getJobsPersistPath();
    const dir = path.dirname(persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(jobStore.values());
    fs.writeFileSync(persistPath, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

function loadJobsFromDisk(): void {
  if (process.env.NODE_ENV === 'test' && !process.env.AFK_JOBS_FILE) {
    return;
  }
  try {
    const persistPath = getJobsPersistPath();
    if (!fs.existsSync(persistPath)) return;
    const raw = fs.readFileSync(persistPath, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.jobId) {
          if (item.phase === 'running') {
            item.phase = 'failed';
            item.error = '服务重启导致执行中断，已自动复位';
            item.updatedAt = formatUtc8Now();
          }
          jobStore.set(item.jobId, item);
        }
      }
    }
  } catch {}
}

export function resetJobForTest(jobId: string): void {
  jobStore.delete(jobId);
}

const DRAFT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    qa: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['id', 'type', 'title', 'answer'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['qa', 'summary'],
};

const SUBMIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['submitted', 'failed'] },
    summary: { type: 'string' },
  },
  required: ['status', 'summary'],
};

/**
 * 获取任务详情
 */
export function getJob(jobId: string): TaskJob | undefined {
  return jobStore.get(jobId);
}

/**
 * 获取所有任务状态
 */
export function listJobs(): TaskJob[] {
  return Array.from(jobStore.values());
}

export function pendingQueueLength(): number {
  return executionQueue.length;
}

function evictOldJobs() {
  if (jobStore.size <= MAX_JOBS_RETAINED) return;
  for (const [id, job] of jobStore) {
    if (jobStore.size <= MAX_JOBS_RETAINED) break;
    if (job.phase === 'submitted' || job.phase === 'failed' || job.phase === 'ignored') {
      jobStore.delete(id);
    }
  }
}

/**
 * 将任务推入执行队列 (串行保护，防止多个 agy 进程并发消耗内存)
 * 调用方 (index.ts) 负责参数白名单校验
 */
export function enqueueJob(params: {
  jobId: string;
  taskUrl: string;
  platform?: string;
  deadline?: string;
  mode?: 'draft' | 'submit';
}): TaskJob {
  const now = formatUtc8Now();
  let job = jobStore.get(params.jobId);

  if (job) {
    job.mode = params.mode || 'draft';
    job.taskUrl = params.taskUrl || job.taskUrl;
    job.platform = params.platform || job.platform;
    job.deadline = params.deadline || job.deadline;
    job.phase = job.phase === 'running' ? 'running' : 'pending';
    job.error = undefined;
    job.updatedAt = now;
  } else {
    job = {
      jobId: params.jobId,
      platform: params.platform || 'chaoxing',
      taskUrl: params.taskUrl,
      deadline: params.deadline,
      mode: params.mode || 'draft',
      phase: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    jobStore.set(params.jobId, job);
    evictOldJobs();
  }

  // 避免队列中重复积压同个任务
  if (!executionQueue.some((q) => q.jobId === job!.jobId)) {
    executionQueue.push(job);
  }

  triggerQueueDrain();
  return job;
}

/**
 * 驱动队列串行执行 (同一时刻保证只有 1 个 agy 在运行)
 */
async function triggerQueueDrain(): Promise<void> {
  if (isWorkerRunning || executionQueue.length === 0) {
    return;
  }

  const currentJob = executionQueue[0];
  if (!currentJob) return;

  // 1. 尝试抢占单例硬件互斥锁
  if (!acquireLock(currentJob.jobId)) {
    console.log(`[Shim Runner] 硬件互斥锁已被占用，任务 [${currentJob.jobId}] 在队列中等待`);
    return;
  }

  // 2. 成功获取锁，出队开始执行
  executionQueue.shift();
  isWorkerRunning = true;

  try {
    currentJob.phase = 'running';
    currentJob.attemptCount = (currentJob.attemptCount || 0) + 1;
    currentJob.updatedAt = formatUtc8Now();
    saveJobsToDisk();
    console.log(
      `[Shim Runner] 🔒 获取硬件单例互斥锁成功，开始执行任务: ${currentJob.jobId} (模式: ${currentJob.mode}, 第 ${currentJob.attemptCount} 次)`
    );

    await runWithAgyLock(currentJob.jobId, async () => {
      if (currentJob.mode === 'submit') {
        await processSubmitTask(currentJob);
      } else {
        await processDraftTask(currentJob);
      }
    });
  } catch (err: any) {
    currentJob.phase = 'failed';
    currentJob.error = err?.message || String(err);
    currentJob.lastFailedAtMs = Date.now();
    currentJob.updatedAt = formatUtc8Now();
    console.error(`[Shim Runner] 任务失败: ${currentJob.jobId}`, err);
    await notifyEdgeCallback(currentJob);
  } finally {
    isWorkerRunning = false;
    releaseLock(currentJob.jobId);
    saveJobsToDisk();
    // 调度消费队列中下一个任务
    setTimeout(() => {
      triggerQueueDrain();
    }, 500);
  }
}

function buildDraftPrompt(job: TaskJob): string {
  const host = new URL(job.taskUrl).hostname;
  return [
    UNTRUSTED_CONTENT_RULES,
    '',
    '【任务】',
    `打开下面给出的作业页面（浏览器已就绪，只允许在 ${host} 域内操作），读取全部题目；`,
    '逐题作答（客观题直接选，主观/编程题完整作答）；在页面中填写答案并【仅保存草稿】，【绝对不要点提交】。',
    wrapUntrusted('task-url', job.taskUrl),
    '',
    '【输出】最后只输出一个 JSON：{"qa":[{"id":"题目ID","type":"题型","title":"题干","answer":"作答内容"}],"summary":"简要作答总结"}',
  ].join('\n');
}

function buildSubmitPrompt(job: TaskJob): string {
  const host = new URL(job.taskUrl).hostname;
  return [
    UNTRUSTED_CONTENT_RULES,
    '',
    '【任务】',
    `打开下面给出的作业页面（只允许在 ${host} 域内操作），确认此前保存的草稿仍在，然后点击提交并确认平台提示提交成功。`,
    '若草稿不存在、页面异常或无法确认提交成功，不要重新作答，直接输出 status=failed。',
    wrapUntrusted('task-url', job.taskUrl),
    '',
    '【输出】只输出一个 JSON：{"status":"submitted" 或 "failed","summary":"说明"}',
  ].join('\n');
}

/**
 * 从 jobId / taskUrl 提取超星 courseId / classId / workId 及测验标记
 */
export function parseChaoxingTaskIdentifiers(job: Pick<TaskJob, 'jobId' | 'taskUrl'>): {
  courseId: string;
  classId: string;
  workId: string;
  isExam: boolean;
} {
  let courseId = '';
  let classId = '';
  let workId = '';
  const isWorkJobId = /^chaoxing-(?:notice-work|work|hw)-/.test(job.jobId);
  let isExam = /^chaoxing-notice-exam-/.test(job.jobId);
  try {
    const u = new URL(job.taskUrl);
    courseId = u.searchParams.get('courseId') || '';
    classId = u.searchParams.get('classId') || '';
    const workOrExam = (u.searchParams.get('workOrExam') || '').toLowerCase();
    workId =
      u.searchParams.get('workId') ||
      u.searchParams.get('workAnswerId') ||
      u.searchParams.get('taskrefId') ||
      u.searchParams.get('examId') ||
      '';
    if (workOrExam === 'work' || isWorkJobId) {
      isExam = false;
    } else if (workOrExam === 'exam' || u.pathname.includes('/exam/') || u.searchParams.has('examId')) {
      isExam = true;
    }
  } catch {
    // ignore URL parse error
  }
  const noticeMatch = job.jobId.match(/^chaoxing-notice-(?:work|exam)-(\d+)-(\d+)/);
  if (noticeMatch) {
    if (!workId) workId = noticeMatch[1];
    if (!classId) classId = noticeMatch[2];
  } else {
    const hwMatch = job.jobId.match(/^chaoxing-(?:work|hw)-(\d+)(?:-(\d+))?/);
    if (hwMatch) {
      if (!workId && hwMatch[1] !== courseId) {
        workId = hwMatch[1];
      }
      if (!classId && hwMatch[2]) {
        classId = hwMatch[2];
      }
    }
  }
  return { courseId, classId, workId, isExam };
}

/**
 * 超星纯 HTTP 原生作答 / 提交链路（无需无头浏览器，自动识别已交/过期/无表单作业）
 */
async function processChaoxingTask(job: TaskJob, mode: 'draft' | 'submit'): Promise<void> {
  const {
    chaoxingLogin,
    getChaoxingCourses,
    getCourseHomeworkList,
    getHomeworkDetail,
    requiresManualAttachmentUpload,
    submitHomework,
  } = await import('../../adapters/chaoxing/index');
  const { downloadCourseMaterials, searchCourseMaterialsContext } = await import('../../adapters/chaoxing/materials');
  const { solveHomeworkDualTrack, isPoisonedOrRefusalAnswer } = await import('../../core/solver');

  const phone = process.env.CHAOXING_PHONE || '';
  const password = process.env.CHAOXING_PASSWORD || '';
  if (!phone || !password) {
    throw new Error('未配置 CHAOXING_PHONE / CHAOXING_PASSWORD，无法以超星原生协议登录作答');
  }
  const cookies = await chaoxingLogin(phone, password);
  const { courseId, classId, workId, isExam } = parseChaoxingTaskIdentifiers(job);

  if (isExam) {
    job.phase = 'ignored';
    job.summary = `该任务为学习通考试/随堂测验 (id=${workId || job.jobId})，不支持自动代做，已自动归档忽略（请在学习通客户端确认）`;
    job.updatedAt = formatUtc8Now();
    console.log(`[Shim Runner] 考试/随堂测验 [${job.jobId}] 不支持自动代做，已自动归档为 ignored`);
    await notifyEdgeCallback(job);
    return;
  }

  const courses = await getChaoxingCourses(cookies);
  let targetCourse = courses.find(
    (c) => (courseId && c.courseId === courseId) || (classId && c.classId === classId)
  );
  if (!targetCourse && courseId && classId) {
    targetCourse = { courseId, classId, courseName: '' };
  }

  let found: Awaited<ReturnType<typeof getCourseHomeworkList>>[number] | undefined;
  let resolvedCourse = targetCourse;

  if (targetCourse) {
    const list = await getCourseHomeworkList(targetCourse, cookies);
    found = workId ? list.find((w) => w.workId === workId) : list.find((w) => w.isPending);
  }
  if (!found && workId) {
    for (const c of courses) {
      if (targetCourse && c.courseId === targetCourse.courseId && c.classId === targetCourse.classId) continue;
      try {
        const list = await getCourseHomeworkList(c, cookies);
        const hit = list.find((w) => w.workId === workId);
        if (hit) {
          found = hit;
          resolvedCourse = c;
          break;
        }
      } catch {
        // skip course error
      }
    }
  }

  if (!found && workId && (courseId || resolvedCourse?.courseId) && (classId || resolvedCourse?.classId)) {
    const cid = courseId || resolvedCourse!.courseId;
    const clsid = classId || resolvedCourse!.classId;
    found = {
      workId,
      workAnswerId: '0',
      title: job.jobId,
      statusText: '待做',
      isPending: true,
      canEdit: true,
      startDate: '',
      endDate: job.deadline || '',
      courseId: cid,
      classId: clsid,
      courseName: resolvedCourse?.courseName || '',
    };
    if (!resolvedCourse) {
      resolvedCourse = { courseId: cid, classId: clsid, courseName: '' };
    }
  }

  if (!found || !resolvedCourse) {
    if (job.jobId.startsWith('chaoxing-notice-') || !workId) {
      job.phase = 'ignored';
      job.summary = !workId
        ? '该课程当前无未完成的在线作业待办（可能已截止或非作业红点），已自动归档忽略'
        : '通知型任务已截止、已删除或非标准作业（如课堂测验/附件），已自动归档忽略';
      job.updatedAt = formatUtc8Now();
      console.log(`[Shim Runner] 任务 [${job.jobId}] 未在作业列表中找到有效待办，自动归档为 ignored`);
      await notifyEdgeCallback(job);
      return;
    }
    throw new Error('未在学习通课程作业列表中找到该有效作业（可能已截止、已删除或仅限课堂附件提交）');
  }

  const st = found.statusText || '';
  if (!found.isPending && (st.includes('已交') || st.includes('待批') || st.includes('已批') || st.includes('完成'))) {
    job.phase = 'submitted';
    job.summary = `学习通平台已提交（状态: ${st}），已自动同步完成`;
    job.updatedAt = formatUtc8Now();
    console.log(`[Shim Runner] 检测到超星作业 [${job.jobId}] 已提交 (${st})，直接回传 submitted`);
    await notifyEdgeCallback(job);
    return;
  }

  if (mode === 'submit') {
    if (!found.canEdit && !st.includes('暂存')) {
      throw new Error(`超星作业当前状态 [${st || '未知'}] 不可提交，请打开学习通确认`);
    }
    const detail = await getHomeworkDetail(found, cookies);
    const draftAnswers: Record<string, string> = {};
    for (const item of job.qa || []) {
      if (item.id && item.answer) draftAnswers[item.id] = item.answer;
    }
    for (const q of detail.questions) {
      if (!draftAnswers[q.id] && detail.formParams[`answer${q.id}`]) {
        draftAnswers[q.id] = detail.formParams[`answer${q.id}`];
      }
    }
    if (Object.keys(draftAnswers).length === 0 && detail.questions.length > 0) {
      const solveRes = await solveHomeworkDualTrack(found, detail.questions, () => '', { platform: 'chaoxing' });
      Object.assign(draftAnswers, solveRes.answers);
    }
    const submitRes = await submitHomework(found, draftAnswers, detail.formParams, cookies, false, detail.formAction);
    if (!submitRes.success) {
      throw new Error(`学习通正式提交失败: ${submitRes.msg}`);
    }
    job.phase = 'submitted';
    job.summary = `已通过超星原生协议完成正式提交：${submitRes.msg}`.slice(0, 2000);
    job.updatedAt = formatUtc8Now();
    await notifyEdgeCallback(job);
    return;
  }

  // draft 模式
  if (!found.isPending) {
    throw new Error(`超星作业当前状态 [${st || '未知'}] 无需或无法作答`);
  }

  let detail: Awaited<ReturnType<typeof getHomeworkDetail>>;
  try {
    detail = await getHomeworkDetail(found, cookies);
  } catch (detailErr: any) {
    const errMsg = String(detailErr?.message || detailErr || '');
    if (errMsg.includes('章节任务点未达标')) {
      let progressHint = '';
      try {
        const { scanCourseChapterProgress } = await import('../../adapters/chaoxing/index');
        const { syncCourseChapterProgressToEdge } = await import('../../core/d1-bridge');
        const prog = await scanCourseChapterProgress(resolvedCourse, cookies);
        await syncCourseChapterProgressToEdge([
          {
            courseId: prog.courseId,
            classId: prog.classId,
            courseName: prog.courseName,
            totalChapters: prog.totalChapters,
            completedChapters: prog.completedChapters,
            pendingChapters: prog.pendingChapters,
            totalUnfinishedPoints: prog.totalUnfinishedPoints,
            completionRate: prog.completionRate,
            pendingChapterTitles: prog.pendingChapterTitles,
          },
        ]).catch(() => false);
        if (prog.pendingChapters > 0) {
          const topNames = prog.chapters
            .filter((ch) => ch.status === 'pending')
            .slice(0, 3)
            .map((ch) => `${ch.title}(待完成${ch.unfinishedPoints}个任务点)`)
            .join('、');
          progressHint = `；当前章节完成率 ${prog.completionRate}%，待完成章节 ${prog.pendingChapters}/${prog.totalChapters}（${topNames}）`;
        }
      } catch {
        // 章节进度补充查询异常不阻断状态归档
      }
      job.phase = 'awaiting_approval';
      job.summary = `⚠️ 作业《${found.title}》受限于${errMsg}${progressHint}，请先完成前置章节任务点`.slice(0, 2000);
      job.updatedAt = formatUtc8Now();
      console.log(`[Shim Runner] 作业 [${job.jobId}] 前置章节任务点未达标，已联动章节进度巡检并转为 awaiting_approval`);
      await notifyEdgeCallback(job);
      return;
    }
    throw detailErr;
  }
  if (!detail.questions || detail.questions.length === 0 || requiresManualAttachmentUpload(detail.questions)) {
    const isReturned = st.includes('打回') || st.includes('重做') || st.includes('退回');
    job.phase = 'awaiting_approval';
    job.summary = isReturned
      ? `⚠️ 作业《${found.title}》已被打回（状态: ${st}）且需上传源程序/附件/截图，请打开学习通手动提交`
      : `⚠️ 作业《${found.title}》需上传源程序/附件或截图（无纯文本可代答表单），请打开学习通手动完成`;
    job.updatedAt = formatUtc8Now();
    console.log(`[Shim Runner] 作业 [${job.jobId}] 需人工上传附件/截图 (${st})，转为 awaiting_approval`);
    await notifyEdgeCallback(job);
    return;
  }

  let materialsDir = '';
  try {
    const matRes = await downloadCourseMaterials(resolvedCourse, cookies);
    materialsDir = matRes.dir;
  } catch {
    // 课件下载失败不阻断求解
  }

  const solveRes = await solveHomeworkDualTrack(
    found,
    detail.questions,
    (keywords) => (materialsDir ? searchCourseMaterialsContext(keywords, materialsDir) : ''),
    { platform: 'chaoxing', materialsDir }
  );

  const validAnswers: Record<string, string> = {};
  const blockedDetails: string[] = [];
  for (const q of detail.questions) {
    const ans = solveRes.answers[q.id] || '';
    if (!isPoisonedOrRefusalAnswer(ans)) {
      validAnswers[q.id] = ans;
    } else {
      const reasonMatch = q.title.match(/附件不可读:\s*([^|\])]+)/);
      blockedDetails.push(reasonMatch ? reasonMatch[1].trim() : `第 ${q.id} 题缺少有效正文或附件内容`);
    }
  }

  const validAnswerCount = Object.keys(validAnswers).length;
  if (validAnswerCount === 0) {
    const reasonNote = blockedDetails.length > 0 ? `（${Array.from(new Set(blockedDetails)).slice(0, 2).join('；')}）` : '';
    job.phase = 'awaiting_approval';
    job.qa = undefined;
    job.summary = `⚠️ 作业《${found.title}》缺少可解析的正文或附件内容${reasonNote}，已拦截无效草稿暂存与循环重试，请打开学习通查看原题确认`.slice(0, 2000);
    job.updatedAt = formatUtc8Now();
    console.warn(`[Shim Runner] 作业 [${job.jobId}] 信息缺失/附件不可读，已转为 awaiting_approval 并拦截无效草稿`);
    await notifyEdgeCallback(job);
    return;
  }

  const saveRes = await submitHomework(found, validAnswers, detail.formParams, cookies, true, detail.formAction);
  if (!saveRes.success) {
    throw new Error(`学习通草稿暂存失败: ${saveRes.msg}`);
  }

  const qaList = detail.questions.slice(0, 500).map((q) => ({
    id: String(q.id).slice(0, 128),
    type: String(q.type || 'single').slice(0, 32),
    title: String(q.title || '').slice(0, 4000),
    answer: validAnswers[q.id] ? String(validAnswers[q.id]).slice(0, 20000) : '⚠️ 缺少原题正文/附件内容，已跳过暂存',
    solvedBy: validAnswers[q.id] ? 'agy' : 'skipped',
  }));
  const skippedCount = detail.questions.length - validAnswerCount;
  job.qa = qaList;
  job.phase = 'draft_saved';
  job.summary =
    skippedCount > 0
      ? `⚠️ 已暂存 ${validAnswerCount}/${qaList.length} 道有效题草稿，另有 ${skippedCount} 题因缺少正文/附件未覆盖（${saveRes.msg}）`.slice(0, 2000)
      : `已通过超星原生协议暂存 ${qaList.length} 道题草稿（${saveRes.msg}）`.slice(0, 2000);
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] 超星作业 ${job.jobId} 已安全完成草稿暂存，有效题数 ${validAnswerCount}/${qaList.length}`);
  await notifyEdgeCallback(job);
}

/**
 * PTA (pintia.cn) 纯 HTTP 原生作答 / 提交链路（无需无头浏览器，支持草稿暂存、整组防覆盖提交与 Java/C++/Py 沙箱）
 */
export async function processPtaTask(job: TaskJob, mode: 'draft' | 'submit'): Promise<void> {
  const { PtaAdapter, parsePtaTaskIdentifiers } = await import('../../adapters/pta/index');
  const { problemSetId } = parsePtaTaskIdentifiers(job);
  if (!problemSetId) {
    throw new Error(`无法从任务 [${job.jobId}] 解析 PTA 题目集 ID (taskUrl=${job.taskUrl})`);
  }

  const pta = new PtaAdapter();
  const status = await pta.queryTaskStatus({
    workId: problemSetId,
    workAnswerId: '0',
    title: job.jobId,
    statusText: '',
    isPending: true,
    canEdit: true,
    courseId: 'pta',
    classId: 'EXERCISE',
  });

  if (status === 'submitted') {
    job.phase = 'submitted';
    job.summary = `PTA 题目集 [${problemSetId}] 已全部作答提交，已自动同步完成`;
    job.updatedAt = formatUtc8Now();
    console.log(`[Shim Runner] 检测到 PTA 题目集 [${problemSetId}] 已完成，直接回传 submitted`);
    await notifyEdgeCallback(job);
    return;
  }

  const autoSubmit = mode === 'submit';
  const outcome = await pta.solveProblemSetById(problemSetId, autoSubmit);

  job.qa = outcome.qa.slice(0, 500);
  job.phase = autoSubmit ? 'submitted' : 'draft_saved';
  job.summary = outcome.summary.slice(0, 2000);
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] PTA 任务 ${job.jobId} (${mode}) 完成：${job.summary}`);
  await notifyEdgeCallback(job);
}

/**
 * 模式 1: solve-draft
 * agy 打开真实作业页面，读题，逐题解答并保存草稿，【绝对不要点提交】
 */
async function processDraftTask(job: TaskJob): Promise<void> {
  // 测试或模拟模式快速通路
  if (process.env.NODE_ENV === 'test' || process.env.AFK_MOCK_SOLVER === 'true') {
    job.phase = 'draft_saved';
    job.qa = [{ id: '1', type: 'single', title: '测试题目', answer: 'A', solvedBy: 'test' }];
    job.summary = '测试模式草稿暂存成功';
    job.updatedAt = formatUtc8Now();
    await notifyEdgeCallback(job);
    return;
  }

  // 超星作业直接走纯 HTTP 原生适配器（同步真实已交状态 + 提取题目 + 双轨求解 + 暂存草稿）
  if (job.platform.toLowerCase() === 'chaoxing' || job.taskUrl.includes('chaoxing.com')) {
    await processChaoxingTask(job, 'draft');
    return;
  }

  // PTA (pintia.cn) 直接走纯 HTTP REST + 本地代码沙箱适配器（无需重型无头浏览器）
  if (job.platform.toLowerCase() === 'pta' || job.taskUrl.includes('pintia.cn')) {
    await processPtaTask(job, 'draft');
    return;
  }

  // 1. 若为 Web 平台 (PTA / 智慧树等需要真机渲染的平台)，先检查可用内存并确认浏览器就绪 (超星走纯 HTTP 原生，不拉起重型浏览器)
  if (['pta', 'zhihuishu'].includes(job.platform.toLowerCase())) {
    const memMb = getLinuxMemAvailableMb();
    const minBrowserMemMb = parseInt(process.env.AFK_MIN_BROWSER_MEM_MB || '150', 10);
    if (memMb > 0 && memMb < minBrowserMemMb) {
      throw new Error(`主机可用内存不足 (${memMb} MB < ${minBrowserMemMb} MB)，暂缓拉起 Chromium 以防止 OOM`);
    }
    try {
      await startManagedBrowser(job.platform, 10);
      touchBrowser(10);
    } catch (e: any) {
      console.warn(`[Shim Runner] 浏览器启动提示: ${e?.message || e}`);
    }
  }

  // 2. 以安全基线调用 agy (无 shell、沙箱、最小环境变量、隔离工作目录、结构化输出)
  const proModel = normalizeAgyModelName(process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || DEFAULT_PRO_MODEL, 'pro');
  console.log(`[Shim Runner] 调用 agy (Model: ${proModel})...`);
  const stdout = await invokeAgy({
    prompt: buildDraftPrompt(job),
    model: proModel,
    timeoutMs: 15 * 60 * 1000,
    jsonSchema: DRAFT_OUTPUT_SCHEMA,
    maxBuffer: 20 * 1024 * 1024,
    onSpawn: (pid) => updateLockAgyPid(job.jobId, pid),
  });

  // 3. 稳健提取结构化 JSON 结果
  const parsed = extractLastJsonObject(stdout);
  if (!parsed || !Array.isArray(parsed.qa)) {
    throw new Error(`agy 未返回合法的结构化结果: ${stdout.slice(0, 200)}`);
  }

  job.qa = parsed.qa.slice(0, 500).map((q: any) => ({
    id: String(q?.id ?? '').slice(0, 128),
    type: String(q?.type ?? 'single').slice(0, 32),
    title: String(q?.title ?? '').slice(0, 4000),
    answer: String(q?.answer ?? '').slice(0, 20000),
    solvedBy: 'agy',
  }));
  job.summary = String(parsed.summary || '已通过 agy 浏览器读题并完成草稿暂存').slice(0, 2000);

  if (/possible_prompt_injection/i.test(job.summary)) {
    throw new Error(`agy 报告疑似 Prompt Injection，已中止：${job.summary}`);
  }
  if (
    parsed.qa.length === 0 ||
    /无法完成任务|未声明任何浏览器|没有浏览器|cannot access|no browser/i.test(job.summary)
  ) {
    throw new Error(`agy 未能成功作答或无可用浏览器工具：${job.summary}`);
  }

  job.phase = 'draft_saved';
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] 任务 ${job.jobId} 已安全完成草稿暂存，包含 ${job.qa?.length || 0} 道题`);

  // 4. 回调 Cloudflare Worker 记账与触发通知/审批门
  await notifyEdgeCallback(job);
}

/**
 * 模式 2: submit
 * agy 回到作业页面，确认草稿已在，点击提交并确认提交成功
 */
async function processSubmitTask(job: TaskJob): Promise<void> {
  // 测试或模拟模式快速通路
  if (process.env.NODE_ENV === 'test' || process.env.AFK_MOCK_SOLVER === 'true') {
    job.phase = 'submitted';
    job.summary = '测试模式正式提交成功';
    job.updatedAt = formatUtc8Now();
    await notifyEdgeCallback(job);
    return;
  }

  if (job.platform.toLowerCase() === 'chaoxing' || job.taskUrl.includes('chaoxing.com')) {
    await processChaoxingTask(job, 'submit');
    return;
  }

  if (job.platform.toLowerCase() === 'pta' || job.taskUrl.includes('pintia.cn')) {
    await processPtaTask(job, 'submit');
    return;
  }

  const proModel = normalizeAgyModelName(process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || DEFAULT_PRO_MODEL, 'pro');
  console.log(`[Shim Runner] 调用 agy 点提交...`);
  const stdout = await invokeAgy({
    prompt: buildSubmitPrompt(job),
    model: proModel,
    timeoutMs: 15 * 60 * 1000,
    jsonSchema: SUBMIT_OUTPUT_SCHEMA,
    onSpawn: (pid) => updateLockAgyPid(job.jobId, pid),
  });

  // 必须拿到明确的 submitted 结论才记为已提交，否则一律视为失败
  const parsed = extractLastJsonObject(stdout);
  if (parsed?.status !== 'submitted') {
    throw new Error(`agy 未确认提交成功: ${String(parsed?.summary || stdout).slice(0, 300)}`);
  }

  job.phase = 'submitted';
  job.summary = String(parsed.summary || '已通过 agy 确认提交成功').slice(0, 2000);
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] 任务 ${job.jobId} 已成功正式提交`);

  await notifyEdgeCallback(job);
}

/**
 * 主路径回调：将状态主动推送回 Cloudflare Edge Worker (HMAC 签名，与 Edge -> Shim 同一套方案)
 */
export async function notifyEdgeCallback(job: TaskJob): Promise<boolean> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const secret = process.env.AFK_SHIM_SECRET;

  if (!edgeUrl) {
    console.log(`[Shim Callback] 未配置 AFK_EDGE_WORKER_URL，跳过边缘回调 (Job: ${job.jobId})`);
    return false;
  }
  if (!secret) {
    console.warn(`[Shim Callback] 未配置 AFK_SHIM_SECRET，无法签名回调，跳过 (Job: ${job.jobId})`);
    return false;
  }

  const endpoint = new URL('/api/agent/callback', edgeUrl.replace(/\/+$/, '') + '/');
  const body = JSON.stringify({
    jobId: job.jobId,
    phase: job.phase,
    qa: job.qa,
    summary: job.summary,
    error: job.error,
    platform: job.platform,
    taskUrl: job.taskUrl,
  });

  try {
    const sigHeaders = await signRequest({
      secret,
      method: 'POST',
      pathWithQuery: endpoint.pathname + endpoint.search,
      body,
    });
    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sigHeaders },
      body,
    });

    console.log(`[Shim Callback] Job [${job.jobId}] 回调 Edge 状态 HTTP ${res.status}`);
    return res.ok;
  } catch (err: any) {
    console.error(`[Shim Callback Error] 回调失败: ${err?.message || err}`);
    return false;
  }
}

/**
 * 宿主机看门狗回收器：每 60 秒检查并强制清除超期硬件锁、孤儿进程与遗留临时目录
 */
export function reapStaleAgyProcesses(): void {
  const lock = getActiveLock();
  const now = Date.now();

  // 1. 检查锁是否已超时 (>18分钟，预留于 15m 任务超时优雅收尾)
  if (lock && now - lock.timestamp > 18 * 60 * 1000) {
    console.warn(`[Shim Watchdog] ⚠️ 检测到超期硬件单例锁 (>18m, Job: ${lock.jobId})，立即强制回收！`);
    if (lock.agyPid) {
      killProcessGroup(lock.agyPid);
    }
    releaseLock();
    const job = jobStore.get(lock.jobId);
    if (job && job.phase === 'running') {
      job.phase = 'failed';
      job.error = '执行超时 (>18m)，宿主机看门狗已强制杀死 agy 进程并回收单例锁';
      job.lastFailedAtMs = Date.now();
      job.updatedAt = formatUtc8Now();
      saveJobsToDisk();
      notifyEdgeCallback(job).catch(() => {});
    }
    isWorkerRunning = false;
    setTimeout(() => {
      triggerQueueDrain();
    }, 500);
  }

  // 2. POSIX 环境下仅扫描 afk shim 遗留的无头 worker (agy -p ... --disable-slash-commands)，绝不误杀 remote-control / 交互会话（单测模式下跳过外部 ps 阻塞）
  if (process.platform !== 'win32' && !lock && !isWorkerRunning && process.env.NODE_ENV !== 'test') {
    try {
      const output = execSync('ps -eo pid=,args=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of output.trim().split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const orphanPid = parseInt(m[1], 10);
        const cmd = m[2];
        if (isNaN(orphanPid) || orphanPid <= 1 || orphanPid === process.pid) continue;
        if (cmd.includes('remote-control') || cmd.includes('ps -eo')) continue;
        if (/\bagy\b/.test(cmd) && cmd.includes('--disable-slash-commands') && /\s-p\s/.test(cmd)) {
          console.warn(`[Shim Watchdog] ⚠️ 发现脱缰孤儿 agy worker (PID: ${orphanPid})，立即连带进程组执行 SIGKILL！`);
          killProcessGroup(orphanPid);
        }
      }
    } catch {
      // 无匹配时忽略
    }
  }

  // 3. 定期清理隔离工作区超过 24 小时的临时垃圾
  cleanStaleAgyWorkspace();
}

let watchdogTimer: NodeJS.Timeout | null = null;

export function startAgyWatchdog(intervalMs = 60_000): void {
  if (watchdogTimer) return;
  // 启动即先执行一轮巡检与清理
  reapStaleAgyProcesses();
  watchdogTimer = setInterval(() => {
    reapStaleAgyProcesses();
  }, intervalMs);
  if (watchdogTimer.unref) {
    watchdogTimer.unref();
  }
}

export function stopAgyWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
