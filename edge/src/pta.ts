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
  expiringSoonNotifiedAtMs?: number;
  lastKeepAliveMs?: number;
  lastRolledAt?: string;
  blockedUntilMs?: number;
  blockedNotifiedAtMs?: number;
  totalSets?: number;
  activeCount?: number;
  pendingCount?: number;
  lastError?: string;
}

export interface EdgeCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface PtaSessionStatusSummary {
  configured: boolean;
  hasPtaSession: boolean;
  rememberMeLikely: boolean;
  source?: string;
  updatedAt?: string;
  sessionExpiresAt?: string;
  sessionExpiresAtMs?: number | null;
  remainingHours?: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
  lastCheckedAt?: string;
  lastRolledAt?: string;
  lastError?: string;
  activeCount?: number;
  pendingCount?: number;
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
const PTA_PASSPORT_ORIGIN = 'https://passport.pintia.cn';
const PTA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const EXPIRING_SOON_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function normalizePtaCookieString(raw: string): string {
  let cleaned = String(raw || '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned.replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
}

function splitCombinedSetCookieHeader(rawHeader: string): string[] {
  if (!rawHeader) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < rawHeader.length; i++) {
    if (!inExpires && rawHeader.slice(i, i + 8).toLowerCase() === 'expires=') {
      inExpires = true;
      continue;
    }
    if (inExpires && rawHeader[i] === ';') {
      inExpires = false;
      continue;
    }
    if (!inExpires && rawHeader[i] === ',') {
      const candidate = rawHeader.slice(start, i).trim();
      const rest = rawHeader.slice(i + 1).trim();
      if (candidate && /^[^=;\s]+=/.test(rest)) {
        parts.push(candidate);
        start = i + 1;
      }
    }
  }
  const tail = rawHeader.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

export function parseEdgeSetCookies(res: Response, nowMs = Date.now()): EdgeCookieRecord[] {
  const hdrs: any = res.headers;
  let rawList: string[] = [];
  if (hdrs && typeof hdrs.getSetCookie === 'function') {
    const arr = hdrs.getSetCookie();
    if (Array.isArray(arr) && arr.length > 0) rawList = arr.filter(Boolean);
  }
  if (rawList.length === 0) {
    const single = res.headers.get('set-cookie');
    if (single) rawList = splitCombinedSetCookieHeader(single);
  }

  const out: EdgeCookieRecord[] = [];
  for (const raw of rawList) {
    const segments = String(raw || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) continue;
    const eq = segments[0].indexOf('=');
    if (eq <= 0) continue;
    const name = segments[0].slice(0, eq).trim();
    const value = segments[0].slice(eq + 1).trim();
    if (!name || !value) continue;

    let domain = '.pintia.cn';
    let path = '/';
    let expires: number | undefined;
    let httpOnly = false;
    let secure = false;
    let sameSite: string | undefined;
    let deleted = false;
    let hasMaxAge = false;

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const attrEq = seg.indexOf('=');
      const attrName = (attrEq >= 0 ? seg.slice(0, attrEq) : seg).trim().toLowerCase();
      const attrVal = attrEq >= 0 ? seg.slice(attrEq + 1).trim() : '';

      if (attrName === 'domain' && attrVal) domain = attrVal;
      else if (attrName === 'path' && attrVal) path = attrVal;
      else if (attrName === 'httponly') httpOnly = true;
      else if (attrName === 'secure') secure = true;
      else if (attrName === 'samesite' && attrVal) sameSite = attrVal;
      else if (attrName === 'max-age') {
        const sec = parseInt(attrVal, 10);
        if (Number.isFinite(sec)) {
          hasMaxAge = true;
          if (sec <= 0) deleted = true;
          else expires = Math.floor(nowMs / 1000) + sec;
        }
      } else if (attrName === 'expires' && !hasMaxAge) {
        const expMs = Date.parse(attrVal);
        if (Number.isFinite(expMs)) {
          if (expMs <= nowMs) deleted = true;
          else expires = Math.floor(expMs / 1000);
        }
      }
    }

    if (deleted || !domain.toLowerCase().includes('pintia')) continue;
    out.push({
      name,
      value,
      domain,
      path,
      ...(expires ? { expires } : {}),
      ...(httpOnly ? { httpOnly } : {}),
      ...(secure ? { secure } : {}),
      ...(sameSite ? { sameSite } : {}),
    });
  }
  return out;
}

export function extractPtaCookieHeaderFromSession(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') return normalizePtaCookieString(raw);
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

function cookieStringToRecords(cookieStr: string): EdgeCookieRecord[] {
  const cleaned = normalizePtaCookieString(cookieStr);
  const out: EdgeCookieRecord[] = [];
  for (const pair of cleaned.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({
      name,
      value,
      domain: '.pintia.cn',
      path: '/',
      ...(name === 'PTASession' ? { httpOnly: true, secure: true } : { secure: true }),
    });
  }
  return out;
}

export function mergePtaCookiesIntoSession(
  existing: any,
  incomingCookies: EdgeCookieRecord[],
  meta: { source?: string; rememberMe?: boolean; nowMs?: number; isRolling?: boolean } = {}
): { session: Record<string, any>; changed: boolean; ptaExpiresAtMs: number | null } {
  const nowMs = meta.nowMs ?? Date.now();
  const baseCookies: EdgeCookieRecord[] = Array.isArray(existing?.cookies)
    ? existing.cookies.map((c: any) => ({ ...c }))
    : typeof existing === 'string'
      ? cookieStringToRecords(existing)
      : [];

  const prevPtaVal = baseCookies.find((c) => c.name === 'PTASession')?.value || '';
  let changed = !existing || !Array.isArray(existing?.cookies);

  for (const rawCookie of incomingCookies) {
    if (!rawCookie || !rawCookie.name || !rawCookie.value) continue;
    const domain = rawCookie.domain || '.pintia.cn';
    if (!domain.toLowerCase().includes('pintia')) continue;
    const incoming: EdgeCookieRecord = {
      name: String(rawCookie.name),
      value: String(rawCookie.value),
      domain,
      path: String(rawCookie.path || '/'),
      ...(typeof rawCookie.expires === 'number' && Number.isFinite(rawCookie.expires) && rawCookie.expires > 0
        ? { expires: Math.floor(rawCookie.expires) }
        : {}),
      ...(rawCookie.httpOnly !== undefined ? { httpOnly: Boolean(rawCookie.httpOnly) } : {}),
      ...(rawCookie.secure !== undefined ? { secure: Boolean(rawCookie.secure) } : {}),
      ...(rawCookie.sameSite ? { sameSite: String(rawCookie.sameSite) } : {}),
    };

    const idx = baseCookies.findIndex((c) => c.name === incoming.name && (c.domain || '.pintia.cn') === incoming.domain);
    if (idx < 0) {
      baseCookies.push(incoming);
      changed = true;
    } else {
      const prev = baseCookies[idx];
      const valChanged = prev.value !== incoming.value;
      const expExtended = Boolean(incoming.expires && (!prev.expires || incoming.expires > prev.expires + 60));
      if (valChanged || expExtended) {
        baseCookies[idx] = { ...prev, ...incoming };
        changed = true;
      }
    }
  }

  const nextPtaCookie = baseCookies.find((c) => c.name === 'PTASession' && Boolean(c.value));
  const ptaValChanged = Boolean(nextPtaCookie && nextPtaCookie.value !== prevPtaVal);
  let ptaExpiresAtMs: number | null = null;
  if (nextPtaCookie?.expires && nextPtaCookie.expires > 0) {
    ptaExpiresAtMs = nextPtaCookie.expires * 1000;
  } else if (!ptaValChanged && typeof existing?.sessionExpiresAtMs === 'number' && existing.sessionExpiresAtMs > 0) {
    ptaExpiresAtMs = existing.sessionExpiresAtMs;
  }

  const rememberMeLikely =
    meta.rememberMe !== undefined
      ? Boolean(meta.rememberMe)
      : Boolean(existing?.rememberMe) || Boolean(ptaExpiresAtMs !== null && ptaExpiresAtMs - nowMs > 48 * 3600_000);

  const tsStr = formatUtc8FromMs(nowMs) || nowUtc8();
  const session: Record<string, any> = {
    platform: 'pta',
    updatedAt: tsStr,
    cookies: baseCookies,
    origins: Array.isArray(existing?.origins) ? existing.origins : [],
    source: meta.source || existing?.source || 'manual-import',
    rememberMe: rememberMeLikely,
    ...(ptaExpiresAtMs !== null ? { sessionExpiresAtMs: ptaExpiresAtMs } : {}),
    ...(meta.isRolling ? { lastRolledAt: tsStr } : existing?.lastRolledAt ? { lastRolledAt: existing.lastRolledAt } : {}),
  };

  return { session, changed, ptaExpiresAtMs };
}

export function buildPtaSessionStatus(
  sessionObj: any,
  watchState: PtaWatchState | null,
  nowMs = Date.now()
): PtaSessionStatusSummary {
  const cookieHeader = extractPtaCookieHeaderFromSession(sessionObj);
  const hasPtaSession = Boolean(cookieHeader && hasPtaSessionToken(cookieHeader));
  const cookies: EdgeCookieRecord[] = Array.isArray(sessionObj?.cookies) ? sessionObj.cookies : [];
  const ptaCookie = cookies.find((c) => c && c.name === 'PTASession' && Boolean(c.value));

  let sessionExpiresAtMs: number | null = null;
  if (ptaCookie?.expires && Number.isFinite(ptaCookie.expires) && ptaCookie.expires > 0) {
    sessionExpiresAtMs = ptaCookie.expires * 1000;
  } else if (
    typeof sessionObj?.sessionExpiresAtMs === 'number' &&
    Number.isFinite(sessionObj.sessionExpiresAtMs) &&
    sessionObj.sessionExpiresAtMs > 0
  ) {
    sessionExpiresAtMs = sessionObj.sessionExpiresAtMs;
  }

  const remainingMs = sessionExpiresAtMs !== null ? sessionExpiresAtMs - nowMs : null;
  const remainingHours = remainingMs !== null ? Math.round((remainingMs / 3600_000) * 10) / 10 : null;
  const expiredByTime = Boolean(sessionExpiresAtMs !== null && sessionExpiresAtMs <= nowMs);
  const expiredByRuntime = Boolean(watchState?.lastError && /session expired/i.test(watchState.lastError));
  const isExpired = hasPtaSession ? expiredByTime || expiredByRuntime : false;
  const isExpiringSoon = Boolean(
    hasPtaSession && !isExpired && remainingMs !== null && remainingMs > 0 && remainingMs <= 12 * 3600_000
  );
  const rememberMeLikely =
    Boolean(sessionObj?.rememberMe) || Boolean(remainingMs !== null && remainingMs > 48 * 3600_000);

  return {
    configured: hasPtaSession,
    hasPtaSession,
    rememberMeLikely,
    source: sessionObj?.source ? String(sessionObj.source) : undefined,
    updatedAt: sessionObj?.updatedAt ? String(sessionObj.updatedAt) : undefined,
    sessionExpiresAt: sessionExpiresAtMs ? formatUtc8FromMs(sessionExpiresAtMs) : undefined,
    sessionExpiresAtMs,
    remainingHours,
    isExpired,
    isExpiringSoon,
    lastCheckedAt: watchState?.lastCheckedAt,
    lastRolledAt: watchState?.lastRolledAt || sessionObj?.lastRolledAt,
    lastError: watchState?.lastError,
    activeCount: watchState?.activeCount,
    pendingCount: watchState?.pendingCount,
  };
}

export async function getPtaSessionStatus(
  env: ExtendedNotifyEnv,
  nowMs = Date.now()
): Promise<PtaSessionStatusSummary> {
  const [sessionObj, watchState] = await Promise.all([
    getCachedSession<any>(env, 'web-profile:pta', 'default').catch(() => null),
    getCachedSession<PtaWatchState>(env, 'pta_watch_state', 'default').catch(() => null),
  ]);
  return buildPtaSessionStatus(sessionObj, watchState, nowMs);
}

async function ptaEdgeFetchJson<T = any>(
  url: string,
  cookie: string,
  psId?: string
): Promise<{ ok: boolean; status: number; bodyText: string; data?: T; setCookies: EdgeCookieRecord[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json;charset=UTF-8',
        Referer: psId ? `${PTA_ORIGIN}/problem-sets/${psId}/exam/problems` : `${PTA_ORIGIN}/problem-sets`,
        Origin: PTA_ORIGIN,
        'User-Agent': PTA_UA,
      },
      signal: controller.signal,
    });
    const setCookies = res.ok ? parseEdgeSetCookies(res) : [];
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, status: res.status, bodyText, setCookies };
    }
    if (/^\s*<!doctype\s+html/i.test(bodyText)) {
      return { ok: false, status: 403, bodyText: 'HTML challenge returned', setCookies: [] };
    }
    try {
      return { ok: true, status: res.status, bodyText, data: JSON.parse(bodyText) as T, setCookies };
    } catch {
      return { ok: false, status: res.status, bodyText, setCookies };
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function saveAndVerifyPtaSession(
  env: ExtendedNotifyEnv,
  payload: {
    cookie?: string;
    cookies?: EdgeCookieRecord[];
    source?: string;
    rememberMe?: boolean;
    verify?: boolean;
    triggerScan?: boolean;
    nowMs?: number;
  }
): Promise<{
  ok: boolean;
  statusCode: number;
  saved?: boolean;
  verified?: 'live' | 'deferred-to-shim' | 'skipped';
  error?: string;
  sessionStatus?: PtaSessionStatusSummary;
  scanResult?: PtaEdgeInspectionSummary;
}> {
  const nowMs = payload.nowMs ?? Date.now();
  let incomingCookies: EdgeCookieRecord[] = [];
  if (Array.isArray(payload.cookies) && payload.cookies.length > 0) {
    incomingCookies = payload.cookies
      .filter((c) => c && c.name && c.value && (!c.domain || String(c.domain).toLowerCase().includes('pintia')))
      .map((c) => ({
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain || '.pintia.cn'),
        path: String(c.path || '/'),
        ...(typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0 ? { expires: Math.floor(c.expires) } : {}),
        ...(c.httpOnly !== undefined ? { httpOnly: Boolean(c.httpOnly) } : {}),
        ...(c.secure !== undefined ? { secure: Boolean(c.secure) } : {}),
        ...(c.sameSite ? { sameSite: String(c.sameSite) } : {}),
      }));
  } else if (typeof payload.cookie === 'string' && payload.cookie.trim()) {
    incomingCookies = cookieStringToRecords(payload.cookie);
  }

  const candidateHeader = extractPtaCookieHeaderFromSession({ cookies: incomingCookies });
  if (!candidateHeader || !hasPtaSessionToken(candidateHeader)) {
    return {
      ok: false,
      statusCode: 400,
      error:
        '缺少 HttpOnly 会话凭证 PTASession，已拒绝覆盖现有会话（请使用伴侣扩展、pnpm afk pta login 或从 DevTools 请求头复制完整 Cookie）。',
    };
  }

  let verified: 'live' | 'deferred-to-shim' | 'skipped' = 'skipped';
  if (payload.verify !== false) {
    for (const probeUrl of [
      `${PTA_PASSPORT_ORIGIN}/api/u/current`,
      `${PTA_ORIGIN}/api/problem-sets?filter=%7B%7D&page=0&limit=1`,
    ]) {
      const probe = await ptaEdgeFetchJson(probeUrl, candidateHeader).catch(() => null);
      if (!probe) continue;
      if (probe.ok) {
        verified = 'live';
        if (probe.setCookies.length > 0) {
          incomingCookies = [...incomingCookies, ...probe.setCookies];
        }
        break;
      }
      const isAuthFail =
        probe.status === 401 ||
        ((probe.status === 403 || probe.status === 404) &&
          /USER_NOT_LOGGED_IN|USER_NOT_FOUND|INVALID_SESSION/i.test(probe.bodyText));
      if (isAuthFail) {
        return {
          ok: false,
          statusCode: 400,
          error: `PTASession 验证无效或已过期 (HTTP ${probe.status})，未覆盖现有会话，请重新登录后同步。`,
        };
      }
      verified = 'deferred-to-shim';
    }
  }

  const existingSession = await getCachedSession<any>(env, 'web-profile:pta', 'default').catch(() => null);
  const { session: mergedSession, ptaExpiresAtMs } = mergePtaCookiesIntoSession(existingSession, incomingCookies, {
    source: payload.source || 'web-dashboard',
    rememberMe: payload.rememberMe,
    nowMs,
  });

  const remainingSec = ptaExpiresAtMs ? Math.floor((ptaExpiresAtMs - nowMs) / 1000) : 0;
  const ttlSeconds = Math.max(30 * 24 * 3600, remainingSec > 0 ? remainingSec + 3600 : 0);
  await saveCachedSession(env, 'web-profile:pta', 'default', mergedSession, ttlSeconds);

  const prevWatch = (await getCachedSession<PtaWatchState>(env, 'pta_watch_state', 'default').catch(() => null)) || {};
  const nextWatch: PtaWatchState = {
    ...prevWatch,
    expiredNotifiedAtMs: 0,
    expiringSoonNotifiedAtMs: 0,
    blockedUntilMs: 0,
    lastError: undefined,
  };
  await saveCachedSession(env, 'pta_watch_state', 'default', nextWatch, 30 * 24 * 3600).catch(() => {});

  const expText = ptaExpiresAtMs ? `, 预计有效期至 ${formatUtc8FromMs(ptaExpiresAtMs) || '未知'}` : '';
  await logExecution(
    env,
    'pta_session_updated',
    'pta',
    `已更新 PTA 会话 (来源: ${mergedSession.source}, Cookies: ${incomingCookies.length}, 校验: ${verified}${expText})`
  ).catch(() => {});

  let scanResult: PtaEdgeInspectionSummary | undefined;
  if (payload.triggerScan !== false) {
    scanResult = await runPtaInspectionCycle(env, { force: true, nowMs }).catch(() => undefined);
  }

  const latestStatus = await getPtaSessionStatus(env, nowMs);
  return {
    ok: true,
    statusCode: 200,
    saved: true,
    verified,
    sessionStatus: latestStatus,
    ...(scanResult ? { scanResult } : {}),
  };
}

