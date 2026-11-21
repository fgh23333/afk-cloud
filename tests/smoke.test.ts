import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchCourseMaterialsContext } from '../packages/adapters/chaoxing/materials';
import { encryptChaoxingPassword } from '../packages/adapters/chaoxing/session';
import { WebBrowserAdapter } from '../packages/adapters/web-agent';
import { renderDashboardHtml } from '../edge/src/dashboard';
import { sendDigestNotification } from '../edge/src/notify';
import {
  getBrowserProfilePaths,
  readLocalStorageState,
} from '../packages/core/browser-profile';
import {
  provisionCloudflareEdge,
  renderWranglerConfig,
  upsertEnvVariables,
} from '../packages/core/cf-provisioner';
import {
  computeQuestionHash,
  lookupQuestionBankCache,
  saveToQuestionBankCache,
} from '../packages/core/d1-bridge';
import { runCodeInLocalSandbox, triggerCloudBurst } from '../packages/core/sandbox';
import { extractKeywords, localHeuristicSolve, normalizeAnswerByType } from '../packages/core/solver';
import { formatUtc8Now } from '../packages/core/types';
import { signRequest, verifySignedRequest } from '../packages/core/request-signing';
import { checkAuth, isAllowedTaskUrl } from '../edge/src/auth';

async function runAllTests() {
  console.log(`\n======================================================`);
  console.log(` 🧪 afk-cloud 自动化冒烟与核心链路测试 (${formatUtc8Now()})`);
  console.log(`======================================================\n`);

  // --- Test 1: DES 加密与题库 SHA-256 哈希缓存读写 ---
  {
    const cipherHex = encryptChaoxingPassword('test_pass_123');
    assert.ok(cipherHex.length >= 16, 'DES 加密输出应为合法十六进制串');

    const h1 = computeQuestionHash('single', '1. （5.0分） 二叉树的前序遍历顺序是？', [
      { key: 'A', text: '根-左-右' },
      { key: 'B', text: '左-根-右' },
    ]);
    const h2 = computeQuestionHash('single', '二叉树的前序遍历顺序是？', [
      { key: 'A', text: '根-左-右' },
      { key: 'B', text: '左-根-右' },
    ]);
    assert.strictEqual(h1, h2, '不同题号与分值前缀的相同题目应生成完全一致的 SHA-256 指纹');

    await saveToQuestionBankCache([
      {
        questionHash: h1,
        platform: 'chaoxing',
        questionType: 'single',
        title: '二叉树的前序遍历顺序是？',
        answer: 'A',
        modelTier: 'flash',
        updatedAt: formatUtc8Now(),
      },
    ]);

    const hits = await lookupQuestionBankCache([h1]);
    assert.strictEqual(hits[h1]?.answer, 'A', '本地/D1 题库缓存应命中并返回 A');
    console.log(' ✅ [Test 1/6 PASS] DES 协议加密与题库 SHA-256 确定性哈希缓存验证通过');
  }

  // --- Test 2: 课件资料 RAG 检索与双轨答案规范化 ---
  {
    const tmpCourseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-rag-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpCourseDir, '数据结构讲义.md'),
        '快速排序（Quicksort）的平均时间复杂度为 O(n log n)，最坏情况下退化为 O(n^2)。\n\n哈希表通过链地址法解决冲突。',
        'utf8'
      );

      const kws = extractKeywords('【单选题】快速排序在最坏情况下的时间复杂度是多少？');
      const ctx = searchCourseMaterialsContext(kws, tmpCourseDir);
      assert.ok(ctx.includes('O(n^2)'), 'RAG 检索应准确命中包含快速排序复杂度的讲义段落');

      const ans = localHeuristicSolve(
        {
          id: '1',
          type: 'single',
          typeName: '单选题',
          title: '快速排序最坏情况时间复杂度',
          options: [
            { key: 'A', text: 'O(1)' },
            { key: 'B', text: 'O(n^2)' },
          ],
        },
        ctx
      );
      assert.strictEqual(ans, 'B', '启发式求解器应结合讲义片段选出 B');
      assert.strictEqual(
        normalizeAnswerByType({ id: '2', type: 'multiple', typeName: '多选', title: '' }, 'C, A, B'),
        'ABC',
        '多选题答案应自动去重并按升序排列'
      );
      console.log(' ✅ [Test 2/6 PASS] 课程资料 RAG 关键词检索与题型答案清洗验证通过');
    } finally {
      fs.rmSync(tmpCourseDir, { recursive: true, force: true });
    }
  }

  // --- Test 3: 本地隔离代码评测沙箱 + PTA/智慧树无头浏览器 Profile 持久化 ---
  {
    const sandboxRes = await runCodeInLocalSandbox({
      language: 'javascript',
      code: `
        const fs = require('fs');
        const input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
        console.log((input[0] || 0) + (input[1] || 0));
      `,
      sampleInput: '18 24\n',
      expectedOutput: '42',
    });
    assert.strictEqual(sandboxRes.passed, true, '沙箱代码执行结果应与样例输出 42 完全一致');

    const ptaWeb = new WebBrowserAdapter('pta');
    const profilePaths = getBrowserProfilePaths('pta');
    await ptaWeb.importCookieString('PTASession=mock_session_token; JSESSIONID=mock_jsid', '.pintia.cn');
    const savedState = readLocalStorageState('pta');
    assert.ok(fs.existsSync(profilePaths.userDataDir), 'PTA userDataDir Profile 目录应已创建');
    assert.strictEqual(savedState?.cookies.length, 2, 'PTA storage-state.json 应持久化 2 个 Cookie');
    fs.rmSync(profilePaths.storageStatePath, { force: true });

    console.log(
      ` ✅ [Test 3/6 PASS] 编程沙箱评测 (${sandboxRes.durationMs}ms) 与 PTA/智慧树无头浏览器 Profile 持久化验证通过`
    );
  }

  // --- Test 4: Cloudflare 全自动编排引擎 + Cloud Run / Ephemeral GCE 调度验证 ---
  {
    const { assertSafeResourceDestruction } = await import('../packages/core/cf-provisioner');
    assert.doesNotThrow(() => {
      assertSafeResourceDestruction('d1', 'afk-cloud-db');
      assertSafeResourceDestruction('worker', 'afk-cloud-edge');
      assertSafeResourceDestruction('r2', 'afk-cloud-snapshots');
    }, 'afk- 前缀受管资源应允许销毁');

    assert.throws(() => {
      assertSafeResourceDestruction('d1', 'my-personal-prod-db');
    }, /安全拦截/, '严禁误删用户账户内已有的外部资源');

    const cfDry = await provisionCloudflareEdge({ dryRun: true, dbName: 'afk-cloud-db' });
    assert.strictEqual(cfDry.stepsCompleted.length, 5, 'Cloudflare 全自动编排应包含完整 5 个自动化阶段');
    const rendered = renderWranglerConfig({
      workerName: 'afk-cloud-edge',
      dbName: 'afk-cloud-db',
      databaseId: '12345678-1234-1234-1234-123456789abc',
      realname: '测试同学',
      autoSubmit: 'false',
    });
    assert.ok(rendered.includes('12345678-1234-1234-1234-123456789abc'), 'wrangler.jsonc 应自动注入提取的 database_id');

    const tmpEnv = path.join(os.tmpdir(), `afk-env-test-${Date.now()}.env`);
    try {
      upsertEnvVariables(tmpEnv, { AFK_EDGE_WORKER_URL: 'https://afk.workers.dev' });
      const envText = fs.readFileSync(tmpEnv, 'utf8');
      assert.ok(envText.includes('AFK_EDGE_WORKER_URL=https://afk.workers.dev'), '.env 应自动回写 Worker URL');
    } finally {
      fs.rmSync(tmpEnv, { force: true });
    }

    const crBurst = await triggerCloudBurst({
      mode: 'cloud-run',
      taskCommand: 'solve',
      dryRun: true,
    });
    assert.ok(crBurst.command.includes('gcloud run jobs execute'), 'Tier 1 应生成 Cloud Run Jobs 免费层执行指令');

    const gceBurst = await triggerCloudBurst({
      mode: 'gce',
      taskCommand: 'solve --auto-submit',
      ttlMinutes: 15,
      machineType: 'e2-micro',
      dryRun: true,
    });
    assert.ok(
      gceBurst.command.includes('spawn-ephemeral-gce.sh') && gceBurst.command.includes('GCE_BURST_TTL_MINUTES=15'),
      'Tier 2 应生成带 15 分钟 TTL 自毁熔断的临时 GCE 拉起指令'
    );

    const dashboardHtml = renderDashboardHtml();
    assert.ok(
      dashboardHtml.includes('afk-cloud 个人云端自治看板') && dashboardHtml.includes('/api/dashboard'),
      'Cloudflare 零服务器边缘看板 HTML 应包含完整监控面板与 API 绑定'
    );
    const digestText = await sendDigestNotification(
      {},
      {
        pendingCount: 1,
        draftCount: 2,
        submittedCount: 5,
        signinCount: 12,
        questionBankCount: 48,
        recentTasks: [
          {
            platform: 'chaoxing',
            course_name: '数据结构与算法课程设计',
            title: '第一次实验报告',
            status: 'draft_saved',
            deadline: '2026-11-20',
          },
        ],
      },
      '单元测试简报'
    );
    assert.ok(digestText.includes('草稿暂存 2') && digestText.includes('数据结构与算法课程设计'), '汇总简报通知应包含完整平台任务统计');

    console.log(' ✅ [Test 4/6 PASS] Cloudflare 全自动编排 + 零服务器边缘看板/通知 + Tier 1/2 算力调度验证通过');
  }

  // --- Test 5: Server Shim 与 agy 安全调用加固 (HMAC-SHA256 签名、防重放、URL 白名单) ---
  {
    const { createShimServer } = await import('../packages/shim/src/index');
    const { computeQuestionHash: computeHashWorker } = await import('../edge/src/hash');

    // 1. 验证 Edge 与 Node 的 WebCrypto 指纹完全对齐
    const nodeHash = computeQuestionHash('single', '1. 快速排序最坏时间复杂度', [{ key: 'A', text: 'O(n^2)' }]);
    const workerHash = await computeHashWorker('single', '1. 快速排序最坏时间复杂度', [{ key: 'A', text: 'O(n^2)' }]);
    assert.strictEqual(workerHash, nodeHash, 'Edge Web Crypto 与 Node.js crypto 生成的指纹应 100% 相同');

    // 2. 验证 URL 白名单校验逻辑 (防 SSRF 与钓鱼重定向)
    assert.strictEqual(isAllowedTaskUrl('https://mooc1.chaoxing.com/mooc2/work/dowork?id=1'), true);
    assert.strictEqual(isAllowedTaskUrl('https://studyh5.zhihuishu.com/videoStudy.html'), true);
    assert.strictEqual(isAllowedTaskUrl('https://pintia.cn/problem-sets/1/problems/2'), true);
    assert.strictEqual(isAllowedTaskUrl('http://mooc1.chaoxing.com/dowork'), false, '必须要求 https 协议');
    assert.strictEqual(isAllowedTaskUrl('https://evil.attacker.com/chaoxing.com'), false, '恶意伪装域名必须被拦截');
    assert.strictEqual(isAllowedTaskUrl('https://user:pass@mooc1.chaoxing.com'), false, '内嵌凭据 URL 必须被拦截');

    // 3. 启动带安全加固的测试 Shim Server
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.NODE_ENV = 'test';
    process.env.AFK_SHIM_SECRET = testSecret;
    const { resetJobForTest } = await import('../packages/shim/src/runner');
    resetJobForTest('test-job-auth-101');
    const testPort = 8798;
    const server = createShimServer({ secret: testSecret });
    await new Promise<void>((resolve) => server.listen(testPort, '127.0.0.1', () => resolve()));

    try {
      // 3.1 公开存活探针
      const healthRes = await fetch(`http://127.0.0.1:${testPort}/health`);
      assert.strictEqual(healthRes.status, 200, '/health 应返回 200');

      // 3.2 未签名调用 /task 必须被拦截为 401
      const unauthRes = await fetch(`http://127.0.0.1:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: 'test-job-unauth', taskUrl: 'https://mooc1.chaoxing.com/dowork' }),
      });
      assert.strictEqual(unauthRes.status, 401, '缺少 HMAC 签名的请求应被安全拦截为 401');

      // 3.3 带非法域名的任务即使签名正确也应被参数校验拒绝 (400 Bad Request)
      const invalidUrlBody = JSON.stringify({
        jobId: 'test-job-bad-url',
        taskUrl: 'https://evil.attacker.com/malicious',
      });
      const invalidUrlHeaders = await signRequest({
        secret: testSecret,
        method: 'POST',
        pathWithQuery: '/task',
        body: invalidUrlBody,
      });
      const badUrlRes = await fetch(`http://127.0.0.1:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...invalidUrlHeaders },
        body: invalidUrlBody,
      });
      assert.strictEqual(badUrlRes.status, 400, '非白名单域名任务 URL 应被拒绝为 400');

      // 3.4 合法签名且白名单内请求应被受理为 202 Accepted
      const validBody = JSON.stringify({
        jobId: 'test-job-auth-101',
        taskUrl: 'https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=1&classId=2&workId=3',
        platform: 'chaoxing',
        mode: 'draft',
      });
      const validHeaders = await signRequest({
        secret: testSecret,
        method: 'POST',
        pathWithQuery: '/task',
        body: validBody,
      });
      const authRes = await fetch(`http://127.0.0.1:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...validHeaders },
        body: validBody,
      });
      assert.strictEqual(authRes.status, 202, '合法 HMAC 签名请求应被受理为 202');
      const authJson: any = await authRes.json();
      assert.strictEqual(authJson.accepted, true, '受理响应中的 accepted 应为 true');

      // 3.5 防重放测试：使用完全相同的 Nonce/时间戳再次请求必须被判定为 401
      const replayRes = await fetch(`http://127.0.0.1:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...validHeaders },
        body: validBody,
      });
      assert.strictEqual(replayRes.status, 401, '重放同一个 Nonce 请求应被安全拦截为 401 (Replay Attack)');

      // 3.6 签名查询 GET /status/:jobId
      const statusHeaders = await signRequest({
        secret: testSecret,
        method: 'GET',
        pathWithQuery: '/status/test-job-auth-101',
      });
      const statusRes = await fetch(`http://127.0.0.1:${testPort}/status/test-job-auth-101`, {
        headers: statusHeaders,
      });
      assert.strictEqual(statusRes.status, 200, '签名查询任务状态应返回 200');
      const statusJson: any = await statusRes.json();
      assert.strictEqual(statusJson.jobId, 'test-job-auth-101', '查询到的 jobId 应正确对应');

      // 3.7 宿主机单例硬件互斥锁与看门狗回收验证
      const { acquireLock, getActiveLock, releaseLock, reapStaleAgyProcesses } = await import('../packages/shim/src/runner');
      assert.strictEqual(acquireLock('test-lock-job-1'), true, '首次应能成功获取单例硬件锁');
      assert.strictEqual(acquireLock('test-lock-job-2'), false, '锁被占用期间，并发的第二个任务必须被拒绝直接执行');
      assert.strictEqual(getActiveLock()?.jobId, 'test-lock-job-1', '活跃锁的 jobId 应准确记录');
      releaseLock('test-lock-job-1');
      assert.strictEqual(getActiveLock(), null, '释放锁后应恢复空闲状态');
      assert.strictEqual(acquireLock('test-lock-job-2'), true, '释放后第二个任务应能顺利获取锁');
      releaseLock();
      assert.doesNotThrow(() => reapStaleAgyProcesses(), '看门狗巡检执行不应抛出任何未捕获异常');

      console.log(' ✅ [Test 5/6 PASS] Server Shim HMAC-SHA256 签名、防重放、域名白名单与加固契约验证通过');
    } finally {
      const { stopManagedBrowser } = await import('../packages/shim/src/browser');
      await stopManagedBrowser().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.AFK_SHIM_SECRET;
      delete process.env.NODE_ENV;
    }
  }

  // --- Test 6: Edge 边缘节点 Fail-Closed 访问控制与 D1 迁移脚本有效性 ---
  {
    // 1. 验证 Edge checkAuth 严格鉴权 (Fail-Closed 原则)
    const emptyEnv = {};
    const unauthReq = new Request('https://afk.worker.dev/api/dashboard');
    assert.strictEqual(checkAuth(unauthReq, emptyEnv), false, '未注入任何 Secret/Token 时必须 Fail-Closed 拒绝访问');

    const securedEnv = { API_BEARER_TOKEN: 'secret_token_abc_123' };
    const goodBearerReq = new Request('https://afk.worker.dev/api/dashboard', {
      headers: { Authorization: 'Bearer secret_token_abc_123' },
    });
    assert.strictEqual(checkAuth(goodBearerReq, securedEnv), true, '合法 Bearer Token 应通过鉴权');

    const badBearerReq = new Request('https://afk.worker.dev/api/dashboard', {
      headers: { Authorization: 'Bearer wrong_token' },
    });
    assert.strictEqual(checkAuth(badBearerReq, securedEnv), false, '错误 Bearer Token 必须被拒绝');

    const goodCookieReq = new Request('https://afk.worker.dev/dashboard', {
      headers: { Cookie: 'afk_token=secret_token_abc_123' },
    });
    assert.strictEqual(checkAuth(goodCookieReq, securedEnv), true, '合法 Cookie 登录态应通过鉴权');

    const goodQueryReq = new Request('https://afk.worker.dev/dashboard?token=secret_token_abc_123');
    assert.strictEqual(checkAuth(goodQueryReq, securedEnv), true, '合法 Query Token 应通过鉴权');

    // 2. 校验 D1 迁移脚本幂等性与性能索引
    const migrationsDir = path.join(__dirname, '../edge/migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    assert.ok(files.includes('0004_perf_indexes.sql'), '必须包含 0004 性能索引迁移脚本');

    for (const f of files) {
      const sqlContent = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      assert.ok(sqlContent.length > 10, `迁移文件 ${f} 内容不得为空`);
      if (sqlContent.includes('CREATE TABLE')) {
        assert.ok(sqlContent.includes('CREATE TABLE IF NOT EXISTS'), `表定义必须具备幂等性: ${f}`);
      }
      if (sqlContent.includes('CREATE INDEX')) {
        assert.ok(sqlContent.includes('CREATE INDEX IF NOT EXISTS'), `索引定义必须具备幂等性: ${f}`);
      }
    }

    const sql0004 = fs.readFileSync(path.join(migrationsDir, '0004_perf_indexes.sql'), 'utf8');
    assert.ok(sql0004.includes('idx_pending_tasks_status_deadline'), '0004 需包含任务状态与截止时间联合索引');
    assert.ok(sql0004.includes('idx_question_bank_lookup'), '0004 需包含题库查询联合索引');
    assert.ok(sql0004.includes('idx_execution_logs_event_type'), '0004 需包含审计日志事件索引');

    console.log(' ✅ [Test 6/6 PASS] Edge Fail-Closed 访问控制、Cookie/Bearer 鉴权与 D1 迁移规范验证通过');
  }

  // --- Test 7: 超星移动端防风控请求头与 UA 契约验证 ---
  {
    const { CHAOXING_MOBILE_UA } = await import('../edge/src/chaoxing');
    const { MOBILE_UA } = await import('../packages/adapters/chaoxing/signin');

    assert.ok(
      CHAOXING_MOBILE_UA.includes('ChaoXingStudy'),
      'Edge 端移动 UA 必须包含 ChaoXingStudy 原生客户端标识以绕过 anti-bot 拦截'
    );
    assert.ok(
      MOBILE_UA.includes('ChaoXingStudy'),
      'Adapter 端移动 UA 必须包含 ChaoXingStudy 原生客户端标识'
    );

    const chaoxingEdgeCode = fs.readFileSync(path.join(__dirname, '../edge/src/chaoxing.ts'), 'utf8');
    assert.ok(
      !chaoxingEdgeCode.includes("'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'"),
      'Edge 移动端调用严禁使用不带 ChaoXingStudy 的裸 iPhone UA'
    );

    console.log(' ✅ [Test 7/7 PASS] 超星移动端防风控请求头与 UA 契约验证通过');
  }

  // --- Test 8: 超星 WebIM 信令监听解析与 Cloud Run 灾备契约验证 ---
  {
    const { parseWebIMMessage, ChaoxingWebIMListener } = await import(
      '../packages/adapters/chaoxing/webim'
    );
    const { forwardTaskToCloudRun } = await import('../packages/core/sandbox');

    // 1. 验证群聊文本消息中的签到 URL 识别抽取
    const rawMsg1 = {
      data: '同学请注意，老师已发布签到：https://mobilelearn.chaoxing.com/newsign/preSign?courseId=267230708&classId=155058274&activePrimaryId=5000181110795&appType=15',
    };
    const s1 = parseWebIMMessage(rawMsg1);
    assert.ok(s1 && s1.type === 'sign', '应准确从文本消息中提取签到信令');
    assert.strictEqual(s1?.activeId, '5000181110795', '应准确提取 activePrimaryId');
    assert.strictEqual(s1?.courseId, '267230708', '应准确提取 courseId');

    // 2. 验证 ext 结构化载荷识别
    const rawMsg2 = {
      ext: {
        activeId: '6000181740534',
        courseId: '268090261',
        atype: 'sign',
        name: '周四机房签到20261112',
      },
    };
    const s2 = parseWebIMMessage(rawMsg2);
    assert.ok(s2 && s2.type === 'sign', '应准确从 ext 结构体中解析签到');
    assert.strictEqual(s2?.activeId, '6000181740534');

    // 3. 验证 ChaoxingWebIMListener 事件分发
    let capturedSignal: any = null;
    const listener = new ChaoxingWebIMListener({
      cookies: {
        _uid: '149258490',
        _d: 'test',
        vc3: 'test',
        uf: 'test',
        fid: '2893',
        cookieStr: '',
      },
      onSignSignal: (sig) => {
        capturedSignal = sig;
      },
    });
    listener.handleRawMessage(rawMsg1);
    assert.ok(capturedSignal && capturedSignal.activeId === '5000181110795', '监听器事件分发应正常触发');

    // 4. 验证 Cloud Run 容器配置与脚本文件
    const dockerfileShim = fs.readFileSync(path.join(__dirname, '../infra/docker/Dockerfile.shim'), 'utf8');
    assert.ok(dockerfileShim.includes('EXPOSE 8080'), 'Cloud Run Dockerfile 必须暴露 8080 端口');
    assert.ok(dockerfileShim.includes('SHIM_HOST=0.0.0.0'), 'Cloud Run Dockerfile 必须绑定 0.0.0.0');

    const cloudRunDeployScript = fs.readFileSync(
      path.join(__dirname, '../infra/gcp/deploy-cloud-run-service.sh'),
      'utf8'
    );
    assert.ok(cloudRunDeployScript.includes('gcloud run deploy'), '必须包含 gcloud run deploy 指令');
    assert.ok(cloudRunDeployScript.includes('--min-instances=0'), '必须配置 min-instances=0 实现按需零计费缩容');

    assert.strictEqual(typeof forwardTaskToCloudRun, 'function', 'sandbox 模块必须导出 forwardTaskToCloudRun');

    console.log(' ✅ [Test 8/8 PASS] 超星 WebIM 信令监听解析与 Cloud Run 灾备契约验证通过');
  }

  // --- Test 9: Gemini 4 Hydrogen 模型默认切换、agy JSON Schema 参数/信封解包、UTC+8 解析防死锁与看板签到/拉取契约验证 ---
  {
    const {
      DEFAULT_FLASH_MODEL,
      DEFAULT_PRO_MODEL,
      normalizeAgyModelName,
      buildAgyArgs,
      extractLastJsonObject,
    } = await import('../packages/core/agy-invoke');
    const { parseUtc8ToMs } = await import('../edge/src/store');
    const { getDashboardData } = await import('../edge/src/dashboard');

    // 1. 验证默认模型已切换为 Gemini 4 Hydrogen
    assert.strictEqual(DEFAULT_FLASH_MODEL, 'gemini-4-hydrogen-medium', '默认 Flash 模型应为 gemini-4-hydrogen-medium');
    assert.strictEqual(DEFAULT_PRO_MODEL, 'gemini-4-hydrogen-xhigh', '默认 Pro 模型应为 gemini-4-hydrogen-xhigh');
    assert.strictEqual(normalizeAgyModelName('flash', 'flash'), 'gemini-4-hydrogen-medium');
    assert.strictEqual(normalizeAgyModelName('pro', 'pro'), 'gemini-4-hydrogen-xhigh');
    assert.strictEqual(normalizeAgyModelName('gemini-4-hydrogen', 'flash'), 'gemini-4-hydrogen-medium');
    assert.strictEqual(normalizeAgyModelName('gemini-4-hydrogen', 'pro'), 'gemini-4-hydrogen-xhigh');
    assert.strictEqual(normalizeAgyModelName(undefined, 'pro'), 'gemini-4-hydrogen-xhigh');

    // 1.1 验证 buildAgyArgs 传入 jsonSchema 时自动附加 --output-format json，且 extractLastJsonObject 正确解包 agy 信封
    const agyArgs = buildAgyArgs({
      prompt: 'test prompt',
      timeoutMs: 60000,
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    const outFmtIdx = agyArgs.indexOf('--output-format');
    const schemaIdx = agyArgs.indexOf('--json-schema');
    assert.ok(outFmtIdx >= 0 && agyArgs[outFmtIdx + 1] === 'json', '传入 jsonSchema 时必须携带 --output-format json');
    assert.ok(schemaIdx > outFmtIdx, '--json-schema 应在 --output-format json 之后传入');

    const envelopeWithStructured = JSON.stringify({
      conversation_id: 'conv-123',
      status: 'SUCCESS',
      response: '{"status":"draft_saved","qa":[{"id":"1","type":"single","title":"题1","answer":"A"}],"summary":"ok"}\n',
      structured_output: {
        status: 'draft_saved',
        qa: [{ id: '1', type: 'single', title: '题1', answer: 'A' }],
        summary: 'ok',
      },
    });
    const unwrapped1 = extractLastJsonObject(envelopeWithStructured);
    assert.strictEqual(unwrapped1?.status, 'draft_saved', '应自动解包 structured_output 载荷');
    assert.strictEqual(unwrapped1?.qa?.[0]?.answer, 'A', '解包后应保留内部 qa 数组');

    const envelopeResponseOnly = JSON.stringify({
      conversation_id: 'conv-456',
      status: 'SUCCESS',
      response: '{"answers":[{"id":"2","answer":"B"}]}',
    });
    const unwrapped2 = extractLastJsonObject(`日志前缀...\n${envelopeResponseOnly}`);
    assert.strictEqual(unwrapped2?.answers?.[0]?.answer, 'B', '无 structured_output 时应从 response 字符串解包内部 JSON');

    // 2. 验证 UTC+8 时间戳字符串可被正确解析，避免 SolverAgent 队列耗时 NaN 死锁
    const parsedMs = parseUtc8ToMs('2026/11/12 14:48:18 (UTC+8)');
    assert.strictEqual(Number.isFinite(parsedMs), true, 'UTC+8 时间字符串必须能解析为有限毫秒值');
    assert.strictEqual(
      parsedMs,
      Date.parse('2026-11-12T14:48:18+08:00'),
      'UTC+8 解析结果应与 ISO+08:00 完全一致'
    );
    assert.ok(Number.isNaN(parseUtc8ToMs('invalid-ts')), '非法时间戳应返回 NaN 以便上层判定过期');

    // 3. 验证 Edge 看板签到统计包含 sign_success 与 sign_fail 历史
    const mockDb: any = {
      prepare(sql: string) {
        const execAll = async () => {
          if (sql.includes("IN ('signin', 'sign_success', 'sign_fail')")) {
            return {
              results: [
                {
                  id: 15,
                  created_at: '2026/11/12 14:48:18 (UTC+8)',
                  event_type: 'sign_success',
                  platform: 'chaoxing',
                  summary: '学习通主动签到成功: 《LabVIEW编程及应用》 [普通签到] (上海海洋大学)',
                },
                {
                  id: 16,
                  created_at: '2026/11/12 14:49:00 (UTC+8)',
                  event_type: 'sign_fail',
                  platform: 'chaoxing',
                  summary: '签到尝试失败: 《LabVIEW编程及应用》 activeId=8000185468865 HTTP 500',
                },
              ],
            };
          }
          if (sql.includes('COUNT(*) as cnt FROM execution_logs') && sql.includes('sign_success')) {
            return { results: [{ cnt: 1 }] };
          }
          if (sql.includes('COUNT(*)')) {
            return { results: [{ cnt: 0 }] };
          }
          return { results: [] };
        };
        const execFirst = async () => {
          const allRes = await execAll();
          return allRes.results?.[0] ?? null;
        };
        return {
          _all: execAll,
          bind() {
            return { _all: execAll, all: execAll, first: execFirst, run: async () => ({ success: true }) };
          },
          all: execAll,
          first: execFirst,
          run: async () => ({ success: true }),
        };
      },
      async batch(stmts: any[]) {
        const out = [];
        for (const s of stmts) {
          out.push(await s.all());
        }
        return out;
      },
    };

    const dash = await getDashboardData({ DB: mockDb });
    assert.strictEqual(dash.stats.signinCount, 1, 'signinCount 必须计入 sign_success 记录');
    assert.ok(dash.signinHistory && dash.signinHistory.length === 2, 'signinHistory 必须返回 sign_success 与 sign_fail 历史');
    assert.strictEqual(dash.signinHistory[0].result, '签到成功', 'sign_success 应映射为 签到成功');
    assert.strictEqual(dash.signinHistory[0].courseName, 'LabVIEW编程及应用');
    assert.strictEqual(dash.signinHistory[0].address, '上海海洋大学');
    assert.strictEqual(dash.signinHistory[1].result, '签到异常', 'sign_fail 应映射为 签到异常');

    // 4. 验证 Edge /api/tasks/sync、/api/tasks/pull 与 SolverAgent 防死锁源码契约
    const edgeIndexCode = fs.readFileSync(path.join(__dirname, '../edge/src/index.ts'), 'utf8');
    assert.ok(edgeIndexCode.includes("url.pathname === '/api/tasks/pull'"), 'Edge 必须提供 /api/tasks/pull 拉取接口');
    assert.ok(edgeIndexCode.includes('syncExternalTaskStatus'), 'Tasks Sync 必须同步解锁 SolverAgent 状态');

    console.log(' ✅ [Test 9/10 PASS] Gemini 4 Hydrogen 默认模型、UTC+8 防死锁与看板签到/拉取契约验证通过');
  }

  // --- Test 10: 看板同 workId 作业去重合并、规范 taskId 解析与无 shim 防队列噪音契约 ---
  {
    const { getDashboardData } = await import('../edge/src/dashboard');
    const { resolveCanonicalPendingTaskId, upsertPendingTask } = await import('../edge/src/store');

    const insertedTaskIds: string[] = [];
    const mockDedupDb: any = {
      prepare(sql: string) {
        const execAll = async () => {
          if (sql.includes('FROM pending_tasks') && !sql.includes('SELECT task_id') && !sql.includes('COUNT(*)')) {
            return {
              results: [
                {
                  task_id: 'chaoxing-notice-work-58213243-154423000',
                  platform: 'chaoxing',
                  course_id: '268784111',
                  class_id: '154423000',
                  course_name: '计算机辅助测试与虚拟仪器(B)',
                  title: 'VI创建及子VI的设计',
                  status: 'pending',
                  compute_tier: 'tier1-cloud-run',
                  deadline: '2026-05-20 23:59',
                  result_summary: null,
                  payload_json: JSON.stringify({ idCode: 'NOTICE_ID_CODE_123' }),
                  created_at: '2026/11/12 10:00:00 (UTC+8)',
                  updated_at: '2026/11/12 10:00:00 (UTC+8)',
                },
                {
                  task_id: 'chaoxing-hw-58213243',
                  platform: 'chaoxing',
                  course_id: '268784111',
                  class_id: '154423000',
                  course_name: '未命名课程',
                  title: 'VI创建及子VI的设计',
                  status: 'draft_saved',
                  compute_tier: 'tier1-cloud-run',
                  deadline: '近期',
                  result_summary: '已暂存 8 题 (单选/判断)',
                  payload_json: JSON.stringify({
                    workId: '58213243',
                    url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=58213243',
                  }),
                  created_at: '2026/11/12 10:05:00 (UTC+8)',
                  updated_at: '2026/11/12 12:00:00 (UTC+8)',
                },
                {
                  task_id: 'chaoxing-hw-268784887-158750280',
                  platform: 'chaoxing',
                  course_id: '268784887',
                  class_id: '158750280',
                  course_name: '高等数学(二)',
                  title: '待办课程作业提示',
                  status: 'pending',
                  compute_tier: 'tier1-cloud-run',
                  deadline: '近期',
                  result_summary: null,
                  payload_json: null,
                  created_at: '2026/11/12 09:00:00 (UTC+8)',
                  updated_at: '2026/11/12 09:00:00 (UTC+8)',
                },
              ],
            };
          }
          if (sql.includes('SELECT task_id FROM pending_tasks')) {
            return {
              results: [{ task_id: 'chaoxing-notice-work-58213243-154423000' }],
            };
          }
          if (sql.includes('COUNT(*)')) {
            return { results: [{ cnt: 0 }] };
          }
          return { results: [] };
        };
        const makeBound = (args: unknown[]) => ({
          _all: execAll,
          all: execAll,
          first: async () => {
            if (sql.includes('SELECT status, payload_json FROM pending_tasks')) {
              return { status: 'pending', payload_json: JSON.stringify({ idCode: 'NOTICE_ID_CODE_123' }) };
            }
            const res = await execAll();
            return res.results?.[0] ?? null;
          },
          run: async () => {
            if (sql.includes('INSERT INTO pending_tasks') && typeof args[0] === 'string') {
              insertedTaskIds.push(args[0]);
            }
            return { success: true };
          },
        });
        return {
          _all: execAll,
          bind: (...args: unknown[]) => makeBound(args),
          all: execAll,
          first: async () => {
            const res = await execAll();
            return res.results?.[0] ?? null;
          },
          run: async () => ({ success: true }),
        };
      },
      async batch(stmts: any[]) {
        const out = [];
        for (const s of stmts) {
          out.push(await s.all());
        }
        return out;
      },
    };

    const dash = await getDashboardData({ DB: mockDedupDb });
    assert.strictEqual(dash.homeworks?.length, 2, '同 workId 的 notice-work 与 hw 两条记录应合并为 1 条');
    assert.strictEqual(dash.stats.draftCount, 1, '合并后 draftCount 应为 1 而非重复计数');
    assert.strictEqual(dash.stats.pendingCount, 1, '不同课程级占位任务不应误合并');

    const merged = dash.homeworks?.find((h) => h.taskId === 'chaoxing-notice-work-58213243-154423000');
    assert.ok(merged, '合并后应保留带 noticeUrl 的 chaoxing-notice-work-* taskId');
    assert.strictEqual(merged?.status, 'draft_saved', '高优先级完成状态 draft_saved 应胜出');
    assert.strictEqual(
      merged?.noticeUrl,
      'https://notice.chaoxing.com/pc/notice/NOTICE_ID_CODE_123/detail',
      '必须保留 403-free noticeUrl'
    );
    assert.strictEqual(merged?.resultSummary, '已暂存 8 题 (单选/判断)', '必须保留暂存摘要');
    assert.strictEqual(merged?.courseName, '计算机辅助测试与虚拟仪器(B)', '应保留非占位课程名');
    assert.strictEqual(merged?.endDate, '2026-05-20 23:59', '应保留真实截止时间');

    const resolvedId = await resolveCanonicalPendingTaskId(mockDedupDb, 'chaoxing-hw-58213243', '58213243');
    assert.strictEqual(
      resolvedId,
      'chaoxing-notice-work-58213243-154423000',
      '同步或入库时必须复用已存在的 notice-work 规范 task_id'
    );

    // 验证 courseId-classId 占位 ID 不会被误判成 workId 去重合并
    const resolvedPlaceholder = await resolveCanonicalPendingTaskId(
      mockDedupDb,
      'chaoxing-hw-268784887-158750280'
    );
    assert.strictEqual(
      resolvedPlaceholder,
      'chaoxing-hw-268784887-158750280',
      'chaoxing-hw-courseId-classId 占位 ID 应保持独立'
    );

    await upsertPendingTask(
      { DB: mockDedupDb },
      {
        taskId: 'chaoxing-hw-58213243',
        platform: 'chaoxing',
        courseId: '268784111',
        classId: '154423000',
        courseName: '计算机辅助测试与虚拟仪器(B)',
        title: 'VI创建及子VI的设计',
        status: 'pending',
        payload: { workId: '58213243' },
      }
    );
    assert.deepStrictEqual(
      insertedTaskIds,
      ['chaoxing-notice-work-58213243-154423000'],
      'upsertPendingTask 必须向规范 task_id 写入而非新增 chaoxing-hw-<id>'
    );

    const edgeIndexCode = fs.readFileSync(path.join(__dirname, '../edge/src/index.ts'), 'utf8');
    assert.ok(
      edgeIndexCode.includes('shouldCheckHomework && env.DB && (env.AFK_SHIM_URL || env.SHIM_URL)'),
      'scheduled 自动派发仅应在配置常驻 shim 时触发'
    );
    assert.ok(
      edgeIndexCode.includes('suppressQueueLog: true'),
      'scheduled 自动派发必须抑制每 10 分钟重复写入 task_queued 日志'
    );
    console.log(' ✅ [Test 10/12 PASS] 看板同 workId 去重合并、规范 taskId 解析与防队列噪音验证通过');
  }

  // --- Test 11: 超星讨论区 HTML 解析、教师/学生帖识别与移动端频控即时熔断契约 ---
  {
    const {
      cleanTopicText,
      parseTopicCardsFromHtml,
      parseTopicDetailFromHtml,
    } = await import('../packages/adapters/chaoxing/bbs-protocol');
    const {
      isChaoxingRateLimitMessage,
      scanCourseActivitiesShared,
    } = await import('../packages/adapters/chaoxing/activity-protocol');
    const { CHAOXING_MOBILE_UA } = await import('../edge/src/chaoxing');

    const bbsHtml = `
      <div class="content1118" id="topic_726151794">
        <h3 class="bt"><em class="zdi_top">置顶</em>[空标题]
          <a href="/mooc-ans/bbscircle/gettopicdetail?courseId=266874983&clazzid=154101446&topicid=726151794&chapterLabel=2.1&openc=abc123"
             onclick="openDetail('/mooc-ans/bbscircle/gettopicdetail?courseId=266874983&clazzid=154101446&topicid=726151794&chapterLabel=2.1&openc=abc123')">[空标题]</a>
        </h3>
        <span class="fl photo18" title="其他"></span>
        <span class="name">张老师</span>
        <span class="danwei">11-13 12:33</span>
        <a onclick="reportTopic(726151794, '_topicDiscuss')">举报</a>
        <input id="reply_count726151794" value="12" />
      </div>
      <div class="content1118" id="topic_719690304">
        <h3 class="bt">
          <a href="/mooc-ans/bbscircle/gettopicdetail?courseId=266874983&clazzid=154101446&topicid=719690304">提取码是啥</a>
        </h3>
        <span class="fl photo18" title="2023水养4"></span>
        <span class="name">李同学</span>
      </div>
    `;

    const cards = parseTopicCardsFromHtml(
      bbsHtml,
      { courseId: '266874983', classId: '154101446', courseName: 'LabVIEW编程及应用' },
      'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/grouptopic?courseId=266874983&clazzid=154101446'
    );
    assert.strictEqual(cards.length, 2, '应解析出 2 条不重复话题卡片');
    assert.strictEqual(cards[0].isTeacherTopic, true, '含 _topicDiscuss / zdi_top 卡片必须识别为教师话题');
    assert.strictEqual(cards[0].isPinned, true);
    assert.strictEqual(cards[0].title, '', '卡片阶段 [空标题] 占位符必须被剔除');
    assert.strictEqual(cards[0].chapterLabel, '2.1');
    assert.strictEqual(cards[0].replyCount, 12);
    assert.strictEqual(cards[1].isTeacherTopic, false, '带班级徽章且无 _topicDiscuss 的同学提问应过滤');

    const detailHtml = `
      <h3 class="bt">[空标题]LabVIEW 数据类型思考<a class="zan">赞0</a></h3>
      <p id="topicContent">LabVIEW 中簇（Cluster）与数组（Array）的本质区别是什么？赞 0</p>
      <span class="name">张老师</span>
      <span class="name">王同学</span>
      <input type="hidden" id="openc" value="openc_sig_123" />
      <a onclick="form_rep_submit2(726151794, 154101446, '9988', 's', 'list_154101446')">发布</a>
    `;

    assert.strictEqual(cleanTopicText('[空标题]测试文本 赞 5'), '测试文本');
    const detailNotMe = parseTopicDetailFromHtml(detailHtml, cards[0], '陈同学');
    assert.strictEqual(detailNotMe.title, 'LabVIEW 数据类型思考');
    assert.ok(detailNotMe.prompt.includes('簇（Cluster）与数组（Array）'));
    assert.ok(!detailNotMe.prompt.includes('赞 0'), '必须清除尾部 赞0 按钮文本');
    assert.strictEqual(detailNotMe.myReplied, false, '未回复同学不应误判为已回复');
    assert.strictEqual(detailNotMe.canReply, true);
    assert.deepStrictEqual(detailNotMe.replyParams, {
      topicId: '726151794',
      clazzid: '154101446',
      cpi: '9988',
      ut: 's',
      showChooseClazzId: 'list_154101446',
      openc: 'openc_sig_123',
    });

    const detailMe = parseTopicDetailFromHtml(detailHtml, cards[0], '王同学');
    assert.strictEqual(detailMe.myReplied, true, '回复列表中存在本人姓名时必须标记 myReplied=true');

    // 验证 taskactivelist 返回"请勿频繁操作"时立即熔断，绝不二次请求 student/activelist
    assert.strictEqual(isChaoxingRateLimitMessage('请勿频繁操作'), true);
    assert.strictEqual(isChaoxingRateLimitMessage('OK', 429), true);

    const origFetch = globalThis.fetch;
    try {
      let callUrls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        callUrls.push(u);
        return new Response(JSON.stringify({ result: 0, errorMsg: '请勿频繁操作' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const rateRes = await scanCourseActivitiesShared(
        { courseId: '266874983', classId: '154101446', courseName: 'LabVIEW编程及应用' },
        '_uid=149258490',
        '149258490',
        CHAOXING_MOBILE_UA
      );
      assert.strictEqual(callUrls.length, 1, '触发频控时严禁回退请求 student/activelist 加剧风控');
      assert.strictEqual(rateRes.rateLimited, true, '应精确向上抛出 rateLimited=true');

      // 验证签到活动与非签到课堂互动(activeType=4等)精确分离
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            result: 1,
            activeList: [
              { id: 1001, status: 1, activeType: 2, nameOne: '位置签到' },
              { id: 2002, status: 1, activeType: 4, nameOne: '随堂抢答' },
              { id: 3003, status: 2, activeType: 2, nameOne: '已结束签到' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const mixedRes = await scanCourseActivitiesShared(
        { courseId: '266874983', classId: '154101446', courseName: 'LabVIEW编程及应用' },
        '_uid=149258490',
        '149258490',
        CHAOXING_MOBILE_UA
      );
      assert.strictEqual(mixedRes.rateLimited, false);
      assert.strictEqual(mixedRes.activities.length, 1, '仅应将进行中签到归入 activities');
      assert.strictEqual(mixedRes.activities[0].id, '1001');
      assert.strictEqual(mixedRes.classActivities.length, 1, '进行中非签到互动应归入 classActivities');
      assert.strictEqual(mixedRes.classActivities[0].id, '2002');
    } finally {
      globalThis.fetch = origFetch;
    }

    console.log(' ✅ [Test 11/12 PASS] 超星讨论区解析与移动端频控熔断/课堂互动分离契约通过');
  }

  // --- Test 12: 讨论区审批发布闭环、看板 UI 与 Edge 15 分钟频控冷却退避验证 ---
  {
    const { getDashboardData, renderDashboardHtml } = await import('../edge/src/dashboard');
    const { approveAndPublishDiscussion } = await import('../edge/src/discussions');
    const { runChaoxingInspectionCycle } = await import('../edge/src/inspection');

    let updatedDiscussionStatus = '';
    let publishedReplySaved = '';
    const replyParams = {
      topicId: '726151794',
      clazzid: '154101446',
      cpi: '9988',
      ut: 's',
      showChooseClazzId: 'list_154101446',
      openc: 'openc_sig_123',
    };

    const mockDiscDb: any = {
      prepare(sql: string) {
        const execAll = async () => {
          if (sql.includes('FROM discussions') && !sql.includes('WHERE discussion_id = ?')) {
            return {
              results: [
                {
                  discussion_id: 'chaoxing-disc-726151794',
                  topic_id: '726151794',
                  course_id: '266874983',
                  class_id: '154101446',
                  course_name: 'LabVIEW编程及应用',
                  author: '张老师',
                  title: 'LabVIEW 数据类型思考',
                  prompt: '簇和数组有何区别？',
                  chapter_label: '2.1',
                  topic_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/gettopicdetail?topicid=726151794',
                  bbs_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/grouptopic?courseId=266874983',
                  reply_params_json: JSON.stringify(replyParams),
                  status: 'awaiting_approval',
                  draft_reply: '数组要求所有元素数据类型一致，簇则允许封装不同数据类型。',
                  posted_reply: '',
                  model_used: 'gemini-4-hydrogen-xhigh',
                  reply_count: 12,
                  published_at: '',
                  updated_at: '2026/11/13 13:00:00 (UTC+8)',
                },
                {
                  discussion_id: 'chaoxing-disc-726151775',
                  topic_id: '726151775',
                  course_id: '266874983',
                  class_id: '154101446',
                  course_name: 'LabVIEW编程及应用',
                  author: '张老师',
                  title: '状态机模式设计',
                  prompt: '如何使用移位寄存器构建状态机？',
                  chapter_label: '3.2',
                  topic_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/gettopicdetail?topicid=726151775',
                  bbs_url: '',
                  status: 'pending',
                  draft_reply: '',
                  posted_reply: '',
                  reply_count: 5,
                  updated_at: '2026/11/13 12:55:00 (UTC+8)',
                },
              ],
            };
          }
          if (sql.includes('COUNT(*)')) {
            return { results: [{ cnt: 0 }] };
          }
          return { results: [] };
        };
        const makeBound = (args: unknown[]) => ({
          _all: execAll,
          all: execAll,
          first: async () => {
            if (sql.includes('FROM sessions')) {
              return {
                cookie_json: JSON.stringify({
                  _uid: '149258490',
                  _d: 'd',
                  vc3: 'vc3',
                  uf: 'uf',
                  fid: '2893',
                  cookie: '_uid=149258490; vc3=vc3;',
                }),
                expires_at: Date.now() + 3600 * 1000,
              };
            }
            if (sql.includes('FROM discussions WHERE discussion_id = ?')) {
              return {
                discussion_id: 'chaoxing-disc-726151794',
                topic_id: '726151794',
                course_id: '266874983',
                class_id: '154101446',
                course_name: 'LabVIEW编程及应用',
                title: 'LabVIEW 数据类型思考',
                topic_url: 'https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/gettopicdetail?topicid=726151794',
                reply_params_json: JSON.stringify(replyParams),
                draft_reply: '数组元素类型同构，簇可组合异构数据。',
              };
            }
            const res = await execAll();
            return res.results?.[0] ?? null;
          },
          run: async () => {
            if (sql.includes("SET status = 'submitted'") && sql.includes('UPDATE discussions')) {
              updatedDiscussionStatus = 'submitted';
              publishedReplySaved = String(args[0] || '');
            }
            return { success: true };
          },
        });
        return {
          _all: execAll,
          bind: (...args: unknown[]) => makeBound(args),
          all: execAll,
          first: async () => {
            const res = await execAll();
            return res.results?.[0] ?? null;
          },
          run: async () => ({ success: true }),
        };
      },
      async batch(stmts: any[]) {
        const out = [];
        for (const s of stmts) {
          out.push(await s.all());
        }
        return out;
      },
    };

    const dash = await getDashboardData({ DB: mockDiscDb });
    assert.strictEqual(dash.discussions?.length, 2, 'getDashboardData 必须聚合返回 discussions 列表');
    assert.strictEqual(dash.stats.discussionPendingCount, 1);
    assert.strictEqual(dash.stats.discussionDraftCount, 1);

    const html = renderDashboardHtml();
    assert.ok(html.includes('tabBtn-discussions'), '看板 HTML 必须包含话题讨论标签页');
    assert.ok(html.includes('publishDiscussionUI'), '看板 HTML 必须包含审批发布动作函数');
    assert.ok(html.includes('function escapeHtml'), '看板 HTML 必须具备 XSS 转义函数');

    const origFetch = globalThis.fetch;
    try {
      let postedBody = '';
      let postedUrl = '';
      let mobileScanCalls = 0;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.includes('/mooc-ans/bbscircle/addreply')) {
          postedUrl = u;
          postedBody = String(init?.body || '');
          return new Response('success', { status: 200 });
        }
        if (u.includes('/visit/courselistdata')) {
          return new Response(
            '<li class="course" courseId="266874983" clazzId="154101446" personId="9988"><span class="course-name" title="LabVIEW编程及应用">LabVIEW编程及应用</span></li>',
            { status: 200 }
          );
        }
        if (u.includes('taskactivelist')) {
          mobileScanCalls++;
          return new Response(JSON.stringify({ result: 0, errorMsg: '请勿频繁操作' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.includes('bbs/get') || u.includes('grouptopic')) {
          return new Response('', { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof fetch;

      const pubRes = await approveAndPublishDiscussion(
        { DB: mockDiscDb, CHAOXING_PHONE: '13800000000', CHAOXING_PASSWORD: 'pwd' },
        'chaoxing-disc-726151794'
      );
      assert.strictEqual(pubRes.success, true, `审批发布应成功提交到 addreply: ${pubRes.msg}`);
      assert.ok(postedUrl.includes('/mooc-ans/bbscircle/addreply'));
      assert.ok(postedBody.includes('topicId=726151794'));
      assert.ok(postedBody.includes('openc=openc_sig_123'));
      assert.strictEqual(updatedDiscussionStatus, 'submitted', '发布成功后必须标记讨论状态为 submitted');
      assert.ok(publishedReplySaved.includes('异构数据'));

      // 验证 Inspection 15 分钟冷却退避：首次触发请勿频繁操作后记录冷却时间戳，第二次跳过 mobilelearn 轮询
      let savedAgentState: any = null;
      const cycle1 = await runChaoxingInspectionCycle(
        {
          DB: mockDiscDb,
          CHAOXING_PHONE: '13800000000',
          CHAOXING_PASSWORD: 'pwd',
          SIGN_LISTEN_WINDOWS: '*',
          MOBILE_SCAN_INTERVAL_SEC: '0',
          MOBILE_SCAN_JITTER_SEC: '0',
        },
        {
          force: false,
          checkHomework: false,
          scanDiscussions: false,
          skipSleep: true,
          onStateUpdate: (next) => {
            savedAgentState = next;
          },
        }
      );
      assert.strictEqual(cycle1.rateLimited, true, '首次触发频控应回报 rateLimited=true');
      assert.ok(savedAgentState && savedAgentState.rateLimitUntilMs > Date.now(), '应写入 15 分钟冷却到期时间戳');
      assert.strictEqual(mobileScanCalls, 1, '触发频控后必须立即中断本轮剩余课程扫描');

      const cycle2 = await runChaoxingInspectionCycle(
        {
          DB: mockDiscDb,
          CHAOXING_PHONE: '13800000000',
          CHAOXING_PASSWORD: 'pwd',
          SIGN_LISTEN_WINDOWS: '*',
          MOBILE_SCAN_INTERVAL_SEC: '0',
          MOBILE_SCAN_JITTER_SEC: '0',
        },
        {
          force: false,
          checkHomework: false,
          scanDiscussions: false,
          skipSleep: true,
          state: savedAgentState,
        }
      );
      assert.strictEqual(cycle2.cooldownActive, true, '冷却窗口期内必须进入 cooldownActive');
      assert.strictEqual(mobileScanCalls, 1, '冷却期内绝不应再次请求 mobilelearn 触发风控');
    } finally {
      globalThis.fetch = origFetch;
    }

    console.log(' ✅ [Test 12/12 PASS] 讨论区人工审批发布闭环与 15 分钟频控退避冷却验证通过');
  }

  console.log(`\n🎉 全部 12 项核心自检与安全链路测试 100% 通过！\n`);
}

runAllTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
