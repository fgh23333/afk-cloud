import { spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { blue, cyan, green, yellow } from 'kolorist';
import {
  BrowserCookie,
  detectChromiumExecutable,
  getBrowserProfilePaths,
  pushBrowserProfileToCloud,
  readLocalStorageState,
  writeLocalStorageState,
} from '../../core/browser-profile';
import {
  buildCookieHeaderFromCookies,
  extractPtaSessionMeta,
  extractPtaSessionValue,
  extractResponseSetCookies,
  hasPtaAuthCookie,
  parseSetCookieHeaders,
  PTA_ORIGIN,
  PTA_PASSPORT_ORIGIN,
  PTA_USER_AGENT,
} from './protocol';

export interface PtaLoginOptions {
  email?: string;
  password?: string;
  timeoutSec?: number;
  autoScan?: boolean;
  port?: number;
  autoRememberMe?: boolean;
}

export interface PtaInteractiveLoginResult {
  ok: boolean;
  cookieCount: number;
  sessionExpiresAtMs: number | null;
  remainingHours: number | null;
  rememberMeLikely: boolean;
  cloudSynced: boolean;
  cloudSyncMsg: string;
  msg: string;
}

/**
 * 检测当前运行环境是否具备图形界面以拉起可见浏览器给用户手动过验证码
 */
export function detectGuiAvailable(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32' || platform === 'darwin') return true;
  return Boolean((env.DISPLAY && env.DISPLAY.trim()) || (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim()));
}

/**
 * 从 CDP Network.getAllCookies 结果筛选并归一化 pintia.cn Cookie（保留 HttpOnly 与真实过期时间）
 */
export function extractPintiaCookiesFromCdp(cdpCookies: Array<Record<string, any>>): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const c of cdpCookies || []) {
    const domain = String(c?.domain || '');
    const name = String(c?.name || '');
    const value = String(c?.value || '');
    if (!name || !value || !domain.toLowerCase().includes('pintia')) continue;

    let sameSite: 'Strict' | 'Lax' | 'None' | undefined;
    const rawSs = String(c.sameSite || '').toLowerCase();
    if (rawSs === 'strict') sameSite = 'Strict';
    else if (rawSs === 'lax') sameSite = 'Lax';
    else if (rawSs === 'none') sameSite = 'None';

    const expires =
      typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : undefined;

    out.push({
      name,
      value,
      domain,
      path: String(c.path || '/'),
      ...(expires ? { expires } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: Boolean(c.httpOnly) } : {}),
      ...(c.secure !== undefined ? { secure: Boolean(c.secure) } : {}),
      ...(sameSite ? { sameSite } : {}),
    });
  }
  return out;
}

/**
 * 生成注入 Pintia 登录页的安全辅助脚本：
 * - 自动勾选「记住我 / 保持登录」以延长 PTASession 有效期
 * - 按需预填本地账号密码（仅用户显式传入或在本地 .env 配置时）
 * - 严禁接触、点击、拖拽或绕过 TencentCaptcha，登录按钮与滑块验证码必须由用户本人交互
 */
