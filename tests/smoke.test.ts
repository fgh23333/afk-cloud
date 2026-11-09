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
    console.log(' ✅ [Test 1/4 PASS] DES 协议加密与题库 SHA-256 确定性哈希缓存验证通过');
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
      console.log(' ✅ [Test 2/4 PASS] 课程资料 RAG 关键词检索与题型答案清洗验证通过');
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

    // 验证 PTA / 智慧树无头浏览器 Profile 目录与 Cookie 状态持久化
    const ptaWeb = new WebBrowserAdapter('pta');
    const profilePaths = getBrowserProfilePaths('pta');
    await ptaWeb.importCookieString('PTASession=mock_session_token; JSESSIONID=mock_jsid', '.pintia.cn');
    const savedState = readLocalStorageState('pta');
    assert.ok(fs.existsSync(profilePaths.userDataDir), 'PTA userDataDir Profile 目录应已创建');
    assert.strictEqual(savedState?.cookies.length, 2, 'PTA storage-state.json 应持久化 2 个 Cookie');
    fs.rmSync(profilePaths.storageStatePath, { force: true });

    console.log(
      ` ✅ [Test 3/4 PASS] 编程沙箱评测 (${sandboxRes.durationMs}ms) 与 PTA/智慧树无头浏览器 Profile 持久化验证通过`
    );
  }

  // --- Test 4: Cloudflare 全自动编排引擎 + Cloud Run / Ephemeral GCE 调度验证 ---
  {
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

    console.log(' ✅ [Test 4/4 PASS] Cloudflare 全自动编排 + 零服务器边缘看板/通知 + Tier 1/2 算力调度验证通过');
  }

  console.log(`\n🎉 全部 4 项核心自检测试 100% 通过！\n`);
}

runAllTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
