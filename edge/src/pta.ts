import { ExtendedNotifyEnv, sendNotification } from './notify';
import { signRequest } from './request-signing';
import {
  formatUtc8FromMs,
  getCachedSession,
  logExecution,
  nowUtc8,
  saveCachedSession,
  upsertPendingTaskWithOutcome,
} from './store';

export interface PtaWatchState {
  lastCheckedAt?: string;
  lastCheckMs?: number;
  expiredNotifiedAtMs?: number;
  blockedUntilMs?: number;
  blockedNotifiedAtMs?: number;
  totalSets?: number;
  activeCount?: number;
  pendingCount?: number;
  lastError?: string;
}

export interface PtaEdgeInspectionSummary {
  success: boolean;
  configured: boolean;
  delegatedToShim?: boolean;
  sessionExpired?: boolean;
  blocked?: boolean;
  totalSets: number;
  activeCount: number;
  pendingCount: number;
  newTasksNotified: number;
  msg: string;
  time: string;
}

const PTA_ORIGIN = 'https://pintia.cn';
const PTA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function extractPtaCookieHeaderFromSession(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object' && Array.isArray((raw as any).cookies)) {
    const cookies = (raw as any).cookies as Array<{ name?: string; value?: string; domain?: string }>;
    return cookies
      .filter((c) => c && c.name && (!c.domain || String(c.domain).toLowerCase().includes('pintia')))
      .map((c) => `${c.name}=${c.value || ''}`)
      .join('; ');
  }
  return '';
}

function hasPtaSessionToken(cookieHeader: string): boolean {
  return /(?:^|;\s*)PTASession=[^;\s]+/.test(cookieHeader);
}

async function ptaEdgeFetchJson<T = any>(url: string, cookie: string, psId?: string): Promise<{ ok: boolean; status: number; bodyText: string; data?: T }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      Accept: 'application/json;charset=UTF-8',
      Referer: psId ? `${PTA_ORIGIN}/problem-sets/${psId}/exam/problems` : `${PTA_ORIGIN}/problem-sets`,
      Origin: PTA_ORIGIN,
      'User-Agent': PTA_UA,
    },
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, status: res.status, bodyText };
  }
  if (/^\s*<!doctype\s+html/i.test(bodyText)) {
    return { ok: false, status: 403, bodyText: 'HTML challenge returned' };
  }
  try {
    return { ok: true, status: res.status, bodyText, data: JSON.parse(bodyText) as T };
  } catch {
    return { ok: false, status: res.status, bodyText };
  }
}

async function delegatePtaScanToShim(env: ExtendedNotifyEnv): Promise<{ ok: boolean; summary?: string } | null> {
  const shimUrl = env.AFK_SHIM_URL || env.SHIM_URL;
  const shimSecret = env.AFK_SHIM_SECRET;
  if (!shimUrl || !shimSecret) return null;

  try {
    const endpoint = new URL('/pta/inspect', shimUrl.replace(/\/+$/, '') + '/');
    const body = JSON.stringify({ source: 'edge-fallback' });
    const sigHeaders = await signRequest({
      secret: shimSecret,
      method: 'POST',
      pathWithQuery: endpoint.pathname + endpoint.search,
      body,
    });
    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sigHeaders },
      body,
    });
    const data: any = await res.json().catch(() => ({}));
    return { ok: res.ok && Boolean(data?.ok), summary: data?.msg || `HTTP ${res.status}` };
  } catch {
    return null;
  }
}

/**
 * Cloudflare Edge PTA 定时巡检与监听链路：
 * 1. 从 D1 `sessions` (web-profile:pta) 读取已持久化的 PTA Cookie；
 * 2. 拉取未过期活跃题目集及各题目状态；若 Edge IP 受限自动降级通知 Shim 代扫；
 * 3. 新发现的待完成题目集写入 pending_tasks 并推送实时提醒；已完成集同步为 submitted 防重复推送；
 * 4. 登录态失效时按 12 小时冷却推送过期提醒，绝不刷屏。
 */
