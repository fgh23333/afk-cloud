const ALARM_NAME = 'pta-rolling-sync';
let debounceTimer = null;

function mapChromeCookie(c) {
  let sameSite;
  if (c.sameSite === 'strict') sameSite = 'Strict';
  else if (c.sameSite === 'lax') sameSite = 'Lax';
  else if (c.sameSite === 'no_restriction') sameSite = 'None';

  return {
    name: String(c.name || ''),
    value: String(c.value || ''),
    domain: String(c.domain || '.pintia.cn'),
    path: String(c.path || '/'),
    ...(typeof c.expirationDate === 'number' && c.expirationDate > 0
      ? { expires: Math.floor(c.expirationDate) }
      : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: Boolean(c.httpOnly) } : {}),
    ...(c.secure !== undefined ? { secure: Boolean(c.secure) } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function collectPintiaCookies() {
  const [mainCookies, passportCookies] = await Promise.all([
    chrome.cookies.getAll({ url: 'https://pintia.cn/' }),
    chrome.cookies.getAll({ url: 'https://passport.pintia.cn/' }),
  ]);

  const dedup = new Map();
  for (const raw of [...mainCookies, ...passportCookies]) {
    if (!raw || !raw.name || !raw.value) continue;
    if (!String(raw.domain || '').toLowerCase().includes('pintia')) continue;
    const key = `${raw.name}|${raw.domain}|${raw.path}`;
    dedup.set(key, mapChromeCookie(raw));
  }
  return Array.from(dedup.values());
}

async function saveSyncState(patch) {
  await chrome.storage.local.set(patch);
}

async function syncPtaCookies(reason, force) {
  const cfg = await chrome.storage.local.get({
    edgeUrl: '',
    bearerToken: '',
    autoRememberMe: true,
    lastSignature: '',
  });

  const edgeUrl = String(cfg.edgeUrl || '').trim().replace(/\/+$/, '');
  const bearerToken = String(cfg.bearerToken || '').trim();
  if (!edgeUrl || !bearerToken) {
    setBadge('CFG', '#f59e0b');
    return { ok: false, configured: false, msg: '请先配置 Edge Worker URL 与 Bearer Token' };
  }

  const cookies = await collectPintiaCookies();
  const ptaCookie = cookies.find((c) => c.name === 'PTASession' && Boolean(c.value));
  if (!ptaCookie) {
    setBadge('', '#64748b');
    await saveSyncState({
      lastCheckedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      lastSyncOk: false,
      lastSyncMsg: '当前浏览器尚未登录 pintia.cn（未检测到 PTASession）',
      sessionExpiresAtMs: null,
    });
    return { ok: false, configured: true, notLoggedIn: true, msg: '当前浏览器尚未登录 pintia.cn' };
  }

  const expiresAtMs = ptaCookie.expires ? ptaCookie.expires * 1000 : null;
  const sig = `${ptaCookie.value.length}:${ptaCookie.value.slice(0, 8)}:${ptaCookie.expires || 0}`;
  if (!force && sig === cfg.lastSignature && reason !== 'manual') {
    return { ok: true, skipped: true, cookieCount: cookies.length, sessionExpiresAtMs: expiresAtMs };
  }

  const endpoint = `${edgeUrl}/api/pta/session`;
  const hasPermission = await chrome.permissions.contains({ origins: [`${new URL(edgeUrl).origin}/*`] }).catch(() => true);
  if (!hasPermission) {
    setBadge('PRM', '#f59e0b');
    const msg = '请在扩展弹窗点击“保存配置并同步”以授予 Edge 域名网络权限';
    await saveSyncState({ lastSyncOk: false, lastSyncMsg: msg });
    return { ok: false, msg };
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        cookies,
        source: 'browser-extension',
        rememberMe: cfg.autoRememberMe !== false,
        verify: true,
        triggerScan: reason !== 'alarm',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const errMsg = data?.error || `HTTP ${res.status}`;
      setBadge('ERR', '#ef4444');
      await saveSyncState({
        lastSyncAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        lastSyncOk: false,
        lastSyncMsg: `同步失败: ${errMsg}`,
        sessionExpiresAtMs: expiresAtMs,
      });
      return { ok: false, msg: errMsg };
    }

    setBadge('OK', '#16a34a');
    const remainingHours = data?.sessionStatus?.remainingHours ?? null;
    const msg = `同步成功 (${cookies.length} Cookies · ${data.verified === 'live' ? '活体校验通过' : '已落盘'}${remainingHours !== null ? ` · 预计剩 ${remainingHours}h` : ''})`;
    await saveSyncState({
      lastSignature: sig,
      lastSyncAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      lastSyncOk: true,
      lastSyncMsg: msg,
      sessionExpiresAtMs: data?.sessionStatus?.sessionExpiresAtMs ?? expiresAtMs,
      remainingHours,
    });
    return { ok: true, msg, cookieCount: cookies.length, data };
  } catch (err) {
    setBadge('ERR', '#ef4444');
    const errMsg = err?.message || String(err);
    await saveSyncState({
      lastSyncAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      lastSyncOk: false,
      lastSyncMsg: `网络异常: ${errMsg}`,
    });
    return { ok: false, msg: errMsg };
  }
}

function scheduleCookieSync(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncPtaCookies(reason, true);
  }, 1500);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 360 });
  void syncPtaCookies('installed', false);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 360 });
  void syncPtaCookies('startup', false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void syncPtaCookies('alarm', false);
  }
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo.cookie;
  if (!cookie || changeInfo.removed) return;
  if (!String(cookie.domain || '').toLowerCase().includes('pintia')) return;
  if (cookie.name === 'PTASession') {
    scheduleCookieSync('cookie-changed');
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'SYNC_NOW') {
    void syncPtaCookies('manual', true).then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    void (async () => {
      const [cfg, cookies] = await Promise.all([
        chrome.storage.local.get({
          edgeUrl: '',
          bearerToken: '',
          autoRememberMe: true,
          autoFillEnabled: false,
          ptaEmail: '',
          lastSyncAt: '',
          lastSyncOk: null,
          lastSyncMsg: '',
          sessionExpiresAtMs: null,
          remainingHours: null,
        }),
        collectPintiaCookies(),
      ]);
      const ptaCookie = cookies.find((c) => c.name === 'PTASession' && Boolean(c.value));
      sendResponse({
        configured: Boolean(cfg.edgeUrl && cfg.bearerToken),
        hasLocalPtaSession: Boolean(ptaCookie),
        localCookieCount: cookies.length,
        localExpiresAtMs: ptaCookie?.expires ? ptaCookie.expires * 1000 : cfg.sessionExpiresAtMs,
        ...cfg,
        ptaPassword: '',
      });
    })();
    return true;
  }
  return false;
});
