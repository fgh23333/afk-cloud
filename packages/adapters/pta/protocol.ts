import {
  BrowserCookie,
  PortableStorageState,
  pullBrowserProfileFromCloud,
  pushBrowserProfileToCloud,
  readLocalStorageState,
  writeLocalStorageState,
} from '../../core/browser-profile';
import { formatUtc8Now, QuestionOption, StandardQuestion } from '../../core/types';

export const PTA_ORIGIN = 'https://pintia.cn';
export const PTA_PASSPORT_ORIGIN = 'https://passport.pintia.cn';
export const PTA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const PTA_CLUSTERED_TYPES = new Set([
  'TRUE_OR_FALSE',
  'MULTIPLE_CHOICE',
  'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER',
  'FILL_IN_THE_BLANK',
  'FILL_IN_THE_BLANK_FOR_PROGRAMMING',
  'CHOICE_BLANK',
]);

export interface PtaBlankMeta {
  index: number;
  length: number;
  multipleLine?: boolean;
}

export interface PtaProblemSetSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  stage?: string;
  feature?: string;
  startAt?: string;
  endAt?: string;
  organizationId?: string;
  organizationName?: string;
  ownerNickname?: string;
  compilers?: string[];
  judgeTiming?: string;
}

export interface PtaExamRecord {
  id: string;
  score: number;
  startAt?: string;
  endAt?: string;
  acceptCount?: number;
  ended: boolean;
  status: string;
  studentUser?: { studentNumber?: string; name?: string; id?: string };
}

export interface PtaProblemStatusItem {
  id: string;
  label: string;
  score: number;
  problemSubmissionStatus: string;
  problemType: string;
  problemPoolIndex?: number;
  indexInProblemPool?: number;
}

export interface PtaRawProblem {
  id: string;
  label: string;
  score: number;
  type: string;
  title?: string;
  content?: string;
  description?: string;
  compiler?: string;
  lastSubmissionId?: string;
  problemStatus?: string;
  problemSetId?: string;
  problemPoolIndex?: number;
  indexInProblemPool?: number;
  problemConfig?: Record<string, any>;
}

export interface PtaProblemMeta {
  problemSetProblemId: string;
  label: string;
  problemType: string;
  maxScore: number;
  choices?: string[];
  blanks?: PtaBlankMeta[];
  codeTemplate?: string;
  compiler?: string;
  submissionStatus?: string;
}

export interface PtaSubmissionSummary {
  id: string;
  userId?: string;
  problemType: string;
  problemSetProblemId: string;
  submitAt?: string;
  status: string;
  score: number;
  compiler?: string;
  submissionDetails?: Array<Record<string, any>>;
  judgeResponseContents?: Array<Record<string, any>>;
}

export interface PtaProblemSetOverview {
  problemSet: PtaProblemSetSummary;
  exam: PtaExamRecord | null;
  compilers: string[];
  judgeTiming: string;
  shuffledAnswers: boolean;
  totalProblems: number;
  totalScore: number;
  acceptedCount: number;
  submittedCount: number;
  noAnswerCount: number;
  isExpired: boolean;
  isEnded: boolean;
  isCompleted: boolean;
  isPending: boolean;
  url: string;
  deadlineUtc8: string;
}

export class PtaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtaAuthError';
  }
}

export class PtaBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtaBlockedError';
  }
}

export function formatIsoToUtc8(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)';
}

