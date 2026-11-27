(function () {
  if (
    location.pathname.indexOf('login') === -1 &&
    location.hostname.indexOf('passport') === -1
  ) {
    return;
  }

  var valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  );

  function setInputValue(el, val) {
    if (!el || !val || el.dataset.afkPrefilled === '1') return;
    if (el.value && el.value.trim() !== '') return;
    if (valueSetter && typeof valueSetter.set === 'function') {
      valueSetter.set.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dataset.afkPrefilled = '1';
  }

  function ensureRememberChecked() {
    var box = document.querySelector(
      'input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]'
    );
    if (box) {
      if (!box.checked && box.dataset.afkChecked !== '1') {
        box.dataset.afkChecked = '1';
        box.click();
      }
      return true;
    }

    var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
    for (var i = 0; i < labels.length; i++) {
      var text = (labels[i].textContent || '').trim();
      if (/记住|保持登录|自动登录|remember/i.test(text)) {
        var cb = labels[i].querySelector('input[type="checkbox"]');
        if (cb) {
          if (!cb.checked && cb.dataset.afkChecked !== '1') {
            cb.dataset.afkChecked = '1';
            cb.click();
          }
          return true;
        }
      }
    }
    return false;
  }

  function mountStatusBanner(rememberChecked, hasPrefill) {
    if (document.getElementById('afk-ext-pta-hint') || !document.body) return;
    var bar = document.createElement('div');
    bar.id = 'afk-ext-pta-hint';
    bar.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:999999;max-width:340px;' +
      'padding:11px 14px;border-radius:12px;background:rgba(15,23,42,0.92);' +
      'color:#e2e8f0;border:1px solid rgba(34,197,94,0.45);' +
      'box-shadow:0 12px 28px rgba(0,0,0,0.35);font-size:12px;line-height:1.5;' +
      'font-family:system-ui,-apple-system,sans-serif;';

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#4ade80;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;';
    title.textContent = 'afk-cloud 会话伴侣就绪';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:15px;cursor:pointer;padding:0 4px;';
    closeBtn.addEventListener('click', function () {
      bar.remove();
    });
    title.appendChild(closeBtn);

    var desc = document.createElement('div');
    var notes = [];
    if (rememberChecked) notes.push('已自动勾选「记住我」');
    if (hasPrefill) notes.push('已填入本地保存的账号');
    notes.push('请点击登录并滑一下验证码，成功后扩展会自动将 HttpOnly 会话同步至 Cloudflare D1。');
    desc.textContent = notes.join('；');

    bar.appendChild(title);
    bar.appendChild(desc);
    document.body.appendChild(bar);
  }

  function applyAssist(cfg) {
    var rememberOk = false;
    if (cfg.autoRememberMe !== false) {
      rememberOk = ensureRememberChecked();
    }

    var hasPrefill = false;
    if (cfg.autoFillEnabled && (cfg.ptaEmail || cfg.ptaPassword)) {
      var userInput = document.querySelector(
        'input[name="email"], input[name="phone"], input[autocomplete="username"], input[type="email"]'
      );
      if (!userInput) {
        var candidates = Array.prototype.slice.call(
          document.querySelectorAll('form input[type="text"], main input[type="text"]')
        );
        userInput = candidates.find(function (el) {
          var hint = (el.placeholder || '') + ' ' + (el.name || '');
          return /邮|手机|账|email|phone|user/i.test(hint);
        }) || null;
      }
      var passInput = document.querySelector(
        'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
      );
      if (cfg.ptaEmail && userInput) {
        setInputValue(userInput, cfg.ptaEmail);
        hasPrefill = true;
      }
      if (cfg.ptaPassword && passInput) {
        setInputValue(passInput, cfg.ptaPassword);
      }
    }

    mountStatusBanner(rememberOk, hasPrefill);
  }

  chrome.storage.local.get(
    { autoRememberMe: true, autoFillEnabled: false, ptaEmail: '', ptaPassword: '' },
    function (cfg) {
      applyAssist(cfg);
      var attempts = 0;
      var observer = new MutationObserver(function () {
        attempts++;
        applyAssist(cfg);
        if (attempts >= 20) observer.disconnect();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      setTimeout(function () {
        observer.disconnect();
      }, 10000);
    }
  );
})();
