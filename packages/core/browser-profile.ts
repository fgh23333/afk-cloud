import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { formatUtc8Now, PlatformName } from './types';

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface BrowserOriginState {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/**
 * 标准可迁移浏览器状态快照 (兼容 Playwright storageState 与 CDP Cookie/LocalStorage 注入)
 */
export interface PortableStorageState {
  platform: PlatformName | string;
  updatedAt: string;
  cookies: BrowserCookie[];
  origins: BrowserOriginState[];
}

export interface ProfilePaths {
  platform: string;
  baseDir: string;
  userDataDir: string;
  storageStatePath: string;
}

/**
 * 获取指定平台的本地持久化浏览器 Profile 目录与 storageState.json 路径
 */
export function getBrowserProfilePaths(platform: PlatformName | string): ProfilePaths {
  const cleanName = platform.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const baseDir = path.resolve(process.cwd(), '.cache', 'browser-profiles', cleanName);
  const userDataDir = path.join(baseDir, 'user-data');
  const storageStatePath = path.join(baseDir, 'storage-state.json');

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  return {
    platform: cleanName,
    baseDir,
    userDataDir,
    storageStatePath,
  };
}

/**
 * 读取本地保存的 storageState.json (含 Cookies 与 LocalStorage)
 */
export function readLocalStorageState(platform: string): PortableStorageState | null {
  const { storageStatePath } = getBrowserProfilePaths(platform);
  try {
    if (fs.existsSync(storageStatePath)) {
      return JSON.parse(fs.readFileSync(storageStatePath, 'utf8')) as PortableStorageState;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 保存 storageState.json 到本地 Profile 目录
 */
export function writeLocalStorageState(
  platform: string,
  state: Omit<PortableStorageState, 'platform' | 'updatedAt'>
): PortableStorageState {
  const { storageStatePath } = getBrowserProfilePaths(platform);
  const fullState: PortableStorageState = {
    platform,
    updatedAt: formatUtc8Now(),
    cookies: state.cookies || [],
    origins: state.origins || [],
  };
  fs.writeFileSync(storageStatePath, JSON.stringify(fullState, null, 2), 'utf8');
  return fullState;
}

/**
 * 将本地浏览器登录态快照 (Cookies + LocalStorage) 推送至 Cloudflare D1 持久层
 * 这样在无状态的 Cloud Run Jobs 或临时拉起的 GCE 机器上无需再次扫码/验证码登录！
 */
export async function pushBrowserProfileToCloud(
  platform: string,
  account = 'default'
): Promise<{ synced: boolean; msg: string }> {
  const localState = readLocalStorageState(platform);
  if (!localState) {
    return { synced: false, msg: `本地未找到平台 [${platform}] 的 storage-state.json` };
  }

  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;

  if (!edgeUrl) {
    return { synced: false, msg: '未配置 AFK_EDGE_WORKER_URL，仅保存在本地 .cache/browser-profiles/' };
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

    const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        platform: `web-profile:${platform}`,
        account,
        session: localState,
        ttlSeconds: 30 * 24 * 3600, // 30 天有效期
      }),
    });

    if (!res.ok) {
      return { synced: false, msg: `Edge Worker 返回 HTTP ${res.status}` };
    }
    return {
      synced: true,
      msg: `已成功将 [${platform}] 浏览器登录态 (${localState.cookies.length} Cookies, ${localState.origins.length} Origins) 同步至 Cloudflare D1`,
    };
  } catch (err: any) {
    return { synced: false, msg: `云端同步异常: ${err?.message || err}` };
  }
}

/**
 * 从 Cloudflare D1 拉取浏览器登录态快照到本地 (供 Cloud Run / 临时 GCE 启动无头浏览器前恢复登录态)
 */
export async function pullBrowserProfileFromCloud(
  platform: string,
  account = 'default'
): Promise<PortableStorageState | null> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;

  if (edgeUrl) {
    try {
      const headers: Record<string, string> = {};
      if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

      const res = await fetch(
        `${edgeUrl.replace(/\/+$/, '')}/api/session?platform=${encodeURIComponent(`web-profile:${platform}`)}&account=${encodeURIComponent(account)}`,
        { headers }
      );
      if (res.ok) {
        const data: any = await res.json();
        if (data?.session && Array.isArray(data.session.cookies)) {
          return writeLocalStorageState(platform, data.session);
        }
      }
    } catch {
      // ignore network error and fall back to local
    }
  }

  return readLocalStorageState(platform);
}

/**
 * 自动探测系统可用的 Chromium / Chrome 可执行文件路径
 */
export function detectChromiumExecutable(): string | null {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 启动带持久化 UserDataDir Profile 与 CDP 调试端口的无头浏览器守护进程
 * 启动后 Antigravity (agy) 的 `chrome-devtools` MCP 或 Playwright 可直接挂载操控！
 */
export function launchHeadlessBrowserWithProfile(options: {
  platform: PlatformName | string;
  targetUrl?: string;
  debuggingPort?: number;
  headless?: boolean;
}): {
  process: ChildProcess;
  userDataDir: string;
  cdpUrl: string;
} {
  const exe = detectChromiumExecutable();
  if (!exe) {
    throw new Error('未检测到 Chrome/Chromium 可执行文件，请安装 chromium 或设置 CHROME_PATH');
  }

  const { userDataDir } = getBrowserProfilePaths(options.platform);
  const port = options.debuggingPort || 9222;
  const isHeadless = options.headless !== false;

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--window-size=1440,900',
  ];

  if (isHeadless) {
    args.push('--headless=new');
  }

  if (options.targetUrl) {
    args.push(options.targetUrl);
  }

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return {
    process: child,
    userDataDir,
    cdpUrl: `http://127.0.0.1:${port}`,
  };
}