export function buildCookieHeaderFromCookies(
  cookies: Array<{ name: string; value: string; domain?: string }>
): string {
  return cookies
    .filter((c) => c && c.name && (!c.domain || c.domain.toLowerCase().includes('pintia')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export function hasPtaAuthCookie(cookieHeaderOrCookies: string | Array<{ name: string; value: string }>): boolean {
  if (Array.isArray(cookieHeaderOrCookies)) {
    return cookieHeaderOrCookies.some((c) => c.name === 'PTASession' && Boolean(String(c.value || '').trim()));
  }
  return /(?:^|;\s*)PTASession=[^;\s]+/.test(String(cookieHeaderOrCookies || ''));
}

export function normalizePtaCookieInput(raw: string): string {
  let cleaned = String(raw || '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
  return cleaned;
}

export function extractPtaSessionValue(cookieHeaderOrCookies: string | Array<{ name: string; value: string }>): string {
  if (Array.isArray(cookieHeaderOrCookies)) {
    const found = cookieHeaderOrCookies.find((c) => c.name === 'PTASession' && Boolean(String(c.value || '').trim()));
    return found ? String(found.value).trim() : '';
  }
  const m = String(cookieHeaderOrCookies || '').match(/(?:^|;\s*)PTASession=([^;\s]+)/);
  return m ? m[1] : '';
}

function parseFlexibleTimestampMs(ts?: string | null): number {
  if (!ts) return NaN;
  const cleaned = String(ts).replace(/\s*\(UTC\+8\)\s*$/i, '').trim();
  const match = cleaned.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    return Date.parse(
      `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}+08:00`
    );
  }
  return Date.parse(cleaned);
}

export function splitCombinedSetCookieHeader(rawHeader: string): string[] {
  if (!rawHeader) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < rawHeader.length; i++) {
    const ch = rawHeader[i];
    if (!inExpires && rawHeader.slice(i, i + 8).toLowerCase() === 'expires=') {
      inExpires = true;
      continue;
    }
    if (inExpires && ch === ';') {
      inExpires = false;
      continue;
    }
    if (!inExpires && ch === ',') {
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

export function extractResponseSetCookies(res: Response): string[] {
  const hdrs: any = res.headers;
  if (hdrs && typeof hdrs.getSetCookie === 'function') {
    const arr = hdrs.getSetCookie();
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.filter(Boolean);
    }
  }
  const single = res.headers.get('set-cookie');
  return single ? splitCombinedSetCookieHeader(single) : [];
}

export function parseSetCookieHeaders(setCookies: string[], nowMs = Date.now()): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const raw of setCookies) {
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
    let sameSite: 'Strict' | 'Lax' | 'None' | undefined;
    let deleted = false;
    let hasMaxAge = false;

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const attrEq = seg.indexOf('=');
      const attrName = (attrEq >= 0 ? seg.slice(0, attrEq) : seg).trim().toLowerCase();
      const attrVal = attrEq >= 0 ? seg.slice(attrEq + 1).trim() : '';

      if (attrName === 'domain' && attrVal) {
        domain = attrVal;
      } else if (attrName === 'path' && attrVal) {
        path = attrVal;
      } else if (attrName === 'httponly') {
        httpOnly = true;
      } else if (attrName === 'secure') {
        secure = true;
      } else if (attrName === 'samesite') {
        const lower = attrVal.toLowerCase();
        if (lower === 'strict') sameSite = 'Strict';
        else if (lower === 'lax') sameSite = 'Lax';
        else if (lower === 'none') sameSite = 'None';
      } else if (attrName === 'max-age') {
        const maxAgeSec = parseInt(attrVal, 10);
        if (Number.isFinite(maxAgeSec)) {
          hasMaxAge = true;
          if (maxAgeSec <= 0) {
            deleted = true;
          } else {
            expires = Math.floor(nowMs / 1000) + maxAgeSec;
          }
        }
      } else if (attrName === 'expires' && !hasMaxAge) {
        const expMs = Date.parse(attrVal);
        if (Number.isFinite(expMs)) {
          if (expMs <= nowMs) {
            deleted = true;
          } else {
            expires = Math.floor(expMs / 1000);
          }
        }
      }
    }

    if (deleted) continue;
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

export interface PtaSessionMeta {
  hasPtaSession: boolean;
  expiresAtMs: number | null;
  remainingHours: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
  rememberMeLikely: boolean;
}

export function extractPtaSessionMeta(state: PortableStorageState | null, nowMs = Date.now()): PtaSessionMeta {
  const cookies = Array.isArray(state?.cookies) ? state!.cookies : [];
  const ptaCookie = cookies.find((c) => c.name === 'PTASession' && Boolean(String(c.value || '').trim()));
  const hasPtaSession = Boolean(ptaCookie);

  let expiresAtMs: number | null = null;
  if (ptaCookie?.expires && Number.isFinite(ptaCookie.expires) && ptaCookie.expires > 0) {
    expiresAtMs = ptaCookie.expires * 1000;
  } else if (typeof state?.sessionExpiresAtMs === 'number' && Number.isFinite(state.sessionExpiresAtMs) && state.sessionExpiresAtMs > 0) {
    expiresAtMs = state.sessionExpiresAtMs;
  }

  const remainingMs = expiresAtMs !== null ? expiresAtMs - nowMs : null;
  const remainingHours = remainingMs !== null ? Math.round((remainingMs / 3600_000) * 10) / 10 : null;
  const isExpired = Boolean(expiresAtMs !== null && expiresAtMs <= nowMs);
  const isExpiringSoon = Boolean(remainingMs !== null && remainingMs > 0 && remainingMs <= 12 * 3600_000);
  const rememberMeLikely =
    Boolean(state?.rememberMe) || Boolean(remainingMs !== null && remainingMs > 48 * 3600_000);

  return {
    hasPtaSession,
    expiresAtMs,
    remainingHours,
    isExpired,
    isExpiringSoon,
    rememberMeLikely,
  };
}

let lastRollingCloudSyncMs = 0;
let lastRollingSyncedPtaVal = '';

export async function persistRolledPtaCookies(
  cookies: BrowserCookie[],
  options: { nowMs?: number; skipCloudSync?: boolean } = {}
): Promise<boolean> {
  const ptaCookies = cookies.filter(
    (c) => c && c.name && c.value && (!c.domain || c.domain.toLowerCase().includes('pintia'))
  );
  if (ptaCookies.length === 0) return false;

  if (process.env.NODE_ENV === 'test' && !process.env.AFK_BROWSER_PROFILES_DIR) {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  const existing = readLocalStorageState('pta');
  const prevCookies: BrowserCookie[] = Array.isArray(existing?.cookies) ? [...existing!.cookies] : [];
  let changed = false;

  for (const incoming of ptaCookies) {
    const idx = prevCookies.findIndex(
      (c) => c.name === incoming.name && (c.domain || '.pintia.cn') === (incoming.domain || '.pintia.cn')
    );
    if (idx < 0) {
      prevCookies.push(incoming);
      changed = true;
    } else {
      const prev = prevCookies[idx];
      const valueChanged = prev.value !== incoming.value;
      const expiryExtended = Boolean(incoming.expires && (!prev.expires || incoming.expires > prev.expires + 60));
      if (valueChanged || expiryExtended) {
        prevCookies[idx] = { ...prev, ...incoming };
        changed = true;
      }
    }
  }

  if (!changed || !hasPtaAuthCookie(prevCookies)) {
    return false;
  }

  const meta = extractPtaSessionMeta(
    { platform: 'pta', updatedAt: '', cookies: prevCookies, origins: existing?.origins || [], rememberMe: existing?.rememberMe },
    nowMs
  );
  writeLocalStorageState('pta', {
    cookies: prevCookies,
    origins: existing?.origins || [],
    source: existing?.source || 'rolling-refresh',
    rememberMe: meta.rememberMeLikely,
    sessionExpiresAtMs: meta.expiresAtMs ?? existing?.sessionExpiresAtMs ?? null,
    lastRolledAt: formatUtc8Now(),
  });

  const nextPtaVal = extractPtaSessionValue(prevCookies);
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  const shouldSyncCloud =
    !options.skipCloudSync &&
    Boolean(edgeUrl) &&
    (nextPtaVal !== lastRollingSyncedPtaVal || nowMs - lastRollingCloudSyncMs >= 15 * 60 * 1000);

  if (shouldSyncCloud && edgeUrl) {
    lastRollingCloudSyncMs = nowMs;
    lastRollingSyncedPtaVal = nextPtaVal;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;
      const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/pta/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cookies: prevCookies,
          source: 'rolling-refresh',
          rememberMe: meta.rememberMeLikely,
          verify: false,
          triggerScan: false,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) {
        await pushBrowserProfileToCloud('pta').catch(() => {});
      }
    } catch {
      await pushBrowserProfileToCloud('pta').catch(() => {});
    }
  }

  return true;
}

export async function resolvePtaCookieHeader(
  explicitCookie?: string,
  options: { preferCloud?: boolean; ignoreEnv?: boolean } = {}
): Promise<string> {
  if (explicitCookie && explicitCookie.trim()) {
    return normalizePtaCookieInput(explicitCookie);
  }
  if (!options.ignoreEnv && process.env.PTA_SESSION_COOKIE && process.env.PTA_SESSION_COOKIE.trim()) {
    return normalizePtaCookieInput(process.env.PTA_SESSION_COOKIE);
  }

  const local = readLocalStorageState('pta');
  const localValid = Boolean(local && Array.isArray(local.cookies) && hasPtaAuthCookie(local.cookies));

  if (options.preferCloud) {
    const cloud = await pullBrowserProfileFromCloud('pta').catch(() => null);
    if (cloud && Array.isArray(cloud.cookies) && hasPtaAuthCookie(cloud.cookies)) {
      if (localValid && local) {
        const localTs = parseFlexibleTimestampMs(local.updatedAt);
        const cloudTs = parseFlexibleTimestampMs(cloud.updatedAt);
        if (Number.isFinite(localTs) && Number.isFinite(cloudTs) && localTs > cloudTs + 5000) {
          // Restore fresher local state if pullBrowserProfileFromCloud overwrote disk
          writeLocalStorageState('pta', local);
          return buildCookieHeaderFromCookies(local.cookies);
        }
      }
      const hdr = buildCookieHeaderFromCookies(cloud.cookies);
      if (hdr) return hdr;
    }
    if (localValid && local) {
      return buildCookieHeaderFromCookies(local.cookies);
    }
  }

  if (localValid && local) {
    return buildCookieHeaderFromCookies(local.cookies);
  }
  const cloud = await pullBrowserProfileFromCloud('pta').catch(() => null);
  if (cloud && Array.isArray(cloud.cookies) && cloud.cookies.length > 0) {
    const hdr = buildCookieHeaderFromCookies(cloud.cookies);
    if (hdr) return hdr;
  }
  if (local && Array.isArray(local.cookies) && local.cookies.length > 0) {
    return buildCookieHeaderFromCookies(local.cookies);
  }
  return '';
}

export async function keepAlivePtaPassport(
  cookieHeader: string
): Promise<{ ok: boolean; user?: any; rolled: boolean }> {
  const cleanCookie = normalizePtaCookieInput(cookieHeader);
  if (!cleanCookie || !hasPtaAuthCookie(cleanCookie)) {
    return { ok: false, rolled: false };
  }
  try {
    const res = await fetch(`${PTA_PASSPORT_ORIGIN}/api/u/current`, {
      method: 'GET',
      headers: {
        Cookie: cleanCookie,
        Accept: 'application/json;charset=UTF-8',
        Referer: `${PTA_ORIGIN}/problem-sets`,
        Origin: PTA_ORIGIN,
        'User-Agent': PTA_USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const setCookies = extractResponseSetCookies(res);
    let rolled = false;
    if (res.ok && setCookies.length > 0) {
      const parsed = parseSetCookieHeaders(setCookies);
      if (parsed.length > 0) {
        rolled = await persistRolledPtaCookies(parsed).catch(() => false);
      }
    }
    if (!res.ok) {
      return { ok: false, rolled };
    }
    const data: any = await res.json().catch(() => ({}));
    return { ok: true, user: data?.user || data, rolled };
  } catch {
    return { ok: false, rolled: false };
  }
}

export function buildPtaHeaders(
  cookieHeader: string,
  psId?: string,
  withContentType = false
): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: 'application/json;charset=UTF-8',
    Referer: psId ? `${PTA_ORIGIN}/problem-sets/${psId}/exam/problems` : `${PTA_ORIGIN}/problem-sets`,
    Origin: PTA_ORIGIN,
    'User-Agent': PTA_USER_AGENT,
  };
  if (withContentType) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
  }
  return headers;
}

export function isPtaAuthFailureResponse(status: number, bodyText: string): boolean {
  if (status === 401) return true;
  if (status === 403 || status === 404) {
    return /USER_NOT_LOGGED_IN|USER_NOT_FOUND|INVALID_SESSION|SESSION_EXPIRED/i.test(bodyText);
  }
  return false;
}

export async function ptaFetchJson<T = any>(
  url: string,
  cookieHeader: string,
  init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; psId?: string; timeoutMs?: number } = {}
): Promise<T> {
  if (!cookieHeader) {
    throw new PtaAuthError('未找到 PTA 登录 Cookie，请先执行 `pnpm afk profile import-cookie --platform pta --cookie "..."`');
  }

  const method = init.method || 'GET';
  const hasBody = init.body !== undefined;
  const headers = buildPtaHeaders(cookieHeader, init.psId, hasBody);
  const maxAttempts = method === 'GET' ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs || 15000),
      });
    } catch (err: any) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }

    const setCookies = extractResponseSetCookies(res);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      if (isPtaAuthFailureResponse(res.status, text)) {
        throw new PtaAuthError(`PTA 登录态无效或已过期 (HTTP ${res.status}): ${text.slice(0, 180)}`);
      }
      if (res.status === 403 || /cf-mitigated|Just a moment|TencentCaptcha/i.test(text)) {
        throw new PtaBlockedError(`PTA 请求触发风控拦截 (HTTP ${res.status})`);
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw new Error(`PTA API HTTP ${res.status} (${url}): ${text.slice(0, 220)}`);
    }

    if (setCookies.length > 0) {
      const parsedCookies = parseSetCookieHeaders(setCookies);
      if (parsedCookies.length > 0) {
        await persistRolledPtaCookies(parsedCookies).catch(() => {});
      }
    }

    if (!text) return {} as T;
    if (/^\s*<!doctype\s+html/i.test(text)) {
      throw new PtaBlockedError('PTA 返回了 HTML 页面而非 JSON（可能触发风控或需要重新登录）');
    }
    return JSON.parse(text) as T;
  }

  return {} as T;
}

