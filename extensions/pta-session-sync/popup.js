const edgeUrlEl = document.getElementById('edgeUrl');
const bearerEl = document.getElementById('bearerToken');
const autoRememberEl = document.getElementById('autoRememberMe');
const autoFillEl = document.getElementById('autoFillEnabled');
const prefillBox = document.getElementById('prefillBox');
const ptaEmailEl = document.getElementById('ptaEmail');
const ptaPassEl = document.getElementById('ptaPassword');
const saveBtn = document.getElementById('saveBtn');
const syncBtn = document.getElementById('syncBtn');
const badgeEl = document.getElementById('statusBadge');
const sessionSummaryEl = document.getElementById('sessionSummary');
const syncSummaryEl = document.getElementById('syncSummary');

function togglePrefillBox() {
  prefillBox.style.display = autoFillEl.checked ? 'block' : 'none';
}

function formatExpiry(ms) {
  if (!ms || ms <= 0) return '未知（建议登录时勾选「记住我」）';
  const diffH = Math.round(((ms - Date.now()) / 3600000) * 10) / 10;
  const dateStr = new Date(ms).toLocaleString('zh-CN', { hour12: false });
  return diffH > 0 ? `${dateStr}（约剩 ${diffH}h）` : `${dateStr}（已过期）`;
}

function renderStatus(s) {
  if (!s) return;
  if (!s.configured) {
    badgeEl.className = 'badge warn';
    badgeEl.textContent = '待配置';
  } else if (s.hasLocalPtaSession) {
    badgeEl.className = 'badge ok';
    badgeEl.textContent = '已就绪';
  } else {
    badgeEl.className = 'badge warn';
    badgeEl.textContent = '未登录 PTA';
  }

  sessionSummaryEl.textContent = s.hasLocalPtaSession
    ? `已检测到本地 PTASession（${s.localCookieCount} 个 Cookie），有效期：${formatExpiry(s.localExpiresAtMs)}`
    : '当前浏览器尚未登录 pintia.cn；点击右侧登录并在页面完成一次验证码后将自动同步。';

  if (s.lastSyncMsg) {
    syncSummaryEl.textContent = `${s.lastSyncAt ? `[${s.lastSyncAt}] ` : ''}${s.lastSyncMsg}`;
    syncSummaryEl.style.color = s.lastSyncOk === false ? '#fca5a5' : '#86efac';
  } else {
    syncSummaryEl.textContent = '';
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    if (res.edgeUrl) edgeUrlEl.value = res.edgeUrl;
    if (res.bearerToken) bearerEl.value = res.bearerToken;
    autoRememberEl.checked = res.autoRememberMe !== false;
    autoFillEl.checked = Boolean(res.autoFillEnabled);
    if (res.ptaEmail) ptaEmailEl.value = res.ptaEmail;
    togglePrefillBox();
    renderStatus(res);
  });
}

autoFillEl.addEventListener('change', togglePrefillBox);

saveBtn.addEventListener('click', async () => {
  const edgeUrl = edgeUrlEl.value.trim().replace(/\/+$/, '');
  const bearerToken = bearerEl.value.trim();
  if (!edgeUrl || !bearerToken) {
    syncSummaryEl.textContent = '请填写 Edge Worker URL 和 Bearer Token';
    syncSummaryEl.style.color = '#fca5a5';
    return;
  }

  let originPattern = '';
  try {
    originPattern = `${new URL(edgeUrl).origin}/*`;
  } catch {
    syncSummaryEl.textContent = 'Edge Worker URL 格式无效';
    syncSummaryEl.style.color = '#fca5a5';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = '保存并授权中...';
  try {
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      syncSummaryEl.textContent = '未授予 Edge 域名访问权限，无法从后台同步 Cookie';
      syncSummaryEl.style.color = '#fca5a5';
      return;
    }

    const toSave = {
      edgeUrl,
      bearerToken,
      autoRememberMe: autoRememberEl.checked,
      autoFillEnabled: autoFillEl.checked,
      ptaEmail: ptaEmailEl.value.trim(),
    };
    if (ptaPassEl.value) {
      toSave.ptaPassword = ptaPassEl.value;
    }
    await chrome.storage.local.set(toSave);
    ptaPassEl.value = '';

    chrome.runtime.sendMessage({ type: 'SYNC_NOW' }, () => {
      refreshStatus();
    });
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存配置并授权同步';
  }
});

syncBtn.addEventListener('click', () => {
  syncBtn.disabled = true;
  syncBtn.textContent = '同步中...';
  chrome.runtime.sendMessage({ type: 'SYNC_NOW' }, () => {
    syncBtn.disabled = false;
    syncBtn.textContent = '立即同步 PTA 会话';
    refreshStatus();
  });
});

refreshStatus();