export function buildPintiaAutoFillScript(options: {
  email?: string;
  password?: string;
  autoRememberMe?: boolean;
}): string {
  const payload = JSON.stringify({
    email: options.email || '',
    password: options.password || '',
    autoRememberMe: options.autoRememberMe !== false,
  });

  return `(function afkPtaAssist() {
    var cfg = ${payload};
    var valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    function setReactValue(input, val) {
      if (!input || !val || input.dataset.afkPrefilled === '1') return;
      if (input.value && input.value.trim() !== '') return;
      if (valueSetter && typeof valueSetter.set === 'function') {
        valueSetter.set.call(input, val);
      } else {
        input.value = val;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dataset.afkPrefilled = '1';
    }

    function checkRememberBox() {
      if (!cfg.autoRememberMe) return false;
      var explicit = document.querySelector('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]');
      if (explicit) {
        if (!explicit.checked && explicit.dataset.afkChecked !== '1') {
          explicit.dataset.afkChecked = '1';
          explicit.click();
        }
        return true;
      }
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        var txt = (labels[i].textContent || '').trim();
        if (/记住|保持登录|自动登录|remember/i.test(txt)) {
          var box = labels[i].querySelector('input[type="checkbox"]');
          if (box) {
            if (!box.checked && box.dataset.afkChecked !== '1') {
              box.dataset.afkChecked = '1';
              box.click();
            }
            return true;
          }
        }
      }
      return false;
    }

    function mountBanner(rememberOk) {
      if (document.getElementById('afk-pta-login-banner') || !document.body) return;
      var bar = document.createElement('div');
      bar.id = 'afk-pta-login-banner';
      bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;max-width:360px;padding:12px 14px;border-radius:12px;background:rgba(15,23,42,0.94);color:#e2e8f0;border:1px solid rgba(56,189,248,0.45);box-shadow:0 12px 30px rgba(0,0,0,0.4);font-size:12px;line-height:1.5;font-family:system-ui,-apple-system,sans-serif;';
      var note = rememberOk ? '已自动勾选「记住我」' : '建议勾选「记住我」延长有效期';
      if (cfg.email) note += '并预填账号';
      bar.innerHTML = '<div style="font-weight:600;color:#38bdf8;margin-bottom:4px;">afk-cloud PTA 登录助手</div><div>' + note + '。请点击登录并手工完成一次验证码，登录成功后本窗口会自动同步会话到云端并关闭。</div>';
      document.body.appendChild(bar);
    }

    if (location.pathname.indexOf('login') !== -1 || location.hostname.indexOf('passport') !== -1) {
      var userInput = document.querySelector('input[name="email"], input[name="phone"], input[autocomplete="username"], input[type="email"]');
      if (!userInput) {
        var textInputs = Array.prototype.slice.call(document.querySelectorAll('form input[type="text"], main input[type="text"]'));
        userInput = textInputs.find(function(el) {
          var hint = (el.placeholder || '') + ' ' + (el.name || '');
          return /邮|手机|账|email|phone|user/i.test(hint);
        }) || null;
      }
      var passInput = document.querySelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
      if (cfg.email && userInput) setReactValue(userInput, cfg.email);
      if (cfg.password && passInput) setReactValue(passInput, cfg.password);
      var rememberOk = checkRememberBox();
      mountBanner(rememberOk);
      return { onLoginPage: true, rememberOk: rememberOk, hasEmailInput: Boolean(userInput) };
    }
    return { onLoginPage: false };
  })();`;
}

async function allocateLocalPort(preferred?: number): Promise<number> {
  if (preferred && preferred > 1024 && preferred < 65535) return preferred;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 9229;
      srv.close(() => resolve(port));
    });
  });
}

class MinimalCdpClient {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private fragChunks: Buffer[] = [];
  private closed = false;

  private constructor() {}

  public static async connect(wsUrl: string): Promise<MinimalCdpClient> {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const client = new MinimalCdpClient();

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: parsed.hostname,
        port: Number(parsed.port || 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      const timer = setTimeout(() => {
        req.destroy(new Error('CDP WebSocket 连接超时'));
      }, 10_000);

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.on('upgrade', (_res, socket, head) => {
        clearTimeout(timer);
        client.socket = socket;
        if (head && head.length > 0) {
          client.buffer = Buffer.concat([client.buffer, head]);
        }
        socket.on('data', (chunk) => client.onData(chunk));
        socket.on('close', () => client.onClose());
        socket.on('error', () => client.onClose());
        resolve(client);
      });

      req.end();
    });
  }

  public send<T = any>(method: string, params: Record<string, any> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeFrame(0x1, Buffer.from(payload, 'utf8'));
    });
  }

  public close(): void {
    this.closed = true;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
      this.socket?.end();
    } catch {
      // ignore
    }
  }

  private writeFrame(opcode: number, data: Buffer): void {
    const len = data.length;
    const maskKey = crypto.randomBytes(4);
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      maskKey.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      maskKey.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      maskKey.copy(header, 10);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = data[i] ^ maskKey[i % 4];
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const key = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ key[i % 4];
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x8) {
        this.onClose();
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xA, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragChunks.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.fragChunks).toString('utf8');
          this.fragChunks = [];
          this.handleMessage(text);
        }
      }
    }
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text);
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || 'CDP Error'));
        else entry.resolve(msg.result);
      }
    } catch {
      // ignore non-JSON or CDP event frames
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('CDP Socket 已断开'));
    }
    this.pending.clear();
  }
}

async function verifyPtaCookiesLive(cookies: BrowserCookie[]): Promise<{ ok: boolean; rolledCookies: BrowserCookie[] }> {
  const cookieHeader = buildCookieHeaderFromCookies(cookies);
  if (!hasPtaAuthCookie(cookieHeader)) return { ok: false, rolledCookies: [] };
  const rolledCookies: BrowserCookie[] = [];

  for (const url of [
    `${PTA_PASSPORT_ORIGIN}/api/u/current`,
    `${PTA_ORIGIN}/api/problem-sets?filter=%7B%7D&page=0&limit=1`,
  ]) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json;charset=UTF-8',
          Referer: `${PTA_ORIGIN}/problem-sets`,
          Origin: PTA_ORIGIN,
          'User-Agent': PTA_USER_AGENT,
        },
        signal: AbortSignal.timeout(8000),
      });
      const sc = extractResponseSetCookies(res);
      if (sc.length > 0) rolledCookies.push(...parseSetCookieHeaders(sc));
      if (res.ok) return { ok: true, rolledCookies };
    } catch {
      // try next probe endpoint
    }
  }
  return { ok: false, rolledCookies };
}