export async function listPtaProblemSets(
  cookieHeader: string,
  options: { limit?: number; maxPages?: number } = {}
): Promise<{ total: number; problemSets: PtaProblemSetSummary[] }> {
  const limit = Math.min(50, Math.max(10, options.limit || 50));
  const maxPages = Math.max(1, options.maxPages || 2);
  const all: PtaProblemSetSummary[] = [];
  let total = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = `${PTA_ORIGIN}/api/problem-sets?filter=%7B%7D&page=${page}&limit=${limit}`;
    const data = await ptaFetchJson<{ total?: number; problemSets?: PtaProblemSetSummary[] }>(url, cookieHeader);
    if (typeof data.total === 'number') total = data.total;
    const batch = Array.isArray(data.problemSets) ? data.problemSets : [];
    all.push(...batch);
    if (batch.length < limit || (total > 0 && all.length >= total)) {
      break;
    }
  }

  return { total: total || all.length, problemSets: all };
}

export async function getPtaProblemSetExam(
  psId: string,
  cookieHeader: string
): Promise<{
  exam: PtaExamRecord | null;
  problemSet: Record<string, any> | null;
}> {
  const data = await ptaFetchJson<{ exam?: PtaExamRecord; problemSet?: Record<string, any> }>(
    `${PTA_ORIGIN}/api/problem-sets/${psId}/exams`,
    cookieHeader,
    { psId }
  );
  return {
    exam: data.exam || null,
    problemSet: data.problemSet || null,
  };
}

