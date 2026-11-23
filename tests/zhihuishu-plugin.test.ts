import assert from 'node:assert/strict';
import crypto from 'crypto';
import http from 'http';
import { JSDOM } from 'jsdom';
import { PluginRegistry } from '../packages/core/plugin';
import { WEB_PLATFORM_PRESETS, ZHIHUISHU_INJECT_SCRIPT } from '../packages/adapters/web-agent';
import {
  CdpClient,
  decodeWebSocketFrames,
  encodeWebSocketClientFrame,
} from '../packages/adapters/web-agent/cdp-client';
import {
  buildZhihuishuInspectExpression,
  clampZhihuishuRate,
  isValidZhihuishuStudyUrl,
  ZhihuishuAdapter,
} from '../packages/adapters/zhihuishu';

function runInDom<T>(html: string, url: string, expr: string, mutate?: (win: any) => void): T {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const win = dom.window as any;
  win.getComputedStyle = (el: HTMLElement) => ({
    display: el?.style?.display || 'block',
    visibility: el?.style?.visibility || 'visible',
    opacity: el?.style?.opacity || '1',
    position: el?.style?.position || 'static',
  });
  if (mutate) mutate(win);
  const raw = win.eval(expr);
  return raw === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(raw)) as T);
}

async function runTests() {
  console.log('\n🧪 开始运行智慧树合规倍速播放插件与 CDP 客户端专项测试...\n');

  // 1. 插件注册与合规红线校验
  {
    const adapter = new ZhihuishuAdapter();
    assert.strictEqual(adapter.manifest.id, 'zhihuishu');
    assert.ok(adapter.manifest.capabilities.includes('browser-cdp'));

    const reg = PluginRegistry.getInstance();
    reg.register(adapter);
    assert.ok(reg.has('zhihuishu'), 'ZhihuishuAdapter 应注册进 PluginRegistry');

    assert.strictEqual(WEB_PLATFORM_PRESETS.zhihuishu.studyUrl, 'https://studyvideoh5.zhihuishu.com/stuStudy');
    assert.strictEqual(isValidZhihuishuStudyUrl('https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=abc'), true);
    assert.strictEqual(isValidZhihuishuStudyUrl('https://evil.com/zhihuishu.com'), false);
    assert.strictEqual(isValidZhihuishuStudyUrl('http://studyvideoh5.zhihuishu.com/stuStudy'), false);

    assert.strictEqual(clampZhihuishuRate(0.5), 1.0);
    assert.strictEqual(clampZhihuishuRate(1.25), 1.25);
    assert.strictEqual(clampZhihuishuRate(1.5), 1.5);
    assert.strictEqual(clampZhihuishuRate(16), 1.5, '倍速上限必须严格约束在平台合法 1.5x');

    const expr = buildZhihuishuInspectExpression(1.5);
    for (const s of [ZHIHUISHU_INJECT_SCRIPT, expr]) {
      assert.ok(!s.includes('visibilityState'), '禁止篡改 document.visibilityState');
      assert.ok(!s.includes("document, 'hidden'"), '禁止篡改 document.hidden');
      assert.ok(!s.includes('stopImmediatePropagation'), '禁止拦截页面 visibility/blur 事件');
    }
    console.log(' ✅ [Test 1/5 PASS] 插件契约、域名/倍速约束与无反作弊钩子红线通过');
  }

  // 2. 登录页 & 易盾滑块验证检测 (遇到即停播告警，不绕过)
  {
    const expr = buildZhihuishuInspectExpression(1.5);

    const authState = runInDom<any>(
      '<div class="login-ewm">扫码登录</div>',
      'https://passport.zhihuishu.com/login',
      expr
    );
    assert.strictEqual(authState.status, 'auth_required');

    let videoPausedCalled = false;
    const capState = runInDom<any>(
      `<div id="container"><video></video></div>
       <div id="captchaYidun"><div class="yidun_panel" style="display:block;width:300px;height:160px;">请完成安全验证</div></div>`,
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1',
      expr,
      (win) => {
        const v = win.document.querySelector('video');
        Object.defineProperty(v, 'paused', { value: false, configurable: true });
        v.getBoundingClientRect = () => ({ width: 640, height: 360 });
        v.pause = () => {
          videoPausedCalled = true;
        };
        const panel = win.document.querySelector('.yidun_panel');
        panel.getBoundingClientRect = () => ({ width: 300, height: 160 });
      }
    );
    assert.strictEqual(capState.status, 'captcha_required');
    assert.strictEqual(videoPausedCalled, true, '触发易盾滑块验证时必须暂停视频并停下来等待人工完成');
    console.log(' ✅ [Test 2/5 PASS] 登录重定向与易盾滑块停播告警检测通过');
  }

  // 3. 随堂弹题暂停识别 + 真实播放倍速点击 + 自然播完切换下一未完成小节
  {
    const expr = buildZhihuishuInspectExpression(1.5);

    const quizState = runInDom<any>(
      `<div id="container"><video></video></div>
       <div class="dialog-test" style="display:block;position:fixed">
         <div class="topic-title">以下哪项符合课程规范？</div>
         <li class="topic-item">A. 选项一</li>
         <li class="topic-item">B. 选项二</li>
       </div>`,
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1',
      expr,
      (win) => {
        const dlg = win.document.querySelector('.dialog-test');
        dlg.getBoundingClientRect = () => ({ width: 500, height: 300 });
      }
    );
    assert.strictEqual(quizState.status, 'quiz_paused');
    assert.ok(quizState.quizTitle.includes('以下哪项符合课程规范'));
    assert.deepStrictEqual(quizState.quizOptions, ['A. 选项一', 'B. 选项二']);

    let rateClicked = false;
    const playingState = runInDom<any>(
      `<ul>
         <li class="clearfix video"><b class="fl time_icofinish"></b><span class="catalogue_title">1.1 绪论</span></li>
         <li class="clearfix video current_play"><span class="catalogue_title">1.2 核心概念</span></li>
         <li class="clearfix video"><span class="catalogue_title">1.3 实践演示</span></li>
       </ul>
       <div id="container">
         <video></video>
         <div class="speedBox">
           <div class="speedTab speedTab10" rate="1.25">X 1.25</div>
           <div class="speedTab speedTab15" rate="1.5">X 1.5</div>
         </div>
       </div>`,
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1',
      expr,
      (win) => {
        const v = win.document.querySelector('video');
        let rate = 1.0;
        let muted = false;
        let paused = true;
        Object.defineProperty(v, 'playbackRate', { get: () => rate, set: (n) => (rate = n), configurable: true });
        Object.defineProperty(v, 'muted', { get: () => muted, set: (m) => (muted = m), configurable: true });
        Object.defineProperty(v, 'paused', { get: () => paused, configurable: true });
        Object.defineProperty(v, 'ended', { value: false, configurable: true });
        Object.defineProperty(v, 'duration', { value: 300, configurable: true });
        Object.defineProperty(v, 'currentTime', { value: 60, configurable: true });
        v.play = async () => {
          paused = false;
        };
        const tab15 = win.document.querySelector('.speedTab[rate="1.5"]');
        tab15.click = () => {
          rateClicked = true;
          rate = 1.5;
        };
      }
    );
    assert.strictEqual(playingState.status, 'playing');
    assert.strictEqual(rateClicked, true, '应点击平台原生的 speedTab[rate="1.5"]');
    assert.strictEqual(playingState.playbackRate, 1.5);
    assert.strictEqual(playingState.muted, true);
    assert.strictEqual(playingState.completedLessons, 1);
    assert.strictEqual(playingState.totalLessons, 3);
    assert.strictEqual(playingState.currentLessonTitle, '1.2 核心概念');

    let clickedNextTitle = '';
    const switchState = runInDom<any>(
      `<ul>
         <li class="clearfix video current_play"><span class="catalogue_title">1.2 核心概念</span></li>
         <li class="clearfix video"><span class="catalogue_title">1.3 实践演示</span></li>
       </ul>
       <div id="container"><video></video></div>`,
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1',
      expr,
      (win) => {
        const v = win.document.querySelector('video');
        Object.defineProperty(v, 'ended', { value: true, configurable: true });
        Object.defineProperty(v, 'duration', { value: 300, configurable: true });
        Object.defineProperty(v, 'currentTime', { value: 300, configurable: true });
        const nextSpan = win.document.querySelectorAll('.clearfix.video')[1].querySelector('.catalogue_title');
        nextSpan.click = () => {
          clickedNextTitle = nextSpan.textContent;
        };
      }
    );
    assert.strictEqual(switchState.status, 'switching_next');
    assert.strictEqual(clickedNextTitle, '1.3 实践演示');
    console.log(' ✅ [Test 3/5 PASS] 弹题识别、1.5x 官方控件倍速与播完自动切下一节通过');
  }

  // 4. 全部小节均已有 .time_icofinish 时准确判定 completed
  {
    const expr = buildZhihuishuInspectExpression(1.25);
    const doneState = runInDom<any>(
      `<ul>
         <li class="clearfix video"><b class="fl time_icofinish"></b><span>1.1</span></li>
         <li class="clearfix video current_play"><b class="fl time_icofinish"></b><span>1.2</span></li>
       </ul>
       <div id="container"><video></video></div>`,
      'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=1',
      expr,
      (win) => {
        const v = win.document.querySelector('video');
        Object.defineProperty(v, 'ended', { value: true, configurable: true });
      }
    );
    assert.strictEqual(doneState.status, 'completed');
    assert.strictEqual(doneState.completedLessons, 2);
    assert.strictEqual(doneState.totalLessons, 2);
    console.log(' ✅ [Test 4/5 PASS] 全章节完成识别通过');
  }

  // 5. 本地回环 RFC 6455 WebSocket + CDP JSON-RPC 全双工测试
  {
    function encodeServerTextFrame(text: string): Buffer {
      const data = Buffer.from(text, 'utf8');
      const hdr = Buffer.alloc(2);
      hdr[0] = 0x81;
      hdr[1] = data.length;
      return Buffer.concat([hdr, data]);
    }

    const clientFrame = encodeWebSocketClientFrame('hello cdp');
    const decodedClient = decodeWebSocketFrames(clientFrame);
    assert.strictEqual(decodedClient.frames.length, 1);
    assert.strictEqual(decodedClient.frames[0].payload.toString('utf8'), 'hello cdp');

    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        const addr = server.address() as any;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: 'page-1',
              type: 'page',
              title: 'stuStudy',
              url: 'https://studyvideoh5.zhihuishu.com/stuStudy',
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/1`,
            },
          ])
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on('upgrade', (req, socket) => {
      const key = String(req.headers['sec-websocket-key'] || '');
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n'
      );
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const res = decodeWebSocketFrames(buf);
        buf = buf.subarray(res.consumedBytes);
        for (const f of res.frames) {
          if (f.opcode === 0x8) {
            socket.destroy();
            return;
          }
          const msg = JSON.parse(f.payload.toString('utf8'));
          const reply =
            msg.method === 'Runtime.evaluate'
              ? { id: msg.id, result: { result: { value: 42 } } }
              : { id: msg.id, result: {} };
          socket.write(encodeServerTextFrame(JSON.stringify(reply)));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = server.address() as any;
      const { client } = await CdpClient.connectToFirstPage(`http://127.0.0.1:${addr.port}`, 'zhihuishu.com');
      const val = await client.evaluate<number>('21 * 2');
      assert.strictEqual(val, 42);
      client.close();
    } finally {
      server.close();
    }
    console.log(' ✅ [Test 5/5 PASS] 零依赖 RFC 6455 WebSocket + CDP 客户端收发测试通过');
  }

  console.log('\n🎉 全部 5 项智慧树插件与真机 CDP 测试 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
