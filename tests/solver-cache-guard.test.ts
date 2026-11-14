import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPoisonedOrRefusalAnswer, solveHomeworkDualTrack } from '../packages/core/solver';
import { computeQuestionHash } from '../packages/core/d1-bridge';

async function runTests() {
  console.log('\n🧪 开始运行题库防投毒与短题干隔离测试...\n');

  // Test 1: isPoisonedOrRefusalAnswer 拦截各类拒答与空占位文本
  assert.strictEqual(isPoisonedOrRefusalAnswer(''), true);
  assert.strictEqual(
    isPoisonedOrRefusalAnswer('无法直接作答，当前缺少解答该简答题所需的具体题目内容'),
    true
  );
  assert.strictEqual(
    isPoisonedOrRefusalAnswer('当前题目信息不完整，无法直接结合讲义重点作答。'),
    true
  );
  assert.strictEqual(
    isPoisonedOrRefusalAnswer('根据本门课程参考资料要点综合阐述：遵循实验设计规范，结合课堂教学重点完成相应分析'),
    true
  );
  assert.strictEqual(isPoisonedOrRefusalAnswer('A'), false);
  assert.strictEqual(
    isPoisonedOrRefusalAnswer('顺序表采用连续内存存储，支持 O(1) 随机访问，而链表通过指针串联节点。'),
    false
  );
  console.log(' ✅ [Test 1/3 PASS] isPoisonedOrRefusalAnswer 准确识别拒答与占位模板');

  // Test 2: 短题干主观题按课程+作业名隔离哈希，且跳过毒化本地缓存
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-solver-cache-'));
  const origCwd = process.cwd();
  const origMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const cacheDir = path.join(tmpDir, '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const scopedTitleA = '[数据结构与算法课程设计::实验一 顺序表] 1';
    const scopedTitleB = '[高等数学（二）::无穷级数复习题] 1';
    const hashA = computeQuestionHash('essay', scopedTitleA);
    const hashB = computeQuestionHash('essay', scopedTitleB);
    assert.notStrictEqual(hashA, hashB, '不同课程/作业的短题干 "1" 哈希必须严格隔离');

    // 在本地缓存写入一条毒化答案，验证 solveHomeworkDualTrack 绝不命中它
    const rawGlobalHash = computeQuestionHash('essay', '1');
    fs.writeFileSync(
      path.join(cacheDir, 'question-bank.json'),
      JSON.stringify({
        [rawGlobalHash]: {
          questionHash: rawGlobalHash,
          platform: 'chaoxing',
          questionType: 'essay',
          title: '1',
          answer: '无法直接作答，当前缺少解答该简答题所需的具体题目内容',
          modelTier: 'pro',
          confidence: 0.9,
          updatedAt: '2026/11/14 00:00:00 (UTC+8)',
        },
        [hashA]: {
          questionHash: hashA,
          platform: 'chaoxing',
          questionType: 'essay',
          title: scopedTitleA,
          answer: '无法直接作答，当前缺少解答该简答题所需的具体题目内容',
          modelTier: 'pro',
          confidence: 0.9,
          updatedAt: '2026/11/14 00:00:00 (UTC+8)',
        },
      }),
      'utf8'
    );

    process.chdir(tmpDir);
    const res = await solveHomeworkDualTrack(
      {
        workId: '1001',
        workAnswerId: '0',
        title: '实验一 顺序表',
        statusText: '待做',
        isPending: true,
        canEdit: true,
        startDate: '',
        endDate: '',
        courseId: '2001',
        classId: '3001',
        courseName: '数据结构与算法课程设计',
      },
      [
        {
          id: 'q1',
          type: 'essay',
          typeName: '简答题',
          title: '1',
        },
      ],
      () => '顺序表是用一段物理地址连续的存储单元依次存储数据元素的线性结构。',
      { reportOutputDir: path.join(tmpDir, 'reports') }
    );

    assert.strictEqual(res.stats.cacheHits, 0, '毒化缓存绝不可命中');
    assert.ok(
      !isPoisonedOrRefusalAnswer(res.answers['q1']) || res.stats.proSolved > 0,
      '跳过毒化缓存后应重新进入 Pro 深度推理轨道'
    );
    console.log(' ✅ [Test 2/3 PASS] 毒化缓存自动跳过且短题干哈希跨课程隔离通过');
  } finally {
    process.chdir(origCwd);
    if (origMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origMode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Test 3: 验证 packages/adapters/chaoxing/homework.ts 包含附件与图片链接提取
  const hwSource = fs.readFileSync(
    path.join(__dirname, '../packages/adapters/chaoxing/homework.ts'),
    'utf8'
  );
  assert.ok(
    hwSource.includes('[附件:') && hwSource.includes('[图片:') && hwSource.includes('enrichedTitle'),
    'getHomeworkDetail 必须提取题干中的附件与图片上下文'
  );
  console.log(' ✅ [Test 3/3 PASS] 超星题目附件/图片提取契约验证通过');

  console.log('\n🎉 题库防投毒与自主做题增强测试 3/3 全部通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