export async function startPtaExam(psId: string, cookieHeader: string): Promise<PtaExamRecord> {
  const data = await ptaFetchJson<{ exam?: PtaExamRecord; id?: string }>(
    `${PTA_ORIGIN}/api/problem-sets/${psId}/exams`,
    cookieHeader,
    { method: 'POST', body: {}, psId }
  );
  if (data.exam) return data.exam;
  const fresh = await getPtaProblemSetExam(psId, cookieHeader);
  if (!fresh.exam) {
    throw new Error(`启动 PTA 题目集 ${psId} 失败：未返回 exam 对象`);
  }
  return fresh.exam;
}

export async function getPtaProblemStatus(
  psId: string,
  examId: string,
  cookieHeader: string
): Promise<PtaProblemStatusItem[]> {
  const data = await ptaFetchJson<{ problemStatus?: PtaProblemStatusItem[] }>(
    `${PTA_ORIGIN}/api/problem-sets/${psId}/exam-problem-status?exam_id=${encodeURIComponent(examId)}`,
    cookieHeader,
    { psId }
  );
  return Array.isArray(data.problemStatus) ? data.problemStatus : [];
}

export async function scanPtaOverviews(
  cookieHeader: string,
  options: { nowMs?: number; includeExpired?: boolean; maxDetails?: number } = {}
): Promise<{ totalSets: number; activeSets: PtaProblemSetOverview[] }> {
  const nowMs = options.nowMs ?? Date.now();
  const maxDetails = options.maxDetails ?? 12;
  const { total, problemSets } = await listPtaProblemSets(cookieHeader);

  const candidates = problemSets.filter((ps) => {
    if (options.includeExpired) return true;
    const endMs = ps.endAt ? Date.parse(ps.endAt) : NaN;
    const expiredByTime = Number.isFinite(endMs) && endMs <= nowMs;
    const expiredByStatus = String(ps.status || '').toUpperCase() === 'EXPIRED';
    return !expiredByStatus && !expiredByTime;
  });

  const activeSets: PtaProblemSetOverview[] = [];

  for (const ps of candidates.slice(0, maxDetails)) {
    let exam: PtaExamRecord | null = null;
    let problemSetCfg: Record<string, any> | null = null;
    try {
      const examBundle = await getPtaProblemSetExam(ps.id, cookieHeader);
      exam = examBundle.exam;
      problemSetCfg = examBundle.problemSet;
    } catch (err: any) {
      if (err instanceof PtaAuthError || err instanceof PtaBlockedError) {
        throw err;
      }
      console.warn(`[PTA] 获取题目集 [${ps.id}] 详情超时/失败，跳过明细降级保留摘要: ${err?.message || err}`);
    }
    const cfg = problemSetCfg?.problemSetConfig || {};
    const compilers: string[] = Array.isArray(cfg.compilers) ? cfg.compilers : [];
    const judgeTiming = String(cfg.judgeTiming || 'DEFAULT_JUDGE_TIME');
    const shuffledAnswers = Boolean(cfg.randomGenerationProblemSetConfig?.shuffledAnswers);

    let totalProblems = 0;
    let totalScore = 0;
    let acceptedCount = 0;
    let submittedCount = 0;
    let noAnswerCount = 0;

    if (exam?.id) {
      try {
        const statuses = await getPtaProblemStatus(ps.id, exam.id, cookieHeader);
        totalProblems = statuses.length;
        for (const s of statuses) {
          totalScore += Number(s.score || 0);
          if (s.problemSubmissionStatus === 'PROBLEM_ACCEPTED') acceptedCount++;
          else if (s.problemSubmissionStatus === 'PROBLEM_SUBMITTED') submittedCount++;
          else if (s.problemSubmissionStatus === 'PROBLEM_NO_ANSWER') noAnswerCount++;
        }
      } catch (err: any) {
        if (err instanceof PtaAuthError || err instanceof PtaBlockedError) {
          throw err;
        }
        console.warn(`[PTA] 获取题目集 [${ps.id}] 答题状态失败: ${err?.message || err}`);
      }
    }

    const effectiveEndAt = exam?.endAt || ps.endAt;
    const endMs = effectiveEndAt ? Date.parse(effectiveEndAt) : NaN;
    const isExpired =
      String(ps.status || '').toUpperCase() === 'EXPIRED' ||
      (Number.isFinite(endMs) && endMs <= nowMs);
    const isEnded = Boolean(exam?.ended) || String(exam?.status || '').toUpperCase() === 'END';
    const isCompleted =
      isEnded || (Boolean(exam) && totalProblems > 0 && noAnswerCount === 0);
    const isPending = !isExpired && !isCompleted;

    activeSets.push({
      problemSet: ps,
      exam,
      compilers,
      judgeTiming,
      shuffledAnswers,
      totalProblems,
      totalScore,
      acceptedCount,
      submittedCount,
      noAnswerCount,
      isExpired,
      isEnded,
      isCompleted,
      isPending,
      url: `${PTA_ORIGIN}/problem-sets/${ps.id}/exam`,
      deadlineUtc8: formatIsoToUtc8(effectiveEndAt) || '无截止限制',
    });
  }

  return { totalSets: total, activeSets };
}

