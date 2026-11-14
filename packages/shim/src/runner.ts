import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cleanStaleAgyWorkspace,
  DEFAULT_PRO_MODEL,
  extractLastJsonObject,
  invokeAgy,
  killProcessGroup,
  normalizeAgyModelName,
  UNTRUSTED_CONTENT_RULES,
  wrapUntrusted,
} from '../../core/agy-invoke';
import { signRequest } from '../../core/request-signing';
import { formatUtc8Now } from '../../core/types';
import { startManagedBrowser, touchBrowser } from './browser';

export interface TaskJob {
  jobId: string;
  platform: string;
  taskUrl: string;
  deadline?: string;
  mode: 'draft' | 'submit';
  phase: 'pending' | 'running' | 'draft_saved' | 'submitted' | 'failed';
  qa?: Array<{
    id: string;
    type: string;
    title: string;
    answer: string;
    solvedBy?: string;
  }>;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgyLockData {
  jobId: string;
  shimPid: number;
  agyPid?: number;
  startedAt: string;
  timestamp: number;
}

/** 硬件单例互斥锁文件路径 */
const LOCK_FILE_PATH = process.env.AFK_LOCK_FILE || path.join(os.tmpdir(), 'afk-agy-active.lock');
/** 本地任务持久化文件，服务重启状态不丢失 */
const JOBS_PERSIST_PATH = process.env.AFK_JOBS_FILE || path.join(os.homedir(), '.cache', 'afk-shim-jobs.json');

/** 内存中最多保留的任务数（超出后淘汰最早的已终结任务，避免常驻进程内存无限增长） */
const MAX_JOBS_RETAINED = 200;

const jobStore = new Map<string, TaskJob>();
const executionQueue: TaskJob[] = [];
let isWorkerRunning = false;

// 启动时从磁盘加载历史任务状态
loadJobsFromDisk();

export function getActiveLock(): AgyLockData | null {
  try {
    if (!fs.existsSync(LOCK_FILE_PATH)) return null;
    const raw = fs.readFileSync(LOCK_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.timestamp === 'number') {
      return parsed as AgyLockData;
    }
  } catch {}
  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function acquireLock(jobId: string): boolean {
  const existing = getActiveLock();
  const now = Date.now();
  if (existing) {
    const isAlive = existing.agyPid ? isProcessAlive(existing.agyPid) : isProcessAlive(existing.shimPid);
    const isExpired = now - existing.timestamp > 15 * 60 * 1000;

    if (isAlive && !isExpired) {
      if (existing.jobId === jobId) return true;
      return false; // 锁正被另一个活跃任务持有
    }

    console.warn(
      `[Shim Lock] 检测到残留/过期硬件锁 (Job: ${existing.jobId}, isAlive: ${isAlive}, isExpired: ${isExpired})，执行清理与接管`
    );
    if (existing.agyPid && isAlive) {
      killProcessGroup(existing.agyPid);
    }
    releaseLock();
  }

  const data: AgyLockData = {
    jobId,
    shimPid: process.pid,
    startedAt: formatUtc8Now(),
    timestamp: now,
  };
  try {
    fs.writeFileSync(LOCK_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err: any) {
    console.error(`[Shim Lock] 写入锁文件失败: ${err?.message || err}`);
    return false;
  }
}

export function updateLockAgyPid(jobId: string, agyPid: number): void {
  try {
    const lock = getActiveLock();
    if (lock && lock.jobId === jobId) {
      lock.agyPid = agyPid;
      fs.writeFileSync(LOCK_FILE_PATH, JSON.stringify(lock, null, 2), 'utf8');
    }
  } catch {}
}

export function releaseLock(jobId?: string): void {
  try {
    const lock = getActiveLock();
    if (lock && (!jobId || lock.jobId === jobId)) {
      if (fs.existsSync(LOCK_FILE_PATH)) {
        fs.unlinkSync(LOCK_FILE_PATH);
      }
    }
  } catch {}
}

function saveJobsToDisk(): void {
  try {
    const dir = path.dirname(JOBS_PERSIST_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(jobStore.values());
    fs.writeFileSync(JOBS_PERSIST_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

function loadJobsFromDisk(): void {
  try {
    if (!fs.existsSync(JOBS_PERSIST_PATH)) return;
    const raw = fs.readFileSync(JOBS_PERSIST_PATH, 'utf8');
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
    if (job.phase === 'submitted' || job.phase === 'failed') {
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
    currentJob.updatedAt = formatUtc8Now();
    saveJobsToDisk();
    console.log(`[Shim Runner] 🔒 获取硬件单例互斥锁成功，开始执行任务: ${currentJob.jobId} (模式: ${currentJob.mode})`);

    if (currentJob.mode === 'submit') {
      await processSubmitTask(currentJob);
    } else {
      await processDraftTask(currentJob);
    }
  } catch (err: any) {
    currentJob.phase = 'failed';
    currentJob.error = err?.message || String(err);
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
 * 从 jobId / taskUrl 提取超星 courseId / classId / workId
 */
function parseChaoxingTaskIdentifiers(job: TaskJob): { courseId: string; classId: string; workId: string } {
  let courseId = '';
  let classId = '';
  let workId = '';
  try {
    const u = new URL(job.taskUrl);
    courseId = u.searchParams.get('courseId') || '';
    classId = u.searchParams.get('classId') || '';
    workId = u.searchParams.get('workId') || u.searchParams.get('workAnswerId') || '';
  } catch {
    // ignore URL parse error
  }
  const noticeMatch = job.jobId.match(/^chaoxing-notice-work-(\d+)-(\d+)/);
  if (noticeMatch) {
    if (!workId) workId = noticeMatch[1];
    if (!classId) classId = noticeMatch[2];
  } else {
    const hwMatch = job.jobId.match(/^chaoxing-(?:work|hw)-(\d+)(?:-(\d+))?/);
    if (hwMatch && !workId) {
      workId = hwMatch[1];
    }
  }
  return { courseId, classId, workId };
}

/**
 * 超星纯 HTTP 原生作答 / 提交链路（无需无头浏览器，自动识别已交/过期/无表单作业）
 */
async function processChaoxingTask(job: TaskJob, mode: 'draft' | 'submit'): Promise<void> {
  const { chaoxingLogin, getChaoxingCourses, getCourseHomeworkList, getHomeworkDetail, submitHomework } =
    await import('../../adapters/chaoxing/index');
  const { downloadCourseMaterials, searchCourseMaterialsContext } = await import('../../adapters/chaoxing/materials');
  const { solveHomeworkDualTrack } = await import('../../core/solver');

  const phone = process.env.CHAOXING_PHONE || '';
  const password = process.env.CHAOXING_PASSWORD || '';
  if (!phone || !password) {
    throw new Error('未配置 CHAOXING_PHONE / CHAOXING_PASSWORD，无法以超星原生协议登录作答');
  }
  const cookies = await chaoxingLogin(phone, password);
  const { courseId, classId, workId } = parseChaoxingTaskIdentifiers(job);

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
    found = list.find((w) => (workId && w.workId === workId)) || (workId ? undefined : list.find((w) => w.isPending));
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

  if (!found || !resolvedCourse) {
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

  const detail = await getHomeworkDetail(found, cookies);
  if (!detail.questions || detail.questions.length === 0) {
    throw new Error('该作业无在线表单题目（可能为纯附件/实验报告上传类），请点击「打开作答界面」手动提交');
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

  const saveRes = await submitHomework(found, solveRes.answers, detail.formParams, cookies, true, detail.formAction);
  if (!saveRes.success) {
    throw new Error(`学习通草稿暂存失败: ${saveRes.msg}`);
  }

  const qaList = detail.questions.slice(0, 500).map((q) => ({
    id: String(q.id).slice(0, 128),
    type: String(q.type || 'single').slice(0, 32),
    title: String(q.title || '').slice(0, 4000),
    answer: String(solveRes.answers[q.id] || '').slice(0, 20000),
    solvedBy: 'agy',
  }));
  job.qa = qaList;
  job.phase = 'draft_saved';
  job.summary = `已通过超星原生协议暂存 ${qaList.length} 道题草稿（${saveRes.msg}）`.slice(0, 2000);
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] 超星作业 ${job.jobId} 已安全完成草稿暂存，包含 ${qaList.length} 道题`);
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

  // 1. 若为 Web 平台 (PTA / 智慧树等需要真机渲染的平台)，先确认浏览器就绪 (超星走纯 HTTP 原生，不拉起重型浏览器)
  if (['pta', 'zhihuishu'].includes(job.platform.toLowerCase())) {
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
    timeoutMs: 10 * 60 * 1000,
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

  const proModel = normalizeAgyModelName(process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || DEFAULT_PRO_MODEL, 'pro');
  console.log(`[Shim Runner] 调用 agy 点提交...`);
  const stdout = await invokeAgy({
    prompt: buildSubmitPrompt(job),
    model: proModel,
    timeoutMs: 5 * 60 * 1000,
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

  // 1. 检查锁是否已超时 (>15分钟)
  if (lock && now - lock.timestamp > 15 * 60 * 1000) {
    console.warn(`[Shim Watchdog] ⚠️ 检测到超期硬件单例锁 (>15m, Job: ${lock.jobId})，立即强制回收！`);
    if (lock.agyPid) {
      killProcessGroup(lock.agyPid);
    }
    releaseLock();
    const job = jobStore.get(lock.jobId);
    if (job && job.phase === 'running') {
      job.phase = 'failed';
      job.error = '执行超时 (>15m)，宿主机看门狗已强制杀死 agy 进程并回收单例锁';
      job.updatedAt = formatUtc8Now();
      saveJobsToDisk();
      notifyEdgeCallback(job).catch(() => {});
    }
    isWorkerRunning = false;
    setTimeout(() => {
      triggerQueueDrain();
    }, 500);
  }

  // 2. POSIX 环境下仅扫描 afk shim 遗留的无头 worker (agy -p ... --disable-slash-commands)，绝不误杀 remote-control / 交互会话
  if (process.platform !== 'win32' && !lock && !isWorkerRunning) {
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
