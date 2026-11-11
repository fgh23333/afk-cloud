import { ExtendedNotifyEnv } from './notify';

const DEFAULT_TASK_HOSTS = ['chaoxing.com', 'zhihuishu.com', 'pintia.cn'];

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
  ].filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  return tokens;
}

export function isAuthEnforced(env: ExtendedNotifyEnv): boolean {
  return getExpectedAuthTokens(env).length > 0;
}

/**
 * Edge 严格安全鉴权（Fail-Closed 原则）
 * 支持三种传递方式：
 *  1. Header: Authorization: Bearer <TOKEN>
 *  2. Cookie: afk_token=<TOKEN> (网页登录态)
 *  3. Query: ?token=<TOKEN> (首登或自动化探针)
 */
export function checkAuth(request: Request, env: ExtendedNotifyEnv): boolean {
  const validTokens = getExpectedAuthTokens(env);
  // 安全铁律：如果没有配置任何密钥，拒绝一切访问（Fail-Closed），避免在公网无保护运行
  if (validTokens.length === 0) {
    return false;
  }

  // 1. Authorization: Bearer <token>
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();
    if (validTokens.includes(bearer)) return true;
  }

  // 2. Cookie: afk_token=<token>
  const cookies = parseCookies(request);
  const cookieToken = cookies['afk_token'] || cookies['afk_auth'];
  if (cookieToken && validTokens.includes(cookieToken)) {
    return true;
  }

  // 3. URL Query: ?token=<token>
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken && validTokens.includes(queryToken)) {
    return true;
  }

  return false;
}