export async function runPtaInspectionCycle(
  env: ExtendedNotifyEnv,
  options: { nowMs?: number; force?: boolean } = {}
): Promise<PtaEdgeInspectionSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const base: PtaEdgeInspectionSummary = {
    success: false,
    configured: false,
    totalSets: 0,
    activeCount: 0,
    pendingCount: 0,
    newTasksNotified: 0,
    msg: '',
    time: nowUtc8(),
  };

  const sessionObj = await getCachedSession<any>(env, 'web-profile:pta', 'default');
  const cookieHeader = extractPtaCookieHeaderFromSession(sessionObj);
  if (!cookieHeader || !hasPtaSessionToken(cookieHeader)) {
    return {
      ...base,
      success: true,
      configured: false,
      msg: '未检测到有效 PTA 会话 (web-profile:pta)，跳过 PTA 巡检',
    };
  }

  const prevState = (await getCachedSession<PtaWatchState>(env, 'pta_watch_state', 'default')) || {};
  if (!options.force && prevState.blockedUntilMs && prevState.blockedUntilMs > nowMs) {
    const delegated = await delegatePtaScanToShim(env);
    if (delegated?.ok) {
      return {
        ...base,
        success: true,
        configured: true,
        delegatedToShim: true,
        msg: `PTA Edge 处于冷却期，已委托本机 Shim 代扫: ${delegated.summary}`,
      };
    }
    return {
      ...base,
      success: true,
      configured: true,
      blocked: true,
      msg: 'PTA Edge 处于风控冷却期，等待本机 Shim 同步',
    };
  }

  let listRes: { ok: boolean; status: number; bodyText: string; data?: any };
  try {
    listRes = await ptaEdgeFetchJson<{ total?: number; problemSets?: any[] }>(
      `${PTA_ORIGIN}/api/problem-sets?filter=%7B%7D&page=0&limit=50`,
      cookieHeader
    );
  } catch (err: any) {
    const delegated = await delegatePtaScanToShim(env);
    if (delegated?.ok) {
      return {
        ...base,
        success: true,
        configured: true,
        delegatedToShim: true,
        msg: `Edge 直连 PTA 异常，已委托 Shim 完成巡检: ${delegated.summary}`,
      };
    }
    return {
      ...base,
      configured: true,
      msg: `PTA 请求异常: ${err?.message || err}`,
    };
  }

  if (!listRes.ok) {
    const isAuthFail =
      listRes.status === 401 ||
      ((listRes.status === 403 || listRes.status === 404) &&
        /USER_NOT_LOGGED_IN|USER_NOT_FOUND|INVALID_SESSION/i.test(listRes.bodyText));

    if (isAuthFail) {
      const shouldNotify =
        !prevState.expiredNotifiedAtMs || nowMs - prevState.expiredNotifiedAtMs >= ALERT_COOLDOWN_MS;
      const nextState: PtaWatchState = {
        ...prevState,
        lastCheckedAt: nowUtc8(),
        lastCheckMs: nowMs,
        expiredNotifiedAtMs: shouldNotify ? nowMs : prevState.expiredNotifiedAtMs,
        lastError: `HTTP ${listRes.status} session expired`,
      };
      await saveCachedSession(env, 'pta_watch_state', 'default', nextState, 30 * 24 * 3600).catch(() => {});

      if (shouldNotify) {
        await logExecution(env, 'session_expired', 'pta', `PTA 登录态失效 (HTTP ${listRes.status})，请重新导入 Cookie`).catch(() => {});
        await sendNotification(
          '⚠️ PTA (拼题 A) 登录态已过期',
          '监听巡检检测到 PTA Cookie 已失效，请重新登录后执行 `pnpm afk profile import-cookie --platform pta --cookie "..."` 更新会话（为遵守安全规范不会自动破解登录验证码）。',
          env
        );
      }
      return {
        ...base,
        configured: true,
        sessionExpired: true,
        msg: 'PTA 登录态已过期，等待更新 Cookie',
      };
    }

    // 疑似 Cloudflare/WAF 拦截：降级委托本机 Shim
    const delegated = await delegatePtaScanToShim(env);
    const nextState: PtaWatchState = {
      ...prevState,
      lastCheckedAt: nowUtc8(),
      lastCheckMs: nowMs,
      blockedUntilMs: nowMs + 15 * 60 * 1000,
      lastError: `HTTP ${listRes.status}`,
    };
    await saveCachedSession(env, 'pta_watch_state', 'default', nextState, 30 * 24 * 3600).catch(() => {});

    if (delegated?.ok) {
      return {
        ...base,
        success: true,
        configured: true,
        delegatedToShim: true,
        msg: `Edge 访问 PTA 受限 (HTTP ${listRes.status})，已委托 Shim 完成巡检`,
      };
    }

    return {
      ...base,
      configured: true,
      blocked: true,
      msg: `PTA 接口返回 HTTP ${listRes.status}`,
    };
  }

  const totalSets = Number(listRes.data?.total || 0);
  const allSets = Array.isArray(listRes.data?.problemSets) ? listRes.data.problemSets : [];
  const activeCandidates = allSets.filter((ps: any) => {
    const endMs = ps.endAt ? Date.parse(ps.endAt) : NaN;
    const isExpired =
      String(ps.status || '').toUpperCase() === 'EXPIRED' || (Number.isFinite(endMs) && endMs <= nowMs);
    return !isExpired;
  });

  let pendingCount = 0;
  let newTasksNotified = 0;
  const maxInspect = Math.min(activeCandidates.length, 15);

  for (let i = 0; i < maxInspect; i++) {
    const ps = activeCandidates[i];
    const exRes = await ptaEdgeFetchJson<{ exam?: any; problemSet?: any }>(
      `${PTA_ORIGIN}/api/problem-sets/${ps.id}/exams`,
      cookieHeader,
      ps.id
    ).catch(() => null);
    if (!exRes || !exRes.ok) continue;

    const exam = exRes.data?.exam || null;
    let totalProblems = 0;
    let totalScore = 0;
    let acceptedCount = 0;
    let noAnswerCount = 0;

    if (exam?.id) {
      const stRes = await ptaEdgeFetchJson<{ problemStatus?: any[] }>(
        `${PTA_ORIGIN}/api/problem-sets/${ps.id}/exam-problem-status?exam_id=${encodeURIComponent(exam.id)}`,
        cookieHeader,
        ps.id
      ).catch(() => null);
      if (stRes?.ok && Array.isArray(stRes.data?.problemStatus)) {
        const list = stRes.data.problemStatus;
        totalProblems = list.length;
        for (const item of list) {
          totalScore += Number(item.score || 0);
          if (item.problemSubmissionStatus === 'PROBLEM_ACCEPTED') acceptedCount++;
          else if (item.problemSubmissionStatus === 'PROBLEM_NO_ANSWER') noAnswerCount++;
        }
      }
    }

    const effectiveEndAt = exam?.endAt || ps.endAt;
    const deadlineMs = effectiveEndAt ? Date.parse(effectiveEndAt) : NaN;
    const deadlineUtc8 = Number.isFinite(deadlineMs) ? formatUtc8FromMs(deadlineMs) || '' : '';
    const isEnded = Boolean(exam?.ended) || String(exam?.status || '').toUpperCase() === 'END';
    const isCompleted = isEnded || (Boolean(exam) && totalProblems > 0 && noAnswerCount === 0);
    if (!isCompleted) pendingCount++;

    const status = isCompleted ? 'submitted' : 'pending';
    const resultSummary = isCompleted
      ? `已完成全部 ${totalProblems} 题（即时得分 ${exam?.score ?? acceptedCount}/${totalScore}${isEnded ? ' · 已交卷' : ' · 客观题待统一评测'}）`
      : exam
        ? `已完成 ${Math.max(0, totalProblems - noAnswerCount)}/${totalProblems} 题（待做 ${noAnswerCount} 题）`
        : '新发现 PTA 题目集，尚未开始作答';

    const outcome = await upsertPendingTaskWithOutcome(env, {
      taskId: `pta-ps-${ps.id}`,
      platform: 'pta',
      courseId: String(ps.organizationId || 'pta'),
      classId: String(ps.type || 'EXERCISE'),
      courseName: String(ps.organizationName || 'PTA 拼题 A'),
      title: String(ps.name || `PTA_${ps.id}`),
      status,
      computeTier: 'tier1-cloud-run',
      deadline: deadlineUtc8,
      payload: {
        url: `${PTA_ORIGIN}/problem-sets/${ps.id}/exam`,
        workId: ps.id,
        problemSetId: ps.id,
        examId: exam?.id || '',
        totalProblems,
        noAnswerCount,
      },
    });

    if (outcome.created && !isCompleted) {
      await logExecution(
        env,
        'homework_detected',
        'pta',
        `发现新 PTA 题目集：《${ps.name}》(${ps.organizationName || 'PTA'}, 截止: ${deadlineUtc8 || '无'})`
      );
      await sendNotification(
        '发现新的 PTA 题目集 💻',
        `题目集：《${ps.name}》\n机构/类型：${ps.organizationName || 'PTA 拼题 A'} (${ps.type || 'EXERCISE'})\n状态：${resultSummary}\n截止：${deadlineUtc8 || '请登录查看'}\n入口：${PTA_ORIGIN}/problem-sets/${ps.id}/exam`,
        env
      );
      newTasksNotified++;
    }
  }

  const nextState: PtaWatchState = {
    lastCheckedAt: nowUtc8(),
    lastCheckMs: nowMs,
    expiredNotifiedAtMs: 0,
    blockedUntilMs: 0,
    totalSets,
    activeCount: activeCandidates.length,
    pendingCount,
    lastError: undefined,
  };
  await saveCachedSession(env, 'pta_watch_state', 'default', nextState, 30 * 24 * 3600).catch(() => {});

  return {
    success: true,
    configured: true,
    totalSets,
    activeCount: activeCandidates.length,
    pendingCount,
    newTasksNotified,
    msg: `PTA 巡检完成: 活跃题目集 ${activeCandidates.length} 个, 待完成 ${pendingCount} 个, 新告警 ${newTasksNotified} 个`,
    time: nowUtc8(),
  };
}
