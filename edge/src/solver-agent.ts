import { Agent, callable } from 'agents';
import { isAllowedTaskUrl } from './auth';
import { computeQuestionHash } from './hash';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import { signRequest } from './request-signing';
import { logExecution, nowUtc8, parseUtc8ToMs, upsertPendingTask, upsertQuestionCache } from './store';

export { computeQuestionHash, isAllowedTaskUrl };

export const SUBMITTING_TIMEOUT_MS = 15 * 60 * 1000;

export interface SolverState {
  initialized: boolean;
  activeJobId?: string | null;
  activeJobStartedAt?: string | null;
}

export class SolverAgent extends Agent<ExtendedNotifyEnv, SolverState> {
  initialState = { initialized: false, activeJobId: null, activeJobStartedAt: null };

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

    // 恢复活跃任务状态
    const activeCursor = this.ctx.storage.sql.exec(
      "SELECT job_id, updated_at FROM tasks WHERE status IN ('dispatched', 'submitting') ORDER BY updated_at DESC LIMIT 1"
    );
    const activeRows = [...activeCursor] as any[];
    const activeJobId = activeRows.length > 0 ? activeRows[0].job_id : null;
    const activeJobStartedAt = activeRows.length > 0 ? activeRows[0].updated_at : null;

    this.setState({ initialized: true, activeJobId, activeJobStartedAt });
  }

  /**
   * 查询当前 Durable Object 内部全局队列与单例状态
   */
  @callable()
  async getQueueStatus(): Promise<{
    activeJobId: string | null;
    activeJobStartedAt: string | null;
    pendingCount: number;
    totalTasks: number;
  }> {
    const curPending = this.ctx.storage.sql.exec("SELECT count(*) as cnt FROM tasks WHERE status = 'pending'");
    const curTotal = this.ctx.storage.sql.exec('SELECT count(*) as cnt FROM tasks');
    const pendingCount = ([...curPending][0] as any)?.cnt || 0;
    const totalTasks = ([...curTotal][0] as any)?.cnt || 0;

    return {
      activeJobId: this.state.activeJobId || null,
      activeJobStartedAt: this.state.activeJobStartedAt || null,
      pendingCount,
      totalTasks,
    };
  }

  /**
   * 单例驱动队列调度：
   *  - 若当前有正在执行的任务且未超时 (<15m)，保持等待并返回 busy
   *  - 若无活跃任务或已超时熔断，自动出队最早入队的 pending 任务下发执行
   */
  @callable()
  async tryDispatchNext(): Promise<{ dispatched: boolean; jobId?: string; reason?: string }> {
    const now = nowUtc8();

    // 1. 检查当前活跃任务锁
    if (this.state.activeJobId) {
      const cur = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', this.state.activeJobId);
      const rows = [...cur] as any[];
      if (rows.length > 0) {
        const activeTask = rows[0];
        if (['dispatched', 'submitting'].includes(activeTask.status)) {
          // 检查是否超时 (> 15 分钟)；无法解析的时间戳视作已超时以免死锁
          const startedTime = parseUtc8ToMs(activeTask.updated_at);
          const elapsedMs = isNaN(startedTime) ? 15 * 60 * 1000 + 1 : Date.now() - startedTime;
          if (elapsedMs < 15 * 60 * 1000) {
            return {
              dispatched: false,
              jobId: this.state.activeJobId,
              reason: `当前已有任务 [${this.state.activeJobId}] 正在执行 (已耗时 ${Math.round(elapsedMs / 1000)}s)，单例保护已启动，后续任务已排队`,
            };
          }

          // 超时熔断：
          // - 若任务处于 submitting（草稿已保存、仅提交指令超时），回退为 draft_saved 并记日志
          // - 若未配置 shimUrl，则退回 pending 等待客户端主动拉取；若已配置 shimUrl 但超时未回调，标记为 failed
          const hasShim = !!(this.env.AFK_SHIM_URL || this.env.SHIM_URL);
          const isSubmittingTimeout = activeTask.status === 'submitting';
          const timeoutStatus = isSubmittingTimeout ? 'draft_saved' : hasShim ? 'failed' : 'pending';
          const timeoutSummary = isSubmittingTimeout
            ? '正式提交超时 (>15分钟)，已自动回退为草稿暂存状态'
            : hasShim
              ? '执行超时 (>15分钟)，边缘控制器已自动熔断回收'
              : '边缘等待超时，已重置为待拉取队列';
          console.warn(
            `[SolverAgent 熔断] 任务 [${this.state.activeJobId}] (${activeTask.status}) 超过 15 分钟未响应，状态重置为 ${timeoutStatus}`
          );
          this.ctx.storage.sql.exec(
            'UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE job_id = ?',
            timeoutStatus,
            timeoutSummary,
            now,
            this.state.activeJobId
          );
          if (this.env.DB) {
            await this.env.DB.prepare(
              'UPDATE pending_tasks SET status = ?, result_summary = ?, updated_at = ? WHERE task_id = ?'
            )
              .bind(timeoutStatus, timeoutSummary, now, this.state.activeJobId)
              .run()
              .catch(() => {});
          }
          if (isSubmittingTimeout) {
            await logExecution(
              this.env,
              'submitting_reverted',
              activeTask.platform || 'chaoxing',
              `任务 [${this.state.activeJobId}] 处于 submitting 状态超时 (>15分钟)，已自动回退为 draft_saved`,
              { taskId: this.state.activeJobId, from: 'submitting', to: 'draft_saved', source: 'tryDispatchNext' }
            );
          }
        }
      }
      // 释放锁
      this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
    }

    // 2. 从独享 SQLite 队列中取出最早的 pending 任务
    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM tasks WHERE status = 'pending' ORDER BY updated_at ASC LIMIT 1"
    );
    const pendingRows = [...cursor] as any[];
    if (pendingRows.length === 0) {
      return { dispatched: false, reason: '队列中无等待执行的任务' };
    }

    const nextJob = pendingRows[0];
    const ok = await this.dispatchTask(nextJob.job_id);
    if (ok) {
      this.setState({ ...this.state, activeJobId: nextJob.job_id, activeJobStartedAt: now });
      return { dispatched: true, jobId: nextJob.job_id };
    }
    return { dispatched: false, jobId: nextJob.job_id, reason: '派发请求失败' };
  }

  /**
   * 任务入队：去重、SQLite 登记、D1 镜像同步与单例队列调度
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

    // 同步到 D1 待办表供前端看板高频读 (初始记为 pending)
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

    // 尝试驱动调度消费
    const dispatchRes = await this.tryDispatchNext();
    const isThisJobDispatched = dispatchRes.dispatched && dispatchRes.jobId === task.jobId;

    return {
      accepted: true,
      jobId: task.jobId,
      status: isThisJobDispatched ? 'dispatched' : 'pending',
      reason: isThisJobDispatched ? undefined : (dispatchRes.reason || '已安全排入队列，等待当前任务完成'),
    };
  }

  /**
   * 将任务安全派发给常驻服务器的 HTTP shim (强制 URL 白名单校验 + HMAC-SHA256 签名)
   */
  async dispatchTask(jobId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId);
    const rows = [...cursor];
    if (rows.length === 0) return false;
    const task = rows[0] as any;

    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimSecret = this.env.AFK_SHIM_SECRET;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;

    // 安全防线 1：URL 域名白名单与 HTTPS 校验
    if (!isAllowedTaskUrl(task.task_url, this.env.AFK_TASK_HOST_ALLOWLIST)) {
      console.warn(`[SolverAgent Security] 任务 [${jobId}] 的 URL 不在安全白名单内，拒绝派发: ${task.task_url}`);
      return false;
    }

    if (!shimUrl) {
      console.warn(`[SolverAgent] 未配置 AFK_SHIM_URL，任务 [${jobId}] 保持 pending 等待客户端主动拉取`);
      return false;
    }

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

    try {
      const endpoint = new URL('/task', shimUrl.replace(/\/+$/, '') + '/');
      const body = JSON.stringify({
        jobId: task.job_id,
        taskUrl: task.task_url,
        platform: task.platform,
        deadline: task.deadline,
        mode: 'draft',
      });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // 安全防线 2：HMAC-SHA256 请求签名 (优先) 或 Bearer 鉴权
      if (shimSecret) {
        const sigHeaders = await signRequest({
          secret: shimSecret,
          method: 'POST',
          pathWithQuery: endpoint.pathname + endpoint.search,
          body,
        });
        Object.assign(headers, sigHeaders);
      } else if (shimToken) {
        headers['Authorization'] = `Bearer ${shimToken}`;
      }

      const res = await fetch(endpoint.toString(), {
        method: 'POST',
        headers,
        body,
      });

      console.log(`[SolverAgent] 任务 [${jobId}] 安全派发至 shim HTTP ${res.status}`);
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

    let nextStatus = payload.phase === 'draft_saved' ? 'awaiting_approval' : payload.phase;

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
      let autoSubmitted = false;
      if (this.env.AUTO_SUBMIT_HOMEWORK === 'true') {
        console.log(`[SolverAgent] 检测到开启全自动提交，立即链式下发 submit 指令`);
        const submitRes = await this.submitTask(payload.jobId);
        autoSubmitted = submitRes.ok;
        if (autoSubmitted) {
          nextStatus = 'submitting';
        } else {
          console.warn(`[SolverAgent] 自动提交未能触发，保留 awaiting_approval: ${submitRes.reason}`);
        }
      }
      if (!autoSubmitted) {
        await sendNotification(
          'afk-cloud 作业安全草稿已暂存',
          `任务：${payload.jobId}\n状态：已保存草稿 (包含 ${payload.qa?.length || 0} 题)\n详情：${summary}\n👉 请登录看板核验并点击【审批提交】。`,
          this.env
        );
        // 草稿暂存完成，释放当前执行槽位，出队调度下一个 pending 作业
        if (this.state.activeJobId === payload.jobId) {
          this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
        }
        await this.tryDispatchNext();
      }
    } else if (payload.phase === 'submitted') {
      await sendNotification(
        'afk-cloud 作业正式提交成功',
        `任务：${payload.jobId}\n状态：已正式提交\n详情：${summary}`,
        this.env
      );
      // 提交完成，释放槽位并出队下一个
      if (this.state.activeJobId === payload.jobId) {
        this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
      }
      await this.tryDispatchNext();
    } else if (payload.phase === 'failed') {
      await sendNotification(
        'afk-cloud 作业作答异常报警',
        `任务：${payload.jobId}\n状态：执行失败\n原因：${payload.error || summary}`,
        this.env
      );
      // 失败熔断，释放槽位并调度下一个
      if (this.state.activeJobId === payload.jobId) {
        this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
      }
      await this.tryDispatchNext();
    }

    return { handled: true, status: nextStatus };
  }

  /**
   * 审批通过门 (D7)：触发第二条指令下发 submit
   */
  @callable()
  async approveTask(
    jobId: string
  ): Promise<{ success: boolean; jobId: string; status: string; msg: string; reason?: string }> {
    let rows = [...this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId)] as any[];

    // 若 DO SQLite 尚无该任务（例如 CLI 同步写入 D1 pending_tasks 的草稿），从 D1 兜底读取任务元信息
    if (rows.length === 0 && this.env.DB) {
      try {
        const d1Task = await this.env.DB.prepare('SELECT * FROM pending_tasks WHERE task_id = ?')
          .bind(jobId)
          .first<any>();
        if (d1Task) {
          let taskUrl = '';
          if (d1Task.payload_json) {
            try {
              taskUrl = JSON.parse(d1Task.payload_json)?.url || '';
            } catch {
              // ignore
            }
          }
          if (!taskUrl && d1Task.course_id && d1Task.class_id) {
            const rawWorkId = String(d1Task.task_id || '')
              .replace(/^chaoxing-(?:notice-)?(?:work|hw)-/, '')
              .split('-')[0];
            if (rawWorkId) {
              taskUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${d1Task.course_id}&classId=${d1Task.class_id}&cpi=&workId=${rawWorkId}`;
            }
          }
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO tasks (job_id, platform, task_url, status, deadline, qa_json, summary, attempts, updated_at)
             VALUES (?, ?, ?, ?, ?, '[]', ?, 0, ?)`,
            jobId,
            d1Task.platform || 'chaoxing',
            taskUrl,
            d1Task.status || 'draft_saved',
            d1Task.deadline || '',
            d1Task.result_summary || '',
            d1Task.updated_at || nowUtc8()
          );
          rows = [...this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId)] as any[];
        }
      } catch {
        // ignore D1 fallback error
      }
    }

    if (rows.length === 0) {
      const reason = '未找到指定任务';
      return { success: false, jobId, status: 'not_found', msg: reason, reason };
    }

    const task = rows[0] as any;
    if (task.status === 'submitted') {
      return { success: true, jobId, status: 'submitted', msg: '任务此前已正式提交' };
    }

    const submitRes = await this.submitTask(jobId);
    if (submitRes.ok) {
      this.setState({ ...this.state, activeJobId: jobId, activeJobStartedAt: nowUtc8() });
      return {
        success: true,
        jobId,
        status: 'submitting',
        msg: '已下发正式提交指令',
      };
    }

    const reason = submitRes.reason || '派发提交失败，请检查 shim 通信';
    return {
      success: false,
      jobId,
      status: task.status,
      msg: reason,
      reason,
    };
  }

  /**
   * 忽略/归档任务：同步更新 DO SQLite 与 D1 状态，并释放若占用中的 activeJobId
   */
  @callable()
  async ignoreTask(jobId: string): Promise<{ ok: boolean; jobId: string; status: string }> {
    const now = nowUtc8();
    this.ctx.storage.sql.exec(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE job_id = ?',
      'ignored',
      now,
      jobId
    );
    if (this.state.activeJobId === jobId) {
      this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
    }
    if (this.env.DB) {
      await this.env.DB.prepare('UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ?')
        .bind('ignored', now, jobId)
        .run()
        .catch(() => {});
    }
    return { ok: true, jobId, status: 'ignored' };
  }

  private async revertSubmittingStatus(jobId: string, prevStatus: string, prevUpdatedAt: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE job_id = ? AND status = 'submitting'",
      prevStatus,
      prevUpdatedAt,
      jobId
    );
    if (this.env.DB) {
      await this.env.DB.prepare(
        "UPDATE pending_tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = 'submitting'"
      )
        .bind(prevStatus, prevUpdatedAt, jobId)
        .run()
        .catch(() => {});
    }
  }

  /**
   * 下发第二条指令：让 agy 回到页面点提交 (HMAC 签名认证)
   */
  async submitTask(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    const cursor = this.ctx.storage.sql.exec('SELECT * FROM tasks WHERE job_id = ?', jobId);
    const rows = [...cursor];
    if (rows.length === 0) {
      return { ok: false, reason: '未找到指定任务' };
    }
    const task = rows[0] as any;
    const prevStatus = task.status;
    const prevUpdatedAt = task.updated_at;

    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimSecret = this.env.AFK_SHIM_SECRET;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;

    // 安全校验 1：URL 域名白名单与 HTTPS 校验（不通过时不改写任何状态）
    if (!isAllowedTaskUrl(task.task_url, this.env.AFK_TASK_HOST_ALLOWLIST)) {
      console.warn(`[SolverAgent Security] 提交任务 URL 非法: ${task.task_url}`);
      return { ok: false, reason: '任务 URL 非法或不在安全白名单内，任务状态保持不变' };
    }

    // 安全校验 2：必须先确认已配置 shimUrl，未配置时保持原状态不变
    if (!shimUrl) {
      console.warn(`[SolverAgent] 未配置 AFK_SHIM_URL，任务 [${jobId}] 保持 ${prevStatus} 状态不变`);
      return { ok: false, reason: '未配置 AFK_SHIM_URL / SHIM_URL，无法派发正式提交指令，任务状态保持不变' };
    }

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

    try {
      const endpoint = new URL('/submit', shimUrl.replace(/\/+$/, '') + '/');
      const body = JSON.stringify({
        jobId: task.job_id,
        taskUrl: task.task_url,
      });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (shimSecret) {
        const sigHeaders = await signRequest({
          secret: shimSecret,
          method: 'POST',
          pathWithQuery: endpoint.pathname + endpoint.search,
          body,
        });
        Object.assign(headers, sigHeaders);
      } else if (shimToken) {
        headers['Authorization'] = `Bearer ${shimToken}`;
      }

      const res = await fetch(endpoint.toString(), {
        method: 'POST',
        headers,
        body,
      });
      if (!res.ok) {
        const reason = `shim /submit 返回 HTTP ${res.status}，任务状态已保留为 ${prevStatus}`;
        console.warn(`[SolverAgent] ${reason}`);
        await this.revertSubmittingStatus(jobId, prevStatus, prevUpdatedAt);
        return { ok: false, reason };
      }
      return { ok: true };
    } catch (err: any) {
      const reason = `触发 submit 指令异常: ${err?.message || err}`;
      console.error(`[SolverAgent] ${reason}`);
      await this.revertSubmittingStatus(jobId, prevStatus, prevUpdatedAt);
      return { ok: false, reason };
    }
  }

  /**
   * 外部执行回执同步：CLI/Cron 自主完成草稿或提交后，立即更新 DO 状态并释放全局单例锁
   */
  @callable()
  async syncExternalTaskStatus(jobId: string, status: string, summary?: string): Promise<void> {
    const now = nowUtc8();
    const rawId = jobId.replace(/^chaoxing-(?:notice-)?(?:work|hw)-/, '').split('-')[0];
    const finalSummary = summary || '';

    this.ctx.storage.sql.exec(
      'UPDATE tasks SET status = ?, summary = COALESCE(NULLIF(?, \'\'), summary), updated_at = ? WHERE job_id = ?',
      status,
      finalSummary,
      now,
      jobId
    );

    if (rawId) {
      this.ctx.storage.sql.exec(
        'UPDATE tasks SET status = ?, summary = COALESCE(NULLIF(?, \'\'), summary), updated_at = ? WHERE job_id LIKE ? OR job_id LIKE ?',
        status,
        finalSummary,
        now,
        `%work-${rawId}%`,
        `%hw-${rawId}%`
      );
    }

    if (this.state.activeJobId && (this.state.activeJobId === jobId || (rawId && this.state.activeJobId.includes(rawId)))) {
      if (['draft_saved', 'submitted', 'failed', 'pending'].includes(status)) {
        this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
      }
    }
  }

  /**
   * 兜底对账轮询 (当回调偶发丢失或队列超时卡死时自动推进状态与释放单例锁)
   */
  async reconcileDispatchedTasks(options?: { submittingTimeoutMs?: number; nowMs?: number }): Promise<void> {
    const shimUrl = this.env.AFK_SHIM_URL || this.env.SHIM_URL;
    const shimSecret = this.env.AFK_SHIM_SECRET;
    const shimToken = this.env.AFK_SHIM_TOKEN || this.env.SHIM_TOKEN;
    const submittingTimeoutMs = options?.submittingTimeoutMs ?? SUBMITTING_TIMEOUT_MS;
    const nowMs = options?.nowMs ?? Date.now();
    const now = nowUtc8();

    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM tasks WHERE status IN ('dispatched', 'submitting') LIMIT 10"
    );
    const tasks = [...cursor] as any[];
    const revertedIds = new Set<string>();
    const freshSubmittingIds = new Set<string>();

    const revertSubmittingTask = async (
      jobId: string,
      platform: string,
      reason: string,
      detail?: Record<string, unknown>
    ) => {
      if (revertedIds.has(jobId)) return;
      revertedIds.add(jobId);

      this.ctx.storage.sql.exec(
        "UPDATE tasks SET status = 'draft_saved', updated_at = ? WHERE job_id = ? AND status = 'submitting'",
        now,
        jobId
      );
      if (this.env.DB) {
        await this.env.DB.prepare(
          "UPDATE pending_tasks SET status = 'draft_saved', updated_at = ? WHERE task_id = ? AND status = 'submitting'"
        )
          .bind(now, jobId)
          .run()
          .catch(() => {});
      }
      if (this.state.activeJobId === jobId) {
        this.setState({ ...this.state, activeJobId: null, activeJobStartedAt: null });
      }
      await logExecution(
        this.env,
        'submitting_reverted',
        platform || 'chaoxing',
        `任务 [${jobId}] 处于 submitting 状态超时未完成，已自动回退为 draft_saved (${reason})`,
        { taskId: jobId, from: 'submitting', to: 'draft_saved', reason, ...detail }
      );
    };

    if (shimUrl) {
      for (const t of tasks) {
        let resolvedByRemote = false;
        try {
          const pathWithQuery = `/status/${encodeURIComponent(t.job_id)}`;
          const endpoint = new URL(pathWithQuery, shimUrl.replace(/\/+$/, '') + '/');
          const headers: Record<string, string> = {};

          if (shimSecret) {
            const sigHeaders = await signRequest({
              secret: shimSecret,
              method: 'GET',
              pathWithQuery,
            });
            Object.assign(headers, sigHeaders);
          } else if (shimToken) {
            headers['Authorization'] = `Bearer ${shimToken}`;
          }

          const res = await fetch(endpoint.toString(), { headers });
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
              resolvedByRemote = true;
            }
          }
        } catch {
          // ignore network jitter
        }

        if (!resolvedByRemote && t.status === 'submitting') {
          const startedMs = parseUtc8ToMs(t.updated_at);
          const elapsedMs = isNaN(startedMs) ? submittingTimeoutMs + 1 : nowMs - startedMs;
          if (elapsedMs >= submittingTimeoutMs) {
            await revertSubmittingTask(t.job_id, t.platform, 'shim_reconcile_timeout', { elapsedMs });
          } else {
            freshSubmittingIds.add(t.job_id);
          }
        }
      }
    } else {
      // 未配置 shimUrl 时：
      // - 将超过 15 分钟卡在 dispatched 的历史任务回收至 pending 等待客户端拉取
      // - 将超时卡在 submitting 的任务回退至 draft_saved 并记录执行日志
      for (const t of tasks) {
        const startedMs = parseUtc8ToMs(t.updated_at);
        if (t.status === 'submitting') {
          const elapsedMs = isNaN(startedMs) ? submittingTimeoutMs + 1 : nowMs - startedMs;
          if (elapsedMs >= submittingTimeoutMs) {
            await revertSubmittingTask(t.job_id, t.platform, 'no_shim_timeout', { elapsedMs });
          } else {
            freshSubmittingIds.add(t.job_id);
          }
        } else if (t.status === 'dispatched') {
          const elapsedMs = isNaN(startedMs) ? 15 * 60 * 1000 + 1 : nowMs - startedMs;
          if (elapsedMs >= 15 * 60 * 1000) {
            this.ctx.storage.sql.exec(
              "UPDATE tasks SET status = 'pending', updated_at = ? WHERE job_id = ?",
              now,
              t.job_id
            );
            if (this.env.DB) {
              await this.env.DB.prepare(
                "UPDATE pending_tasks SET status = 'pending', updated_at = ? WHERE task_id = ? AND status = 'dispatched'"
              )
                .bind(now, t.job_id)
                .run()
                .catch(() => {});
            }
          }
        }
      }
    }

    // 兜底检查 D1 pending_tasks 中超时滞留在 submitting 的任务（例如历史写入或未经过 DO 队列的任务）
    if (this.env.DB) {
      try {
        const d1Submitting = await this.env.DB.prepare(
          "SELECT task_id, platform, updated_at FROM pending_tasks WHERE status = 'submitting' LIMIT 20"
        ).all<{ task_id: string; platform?: string; updated_at?: string }>();

        for (const row of d1Submitting.results || []) {
          if (revertedIds.has(row.task_id) || freshSubmittingIds.has(row.task_id)) continue;
          const startedMs = parseUtc8ToMs(row.updated_at);
          const elapsedMs = isNaN(startedMs) ? submittingTimeoutMs + 1 : nowMs - startedMs;
          if (elapsedMs >= submittingTimeoutMs) {
            await revertSubmittingTask(
              row.task_id,
              row.platform || 'chaoxing',
              shimUrl ? 'shim_reconcile_timeout' : 'no_shim_timeout',
              { elapsedMs, source: 'd1_pending_tasks' }
            );
          }
        }
      } catch {
        // ignore D1 query errors
      }
    }

    // 2. 检查是否有空闲单例槽位或超时锁，自动驱动队列出队与锁释放
    await this.tryDispatchNext();
  }
}
