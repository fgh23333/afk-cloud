/**
 * afk-cloud 服务间请求签名 (Edge Worker <-> GCP Shim)
 *
 * 基于 WebCrypto (globalThis.crypto.subtle) 的 HMAC-SHA256 签名方案：
 *   - 签名覆盖 方法 / 路径 / 时间戳 / Nonce / 请求体摘要
 *   - 时间窗口 (默认 300s) + Nonce 去重，杜绝重放攻击
 *   - 常量时间比较，杜绝时序侧信道泄露
 */

export const SIGNATURE_VERSION = 'v1';
export const HEADER_TIMESTAMP = 'X-AFK-Timestamp';
export const HEADER_NONCE = 'X-AFK-Nonce';
export const HEADER_SIGNATURE = 'X-AFK-Signature';

export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function getSubtle(): SubtleCrypto {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) 不可用');
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
 * 生成签名请求头 (Edge 发给 Shim 时使用)
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
 * 校验签名请求 (Edge 接收 Shim 回调时使用)
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

  if (params.seenNonce && (await params.seenNonce(nonce, timestamp))) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  return { ok: true, nonce, timestamp };
}
