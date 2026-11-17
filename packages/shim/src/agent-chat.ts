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

let chatBusy = false;
const MAX_CHAT_QUEUE = 10;
const chatQueue: string[] = [];
let queueRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastEvolveAtMs = 0;

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
      body: JSON.stringify({ title, content: content.slice(0, 1500) }),
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
        reply = typeof candidate === 'string' ? candidate : JSON.stringify(parsed);
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

  if (trimmed === '/news' || trimmed === '资讯') {
    const content = fs.existsSync(NEWS_PATH)
      ? fs.readFileSync(NEWS_PATH, 'utf8').slice(0, 1300)
      : '暂无缓存资讯，可稍后等待定时抓取。';
    void replyViaEdge('📰 最新资讯摘要', content);
    return { accepted: true };
  }

  if (trimmed === '/activity' || trimmed === '日志') {
    const lines = readTailLines(ACTIVITY_PATH, 10);
    void replyViaEdge('📜 最近自主活动记录', lines.length ? lines.join('\n') : '暂无活动记录。');
    return { accepted: true };
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
