import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatUtc8Now } from '../../core/types';

const HOME = process.env.HOME || '/home/Jimmy';
const AUTOPILOT_DIR = path.join(HOME, '.local/share/agy-autopilot');
const TODOS_PATH = path.join(AUTOPILOT_DIR, 'todos.md');
const NEWS_PATH = path.join(AUTOPILOT_DIR, 'news-digest.md');
const ACTIVITY_PATH = path.join(AUTOPILOT_DIR, 'activity.log');
const GEMINI_CONFIG_DIR = path.join(HOME, '.gemini/config');
const LOCK_FILE = process.env.AFK_LOCK_FILE || path.join(os.tmpdir(), 'afk-agy-active.lock');
const LOCK_EXPIRE_MS = 15 * 60 * 1000;

let chatBusy = false;

function readTailLines(filePath: string, count: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-count);
}

function getMemAvailableMb(): number {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = info.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
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

function runBackgroundAgyChat(userText: string): void {
  if (chatBusy) {
    void replyViaEdge('⏳ AGY 正在忙', '上一条个人对话仍在处理中，请稍候再试。');
    return;
  }

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const alive = isPidAlive(existing.agyPid) || isPidAlive(existing.shimPid);
      if (alive && Date.now() - (existing.timestamp || 0) < LOCK_EXPIRE_MS) {
        void replyViaEdge('⏳ AGY 正在执行任务', `当前锁被 ${existing.jobId} 占用，请稍后再发指令。`);
        return;
      }
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // ignore
    }
  }

  const memMb = getMemAvailableMb();
  if (memMb > 0 && memMb < 150) {
    void replyViaEdge('⚠️ 主机内存紧张', `当前可用内存仅 ${memMb} MB（< 150 MB），暂缓唤醒 AGY 以防 OOM。`);
    return;
  }

  const payload = {
    jobId: `tg-chat-${Date.now()}`,
    shimPid: process.pid,
    agyPid: undefined as number | undefined,
    startedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(payload), { flag: 'wx' });
  } catch {
    void replyViaEdge('⏳ AGY 忙碌中', '无法获取执行锁，请稍后再试。');
    return;
  }

  chatBusy = true;
  const model = process.env.AFK_AUTOPILOT_MODEL || 'gemini-4-argon-medium';
  const prompt = [
    '你正在通过 Telegram 作为 Seven/Jimmy 的 Personal Agent 回复他的消息。',
    '请先快速读取 ~/.local/share/agy-autopilot/profile.md 与 todos.md，如有需要再按需读取 memory.md / news-digest.md / backlog.md。',
    `用户发来的消息：\n"""\n${userText}\n"""`,
    '要求：简洁、直接、中文回复，不超过 800 字；若用户要求记住待办或修改本地记忆文件可直接更新 todos.md；若只是问答或分析请直接给出结论。',
  ].join('\n\n');

  const addDirs = [
    AUTOPILOT_DIR,
    GEMINI_CONFIG_DIR,
    path.join(HOME, 'afk-cloud'),
    path.join(HOME, 'crawlerVisualization'),
    path.join(HOME, 'crawler'),
  ].filter((d) => fs.existsSync(d));

  const args = [
    '-p',
    prompt,
    '--sandbox',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    '--print-timeout',
    '300s',
    '--output-format',
    'json',
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--model',
    model,
  ];

  const child = spawn('agy', args, {
    cwd: path.join(HOME, 'afk-cloud'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME },
  });

  payload.agyPid = child.pid;
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(payload));
  } catch {
    // ignore
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  child.on('close', (code) => {
    chatBusy = false;
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (cur.jobId === payload.jobId) fs.unlinkSync(LOCK_FILE);
    } catch {
      // ignore
    }

    let reply = '';
    try {
      const parsed = JSON.parse(stdout.trim());
      reply = parsed?.result || parsed?.response || parsed?.message || parsed?.content || '';
    } catch {
      reply = stdout.trim();
    }

    if (code !== 0 && !reply) {
      reply = `执行失败 (code=${code})：${stderr.slice(-400) || '未知错误'}`;
      appendActivity(`[Telegram Chat Error] ${userText.slice(0, 60)} -> ${reply.slice(0, 120)}`);
      void replyViaEdge('⚠️ AGY 处理失败', reply);
      return;
    }

    appendActivity(`[Telegram Chat] ${userText.slice(0, 60)} -> ${(reply || '完成').slice(0, 120)}`);
    void replyViaEdge('🤖 AGY 回复', (reply || '已完成处理。').slice(0, 1400));
  });
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
    const script = path.join(HOME, '.local/bin/agy-autopilot.mjs');
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

  // Natural language -> run agy in background and reply when done
  runBackgroundAgyChat(trimmed);
  return { accepted: true, immediateReply: '收到，正在交给本机 AGY 处理，完成后回复你…' };
}
