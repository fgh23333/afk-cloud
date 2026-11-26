import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireLock,
  extractLastJsonObject,
  getActiveLock,
  getAgyQuotaState,
  getLinuxMemAvailableMb,
  invokeAgy,
  releaseLock,
  runWithAgyLock,
} from '../../core/agy-invoke';
import { formatUtc8Now } from '../../core/types';

const HOME = process.env.HOME || os.homedir() || '/home/Jimmy';
const AUTOPILOT_DIR = path.join(HOME, '.local/share/agy-autopilot');
const TODOS_PATH = path.join(AUTOPILOT_DIR, 'todos.md');
const NEWS_PATH = path.join(AUTOPILOT_DIR, 'news-digest.md');
const ACTIVITY_PATH = path.join(AUTOPILOT_DIR, 'activity.log');
const GEMINI_CONFIG_DIR = path.join(HOME, '.gemini/config');
const EVOLVE_COOLDOWN_MS = 5 * 60 * 1000;
const PROGRESS_SCAN_COOLDOWN_MS = 2 * 60 * 1000;

let chatBusy = false;
const MAX_CHAT_QUEUE = 10;
const chatQueue: string[] = [];
let queueRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastEvolveAtMs = 0;
let progressScanBusy = false;
let lastProgressScanAtMs = 0;

export function parseProgressCommand(text: string): {
  isProgress: boolean;
  forceRefresh: boolean;
  keyword: string;
} {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^(\/progress!|\/progress|刷新进度|进度)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return { isProgress: false, forceRefresh: false, keyword: '' };
  }
  const cmd = match[1].toLowerCase();
  const forceRefresh = cmd === '/progress!' || cmd === '刷新进度';
  const keyword = (match[2] || '').trim();
  return { isProgress: true, forceRefresh, keyword };
}

export function formatProgressScanReport(
  summaries: Array<{
    courseId: string;
    classId: string;
    courseName: string;
    totalChapters: number;
    completedChapters: number;
    pendingChapters: number;
    totalUnfinishedPoints: number;
    completionRate: number;
    pendingChapterTitles?: string[];
    chapters?: Array<{
      chapterId: string;
      title: string;
      unfinishedPoints: number;
      status: string;
      url: string;
    }>;
  }>,
  keyword?: string
): string {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return keyword
      ? `📖 未找到匹配「${keyword}」的在读课程（可发送 \`/progress\` 查看全部课程进度）。`
      : '📖 未扫描到在读课程的章节任务点数据。';
  }
  const kw = (keyword || '').trim().toLowerCase();
  if (kw) {
    const matched = summaries.filter(
      (s) =>
        (s.courseName || '').toLowerCase().includes(kw) ||
        String(s.courseId || '').toLowerCase() === kw ||
        String(s.classId || '').toLowerCase() === kw
    );
    if (matched.length === 0) {
      return `📖 未找到匹配「${keyword}」的在读课程（可发送 \`/progress\` 查看全部课程进度）。`;
    }
    const blocks = matched.slice(0, 5).map((c) => {
      const unfinish = Number(c.totalUnfinishedPoints) || 0;
      const courseUrl = `https://mooc1-1.chaoxing.com/visit/stucoursemiddle?courseid=${c.courseId}&clazzid=${c.classId}`;
      const lines = [
        `📖 《${c.courseName}》 (ID: ${c.courseId}) — 完成率 ${c.completionRate ?? 100}% (${c.completedChapters || 0}/${c.totalChapters || 0} 章，待完成 ${unfinish} 个任务点)`,
        `🔗 课程入口: ${courseUrl}`,
      ];
      const pendingChapterObjs = Array.isArray(c.chapters)
        ? c.chapters.filter((ch) => ch.status === 'pending' || (Number(ch.unfinishedPoints) || 0) > 0)
        : [];
      const pendingTitles = Array.isArray(c.pendingChapterTitles) ? c.pendingChapterTitles.filter(Boolean) : [];
      if (pendingChapterObjs.length > 0) {
        for (const ch of pendingChapterObjs.slice(0, 15)) {
          lines.push(`  • ${ch.title}（待完成 ${ch.unfinishedPoints} 个任务点）\n    👉 ${ch.url}`);
        }
        if (pendingChapterObjs.length > 15) {
          lines.push(`  … 其余 ${pendingChapterObjs.length - 15} 个待完成章节请点击课程入口查看`);
        }
      } else if (unfinish > 0 && pendingTitles.length > 0) {
        for (const title of pendingTitles) {
          lines.push(`  • ${title}`);
        }
      } else if (unfinish === 0) {
        lines.push('  ✅ 该课程所有章节任务点均已完成！');
      }
      return lines.join('\n');
    });
    return blocks.join('\n\n');
  }

  const totalUnfinished = summaries.reduce((acc, s) => acc + (Number(s.totalUnfinishedPoints) || 0), 0);
  const unfinishedCourses = summaries.filter((s) => (Number(s.totalUnfinishedPoints) || 0) > 0);
  const header =
    totalUnfinished > 0
      ? `⚠️ 共跟踪 ${summaries.length} 门课，${unfinishedCourses.length} 门存在待完成任务点（合计 ${totalUnfinished} 个）：`
      : `✅ 共跟踪 ${summaries.length} 门课，章节任务点全部完成！`;
  const sorted = [...summaries].sort(
    (a, b) => (Number(b.totalUnfinishedPoints) || 0) - (Number(a.totalUnfinishedPoints) || 0)
  );
  const lines = sorted.slice(0, 12).map((c, idx) => {
    const unfinish = Number(c.totalUnfinishedPoints) || 0;
    const badge = unfinish > 0 ? `⚠️ 待完成 ${unfinish} 个任务点` : '✅ 全部完成';
    const pendingTitles = Array.isArray(c.pendingChapterTitles) ? c.pendingChapterTitles.filter(Boolean) : [];
    const pendingPreview =
      unfinish > 0 && pendingTitles.length > 0
        ? ` [待刷: ${pendingTitles.slice(0, 2).join('、')}${pendingTitles.length > 2 ? ' 等' : ''}]`
        : '';
    return `${idx + 1}. 《${c.courseName}》 ${c.completionRate ?? 100}% (${c.completedChapters || 0}/${c.totalChapters || 0} 章) — ${badge}${pendingPreview}`;
  });
  return [header, ...lines].join('\n');
}