export function mapPtaCompilerToLanguageHint(
  compiler?: string,
  fallbackCompilers: string[] = []
): StandardQuestion['languageHint'] {
  const candidates = [compiler, ...fallbackCompilers]
    .map((c) => String(c || '').toUpperCase())
    .filter((c) => c && c !== 'NO_COMPILER');

  for (const c of candidates) {
    if (c.includes('JAVA')) return 'java';
    if (c.includes('GXX') || c.includes('CLANGXX') || c.includes('CPP')) return 'cpp';
    if (c.includes('GCC') || c.includes('CLANG')) return 'c';
    if (c.includes('PY')) return 'python';
    if (c.includes('NODE') || c.includes('JS')) return 'javascript';
  }
  return undefined;
}

export function pickPtaCompiler(
  rawCompiler: string | undefined,
  problemSetCompilers: string[] = []
): string {
  if (rawCompiler && rawCompiler !== 'NO_COMPILER') return rawCompiler;
  if (problemSetCompilers.length > 0 && problemSetCompilers[0] !== 'NO_COMPILER') {
    return problemSetCompilers[0];
  }
  return 'JAVAC';
}

export function extractPtaProblemBlanks(problem: PtaRawProblem): PtaBlankMeta[] {
  const cfg = problem.problemConfig || {};
  const list =
    cfg.fillInTheBlankProblemConfig?.blanks ||
    cfg.fillInTheBlankForProgrammingProblemConfig?.blanks ||
    cfg.choiceBlankProblemConfig?.blanks ||
    [];
  return Array.isArray(list)
    ? list.map((b: any) => ({
        index: Number(b?.index || 0),
        length: Number(b?.length || 0),
        multipleLine: Boolean(b?.multipleLine),
      }))
    : [];
}

export function extractPtaChoices(problem: PtaRawProblem): string[] {
  const cfg = problem.problemConfig || {};
  const list =
    cfg.multipleChoiceProblemConfig?.choices ||
    cfg.multipleChoiceMoreThanOneAnswerProblemConfig?.choices ||
    [];
  return Array.isArray(list) ? list.map((c) => String(c ?? '')) : [];
}

export function extractPtaExamples(problem: PtaRawProblem): { sampleInput?: string; sampleOutput?: string } {
  const cfg = problem.problemConfig || {};
  const examples = cfg.programmingProblemConfig?.examples || cfg.codeCompletionProblemConfig?.examples || [];
  if (Array.isArray(examples) && examples.length > 0 && examples[0]) {
    const input = examples[0].input !== undefined ? String(examples[0].input) : undefined;
    const output = examples[0].output !== undefined ? String(examples[0].output) : undefined;
    if (input || output) return { sampleInput: input, sampleOutput: output };
  }

  const content = String(problem.content || problem.description || '');
  const inMatch = content.match(/```in\s*\n([\s\S]*?)```/i);
  const outMatch = content.match(/```out\s*\n([\s\S]*?)```/i);
  return {
    sampleInput: inMatch ? inMatch[1] : undefined,
    sampleOutput: outMatch ? outMatch[1] : undefined,
  };
}

