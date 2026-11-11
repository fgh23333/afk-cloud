import { Agent, callable } from 'agents';
import { computeQuestionHash } from './hash';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import { nowUtc8, upsertPendingTask, upsertQuestionCache } from './store';

export { computeQuestionHash };

export interface TaskRecord {
  job_id: string;
  platform: string;
  task_url: string;
  status: 'pending' | 'dispatched' | 'draft_saved' | 'awaiting_approval' | 'submitted' | 'failed' | 'submitting';
  deadline: string;
  qa_json: string;
  summary: string;
  attempts: number;
  updated_at: string;
}

export interface SolverState {
  initialized: boolean;
}

export class SolverAgent extends Agent<ExtendedNotifyEnv, SolverState> {
  initialState = { initialized: false };

  onStart(): void {
    // 1. 初始化 Durable Object 独享 SQLite 数据库表 (cf-agent-architecture.md 规范)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        job_id TEXT PRIMARY KEY,
        platform TEXT,
        task_url TEXT,
        status TEXT,
        deadline TEXT,
        qa_json TEXT,
        summary TEXT,
        attempts INTEGER DEFAULT 0,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS qa_cache (
        hash TEXT PRIMARY KEY,
        platform TEXT,
        type TEXT,
        title TEXT,
        answer TEXT,
        updated_at TEXT
      );
    `);
    this.setState({ initialized: true });
  }

  /**
   * 任务入队：去重、SQLite 登记、D1 镜像同步与派发服务器 shim
   */
  @callable()
  async enqueue(task: {
    jobId: string;
    platform: string;
    taskUrl: string;
    deadline?: string;
    courseName?: string;
    title?: string;
    force?: boolean;
  }): Promise<{ accepted: boolean; jobId: string; status: string; reason?: string }> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', task.jobId);
    const existing = [...cursor];

    if (existing.length > 0 && !task.force) {
      const row = existing[0] as any;
      if (['dispatched', 'draft_saved', 'awaiting_approval', 'submitted', 'submitting'].includes(row.status)) {
        return {
          accepted: false,
          jobId: task.jobId,
          status: row.status,
          reason: `任务已存在且处于 [${row.status}] 状态，已自动去重跳过`,
        };
      }
    }

    const now = nowUtc8();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO tasks 
       (job_id, platform, task_url, status, deadline, qa_json, summary, attempts, updated_at)
       VALUES (?, ?, ?, 'pending', ?, '[]', '', 0, ?)`,
      task.jobId,
      task.platform || 'chaoxing',
      task.taskUrl,
      task.deadline || '',
      now
    );

    // 同步到 D1 待办表供前端看板高频读
    await upsertPendingTask(this.env, {
      taskId: task.jobId,
      platform: task.platform || 'chaoxing',
      courseId: '',
      classId: '',
      courseName: task.courseName || '',
      title: task.title || task.jobId,
      status: 'pending',
      computeTier: 'tier1-server-shim',
      deadline: task.deadline || '',
    });