function readTailLines(filePath: string, count: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-count);
}

async function replyViaEdge(title: string, content: string): Promise<void> {
  const edgeUrl = (process.env.AFK_EDGE_WORKER_URL || '').replace(/\/+$/, '');
  const bearer = process.env.AFK_EDGE_BEARER_TOKEN || '';
  if (!edgeUrl || !bearer) {
    console.warn('[Agent Chat] AFK_EDGE_WORKER_URL or AFK_EDGE_BEARER_TOKEN not set');
    return;
  }
  try {
    await fetch(`${edgeUrl}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ title, content: content.slice(0, 3500) }),
    });
  } catch (err: any) {
    console.warn(`[Agent Chat] replyViaEdge failed: ${err?.message || err}`);
  }
}

function appendActivity(line: string) {
  try {
    fs.mkdirSync(AUTOPILOT_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function handleTodosCommand(text: string): { title: string; reply: string } | null {
  const trimmed = text.trim();
  if (trimmed === '/todos' || trimmed === '待办') {
    const lines = fs.existsSync(TODOS_PATH) ? fs.readFileSync(TODOS_PATH, 'utf8').split('\n') : [];
    const open = lines.filter((l) => /^- \[ \] /.test(l.trim())).map((l, idx) => `${idx + 1}. ${l.trim().slice(6)}`);
    return {
      title: '📋 个人待办清单',
      reply: open.length ? open.join('\n') : '当前没有未完成待办！用 `/todo <内容>` 可随时新增。',
    };
  }

  if (trimmed.startsWith('/todo ')) {
    const item = trimmed.slice(6).trim();
    if (!item) return { title: '📋 待办提示', reply: '请在 `/todo ` 后输入内容，例如：`/todo 周五交高数作业`' };
    fs.mkdirSync(AUTOPILOT_DIR, { recursive: true });
    if (!fs.existsSync(TODOS_PATH)) {
      fs.writeFileSync(TODOS_PATH, '# 个人待办与提醒（Todos）\n\n', 'utf8');
    }
    fs.appendFileSync(TODOS_PATH, `- [ ] ${item} (${formatUtc8Now().slice(0, 10)})\n`, 'utf8');
    appendActivity(`[Telegram /todo] 新增待办: ${item}`);
    return { title: '✅ 已记入待办', reply: item };
  }

  if (trimmed.startsWith('/done ')) {
    const target = trimmed.slice(6).trim();
    if (!fs.existsSync(TODOS_PATH)) return { title: '📋 待办提示', reply: '当前待办文件为空。' };
    const lines = fs.readFileSync(TODOS_PATH, 'utf8').split('\n');
    let openIdx = 0;
    let matched = '';
    const updated = lines.map((line) => {
      if (!matched && /^- \[ \] /.test(line.trim())) {
        openIdx += 1;
        const body = line.trim().slice(6);
        if (String(openIdx) === target || body.includes(target)) {
          matched = body;
          return `- [x] ${body}`;
        }
      }
      return line;
    });
    if (!matched) {
      return { title: '📋 未找到待办', reply: `未匹配到待办 "${target}"，请先发 /todos 查看编号或关键词。` };
    }
    fs.writeFileSync(TODOS_PATH, updated.join('\n'), 'utf8');
    appendActivity(`[Telegram /done] 完成待办: ${matched}`);
    return { title: '☑️ 已标记完成', reply: matched };
  }

  return null;
}

function scheduleQueueDrain(delayMs = 5000): void {
  if (queueRetryTimer) return;
  queueRetryTimer = setTimeout(() => {
    queueRetryTimer = null;
    drainChatQueue();
  }, delayMs);
}

function drainChatQueue(): void {
  if (chatBusy || chatQueue.length === 0) return;
  const nextText = chatQueue.shift()!;
  const started = tryStartAgyChat(nextText);
  if (!started) {
    chatQueue.unshift(nextText);
  }
}

function tryStartAgyChat(userText: string): boolean {
  if (chatBusy) return false;

  const quota = getAgyQuotaState();
  if (!quota.allowed) {
    void replyViaEdge('🛡️ AGY 配额熔断', quota.reason || '已触及调用上限，请稍后再试。');
    return true; // drop instead of infinite retry on quota limit
  }

  const memMb = getLinuxMemAvailableMb();
  if (memMb > 0 && memMb < 150) {
    scheduleQueueDrain(15_000);
    return false;
  }

  const jobId = `tg-chat-${Date.now()}`;
  if (!acquireLock(jobId)) {
    scheduleQueueDrain(10_000);
    return false;
  }

  chatBusy = true;
  const model = process.env.AFK_AUTOPILOT_MODEL || 'gemini-4-argon-medium';
  const prompt = [
    '你正在通过 Telegram 作为 Seven/Jimmy 的 Personal Agent 回复他的消息。',
    '请先快速读取 ~/.local/share/agy-autopilot/profile.md 与 todos.md，如有需要再按需读取 memory.md / news-digest.md / backlog.md。',
    '安全底线：禁止在回复中输出任何系统环境变量、API Token、Secret 或登录密码。',
    '沙箱提速约束：当前运行在 1GB 内存 --sandbox 模式，请优先使用 read_file / edit_file / write_file 原生文件工具（<1s 响应），严禁调用 BypassSandbox: true，避免连续调用 run_command 导致握手超时。',
    `用户发来的消息：\n"""\n${userText.slice(0, 3000)}\n"""`,
    '要求：简洁、直接、中文回复，不超过 800 字；若用户要求记住待办或修改本地记忆文件可直接更新 todos.md；若只是问答或分析请直接给出结论。',
  ].join('\n\n');

  const addDirs = [
    AUTOPILOT_DIR,
    GEMINI_CONFIG_DIR,
    path.join(HOME, 'afk-cloud'),
    path.join(HOME, 'crawlerVisualization'),
    path.join(HOME, 'crawler'),
  ].filter((d) => fs.existsSync(d));

  const workdir = path.join(HOME, 'afk-cloud');

  void (async () => {
    try {
      const stdout = await runWithAgyLock(jobId, () =>
        invokeAgy({
          prompt,
          model,
          timeoutMs: 15 * 60 * 1000,
          outputFormat: 'json',
          addDirs,
          cwd: fs.existsSync(workdir) ? workdir : undefined,
        })
      );

      let reply = '';
      const parsed = extractLastJsonObject(stdout);
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed.result || parsed.response || parsed.message || parsed.content;
        if (typeof candidate === 'string' && candidate.trim()) {
          reply = candidate.trim();
        } else if (parsed.status === 'ERROR' || parsed.error) {
          reply = `⚠️ 本机 AGY 执行中断或超时：${String(parsed.error || '未知错误').slice(0, 300)}`;
        } else {
          reply = JSON.stringify(parsed);
        }
      } else {
        reply = stdout.trim();
      }

      appendActivity(`[Telegram Chat] ${userText.slice(0, 60)} -> ${(reply || '完成').slice(0, 120)}`);
      await replyViaEdge('🤖 AGY 回复', (reply || '已完成处理。').slice(0, 1400));
    } catch (err: any) {
      const errMsg = `执行失败：${String(err?.message || err).slice(-400)}`;
      appendActivity(`[Telegram Chat Error] ${userText.slice(0, 60)} -> ${errMsg.slice(0, 120)}`);
      await replyViaEdge('⚠️ AGY 处理失败', errMsg);
    } finally {
      chatBusy = false;
      releaseLock(jobId);
      drainChatQueue();
    }
  })();
  return true;
}

function enqueueAgyChat(userText: string): { queued: boolean; position: number; busyNow: boolean } {
  if (!chatBusy && chatQueue.length === 0) {
    const started = tryStartAgyChat(userText);
    if (started) {
      return { queued: true, position: 0, busyNow: false };
    }
  }

  if (chatQueue.length >= MAX_CHAT_QUEUE) {
    return { queued: false, position: chatQueue.length, busyNow: true };
  }
  chatQueue.push(userText);
  scheduleQueueDrain(5000);
  return { queued: true, position: chatQueue.length, busyNow: true };
}

export async function handleAgentChatRequest(text: string): Promise<{ accepted: boolean; immediateReply?: string }> {
  const trimmed = (text || '').trim();
  if (!trimmed) return { accepted: false, immediateReply: '收到空消息。' };

  const todoRes = handleTodosCommand(trimmed);
  if (todoRes) {
    void replyViaEdge(todoRes.title, todoRes.reply);
    return { accepted: true };
  }

  if (trimmed === '/news' || trimmed === '资讯' || trimmed === '/news!' || trimmed === '刷新资讯') {
    const content = fs.existsSync(NEWS_PATH)
      ? fs.readFileSync(NEWS_PATH, 'utf8').slice(0, 3500)
      : '暂无缓存资讯，可稍后等待定时抓取。';
    void replyViaEdge('📰 最新技术与生态资讯简报', content);
    return { accepted: true };
  }

  if (trimmed === '/activity' || trimmed === '日志') {
    const lines = readTailLines(ACTIVITY_PATH, 10);
    void replyViaEdge('📜 最近自主活动记录', lines.length ? lines.join('\n') : '暂无活动记录。');
    return { accepted: true };
  }

  const progCmd = parseProgressCommand(trimmed);
  if (progCmd.isProgress) {
    if (progressScanBusy) {
      return {
        accepted: false,
        immediateReply: '⏳ 章节任务点进度扫描正在后台运行中，请稍候查收结果。',
      };
    }
    const now = Date.now();
    const forceRefresh = progCmd.forceRefresh || Boolean(progCmd.keyword);
    if (!forceRefresh && now - lastProgressScanAtMs < PROGRESS_SCAN_COOLDOWN_MS) {
      const remainSec = Math.ceil((PROGRESS_SCAN_COOLDOWN_MS - (now - lastProgressScanAtMs)) / 1000);
      return {
        accepted: false,
        immediateReply: `⏳ 章节进度扫描处于 2 分钟防抖冷却期，请 ${remainSec} 秒后再试（或发送 \`/progress!\` 强制刷新）。`,
      };
    }
    const phone = process.env.CHAOXING_PHONE || '';
    const password = process.env.CHAOXING_PASSWORD || '';
    if (!phone || !password) {
      return {
        accepted: false,
        immediateReply: '⚠️ 本机未配置 CHAOXING_PHONE / CHAOXING_PASSWORD，无法扫描章节任务点进度。',
      };
    }

    progressScanBusy = true;
    if (!progCmd.keyword) {
      lastProgressScanAtMs = now;
    }
    appendActivity(
      `[Telegram /progress] 触发本机学习通章节任务点进度扫描${progCmd.keyword ? ` (过滤: ${progCmd.keyword})` : ''}与看板同步`
    );

    void (async () => {
      try {
        const { ChaoxingAdapter } = await import('../../adapters/chaoxing/index');
        const adapter = new ChaoxingAdapter(phone, password);
        const summaries = await adapter.scanAllCourseChapterProgress(true, progCmd.keyword || undefined);
        const report = formatProgressScanReport(summaries, progCmd.keyword || undefined);
        appendActivity(`[Telegram /progress] 已同步 ${summaries.length} 门课程章节进度快照`);
        await replyViaEdge('📖 章节进度已实时刷新并同步看板', report);
      } catch (err: any) {
        const errMsg = `扫描失败：${String(err?.message || err).slice(0, 300)}`;
        appendActivity(`[Telegram /progress Error] ${errMsg}`);
        await replyViaEdge('⚠️ 章节进度扫描失败', errMsg);
      } finally {
        progressScanBusy = false;
      }
    })();

    return {
      accepted: true,
      immediateReply: progCmd.keyword
        ? `🔄 已在本机后台启动匹配「${progCmd.keyword}」的课程章节任务点扫描，完成后推送待刷章节清单与直达链接…`
        : '🔄 已在本机后台启动学习通各课程章节任务点进度扫描，完成后自动同步看板并推送明细…',
    };
  }

  if (trimmed === '/pta' || trimmed.toLowerCase() === 'pta' || trimmed === '刷新PTA' || trimmed === '/pta!') {
    void (async () => {
      try {
        const { PtaAdapter } = await import('../../adapters/pta/index');
        const pta = new PtaAdapter();
        const { totalSets, activeSets } = await pta.scanOverviews();
        if (activeSets.length === 0) {
          await replyViaEdge('💻 PTA 题目集巡检', `已连接 pintia.cn（历史总计 ${totalSets} 套），当前暂无未过期活跃题目集。`);
          return;
        }
        const lines = activeSets.map((ov, i) => {
          const stateText = ov.isCompleted
            ? `✅ 已作答完毕 (${ov.exam?.score ?? ov.acceptedCount}/${ov.totalScore})`
            : ov.exam
              ? `⏳ 待完成 ${ov.noAnswerCount}/${ov.totalProblems} 题`
              : '🆕 未开始作答';
          return `${i + 1}. 《${ov.problemSet.name}》\n   ${stateText} | 截止: ${ov.deadlineUtc8}`;
        });
        await replyViaEdge('💻 PTA 实时状态', `活跃题目集 ${activeSets.length} 套（累计 ${totalSets} 套）：\n${lines.join('\n')}`);
      } catch (err: any) {
        await replyViaEdge('⚠️ PTA 巡检异常', String(err?.message || err).slice(0, 350));
      }
    })();
    return { accepted: true, immediateReply: '💻 正在实时连接 PTA (pintia.cn) 检查活跃题目集并同步状态，请稍候…' };
  }

  if (trimmed === '/evolve') {
    const now = Date.now();
    if (now - lastEvolveAtMs < EVOLVE_COOLDOWN_MS) {
      const remainSec = Math.ceil((EVOLVE_COOLDOWN_MS - (now - lastEvolveAtMs)) / 1000);
      return { accepted: false, immediateReply: `⏳ /evolve 处于 5 分钟冷却期，请 ${remainSec} 秒后再试。` };
    }
    const memMb = getLinuxMemAvailableMb();
    if (memMb > 0 && memMb < 150) {
      return { accepted: false, immediateReply: `⚠️ 当前可用内存仅 ${memMb} MB（< 150 MB），暂缓执行 /evolve 以防 OOM。` };
    }
    const existingLock = getActiveLock();
    if (existingLock) {
      return { accepted: false, immediateReply: `⏳ 当前已有 AGY 任务 [${existingLock.jobId}] 正在运行，请稍后再触发 /evolve。` };
    }
    const script = path.join(HOME, '.local/bin/agy-autopilot.mjs');
    if (!fs.existsSync(script)) {
      return { accepted: false, immediateReply: '⚠️ 未在本机找到 agy-autopilot.mjs 脚本。' };
    }
    lastEvolveAtMs = now;
    const child = spawn('node', [script, '--evolve'], {
      cwd: path.join(HOME, 'afk-cloud'),
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, HOME },
    });
    child.unref();
    appendActivity('[Telegram /evolve] 手动触发一次自主探索与自迭代');
    return { accepted: true, immediateReply: '🚀 已在后台触发一次 `agy-autopilot --evolve`，完成后会自动把结果推给你。' };
  }

  // Natural language -> enqueue & run agy sequentially, replying when done
  const enq = enqueueAgyChat(trimmed);
  if (!enq.queued) {
    return {
      accepted: false,
      immediateReply: `⚠️ 当前排队已满（上限 ${MAX_CHAT_QUEUE} 条），请稍等前面任务完成后再发。`,
    };
  }
  if (enq.position > 0) {
    return {
      accepted: true,
      immediateReply: `📥 已收到！当前前面还有任务在执行，已帮你加入排队（第 ${enq.position} 位），轮到后会自动处理并回复你。`,
    };
  }
  return { accepted: true, immediateReply: '收到，正在交给本机 AGY 处理，完成后回复你…' };
}
