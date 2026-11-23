import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { BrowserCookie } from '../../core/browser-profile';

interface PendingCdpCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * 编码单帧 RFC 6455 客户端 WebSocket 数据帧（强制掩码）
 */
export function encodeWebSocketClientFrame(payload: string | Buffer, opcode = 0x1): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const maskKey = crypto.randomBytes(4);
  const len = data.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
    maskKey.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    maskKey.copy(header, 10);
  }

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = data[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, masked]);
}

/**
 * 从接收缓冲区解析完整 RFC 6455 WebSocket 帧，返回解析出的帧数组及未消费字节数
 */
export function decodeWebSocketFrames(buffer: Buffer): {
  frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>;
  consumedBytes: number;
} {
  const frames: Array<{ fin: boolean; opcode: number; payload: Buffer }> = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      const bigLen = buffer.readBigUInt64BE(cursor);
      if (bigLen > BigInt(32 * 1024 * 1024)) {
        throw new Error('CDP WebSocket frame exceeds 32MB limit');
      }
      payloadLen = Number(bigLen);
      cursor += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;

    let payload = buffer.subarray(cursor + maskLen, cursor + maskLen + payloadLen);
    if (masked) {
      const key = buffer.subarray(cursor, cursor + 4);
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ key[i & 3];
      }
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + maskLen + payloadLen;
  }

  return { frames, consumedBytes: offset };
}

/**
 * 零外部依赖的 Chrome DevTools Protocol (CDP) WebSocket 客户端
 * 兼容 Node 18/20，无需引入 puppeteer / playwright / ws。
 */
export class CdpClient {
  private socket: net.Socket;
  private recvBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragmentChunks: Buffer[] = [];
  private fragmentOpcode = 0x1;
  private nextId = 1;
  private pending = new Map<number, PendingCdpCall>();
  private closed = false;

  private constructor(socket: net.Socket, initialRest?: Buffer) {
    this.socket = socket;
    if (initialRest && initialRest.length > 0) {
      this.onData(initialRest);
    }
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err) => this.rejectAllPending(err));
    this.socket.on('close', () => {
      this.closed = true;
      this.rejectAllPending(new Error('CDP WebSocket 连接已关闭'));
    });
  }

  public static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpClient> {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`连接 CDP WebSocket 超时: ${wsUrl}`));
      }, timeoutMs);

      const req = http.request({
        host: parsed.hostname,
        port: Number(parsed.port || 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        const accept = String(res.headers['sec-websocket-accept'] || '');
        if (accept !== expectedAccept) {
          socket.destroy();
          reject(new Error('CDP WebSocket 握手校验失败'));
          return;
        }
        resolve(new CdpClient(socket, head));
      });

      req.on('response', (res) => {
        clearTimeout(timer);
        reject(new Error(`CDP 拒绝 WebSocket 升级: HTTP ${res.statusCode}`));
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.end();
    });
  }

  public static async connectToFirstPage(
    cdpHttpUrl: string,
    preferUrlContains?: string,
    waitMs = 10000
  ): Promise<{ client: CdpClient; target: CdpTargetInfo }> {
    const base = cdpHttpUrl.replace(/\/+$/, '');
    const deadline = Date.now() + waitMs;
    let lastErr = '';

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const targets = (await res.json()) as CdpTargetInfo[];
          const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          const picked =
            (preferUrlContains && pages.find((t) => t.url.includes(preferUrlContains))) || pages[0];
          if (picked?.webSocketDebuggerUrl) {
            const client = await CdpClient.connect(picked.webSocketDebuggerUrl, 5000);
            await client.send('Page.enable');
            await client.send('Runtime.enable');
            await client.send('Network.enable');
            return { client, target: picked };
          }
        }
      } catch (e: any) {
        lastErr = e?.message || String(e);
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    throw new Error(`未能在 ${base} 找到可调试的浏览器页面目标${lastErr ? `: ${lastErr}` : ''}`);
  }

  private onData(chunk: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
    let decoded;
    try {
      decoded = decodeWebSocketFrames(this.recvBuffer);
    } catch (err: any) {
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
      this.close();
      return;
    }

    if (decoded.consumedBytes > 0) {
      this.recvBuffer = this.recvBuffer.subarray(decoded.consumedBytes);
    }

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        // Ping -> Pong
        if (!this.closed) {
          this.socket.write(encodeWebSocketClientFrame(frame.payload, 0xA));
        }
        continue;
      }
      if (frame.opcode === 0xA) {
        continue;
      }

      if (frame.opcode !== 0x0) {
        this.fragmentOpcode = frame.opcode;
        this.fragmentChunks = [frame.payload];
      } else {
        this.fragmentChunks.push(frame.payload);
      }

      if (frame.fin) {
        const full = Buffer.concat(this.fragmentChunks).toString('utf8');
        this.fragmentChunks = [];
        if (this.fragmentOpcode === 0x1) {
          this.handleJsonMessage(full);
        }
      }
    }
  }

  private handleJsonMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const call = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error) {
          call.reject(new Error(`CDP ${msg.error.code || ''}: ${msg.error.message || 'Unknown error'}`));
        } else {
          call.resolve(msg.result);
        }
      }
    } catch {
      // ignore non-JSON debug payload
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, call] of this.pending.entries()) {
      clearTimeout(call.timer);
      call.reject(err);
      this.pending.delete(id);
    }
  }

  public send<T = any>(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`CDP 连接已关闭，无法调用 ${method}`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeWebSocketClientFrame(payload, 0x1));
    });
  }

  public async evaluate<T = any>(expression: string, timeoutMs = 15000): Promise<T> {
    const res = await this.send<any>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      const msg =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        '页面脚本执行异常';
      throw new Error(msg);
    }
    return res?.result?.value as T;
  }

  public async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }

  public async setCookies(cookies: BrowserCookie[]): Promise<void> {
    const clean = (cookies || [])
      .filter((c) => c && c.name && c.domain)
      .map((c) => ({
        name: c.name,
        value: c.value ?? '',
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: Boolean(c.httpOnly),
        ...(c.expires ? { expires: c.expires } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      }));
    if (clean.length === 0) return;
    await this.send('Network.setCookies', { cookies: clean });
  }

  public async getAllCookies(): Promise<BrowserCookie[]> {
    const res = await this.send<{ cookies?: any[] }>('Network.getAllCookies');
    return (res?.cookies || []).map((c) => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || ''),
      path: String(c.path || '/'),
      expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite,
    }));
  }

  public async captureScreenshotBase64(): Promise<string> {
    const res = await this.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
    return res?.data || '';
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeWebSocketClientFrame(Buffer.alloc(0), 0x8));
    } catch {
      // ignore
    }
    this.socket.destroy();
  }
}
