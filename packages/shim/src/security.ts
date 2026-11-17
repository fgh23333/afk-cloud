import fs from 'fs';
import os from 'os';
import path from 'path';
import { isStrongSecret, MIN_SECRET_LENGTH } from '../../core/request-signing';

/**
 * Shim 安全配置与输入校验
 */

export interface ShimSecurityConfig {
  /** Edge <-> Shim HMAC 共享密钥 (AFK_SHIM_SECRET) */
  secret: string;
  /** 监听地址，默认仅本机回环 (配合 Cloudflare Tunnel 使用，无需对外暴露端口) */
  host: string;
  port: number;
  /** 允许派发的任务域名后缀白名单 */
  taskHostAllowlist: string[];
  /** 请求体最大字节数 */
  maxBodyBytes: number;
  /** 执行队列最大积压数 */
  maxQueueLength: number;
  /** 本地调试不鉴权模式 (仅允许回环地址) */
  insecureDev: boolean;
}

const DEFAULT_TASK_HOSTS = ['chaoxing.com', 'zhihuishu.com', 'pintia.cn'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadShimSecurityConfig(env: NodeJS.ProcessEnv = process.env): ShimSecurityConfig {
  const allowlist = (env.AFK_TASK_HOST_ALLOWLIST || DEFAULT_TASK_HOSTS.join(','))
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);

  return {
    secret: env.AFK_SHIM_SECRET || '',
    host: env.SHIM_HOST || '127.0.0.1',
    port: parseInt(env.SHIM_PORT || env.PORT || '8788', 10),
    taskHostAllowlist: allowlist,
    maxBodyBytes: parseInt(env.SHIM_MAX_BODY_BYTES || String(64 * 1024), 10),
    maxQueueLength: parseInt(env.SHIM_MAX_QUEUE || '20', 10),
    insecureDev: env.AFK_SHIM_INSECURE_DEV === 'true',
  };
}

/**
 * 启动前安全自检：不满足条件直接拒绝启动 (Fail-Closed)
 */
export function assertShimStartupSecurity(cfg: ShimSecurityConfig): void {
  if (cfg.insecureDev) {
    if (!LOOPBACK_HOSTS.has(cfg.host)) {
      throw new Error(`AFK_SHIM_INSECURE_DEV=true 仅允许监听回环地址，当前 SHIM_HOST=${cfg.host}`);
    }
    console.warn('[Shim Security] ⚠️ 本地调试免签名模式已开启，切勿在服务器上使用');
    return;
  }
  if (!isStrongSecret(cfg.secret)) {
    throw new Error(
      `缺少或过短的 AFK_SHIM_SECRET (至少 ${MIN_SECRET_LENGTH} 字符)。可用 \`openssl rand -hex 32\` 生成，并同步写入 Worker secret。`
    );
  }
  if (!LOOPBACK_HOSTS.has(cfg.host)) {
    console.warn(
      `[Shim Security] ⚠️ SHIM_HOST=${cfg.host} 非回环地址，Shim 将暴露在网络上；推荐保持 127.0.0.1 并通过 Cloudflare Tunnel 访问`
    );
  }
}

/**
 * 持久化 + 内存 Nonce 去重缓存 (防重启后在 300s 时间窗口内被重放)
 */
export class NonceCache {
  private seen = new Map<string, number>();
  private persistPath?: string;

  constructor(private ttlSeconds = 600, private maxEntries = 10000, persistPath?: string) {
    const resolvedPath =
      persistPath !== undefined
        ? persistPath
        : process.env.SHIM_NONCE_FILE ||
          (process.env.NODE_ENV !== 'test' ? path.join(os.homedir(), '.cache', 'afk-shim-nonces.json') : undefined);
    this.persistPath = resolvedPath || undefined;
    this.loadFromDisk();
  }

  private loadFromDisk() {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      const now = Math.floor(Date.now() / 1000);
      if (raw && typeof raw === 'object') {
        for (const [k, exp] of Object.entries(raw)) {
          if (typeof exp === 'number' && exp > now) {
            this.seen.set(k, exp);
          }
        }
      }
    } catch {
      // ignore corrupted cache
    }
  }

  private flushToDisk() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.seen)), 'utf8');
    } catch {
      // ignore
    }
  }

  /** 已存在返回 true；不存在则登记并返回 false */
  checkAndRemember(nonce: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    this.gc(now);
    if (this.seen.has(nonce)) return true;
    this.seen.set(nonce, now + this.ttlSeconds);
    this.flushToDisk();
    return false;
  }

  private gc(now: number) {
    if (this.seen.size < this.maxEntries / 2) {
      for (const [k, exp] of this.seen) {
        if (exp > now) break;
        this.seen.delete(k);
      }
      return;
    }
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
    // 极端情况下仍超限，丢弃最旧条目
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATFORMS = new Set(['chaoxing', 'zhihuishu', 'pta']);
const MODES = new Set(['draft', 'submit']);

export function validateJobId(jobId: unknown): string {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new ValidationError('jobId 非法 (仅允许字母数字与 ._:- ，最长 128)');
  }
  return jobId;
}

export function validatePlatform(platform: unknown): string {
  const p = typeof platform === 'string' && platform ? platform.toLowerCase() : 'chaoxing';
  if (!PLATFORMS.has(p)) throw new ValidationError(`platform 不在白名单内: ${String(platform)}`);
  return p;
}

export function validateMode(mode: unknown): 'draft' | 'submit' {
  const m = typeof mode === 'string' && mode ? mode : 'draft';
  if (!MODES.has(m)) throw new ValidationError(`mode 非法: ${String(mode)}`);
  return m as 'draft' | 'submit';
}

export function validateDeadline(deadline: unknown): string | undefined {
  if (deadline === undefined || deadline === null || deadline === '') return undefined;
  if (typeof deadline !== 'string' || deadline.length > 64 || /[\r\n<>]/.test(deadline)) {
    throw new ValidationError('deadline 非法');
  }
  return deadline;
}

/**
 * 任务 URL 校验：仅允许 https + 白名单域名，禁止内嵌账号、非标端口与控制字符
 */
export function validateTaskUrl(raw: unknown, allowlist: string[]): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new ValidationError('taskUrl 缺失或过长');
  }
  if (/[\s<>"'`\\]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ValidationError('taskUrl 含非法字符');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('taskUrl 不是合法 URL');
  }
  if (url.protocol !== 'https:') throw new ValidationError('taskUrl 仅允许 https 协议');
  if (url.username || url.password) throw new ValidationError('taskUrl 不允许内嵌凭据');
  if (url.port && url.port !== '443') throw new ValidationError('taskUrl 不允许非标准端口');

  const host = url.hostname.toLowerCase();
  const allowed = allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) throw new ValidationError(`taskUrl 域名不在白名单内: ${host}`);

  return url.toString();
}

export class ValidationError extends Error {
  readonly status = 400;
}
