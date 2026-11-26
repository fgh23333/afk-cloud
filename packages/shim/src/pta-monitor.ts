import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildPtaTaskSummaryPayload,
  PtaAdapter,
  PtaAuthError,
  resolvePtaCookieHeader,
} from '../../adapters/pta';
import { syncTasksToEdgeDashboard } from '../../core/d1-bridge';
import { formatUtc8Now } from '../../core/types';

export interface PtaMonitorState {
  lastCheckAt?: string;
  lastCheckMs?: number;
  lastExpiredNotifyMs?: number;
  knownPendingIds: string[];
}

export interface PtaMonitorOutcome {
  ok: boolean;
  configured: boolean;
  sessionExpired?: boolean;
  totalSets: number;
  activeCount: number;
  pendingCount: number;
  newAlertsSent: number;
  msg: string;
  time: string;
}

const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

function getStateFilePath(): string {
  if (process.env.AFK_PTA_MONITOR_STATE_FILE) return process.env.AFK_PTA_MONITOR_STATE_FILE;
  return path.resolve(process.cwd(), '.cache', 'pta-monitor-state.json');
}

function loadState(): PtaMonitorState {
  try {
    const file = getStateFilePath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          lastCheckAt: parsed.lastCheckAt,
          lastCheckMs: Number(parsed.lastCheckMs || 0),
          lastExpiredNotifyMs: Number(parsed.lastExpiredNotifyMs || 0),
          knownPendingIds: Array.isArray(parsed.knownPendingIds) ? parsed.knownPendingIds.map(String) : [],
        };
      }
    }
  } catch {
    // ignore corrupted cache
  }
  return { knownPendingIds: [] };
}

