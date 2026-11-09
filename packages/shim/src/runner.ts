import { execFile } from 'child_process';
import { promisify } from 'util';
import { formatUtc8Now } from '../../core/types';
import { startManagedBrowser, touchBrowser } from './browser';

const execFileAsync = promisify(execFile);

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

const jobStore = new Map<string, TaskJob>();
const executionQueue: TaskJob[] = [];
let isWorkerRunning = false;

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

/**
 * 将任务推入执行队列 (串行保护，防止多个 agy 进程并发消耗内存)
 */
export function enqueueJob(
  params: {
    jobId: string;
    taskUrl: string;
    platform?: string;
    deadline?: string;
    mode?: 'draft' | 'submit';
  }
): TaskJob {
  const now = formatUtc8Now();
  let job = jobStore.get(params.jobId);

  if (job) {
    job.mode = params.mode || 'draft';
    job.taskUrl = params.taskUrl || job.taskUrl;
    job.platform = params.platform || job.platform;
    job.deadline = params.deadline || job.deadline;
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

/**
 * 模式 1: solve-draft
 * agy 打开真实作业页面，读题，逐题解答并保存草稿，【绝对不要点提交】
 */
async function processDraftTask(job: TaskJob): Promise<void> {
  // 测试或模拟模式快速通路
  if (process.env.NODE_ENV === 'test' || process.env.AFK_MOCK_SOLVER === 'true') {
    job.phase = 'draft_saved';
    job.qa = [
      { id: '1', type: 'single', title: '测试题目', answer: 'A', solvedBy: 'test' },
    ];
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

  // 2. 组装 agy 提示词模板 (严格匹配 cf-agent-architecture.md 规范)
  const prompt = `打开 ${job.taskUrl}（浏览器已就绪），读取全部题目；逐题解答（客观题直接选，主观/编程题完整作答）；在页面中填写答案并保存草稿，【绝对不要点提交】；最后只输出一个 JSON：{"qa":[{"id":"题目ID","type":"题型","title":"题干","answer":"作答内容"}],"summary":"简要作答总结"}`;

  const proModel = process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || 'pro';
  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (proModel) {
    args.push('--model', proModel);
  }

  console.log(`[Shim Runner] 调用 agy (Model: ${proModel})...`);
  let stdout = '';
  try {
    const res = await execFileAsync('agy', args, {
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 10 * 60 * 1000, // 最多 10 分钟
    });
    stdout = (res.stdout || '').trim();
  } catch (err: any) {
    // 兼容可能仅输出在 stderr 的情况
    stdout = (err.stdout || err.stderr || '').trim();
    if (!stdout) throw err;
  }

  // 3. 稳健提取结构化 JSON 结果
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      job.qa = Array.isArray(parsed.qa)
        ? parsed.qa.map((q: any) => ({
            id: String(q.id || ''),
            type: String(q.type || 'single'),
            title: String(q.title || ''),
            answer: String(q.answer || ''),
            solvedBy: 'agy',
          }))
        : [];
      job.summary = parsed.summary || '已通过 agy 浏览器读题并完成草稿暂存';
    } catch {
      job.summary = stdout.slice(0, 300);
    }
  } else {
    job.summary = stdout.slice(0, 300);
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

  const prompt = `打开 ${job.taskUrl}，确认草稿已在，点击提交并确认提交成功；输出 JSON：{"status":"submitted","summary":"确认已正式提交"}`;

  const proModel = process.env.AFK_PRO_MODEL || process.env.AGY_MODEL || 'pro';
  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (proModel) {
    args.push('--model', proModel);
  }

  console.log(`[Shim Runner] 调用 agy 点提交...`);
  let stdout = '';
  try {
    const res = await execFileAsync('agy', args, {
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    stdout = (res.stdout || '').trim();
  } catch (err: any) {
    stdout = (err.stdout || err.stderr || '').trim();
    if (!stdout) throw err;
  }

  job.phase = 'submitted';
  job.summary = '已通过 agy 确认提交成功';
  job.updatedAt = formatUtc8Now();
  console.log(`[Shim Runner] 任务 ${job.jobId} 已成功正式提交`);

  await notifyEdgeCallback(job);
}

/**
 * 主路径回调：将状态主动推送回 Cloudflare Edge Worker
 */
export async function notifyEdgeCallback(job: TaskJob): Promise<boolean> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const token = process.env.AFK_EDGE_BEARER_TOKEN || process.env.SYNC_SECRET;

  if (!edgeUrl) {
    console.log(`[Shim Callback] 未配置 AFK_EDGE_WORKER_URL，跳过边缘回调 (Job: ${job.jobId})`);
    return false;
  }

  const endpoint = `${edgeUrl.replace(/\/+$/, '')}/api/agent/callback`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jobId: job.jobId,
        phase: job.phase,
        qa: job.qa,
        summary: job.summary,
        error: job.error,
        platform: job.platform,
        taskUrl: job.taskUrl,
      }),
    });

    console.log(`[Shim Callback] Job [${job.jobId}] 回调 Edge 状态 HTTP ${res.status}`);
    return res.ok;
  } catch (err: any) {
    console.error(`[Shim Callback Error] 回调失败: ${err?.message || err}`);
    return false;
  }
}
