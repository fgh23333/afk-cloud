import {
  extractLastJsonObject,
  invokeAgy,
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

/** 内存中最多保留的任务数（超出后淘汰最早的已终结任务，避免常驻进程内存无限增长） */
const MAX_JOBS_RETAINED = 200;

const jobStore = new Map<string, TaskJob>();
const executionQueue: TaskJob[] = [];
let isWorkerRunning = false;

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

  isWorkerRunning = true;
  const currentJob = executionQueue.shift();

  if (!currentJob) {
    isWorkerRunning = false;
    return;
  }

  try {
    currentJob.phase = 'running';
    currentJob.updatedAt = formatUtc8Now();
    console.log(`[Shim Runner] 开始执行任务: ${currentJob.jobId} (模式: ${currentJob.mode})`);

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
    // 继续消费后续任务
    setTimeout(() => {
      triggerQueueDrain();
    }, 200);
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

  // 1. 若为 Web 平台，先确认浏览器就绪
  if (['chaoxing', 'pta', 'zhihuishu'].includes(job.platform.toLowerCase())) {
    try {
      await startManagedBrowser(job.platform, 30);
      touchBrowser(30);
    } catch (e: any) {
      console.warn(`[Shim Runner] 浏览器启动提示: ${e?.message || e}`);
    }
  }

  // 2. 以安全基线调用 agy (无 shell、沙箱、最小环境变量、隔离工作目录、结构化输出)
  const proModel = process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || 'pro';
  console.log(`[Shim Runner] 调用 agy (Model: ${proModel})...`);
  const stdout = await invokeAgy({
    prompt: buildDraftPrompt(job),
    model: proModel,
    timeoutMs: 10 * 60 * 1000,
    jsonSchema: DRAFT_OUTPUT_SCHEMA,
    maxBuffer: 20 * 1024 * 1024,
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

  const proModel = process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || 'pro';
  console.log(`[Shim Runner] 调用 agy 点提交...`);
  const stdout = await invokeAgy({
    prompt: buildSubmitPrompt(job),
    model: proModel,
    timeoutMs: 5 * 60 * 1000,
    jsonSchema: SUBMIT_OUTPUT_SCHEMA,
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
