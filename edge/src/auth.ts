import { ExtendedNotifyEnv } from './notify';

const DEFAULT_TASK_HOSTS = ['chaoxing.com', 'zhihuishu.com', 'pintia.cn'];

/** 已知仓库示例默认值/弱占位口令：绝不允许在生产边缘节点生效 */
const INSECURE_PLACEHOLDER_TOKENS = new Set([
  'chaoxing_secure_sync_key',
  'your_token_here',
  'your_sync_secret_here',
  'changeme',
  '<your_token>',
]);

function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0 && a.length > 0;
}

/**
 * 校验待派发任务 URL 是否在安全白名单内（严格校验 https 且域名属于白名单后缀，杜绝 SSRF）
 */
export function isAllowedTaskUrl(rawUrl: string, customAllowlist?: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    const list = (customAllowlist || DEFAULT_TASK_HOSTS.join(','))
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/^\.+/, ''))
      .filter(Boolean);
    return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((part) => {
    const [k, v] = part.trim().split('=');
    if (k && v) {
      try {
        cookies[k] = decodeURIComponent(v);
      } catch {
        cookies[k] = v;
      }
    }
  });
  return cookies;
}

export function getExpectedAuthTokens(env: ExtendedNotifyEnv): string[] {
  const tokens = [
    env.API_BEARER_TOKEN,
    env.AFK_EDGE_BEARER_TOKEN,
    env.DASHBOARD_PASSWORD,
    env.SYNC_SECRET,
  ]
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim())
    .filter((t) => !INSECURE_PLACEHOLDER_TOKENS.has(t.toLowerCase()));
  return Array.from(new Set(tokens));
}

export function isAuthEnforced(env: ExtendedNotifyEnv): boolean {
  return getExpectedAuthTokens(env).length > 0;
}

export function isValidAuthToken(candidate: string | null | undefined, env: ExtendedNotifyEnv): boolean {
  if (!candidate || typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  const validTokens = getExpectedAuthTokens(env);
  if (validTokens.length === 0) return false;
  let matched = false;
  for (const valid of validTokens) {
    if (constantTimeEqual(trimmed, valid)) {
      matched = true;
    }
  }
  return matched;
}

export interface CheckAuthOptions {
  /** 是否允许通过 URL 查询参数 ?token=... 鉴权（仅首登/看板跳转开启，API 与 WebSocket 默认禁用以防 Referer 泄漏） */
  allowQueryToken?: boolean;
}

/**
 * Edge 严格安全鉴权（Fail-Closed 原则 + 常量时间比较）
 * 支持三种传递方式：
 *  1. Header: Authorization: Bearer <TOKEN>
 *  2. Cookie: afk_token=<TOKEN> (网页登录态)
 *  3. Query: ?token=<TOKEN> (仅在 allowQueryToken !== false 时生效)
 */
export function checkAuth(
  request: Request,
  env: ExtendedNotifyEnv,
  options: CheckAuthOptions = {}
): boolean {
  if (!isAuthEnforced(env)) {
    return false;
  }

  // 1. Authorization: Bearer <token>
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();
    if (isValidAuthToken(bearer, env)) return true;
  }

  // 2. Cookie: afk_token=<token>
  const cookies = parseCookies(request);
  const cookieToken = cookies['afk_token'] || cookies['afk_auth'];
  if (isValidAuthToken(cookieToken, env)) {
    return true;
  }

  // 3. URL Query: ?token=<token>
  if (options.allowQueryToken !== false) {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    if (isValidAuthToken(queryToken, env)) {
      return true;
    }
  }

  return false;
}