export function normalizePtaProblem(
  raw: PtaRawProblem,
  problemSetCompilers: string[] = [],
  submissionStatus?: string
): { question: StandardQuestion; meta: PtaProblemMeta } {
  const content = String(raw.content || raw.description || raw.title || '').trim();
  const choices = extractPtaChoices(raw);
  const blanks = extractPtaProblemBlanks(raw);
  const { sampleInput, sampleOutput } = extractPtaExamples(raw);
  const compiler = pickPtaCompiler(raw.compiler, problemSetCompilers);
  const languageHint = mapPtaCompilerToLanguageHint(raw.compiler, problemSetCompilers);

  let qType: StandardQuestion['type'] = 'unknown';
  let typeName = raw.type;
  let title = `[PTA ${raw.label}] ${content}`;
  let options: QuestionOption[] | undefined;

  if (raw.type === 'TRUE_OR_FALSE') {
    qType = 'judgement';
    typeName = '判断题';
  } else if (raw.type === 'MULTIPLE_CHOICE') {
    qType = 'single';
    typeName = '单选题';
    options = choices.map((text, idx) => ({
      key: String.fromCharCode(65 + idx),
      text: text.replace(/\u00a0/g, ' ').trim(),
    }));
  } else if (raw.type === 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER') {
    qType = 'multiple';
    typeName = '多选题';
    options = choices.map((text, idx) => ({
      key: String.fromCharCode(65 + idx),
      text: text.replace(/\u00a0/g, ' ').trim(),
    }));
  } else if (raw.type === 'FILL_IN_THE_BLANK') {
    qType = 'blank';
    typeName = '填空题';
    const lengthsHint = blanks.map((b, i) => `第${i + 1}空预期长度=${b.length}`).join('，');
    if (blanks.length > 1) {
      title += `\n\n[作答格式要求] 本题共 ${blanks.length} 个空（${lengthsHint}），请严格返回 JSON 字符串数组，例如 ["ans1", "ans2"]。`;
    } else if (blanks.length === 1) {
      title += `\n\n[作答格式要求] 本题共 1 个空（${lengthsHint}），直接返回该空的精确输出文本。`;
    }
  } else if (raw.type === 'FILL_IN_THE_BLANK_FOR_PROGRAMMING') {
    qType = 'essay';
    typeName = '程序填空题';
    const blankCount = blanks.length || (content.match(/@@\[\]\(\d+\)/g)?.length || 1);
    const lengthsHint = blanks.map((b, i) => `第${i + 1}空长度=${b.length}`).join('，');
    title += `\n\n[程序填空作答格式要求] 目标语言=${languageHint || compiler}，共 ${blankCount} 个空${lengthsHint ? `（${lengthsHint}）` : ''}。请仅输出一个 JSON 字符串数组，按顺序填入每个空的代码片段，例如 ["ans1", "ans2"]。`;
  } else if (raw.type === 'CODE_COMPLETION') {
    qType = 'programming';
    typeName = '函数题/代码补全';
    title += `\n\n[代码补全约束] 仅输出需要嵌入到“请在这里填写答案 / 嵌入到这里”位置的代码片段（不要重复粘贴题目已给出的 Main 测试框架或已声明接口）；语言=${languageHint || compiler}。`;
  } else if (raw.type === 'PROGRAMMING') {
    qType = 'programming';
    typeName = '编程题';
    title += `\n\n[编程题约束] 请输出完整可独立编译运行的源码（Java 题目主类名必须为 Main，且仅 Main 可声明为 public）；目标编译器=${compiler}。`;
  }

  return {
    question: {
      id: raw.id,
      type: qType,
      typeName,
      title,
      options,
      score: Number(raw.score || 0),
      sampleInput,
      sampleOutput,
      languageHint,
    },
    meta: {
      problemSetProblemId: raw.id,
      label: raw.label,
      problemType: raw.type,
      maxScore: Number(raw.score || 0),
      choices,
      blanks,
      compiler,
      submissionStatus,
    },
  };
}

export async function fetchAllPtaExamProblems(
  psId: string,
  examId: string,
  statuses: PtaProblemStatusItem[],
  cookieHeader: string,
  problemSetCompilers: string[] = []
): Promise<Array<{ question: StandardQuestion; meta: PtaProblemMeta; raw: PtaRawProblem }>> {
  const statusById = new Map<string, PtaProblemStatusItem>();
  const problemTypes = new Set<string>();
  for (const s of statuses) {
    statusById.set(s.id, s);
    problemTypes.add(s.problemType);
  }

  const rawProblems: PtaRawProblem[] = [];
  for (const pType of problemTypes) {
    for (let page = 0; page < 10; page++) {
      const url = `${PTA_ORIGIN}/api/problem-sets/${psId}/exam-problems?exam_id=${encodeURIComponent(examId)}&problem_type=${encodeURIComponent(pType)}&page=${page}&limit=50`;
      const res = await ptaFetchJson<{ problemSetProblems?: PtaRawProblem[]; total?: number }>(url, cookieHeader, {
        psId,
      });
      const list = Array.isArray(res.problemSetProblems) ? res.problemSetProblems : [];
      rawProblems.push(...list);
      if (list.length < 50) break;
    }
  }

  const enriched: Array<{ question: StandardQuestion; meta: PtaProblemMeta; raw: PtaRawProblem }> = [];
  for (const rp of rawProblems) {
    let detailed = rp;
    if (
      rp.type === 'FILL_IN_THE_BLANK' ||
      rp.type === 'FILL_IN_THE_BLANK_FOR_PROGRAMMING' ||
      rp.type === 'CHOICE_BLANK'
    ) {
      try {
        const dRes = await ptaFetchJson<{ problemSetProblem?: PtaRawProblem }>(
          `${PTA_ORIGIN}/api/problem-sets/${psId}/exam-problems/${rp.id}?exam_id=${encodeURIComponent(examId)}`,
          cookieHeader,
          { psId }
        );
        if (dRes.problemSetProblem) detailed = dRes.problemSetProblem;
      } catch {
        // 列表字段足够时容错降级
      }
    }
    const st = statusById.get(detailed.id);
    const normalized = normalizePtaProblem(detailed, problemSetCompilers, st?.problemSubmissionStatus);
    enriched.push({ ...normalized, raw: detailed });
  }

  return enriched;
}

export function stripMarkdownCodeFence(text: string): string {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^```(?:[a-z0-9_+-]+)?\s*\n([\s\S]*?)```$/i);
  if (match) return match[1].trim();
  const inlineMatch = trimmed.match(/```(?:[a-z0-9_+-]+)?\s*\n([\s\S]*?)```/i);
  if (inlineMatch && trimmed.length - inlineMatch[0].length < 80) {
    return inlineMatch[1].trim();
  }
  return trimmed;
}