async function syncLoginCookiesToCloud(
  cookies: BrowserCookie[],
  meta: { rememberMe: boolean; source: string }
): Promise<{ synced: boolean; msg: string }> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  if (!edgeUrl) {
    return { synced: false, msg: '未配置 AFK_EDGE_WORKER_URL，仅保存在本地 .cache/browser-profiles/pta/' };
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;
    const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/pta/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cookies,
        source: meta.source,
        rememberMe: meta.rememberMe,
        verify: false,
        triggerScan: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      return {
        synced: true,
        msg: data?.scanResult?.msg
          ? `已同步至 Cloudflare D1 并完成云端首扫（${data.scanResult.msg}）`
          : '已成功将 PTA 完整登录态（含 HttpOnly PTASession）同步至 Cloudflare D1',
      };
    }
    if (res.status === 404) {
      return await pushBrowserProfileToCloud('pta');
    }
    return { synced: false, msg: `Edge /api/pta/session 返回 HTTP ${res.status}` };
  } catch (err: any) {
    return await pushBrowserProfileToCloud('pta').catch(() => ({
      synced: false,
      msg: `云端同步异常: ${err?.message || err}`,
    }));
  }
}

/**
 * 启动本地真实可见浏览器引导用户在 pintia.cn 登录（自动勾选「记住我」、按需预填账密、绝不触碰验证码）
 * 用户完成一次滑块验证码后自动捕获 HttpOnly PTASession + 真实过期时间，同步 Cloudflare D1 并关闭窗口。
 */