async function delegatePtaScanToShim(env: ExtendedNotifyEnv): Promise<{ ok: boolean; summary?: string } | null> {
  const shimUrl = env.AFK_SHIM_URL || env.SHIM_URL;
  const shimSecret = env.AFK_SHIM_SECRET;
  if (!shimUrl || !shimSecret) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
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
      signal: controller.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    return { ok: res.ok && Boolean(data?.ok), summary: data?.msg || `HTTP ${res.status}` };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

  let listRes: { ok: boolean; status: number; bodyText: string; data?: any; setCookies: EdgeCookieRecord[] };
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
        await logExecution(env, 'session_expired', 'pta', `PTA 登录态失效 (HTTP ${listRes.status})，等待通过扩展/CLI/看板更新`).catch(() => {});
        await sendNotification(
          '⚠️ PTA (拼题 A) 登录态已过期',
          '监听巡检检测到 PTA 会话已失效。可选任一方式秒级恢复（仅需本人过一次验证码）：1) 在已装伴侣扩展的浏览器打开 pintia.cn 登录（自动同步） 2) 运行 `pnpm afk pta login` 3) 打开 Web 看板「设置 -> PTA 会话管理」一键同步。',
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

  const rolledCookies: EdgeCookieRecord[] = [...(listRes.setCookies || [])];
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
    if (exRes.setCookies?.length) rolledCookies.push(...exRes.setCookies);

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
      if (stRes?.setCookies?.length) rolledCookies.push(...stRes.setCookies);
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

  let lastKeepAliveMs = prevState.lastKeepAliveMs || 0;
  if (!lastKeepAliveMs || nowMs - lastKeepAliveMs >= KEEPALIVE_INTERVAL_MS) {
    const kaRes = await ptaEdgeFetchJson(`${PTA_PASSPORT_ORIGIN}/api/u/current`, cookieHeader).catch(() => null);
    if (kaRes?.setCookies?.length) rolledCookies.push(...kaRes.setCookies);
    lastKeepAliveMs = nowMs;
  }

  let effectiveSessionObj = sessionObj;
  let lastRolledAt = prevState.lastRolledAt;
  if (rolledCookies.length > 0) {
    const merged = mergePtaCookiesIntoSession(sessionObj, rolledCookies, { nowMs, isRolling: true });
    if (merged.changed) {
      effectiveSessionObj = merged.session;
      lastRolledAt = merged.session.lastRolledAt;
      const remSec = merged.ptaExpiresAtMs ? Math.floor((merged.ptaExpiresAtMs - nowMs) / 1000) : 0;
      const ttlSeconds = Math.max(30 * 24 * 3600, remSec > 0 ? remSec + 3600 : 0);
      await saveCachedSession(env, 'web-profile:pta', 'default', merged.session, ttlSeconds).catch(() => {});
    }
  }

  let expiringSoonNotifiedAtMs = prevState.expiringSoonNotifiedAtMs || 0;
  const sessionStatus = buildPtaSessionStatus(effectiveSessionObj, { ...prevState, lastError: undefined }, nowMs);
  if (
    sessionStatus.isExpiringSoon &&
    (!expiringSoonNotifiedAtMs || nowMs - expiringSoonNotifiedAtMs >= EXPIRING_SOON_COOLDOWN_MS)
  ) {
    expiringSoonNotifiedAtMs = nowMs;
    await sendNotification(
      '⏳ PTA (拼题 A) 登录态即将过期',
      `当前 PTASession 预计剩余 ${sessionStatus.remainingHours ?? '<12'} 小时过期。为保持 7×24 巡检不断档，请在已装伴侣扩展的浏览器访问 pintia.cn（自动同步），或在本地运行 \`pnpm afk pta login\`（只需滑一下验证码）。`,
      env
    );
  }

  const nextState: PtaWatchState = {
    lastCheckedAt: nowUtc8(),
    lastCheckMs: nowMs,
    expiredNotifiedAtMs: 0,
    expiringSoonNotifiedAtMs,
    lastKeepAliveMs,
    ...(lastRolledAt ? { lastRolledAt } : {}),
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