export function parseBlankAnswers(rawAnswer: string, expectedCount: number): string[] {
  const cleaned = stripMarkdownCodeFence(rawAnswer);
  if (cleaned.startsWith('[')) {
    try {
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        const mapped = arr.map((x) => String(x ?? '').trim());
        if (expectedCount <= 1 || mapped.length === expectedCount) {
          return mapped;
        }
        if (mapped.length > expectedCount) return mapped.slice(0, expectedCount);
        while (mapped.length < expectedCount) mapped.push('');
        return mapped;
      }
    } catch {
      // fall through
    }
  }

  if (expectedCount <= 1) {
    return [cleaned];
  }

  const lines = cleaned
    .split(/\r?\n|\|\|/)
    .map((s) => s.replace(/^(?:第?\s*\d+\s*空[:：]\s*|\d+[\.\)]\s*)/, '').trim())
    .filter((s) => s.length > 0);
  if (lines.length === expectedCount) return lines;
  const out = lines.slice(0, expectedCount);
  while (out.length < expectedCount) out.push('');
  return out;
}

export function buildPtaSubmissionDetail(
  meta: PtaProblemMeta,
  rawAnswer: string,
  problemSetCompilers: string[] = []
): Record<string, any> {
  const base = {
    problemId: '0',
    problemSetProblemId: meta.problemSetProblemId,
  };

  if (meta.problemType === 'TRUE_OR_FALSE') {
    const low = String(rawAnswer || '').trim().toLowerCase();
    const isTrue =
      low === 'true' || low === 't' || low === '1' || low === 'a' || low.includes('正确') || low.includes('对') || low.includes('√');
    return {
      ...base,
      trueOrFalseSubmissionDetail: {
        answer: isTrue ? 'TRUE' : 'FALSE',
      },
    };
  }

  if (meta.problemType === 'MULTIPLE_CHOICE') {
    const letter = String(rawAnswer || 'A').toUpperCase().match(/[A-Z]/)?.[0] || 'A';
    return {
      ...base,
      multipleChoiceSubmissionDetail: { answer: letter },
    };
  }

  if (meta.problemType === 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER') {
    const letters = Array.from(new Set(String(rawAnswer || 'A').toUpperCase().match(/[A-Z]/g) || ['A'])).sort();
    return {
      ...base,
      multipleChoiceMoreThanOneAnswerSubmissionDetail: { answers: letters },
    };
  }

  if (meta.problemType === 'FILL_IN_THE_BLANK') {
    const expectedCount = Math.max(1, meta.blanks?.length || 1);
    return {
      ...base,
      fillInTheBlankSubmissionDetail: { answers: parseBlankAnswers(rawAnswer, expectedCount) },
    };
  }

  if (meta.problemType === 'FILL_IN_THE_BLANK_FOR_PROGRAMMING') {
    const expectedCount = Math.max(1, meta.blanks?.length || 1);
    return {
      ...base,
      fillInTheBlankForProgrammingSubmissionDetail: { answers: parseBlankAnswers(rawAnswer, expectedCount) },
    };
  }

  if (meta.problemType === 'CODE_COMPLETION') {
    return {
      ...base,
      codeCompletionSubmissionDetail: { program: stripMarkdownCodeFence(rawAnswer) },
    };
  }

  return {
    ...base,
    programmingSubmissionDetail: {
      program: stripMarkdownCodeFence(rawAnswer),
      compiler: pickPtaCompiler(meta.compiler, problemSetCompilers),
    },
  };
}

export async function savePtaProblemDrafts(
  metas: PtaProblemMeta[],
  answers: Record<string, string>,
  cookieHeader: string,
  psId: string,
  problemSetCompilers: string[] = []
): Promise<{ savedCount: number; errors: string[] }> {
  let savedCount = 0;
  const errors: string[] = [];

  for (const meta of metas) {
    const ans = answers[meta.problemSetProblemId];
    if (!ans || !ans.trim()) continue;
    const detail = buildPtaSubmissionDetail(meta, ans, problemSetCompilers);
    try {
      await ptaFetchJson(
        `${PTA_ORIGIN}/api/problem-sets/problems/${meta.problemSetProblemId}/exam-draft`,
        cookieHeader,
        {
          method: 'POST',
          psId,
          body: {
            answer: {
              detail,
              saveAt: new Date().toISOString(),
            },
          },
        }
      );
      savedCount++;
    } catch (err: any) {
      errors.push(`${meta.label}: ${err?.message || err}`);
    }
  }

  return { savedCount, errors };
}