export async function runInteractivePtaLogin(options: PtaLoginOptions = {}): Promise<PtaInteractiveLoginResult> {
  if (!detectGuiAvailable()) {
    throw new Error(
      [
        '当前处于无图形界面 Linux 服务器（未检测到 DISPLAY / WAYLAND_DISPLAY），无法直接弹出本地可见浏览器窗口供您操作验证码。',
        '推荐改用以下零开销并行方式完成一次登录并自动同步到本机与 Cloudflare D1：',
        '  1) 浏览器伴侣扩展：在常用电脑 Chrome/Edge 或手机支持的浏览器加载 extensions/pta-session-sync/，正常登录 pintia.cn 即自动同步；',
        '  2) Web 看板零 CLI 录入：打开 Edge Dashboard 的「设置 -> PTA 会话管理」，直接粘贴 Cookie 一键校验并同步；',
        '  3) 本地终端一键登录：在有桌面环境的电脑拉取仓库并配置相同的 AFK_EDGE_WORKER_URL 与 AFK_EDGE_BEARER_TOKEN，执行 pnpm afk pta login。',
      ].join('\n')
    );
  }

  const exe = detectChromiumExecutable();
  if (!exe) {
    throw new Error('未检测到 Chrome/Chromium/Edge 可执行文件，请先安装浏览器或设置环境变量 CHROME_PATH');
  }

  const email = options.email ?? process.env.PTA_EMAIL ?? '';
  const password = options.password ?? process.env.PTA_PASSWORD ?? '';
  const timeoutSec = Math.max(30, options.timeoutSec || 180);
  const port = await allocateLocalPort(options.port);
  const { userDataDir } = getBrowserProfilePaths('pta');
  const prevState = readLocalStorageState('pta');
  const prevSessionVal = prevState ? extractPtaSessionValue(prevState.cookies || []) : '';

  console.log(cyan(`\n======================================================`));
  console.log(cyan(` 🔐 PTA 拼题 A 真实浏览器辅助登录（自动勾选记住我）`));
  console.log(cyan(`======================================================`));
  console.log(` 🌐 浏览器路径 : ${exe}`);
  console.log(` 📂 Profile 目录 : ${userDataDir}`);
  console.log(` ⏱️  等待超时   : ${timeoutSec} 秒`);
  console.log(yellow(` 💡 窗口打开后，请点击登录并手工完成一次验证码（系统绝不自动破解验证码）。`));

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,820',
    `${PTA_ORIGIN}/auth/login`,
  ];

  const child = spawn(exe, args, { stdio: 'ignore' });
  let cdp: MinimalCdpClient | null = null;
  let capturedCookies: BrowserCookie[] = [];

  try {
    // 等待 CDP HTTP endpoint 就绪
    let wsUrl = '';
    const connectDeadline = Date.now() + 15_000;
    while (Date.now() < connectDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const targets = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
          const page =
            targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url || '').includes('pintia.cn')) ||
            targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!wsUrl) {
      throw new Error(`浏览器 CDP 端口 127.0.0.1:${port} 启动超时，请确认本机图形桌面正常或端口未被占用`);
    }

    cdp = await MinimalCdpClient.connect(wsUrl);
    const assistScript = buildPintiaAutoFillScript({
      email,
      password,
      autoRememberMe: options.autoRememberMe !== false,
    });

    const waitDeadline = Date.now() + timeoutSec * 1000;
    let verifiedCount = 0;

    while (Date.now() < waitDeadline) {
      if (child.exitCode !== null) {
        throw new Error('登录窗口已被关闭，未完成 PTA 登录态捕获');
      }

      await cdp.send('Runtime.evaluate', { expression: assistScript, returnByValue: true }).catch(() => null);
      const cookieRes = await cdp.send<{ cookies?: Array<Record<string, any>> }>('Network.getAllCookies').catch(() => null);
      const cookies = extractPintiaCookiesFromCdp(cookieRes?.cookies || []);
      const curSessionVal = extractPtaSessionValue(cookies);

      if (curSessionVal) {
        const urlEval = await cdp
          .send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
          .catch(() => null);
        const curHref = String(urlEval?.result?.value || '');
        const leftLoginPage = curHref.includes('pintia.cn') && !curHref.includes('/auth/login') && !curHref.includes('/login');
        const changedSession = Boolean(curSessionVal && curSessionVal !== prevSessionVal);

        if (changedSession || leftLoginPage || verifiedCount === 0) {
          verifiedCount++;
          const check = await verifyPtaCookiesLive(cookies);
          if (check.ok) {
            capturedCookies = [...cookies];
            for (const rc of check.rolledCookies) {
              const idx = capturedCookies.findIndex((c) => c.name === rc.name && c.domain === rc.domain);
              if (idx >= 0) capturedCookies[idx] = { ...capturedCookies[idx], ...rc };
              else capturedCookies.push(rc);
            }
            break;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!hasPtaAuthCookie(capturedCookies)) {
      throw new Error(`等待 ${timeoutSec} 秒仍未检测到有效 PTA 登录会话，请确认已完成登录与验证码验证`);
    }

    const meta = extractPtaSessionMeta({
      platform: 'pta',
      updatedAt: '',
      cookies: capturedCookies,
      origins: [],
    });

    writeLocalStorageState('pta', {
      cookies: capturedCookies,
      origins: [],
      source: 'cli-login',
      rememberMe: meta.rememberMeLikely,
      sessionExpiresAtMs: meta.expiresAtMs,
    });

    const cloudRes = await syncLoginCookiesToCloud(capturedCookies, {
      rememberMe: meta.rememberMeLikely,
      source: 'cli-login',
    });

    console.log(green(`\n✅ [PTA 登录成功] 已捕获 ${capturedCookies.length} 个 pintia.cn Cookie（含 HttpOnly PTASession）`));
    if (meta.remainingHours !== null) {
      console.log(blue(`⏳ 会话预计有效期 : ~${meta.remainingHours} 小时（${meta.rememberMeLikely ? '长效 RememberMe 会话' : '标准会话'}）`));
    }
    console.log(cloudRes.synced ? green(`☁️  云端同步状态  : ${cloudRes.msg}`) : yellow(`ℹ️  同步提示      : ${cloudRes.msg}`));

    // 关闭可见浏览器释放内存
    await cdp.send('Browser.close').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    if (options.autoScan !== false) {
      const { PtaAdapter } = await import('./index');
      const cookieHeader = buildCookieHeaderFromCookies(capturedCookies);
      await new PtaAdapter(cookieHeader).scanPendingHomework(true).catch((e) => {
        console.log(yellow(`⚠️ 登录后即时巡检提示: ${e?.message || e}`));
      });
    }

    return {
      ok: true,
      cookieCount: capturedCookies.length,
      sessionExpiresAtMs: meta.expiresAtMs,
      remainingHours: meta.remainingHours,
      rememberMeLikely: meta.rememberMeLikely,
      cloudSynced: cloudRes.synced,
      cloudSyncMsg: cloudRes.msg,
      msg: 'PTA 登录态已捕获并完成同步',
    };
  } finally {
    try {
      cdp?.close();
    } catch {
      // ignore
    }
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}