    // 立即执行派发
    const dispatchRes = await this.dispatchTask(task.jobId);
    return {
      accepted: true,
      jobId: task.jobId,
      status: dispatchRes ? 'dispatched' : 'pending',
    };
  }

  /**
   * 将任务派发给常驻服务器的 HTTP shim
   */
  async dispatchTask(jobId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId);
    const rows = [...cursor];
    if (rows.length === 0) return false;
    const task = rows[0] as any;

    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;

    const now = nowUtc8();
    this.ctx.storage.sql.exec(
      'UPDATE tasks SET status = ?, attempts = attempts + 1, updated_at = ? WHERE job_id = ?',
      'dispatched',
      now,
      jobId
    );

    if (this.env.DB) {
      await this.env.DB.prepare('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?')
        .bind('dispatched', now, jobId)
        .run()
        .catch(() => {});
    }

    if (!shimUrl) {
      console.warn(`[SolverAgent] 未配置 AFK_SHIM_URL，任务 [${jobId}] 保持 dispatched 等待 shim 接入`);
      return false;
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (shimToken) headers['Authorization'] = `Bearer ${shimToken}`;

      const res = await fetch(`${shimUrl.replace(/\/+$/, '')}/task`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: task.job_id,
          taskUrl: task.task_url,
          platform: task.platform,
          deadline: task.deadline,
          mode: 'draft',
        }),
      });

      console.log(`[SolverAgent] 任务 [${jobId}] 派发至 shim HTTP ${res.status}`);
      return res.ok;
    } catch (err: any) {
      console.error(`[SolverAgent] 派发任务至 shim 异常: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * 处理 shim 执行完毕的回调 (主路径)
   */
  async handleCallback(payload: {
    jobId: string;
    phase: string;
    qa?: any[];
    summary?: string;
    error?: string;
    platform?: string;
    taskUrl?: string;
  }): Promise<{ handled: boolean; status: string }> {
    const now = nowUtc8();
    const qaJson = JSON.stringify(payload.qa || []);
    const summary = payload.summary || payload.error || '';

    let nextStatus = payload.phase;
    if (payload.phase === 'draft_saved') {
      nextStatus = this.env.AUTO_SUBMIT_HOMEWORK === 'true' ? 'submitting' : 'awaiting_approval';
    }

    this.ctx.storage.sql.exec(
      'UPDATE tasks SET status = ?, qa_json = ?, summary = ?, updated_at = ? WHERE job_id = ?',
      nextStatus,
      qaJson,
      summary,
      now,
      payload.jobId
    );

    // 1. 题库哈希入库 (SQLite qa_cache + D1 question_bank)
    if (Array.isArray(payload.qa) && payload.qa.length > 0) {
      for (const item of payload.qa) {
        const hash = await computeQuestionHash(item.type || 'single', item.title || '', item.options);
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO qa_cache (hash, platform, type, title, answer, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          hash,
          payload.platform || 'chaoxing',
          item.type || 'single',
          item.title || '',
          item.answer || '',
          now
        );
      }

      if (this.env.DB) {
        const d1Items = await Promise.all(
          payload.qa.map(async (item) => ({
            questionHash: await computeQuestionHash(item.type || 'single', item.title || '', item.options),
            platform: payload.platform || 'chaoxing',
            questionType: item.type || 'single',
            title: item.title || '',
            answer: item.answer || '',
            modelTier: 'pro' as const,
            updatedAt: now,
          }))
        );
        await upsertQuestionCache(this.env, d1Items).catch(() => {});
      }
    }

    // 2. D1 看板同步
    if (this.env.DB) {
      await this.env.DB.prepare(
        'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
      )
        .bind(nextStatus, summary, now, payload.jobId)
        .run()
        .catch(() => {});
    }

    // 3. 阶段性通知与审批门 (D7 铁律)
    if (payload.phase === 'draft_saved') {
      if (this.env.AUTO_SUBMIT_HOMEWORK === 'true') {
        console.log(`[SolverAgent] 检测到开启全自动提交，立即链式下发 submit 指令`);
        await this.submitTask(payload.jobId);
      } else {
        await sendNotification(
          'afk-cloud 作业安全草稿已暂存',
          `任务：${payload.jobId}\n状态：已保存草稿 (包含 ${payload.qa?.length || 0} 题)\n详情：${summary}\n👉 请登录看板核验并点击【审批提交】。`,
          this.env
        );
      }
    } else if (payload.phase === 'submitted') {
      await sendNotification(
        'afk-cloud 作业正式提交成功',
        `任务：${payload.jobId}\n状态：已正式提交\n详情：${summary}`,
        this.env
      );
    } else if (payload.phase === 'failed') {
      await sendNotification(
        'afk-cloud 作业作答异常报警',
        `任务：${payload.jobId}\n状态：执行失败\n原因：${payload.error || summary}`,
        this.env
      );
    }

    return { handled: true, status: nextStatus };
  }

  /**
   * 审批通过门 (D7)：触发第二条指令下发 submit
   */
  @callable()
  async approveTask(jobId: string): Promise<{ success: boolean; jobId: string; status: string; msg: string }> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId);
    const rows = [...cursor];
    if (rows.length === 0) {
      return { success: false, jobId, status: 'not_found', msg: '未找到指定任务' };
    }

    const task = rows[0] as any;
    if (task.status === 'submitted') {
      return { success: true, jobId, status: 'submitted', msg: '任务此前已正式提交' };
    }

    const ok = await this.submitTask(jobId);
    return {
      success: ok,
      jobId,
      status: ok ? 'submitting' : task.status,
      msg: ok ? '已下发正式提交指令' : '派发提交失败，请检查 shim 通信',
    };
  }

  /**
   * 下发第二条指令：让 agy 回到页面点提交
   */
  async submitTask(jobId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId);
    const rows = [...cursor];
    if (rows.length === 0) return false;
    const task = rows[0] as any;

    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;

    const now = nowUtc8();
    this.ctx.storage.sql.exec(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE job_id = ?',
      'submitting',
      now,
      jobId
    );

    if (this.env.DB) {
      await this.env.DB.prepare('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?')
        .bind('submitting', now, jobId)
        .run()
        .catch(() => {});
    }

    if (!shimUrl) return false;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (shimToken) headers['Authorization'] = `Bearer ${shimToken}`;

      const res = await fetch(`${shimUrl.replace(/\/+$/, '')}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: task.job_id,
          taskUrl: task.task_url,
        }),
      });
      return res.ok;
    } catch (err: any) {
      console.error(`[SolverAgent] 触发 submit 指令异常: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * 兜底对账轮询 (当回调偶发丢失时推进状态)
   */
  async reconcileDispatchedTasks(): Promise<void> {
    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;
    if (!shimUrl) return;

    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM tasks WHERE status IN ('dispatched', 'submitting') LIMIT 10"
    );
    const tasks = [...cursor] as any[];

    for (const t of tasks) {
      try {
        const headers: Record<string, string> = {};
        if (shimToken) headers['Authorization'] = `Bearer ${shimToken}`;

        const res = await fetch(`${shimUrl.replace(/\/+$/, '')}/status/${t.job_id}`, { headers });
        if (res.ok) {
          const remote: any = await res.json();
          if (remote?.phase && remote.phase !== t.status) {
            console.log(`[SolverAgent 对账兜底] 任务 [${t.job_id}] 状态由 ${t.status} 推进为 ${remote.phase}`);
            await this.handleCallback({
              jobId: t.job_id,
              phase: remote.phase,
              qa: remote.qa,
              summary: remote.summary,
              error: remote.error,
              platform: t.platform,
              taskUrl: t.task_url,
            });
          }
        }
      } catch {
        // ignore network jitter
      }
    }
  }
}