export async function submitPtaProblemAnswers(options: {
  psId: string;
  examId: string;
  metas: PtaProblemMeta[];
  answers: Record<string, string>;
  cookieHeader: string;
  problemSetCompilers?: string[];
  pollTimeoutMs?: number;
}): Promise<{
  submittedCount: number;
  acceptedCount: number;
  submissionIds: string[];
  verdicts: Array<{ label: string; problemType: string; status: string; score: number }>;
}> {
  const { psId, examId, metas, answers, cookieHeader } = options;
  const compilers = options.problemSetCompilers || [];

  // 先查询已有历史提交，以便对 clustered 题型与旧答案合并，防止触发 OVERRIDDEN 覆盖掉之前作答的同类型题目
  const existingByType = new Map<string, Map<string, Record<string, any>>>();
  try {
    const subsRes = await ptaFetchJson<{ submissions?: PtaSubmissionSummary[] }>(
      `${PTA_ORIGIN}/api/exams/${examId}/problem-sets/${psId}/submissions?limit=50`,
      cookieHeader,
      { psId }
    );
    const activeSubs = (subsRes.submissions || []).filter(
      (s) => PTA_CLUSTERED_TYPES.has(s.problemType) && s.status !== 'OVERRIDDEN' && s.problemSetProblemId === '0'
    );
    for (const s of activeSubs) {
      if (existingByType.has(s.problemType)) continue;
      const fullSub = await ptaFetchJson<{ submission?: PtaSubmissionSummary }>(
        `${PTA_ORIGIN}/api/exams/${examId}/submissions/${s.id}`,
        cookieHeader,
        { psId }
      ).catch(() => null);
      const map = new Map<string, Record<string, any>>();
      for (const d of fullSub?.submission?.submissionDetails || []) {
        if (d?.problemSetProblemId) map.set(String(d.problemSetProblemId), d);
      }
      if (map.size > 0) existingByType.set(s.problemType, map);
    }
  } catch {
    // 无权限查全量提交列表时降级为直接整组提交本次全部同题型答案
  }

  const clusteredGroups = new Map<string, Array<{ meta: PtaProblemMeta; detail: Record<string, any> }>>();
  const individualItems: Array<{ meta: PtaProblemMeta; detail: Record<string, any> }> = [];

  for (const meta of metas) {
    const ans = answers[meta.problemSetProblemId];
    if (!ans || !ans.trim()) continue;
    const detail = buildPtaSubmissionDetail(meta, ans, compilers);
    if (PTA_CLUSTERED_TYPES.has(meta.problemType)) {
      const list = clusteredGroups.get(meta.problemType) || [];
      list.push({ meta, detail });
      clusteredGroups.set(meta.problemType, list);
    } else {
      individualItems.push({ meta, detail });
    }
  }

  const submissionIds: string[] = [];
  const verdicts: Array<{ label: string; problemType: string; status: string; score: number }> = [];
  let submittedCount = 0;
  let acceptedCount = 0;

  for (const [problemType, items] of clusteredGroups.entries()) {
    const mergedMap = new Map<string, Record<string, any>>(existingByType.get(problemType) || []);
    for (const item of items) {
      mergedMap.set(item.meta.problemSetProblemId, item.detail);
    }
    const res = await ptaFetchJson<{ submissionId?: string }>(
      `${PTA_ORIGIN}/api/exams/${examId}/exam-submissions`,
      cookieHeader,
      {
        method: 'POST',
        psId,
        body: {
          problemType,
          details: Array.from(mergedMap.values()),
        },
      }
    );
    if (res.submissionId) submissionIds.push(res.submissionId);
    submittedCount += items.length;
    for (const item of items) {
      verdicts.push({
        label: item.meta.label,
        problemType,
        status: 'SUBMITTED_BATCH',
        score: 0,
      });
    }
  }

  const pollDeadline = Date.now() + (options.pollTimeoutMs || 15000);
  const pendingPolls: Array<{ item: { meta: PtaProblemMeta; detail: Record<string, any> }; submissionId: string }> = [];

  for (const item of individualItems) {
    const res = await ptaFetchJson<{ submissionId?: string }>(
      `${PTA_ORIGIN}/api/exams/${examId}/exam-submissions`,
      cookieHeader,
      {
        method: 'POST',
        psId,
        body: {
          problemType: item.meta.problemType,
          details: [item.detail],
        },
      }
    );
    submittedCount++;
    if (res.submissionId) {
      submissionIds.push(res.submissionId);
      pendingPolls.push({ item, submissionId: res.submissionId });
    }
  }

  for (const { item, submissionId } of pendingPolls) {
    let finalStatus = 'WAITING';
    let finalScore = 0;
    while (Date.now() < pollDeadline) {
      const subRes = await ptaFetchJson<{ submission?: PtaSubmissionSummary }>(
        `${PTA_ORIGIN}/api/exams/${examId}/submissions/${submissionId}`,
        cookieHeader,
        { psId }
      ).catch(() => null);
      const sub = subRes?.submission;
      if (sub && sub.status !== 'WAITING' && sub.status !== 'JUDGING') {
        finalStatus = sub.status;
        finalScore = Number(sub.score || 0);
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (finalStatus === 'ACCEPTED') acceptedCount++;
    verdicts.push({
      label: item.meta.label,
      problemType: item.meta.problemType,
      status: finalStatus,
      score: finalScore,
    });
  }

  return { submittedCount, acceptedCount, submissionIds, verdicts };
}

export function buildPtaTaskSummaryPayload(ov: PtaProblemSetOverview) {
  const status: 'pending' | 'draft_saved' | 'submitted' = ov.isCompleted ? 'submitted' : 'pending';
  let resultSummary = '';
  if (ov.isCompleted) {
    const pts = ov.exam?.score ?? ov.acceptedCount;
    resultSummary = ov.isEnded
      ? `已交卷（得分 ${pts}/${ov.totalScore}，共 ${ov.totalProblems} 题）`
      : `已完成全部 ${ov.totalProblems} 题作答（即时得分 ${pts}/${ov.totalScore}，客观题待统一评测）`;
  } else if (ov.exam) {
    const done = Math.max(0, ov.totalProblems - ov.noAnswerCount);
    resultSummary = `已完成 ${done}/${ov.totalProblems} 题，待作答 ${ov.noAnswerCount} 题`;
  } else {
    resultSummary = '新发现 PTA 题目集，尚未开始作答';
  }
  return {
    taskId: `pta-ps-${ov.problemSet.id}`,
    platform: 'pta' as const,
    courseId: ov.problemSet.organizationId || 'pta',
    classId: ov.problemSet.type || 'EXERCISE',
    courseName: ov.problemSet.organizationName || 'PTA 拼题 A',
    title: ov.problemSet.name,
    status,
    deadline: ov.deadlineUtc8,
    resultSummary,
    url: ov.url,
    problemSetId: ov.problemSet.id,
    examId: ov.exam?.id || '',
    totalProblems: ov.totalProblems,
    noAnswerCount: ov.noAnswerCount,
    isPending: ov.isPending,
    workId: ov.problemSet.id,
    nowUtc8: formatUtc8Now(),
  };
}
