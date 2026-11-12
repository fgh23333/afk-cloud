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

  console.log(`\n🎉 全部 8 项核心自检与安全链路测试 100% 通过！\n`);
}

runAllTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
