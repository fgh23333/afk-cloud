/**
 * afk-cloud 服务间请求签名 (Edge Worker <-> GCP Shim)
 *
 * 采用 HMAC-SHA256 + 时间戳 + 一次性 Nonce 的签名方案，替代裸 Bearer Token：
 *   - 密钥本身永不在网络上传输（即使 Tunnel 日志或中间代理泄露请求，也无法伪造新请求）
 *   - 签名覆盖 方法 / 路径 / 时间戳 / Nonce / 请求体摘要，任何篡改都会导致验签失败
 *   - 时间窗口 + Nonce 去重，防止重放攻击
 *
 * 本文件只依赖 WebCrypto（globalThis.crypto.subtle），可同时运行在 Cloudflare Workers 与 Node.js >= 20。
 */

export const SIGNATURE_VERSION = 'v1';
export const HEADER_TIMESTAMP = 'X-AFK-Timestamp';
export const HEADER_NONCE = 'X-AFK-Nonce';
export const HEADER_SIGNATURE = 'X-AFK-Signature';

/** 默认允许的时钟偏差（秒） */
export const DEFAULT_MAX_SKEW_SECONDS = 300;
/** 共享密钥最短长度（字符） */
export const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function getSubtle(): SubtleCrypto {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) 不可用，请使用 Node.js >= 20 或 Cloudflare Workers 运行');
  }
  return c.subtle as SubtleCrypto;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  (globalThis as any).crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await getSubtle().digest('SHA-256', encoder.encode(data)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = getSubtle();
  const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toHex(await subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * 常量时间字符串比较（先对两侧做 HMAC 归一化为等长摘要，避免长度与逐字节时序泄露）
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const salt = randomHex(16);
  const [ha, hb] = await Promise.all([hmacSha256Hex(salt, a), hmacSha256Hex(salt, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }
  return diff === 0 && a.length === b.length;
}

export function isStrongSecret(secret: string | undefined | null): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

function canonicalString(method: string, pathWithQuery: string, timestamp: string, nonce: string, bodyHash: string) {
  return [SIGNATURE_VERSION, method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyHash].join('\n');
}

/**
 * 生成签名请求头
 */
export async function signRequest(params: {
  secret: string;
  method: string;
  pathWithQuery: string;
  body?: string;
  nowSeconds?: number;
}): Promise<Record<string, string>> {
  if (!isStrongSecret(params.secret)) {
    throw new Error(`签名密钥长度不足 ${MIN_SECRET_LENGTH} 字符，拒绝签名`);
  }
  const timestamp = String(params.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = randomHex(16);
  const bodyHash = await sha256Hex(params.body || '');
  const signature = await hmacSha256Hex(
    params.secret,
    canonicalString(params.method, params.pathWithQuery, timestamp, nonce, bodyHash)
  );
  return {
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: `${SIGNATURE_VERSION}=${signature}`,
  };
}

export type VerifyResult = { ok: true; nonce: string; timestamp: number } | { ok: false; reason: string };

/**
 * 校验签名请求（Nonce 去重由调用方通过 seenNonce 回调实现）
 *
 * @param getHeader  读取请求头（大小写不敏感）
 * @param seenNonce  若该 nonce 已出现过返回 true（并由调用方负责登记），用于防重放
 */
export async function verifySignedRequest(params: {
  secret: string | undefined;
  method: string;
  pathWithQuery: string;
  body: string;
  getHeader: (name: string) => string | null | undefined;
  seenNonce?: (nonce: string, timestamp: number) => Promise<boolean> | boolean;
  maxSkewSeconds?: number;
  nowSeconds?: number;
}): Promise<VerifyResult> {
  if (!isStrongSecret(params.secret)) {
    return { ok: false, reason: 'server_secret_not_configured' };
  }

  const tsRaw = params.getHeader(HEADER_TIMESTAMP) || '';
  const nonce = params.getHeader(HEADER_NONCE) || '';
  const sigRaw = params.getHeader(HEADER_SIGNATURE) || '';

  if (!/^\d{9,11}$/.test(tsRaw) || !/^[a-f0-9]{32}$/.test(nonce) || !sigRaw.startsWith(`${SIGNATURE_VERSION}=`)) {
    return { ok: false, reason: 'missing_or_malformed_signature_headers' };
  }

  const timestamp = parseInt(tsRaw, 10);
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = params.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(now - timestamp) > maxSkew) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  const bodyHash = await sha256Hex(params.body || '');
  const expected = await hmacSha256Hex(
    params.secret,
    canonicalString(params.method, params.pathWithQuery, tsRaw, nonce, bodyHash)
  );
  const provided = sigRaw.slice(SIGNATURE_VERSION.length + 1);
  if (!(await timingSafeEqualString(expected, provided))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // 验签通过后才登记 nonce，避免攻击者用垃圾请求刷爆 nonce 表
  if (params.seenNonce && (await params.seenNonce(nonce, timestamp))) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  return { ok: true, nonce, timestamp };
}