function saveState(state: PtaMonitorState): void {
  if (process.env.NODE_ENV === 'test' && !process.env.AFK_PTA_MONITOR_STATE_FILE) {
    return;
  }
  try {
    const file = getStateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

interface EdgeExistingTaskInfo {
  status?: string;
  deadline?: string;
  resultSummary?: string;
}

async function fetchExistingEdgePtaTasks(): Promise<Map<string, EdgeExistingTaskInfo>> {
  const existing = new Map<string, EdgeExistingTaskInfo>();
  const edgeUrl = (process.env.AFK_EDGE_WORKER_URL || '').replace(/\/+$/, '');
  const bearer = process.env.AFK_EDGE_BEARER_TOKEN || '';
  if (!edgeUrl) return existing;
  try {
    const headers: Record<string, string> = {};
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${edgeUrl}/api/tasks`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return existing;
    const data: any = await res.json();
    for (const t of data?.tasks || []) {
      if (t?.task_id && String(t.platform || '') === 'pta') {
        existing.set(String(t.task_id), {
          status: t.status ? String(t.status) : undefined,
          deadline: t.deadline ? String(t.deadline) : '',
          resultSummary: t.result_summary ? String(t.result_summary) : '',
        });
      }
    }
  } catch {
    // ignore
  }
  return existing;
}

async function notifyEdge(title: string, content: string): Promise<boolean> {
  const edgeUrl = (process.env.AFK_EDGE_WORKER_URL || '').replace(/\/+$/, '');
  const bearer = process.env.AFK_EDGE_BEARER_TOKEN || '';
  if (!edgeUrl || !bearer) return false;
  try {
    const res = await fetch(`${edgeUrl}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ title, content: content.slice(0, 1500) }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let ptaScanInFlight = false;

export async function runPtaMonitorCycle(options: { force?: boolean; cookie?: string } = {}): Promise<PtaMonitorOutcome> {
  if (ptaScanInFlight && !options.force) {
    return {
      ok: true,
      configured: true,
      totalSets: 0,
      activeCount: 0,
      pendingCount: 0,
      newAlertsSent: 0,
      msg: 'PTA 监听巡检正在进行中，跳过并发重入',
      time: formatUtc8Now(),
    };
  }

  ptaScanInFlight = true;
  const nowMs = Date.now();
  const state = loadState();

  try {
    const cookie = await resolvePtaCookieHeader(options.cookie);
    if (!cookie) {
      return {
        ok: true,
        configured: false,
        totalSets: 0,
        activeCount: 0,
        pendingCount: 0,
        newAlertsSent: 0,
        msg: '尚未配置 PTA 登录态，跳过监听本轮',
        time: formatUtc8Now(),
      };
    }

    const edgeExistingTasks = await fetchExistingEdgePtaTasks();
    const pta = new PtaAdapter(cookie);
    const { totalSets, activeSets } = await pta.scanOverviews();

    const syncPayloads = activeSets.map((ov) => buildPtaTaskSummaryPayload(ov));
    const payloadsToSync = syncPayloads.filter((it) => {
      if (options.force) return true;
      const prev = edgeExistingTasks.get(it.taskId);
      if (!prev) return true;
      return (
        prev.status !== it.status ||
        (prev.deadline || '') !== (it.deadline || '') ||
        (prev.resultSummary || '') !== (it.resultSummary || '')
      );
    });
    if (payloadsToSync.length > 0) {
      await syncTasksToEdgeDashboard(
        payloadsToSync.map((it) => ({
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
        })) as any
      ).catch(() => false);
    }

    const knownSet = new Set(state.knownPendingIds);
    let newAlertsSent = 0;
    let pendingCount = 0;

    for (const item of syncPayloads) {
      if (item.isPending) {
        pendingCount++;
        const alreadyKnownLocally = knownSet.has(item.taskId);
        const alreadyKnownEdge = edgeExistingTasks.has(item.taskId);
        if (!alreadyKnownLocally && !alreadyKnownEdge) {
          const ok = await notifyEdge(
            '发现新的 PTA 题目集 💻',
            `题目集：《${item.title}》\n机构/类型：${item.courseName} (${item.classId})\n状态：${item.resultSummary}\n截止：${item.deadline}\n入口：${item.url}`
          );
          if (ok) newAlertsSent++;
        }
        knownSet.add(item.taskId);
      }
    }

    state.lastCheckAt = formatUtc8Now();
    state.lastCheckMs = nowMs;
    state.knownPendingIds = Array.from(knownSet).slice(-100);
    saveState(state);

    const msg = `PTA 监听完成: 活跃题目集 ${activeSets.length} 个, 待完成 ${pendingCount} 个, 新告警 ${newAlertsSent} 个`;
    console.log(`[PTA Monitor] ${msg}`);
    return {
      ok: true,
      configured: true,
      totalSets,
      activeCount: activeSets.length,
      pendingCount,
      newAlertsSent,
      msg,
      time: formatUtc8Now(),
    };
  } catch (err: any) {
    if (err instanceof PtaAuthError) {
      if (!state.lastExpiredNotifyMs || nowMs - state.lastExpiredNotifyMs >= ALERT_COOLDOWN_MS) {
        state.lastExpiredNotifyMs = nowMs;
        saveState(state);
        await notifyEdge(
          '⚠️ PTA (拼题 A) 登录态已过期',
          `Shim 监听检测到 PTA 会话失效 (${err.message})，请更新 Cookie 后执行 \`pnpm afk profile import-cookie --platform pta --cookie "..."\`。`
        );
      }
      return {
        ok: false,
        configured: true,
        sessionExpired: true,
        totalSets: 0,
        activeCount: 0,
        pendingCount: 0,
        newAlertsSent: 0,
        msg: err.message,
        time: formatUtc8Now(),
      };
    }

    console.warn(`[PTA Monitor] 巡检异常: ${err?.message || err}`);
    return {
      ok: false,
      configured: true,
      totalSets: 0,
      activeCount: 0,
      pendingCount: 0,
      newAlertsSent: 0,
      msg: err?.message || String(err),
      time: formatUtc8Now(),
    };
  } finally {
    ptaScanInFlight = false;
  }
}

let ptaMonitorTimer: NodeJS.Timeout | null = null;
let ptaBootTimer: NodeJS.Timeout | null = null;

export function startPtaMonitor(intervalMinutes?: number): void {
  if (process.env.PTA_WATCH_ENABLED === 'false') {
    console.log('[PTA Monitor] PTA_WATCH_ENABLED=false，未启动后台 PTA 监听');
    return;
  }
  if (process.env.NODE_ENV === 'test' && !intervalMinutes) {
    return;
  }
  if (ptaMonitorTimer) return;

  const mins = Math.max(
    1,
    intervalMinutes || parseInt(process.env.PTA_WATCH_INTERVAL_MINUTES || '10', 10) || 10
  );

  console.log(`[PTA Monitor] 🚀 PTA 常驻监听守护已启动（周期 ${mins} 分钟，支持自动同步 D1 与新题提醒）`);

  ptaBootTimer = setTimeout(() => {
    void runPtaMonitorCycle().catch(() => {});
  }, 5000);
  if (ptaBootTimer.unref) ptaBootTimer.unref();

  ptaMonitorTimer = setInterval(() => {
    void runPtaMonitorCycle().catch(() => {});
  }, mins * 60 * 1000);
  if (ptaMonitorTimer.unref) ptaMonitorTimer.unref();
}

export function stopPtaMonitor(): void {
  if (ptaBootTimer) {
    clearTimeout(ptaBootTimer);
    ptaBootTimer = null;
  }
  if (ptaMonitorTimer) {
    clearInterval(ptaMonitorTimer);
    ptaMonitorTimer = null;
  }
}

export function getPtaMonitorCacheDirHint(): string {
  return path.join(os.tmpdir(), 'afk-pta');
}
