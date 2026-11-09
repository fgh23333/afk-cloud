import { ChildProcess } from 'child_process';
import {
  detectChromiumExecutable,
  launchHeadlessBrowserWithProfile,
  pullBrowserProfileFromCloud,
} from '../../core/browser-profile';

interface BrowserInstance {
  process: ChildProcess;
  platform: string;
  cdpUrl: string;
  startedAt: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

let activeBrowser: BrowserInstance | null = null;

/**
 * 启动或复用指定平台的本地无头浏览器
 */
export async function startManagedBrowser(
  platform: string,
  ttlMinutes = 30
): Promise<{ status: string; cdpUrl: string }> {
  // 若已在运行同平台的浏览器，刷新 TTL 并直接复用
  if (activeBrowser && activeBrowser.platform === platform && !activeBrowser.process.killed) {
    touchBrowser(ttlMinutes);
    return {
      status: `running:${platform}`,
      cdpUrl: activeBrowser.cdpUrl,
    };
  }

  // 若运行的是其他平台，先安全停止
  if (activeBrowser) {
    await stopManagedBrowser();
  }

  // 先尝试从云端 D1 恢复登录态
  try {
    await pullBrowserProfileFromCloud(platform);
  } catch (err: any) {
    console.warn(`[Browser Manager] 从云端同步 Profile 失败: ${err?.message || err}`);
  }

  const { process: proc, cdpUrl } = launchHeadlessBrowserWithProfile({
    platform,
    headless: true,
    debuggingPort: 9222,
  });

  const now = Date.now();
  activeBrowser = {
    process: proc,
    platform,
    cdpUrl,
    startedAt: now,
    lastUsedAt: now,
  };

  resetIdleTimer(ttlMinutes);
  console.log(`[Browser Manager] 已拉起平台 [${platform}] 浏览器守护进程 (CDP: ${cdpUrl}, TTL: ${ttlMinutes}m)`);

  return {
    status: `running:${platform}`,
    cdpUrl,
  };
}

/**
 * 安全停止当前运行的浏览器守护进程
 */
export async function stopManagedBrowser(): Promise<{ status: string }> {
  if (!activeBrowser) {
    return { status: 'stopped' };
  }

  if (activeBrowser.idleTimer) {
    clearTimeout(activeBrowser.idleTimer);
  }

  const proc = activeBrowser.process;
  const platform = activeBrowser.platform;
  activeBrowser = null;

  try {
    if (process.platform === 'win32' && proc.pid) {
      const { exec } = await import('child_process');
      exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err: any) {
    console.warn(`[Browser Manager] 终止浏览器进程异常: ${err?.message || err}`);
  }

  console.log(`[Browser Manager] 平台 [${platform}] 浏览器守护进程已停止`);
  return { status: 'stopped' };
}

/**
 * 刷新浏览器的最后活动时间与 TTL 自停计时器
 */
export function touchBrowser(ttlMinutes = 30): void {
  if (activeBrowser) {
    activeBrowser.lastUsedAt = Date.now();
    resetIdleTimer(ttlMinutes);
  }
}

function resetIdleTimer(ttlMinutes: number): void {
  if (!activeBrowser) return;
  if (activeBrowser.idleTimer) {
    clearTimeout(activeBrowser.idleTimer);
  }
  const ms = Math.max(1, ttlMinutes) * 60 * 1000;
  activeBrowser.idleTimer = setTimeout(async () => {
    console.log(`[Browser Manager] 浏览器空闲超过 ${ttlMinutes} 分钟，执行物理 TTL 自动关闭以释放内存`);
    await stopManagedBrowser();
  }, ms);
}

/**
 * 获取当前浏览器运行状态
 */
export function getManagedBrowserStatus(): {
  status: string;
  platform?: string;
  cdpUrl?: string;
  uptimeSeconds?: number;
} {
  if (!activeBrowser || activeBrowser.process.killed) {
    return { status: 'stopped' };
  }
  return {
    status: `running:${activeBrowser.platform}`,
    platform: activeBrowser.platform,
    cdpUrl: activeBrowser.cdpUrl,
    uptimeSeconds: Math.floor((Date.now() - activeBrowser.startedAt) / 1000),
  };
}
