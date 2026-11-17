import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { formatUtc8Now, QuestionOption, QuestionType } from './types';

export interface CachedAnswerEntry {
  questionHash: string;
  platform: string;
  questionType: QuestionType;
  title: string;
  optionsJson?: string;
  answer: string;
  modelTier: 'cache' | 'flash' | 'pro' | 'heuristic';
  confidence?: number;
  updatedAt: string;
}

function getLocalCacheFile(): string {
  return path.resolve(process.cwd(), '.cache', 'question_bank.json');
}

/**
 * 计算题目的确定性 SHA-256 指纹 (归一化空白符与标点，确保跨学期/跨班级同题 100% 命中)
 */
export function computeQuestionHash(
  type: QuestionType,
  title: string,
  options?: QuestionOption[]
): string {
  const normTitle = title
    .replace(/^\d+[\.、\s]*/, '')
    .replace(/（[\d\.]+分）|\([\d\.]+分\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normOpts = (options || [])
    .map((o) => `${o.key.trim()}:${o.text.replace(/\s+/g, ' ').trim()}`)
    .join('|');

  const raw = `${type}::${normTitle}::${normOpts}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function readLocalCacheMap(): Record<string, CachedAnswerEntry> {
  try {
    const cacheFile = getLocalCacheFile();
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function writeLocalCacheMap(map: Record<string, CachedAnswerEntry>): void {
  try {
    const cacheFile = getLocalCacheFile();
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 批量查询题库缓存（优先本地高速缓存 + 远端 Cloudflare D1 Edge Worker 同步）
 */
export async function lookupQuestionBankCache(
  hashes: string[]
): Promise<Record<string, { answer: string; modelTier: string }>> {
  const result: Record<string, { answer: string; modelTier: string }> = {};
  if (hashes.length === 0) return result;

  // 1. 查本地 .cache/question_bank.json
  const localMap = readLocalCacheMap();
  const missingHashes: string[] = [];

  for (const h of hashes) {
    if (localMap[h] && localMap[h].answer) {
      result[h] = { answer: localMap[h].answer, modelTier: 'cache' };
    } else {
      missingHashes.push(h);
    }
  }

  // 2. 若配置了 Cloudflare Edge Worker URL，则向 D1 批量查询缺失的题目指纹
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;

  if (edgeUrl && missingHashes.length > 0) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

      const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/cache/lookup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ hashes: missingHashes }),
      });

      if (res.ok) {
        const data: any = await res.json();
        const remoteHits = data?.hits || {};
        for (const [h, val] of Object.entries<any>(remoteHits)) {
          if (val && val.answer) {
            result[h] = { answer: val.answer, modelTier: 'cache' };
          }
        }
      }
    } catch {
      // 网络离线时无缝降级到本地缓存
    }
  }

  return result;
}

/**
 * 将新解答出的题目写回本地缓存与远端 Cloudflare D1 记忆库
 */
export async function saveToQuestionBankCache(entries: CachedAnswerEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // 1. 写入本地缓存
  const localMap = readLocalCacheMap();
  const now = formatUtc8Now();
  for (const e of entries) {
    if (e.modelTier === 'heuristic') continue; // 启发式兜底结果不污染高置信度题库
    localMap[e.questionHash] = { ...e, updatedAt: now };
  }
  writeLocalCacheMap(localMap);

  // 2. 异步同步至 Cloudflare D1 (若配置了 AFK_EDGE_WORKER_URL)
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  const highConfidenceItems = entries.filter((e) => e.modelTier !== 'heuristic');

  if (edgeUrl && highConfidenceItems.length > 0) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

      await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/cache/upsert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: highConfidenceItems }),
      });
    } catch {
      // ignore remote sync error
    }
  }
}

export interface EdgeTaskSyncItem {
  taskId: string;
  platform: string;
  courseId: string;
  classId: string;
  courseName: string;
  title: string;
  status: 'pending' | 'processing' | 'draft_saved' | 'submitted' | 'failed';
  deadline?: string;
  resultSummary?: string;
}

/**
 * 将扫描到的待办任务或已完成作答的任务状态同步至 Cloudflare Edge D1 看板，并触发边缘即时通知
 */
export async function syncTasksToEdgeDashboard(tasks: EdgeTaskSyncItem[]): Promise<boolean> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  if (!edgeUrl || tasks.length === 0) return false;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

    const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/tasks/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tasks }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 主动触发 Cloudflare Edge Worker 发送一次全平台汇总简报通知
 */
export async function triggerEdgeDigestNotification(): Promise<{ sent: boolean; summary?: string }> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  if (!edgeUrl) {
    return { sent: false, summary: '未配置 AFK_EDGE_WORKER_URL' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;

  const res = await fetch(`${edgeUrl.replace(/\/+$/, '')}/api/digest`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) return { sent: false };
  return (await res.json()) as { sent: boolean; summary?: string };
}

export interface EdgeDiscussionItem {
  discussion_id: string;
  topic_id: string;
  course_id: string;
  class_id: string;
  course_name: string;
  author?: string;
  title: string;
  prompt: string;
  chapter_label?: string;
  topic_url: string;
  bbs_url?: string;
  status: string;
  draft_reply?: string;
  posted_reply?: string;
  model_used?: string;
  reply_count?: number;
}

function buildEdgeAuthHeaders(): { edgeUrl: string; headers: Record<string, string> } | null {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  if (!edgeUrl) return null;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;
  return { edgeUrl: edgeUrl.replace(/\/+$/, ''), headers };
}

export async function triggerDiscussionScanOnEdge(
  offset = 0,
  limit = 9
): Promise<{
  ok: boolean;
  scannedCourses?: number;
  totalCourses?: number;
  nextOffset?: number;
  hasMore?: boolean;
  topicsFound?: number;
  newPendingTopics?: number;
}> {
  const conn = buildEdgeAuthHeaders();
  if (!conn) return { ok: false };
  try {
    const res = await fetch(`${conn.edgeUrl}/api/discussions/scan`, {
      method: 'POST',
      headers: conn.headers,
      body: JSON.stringify({ offset, limit }),
    });
    if (!res.ok) return { ok: false };
    return (await res.json()) as any;
  } catch {
    return { ok: false };
  }
}

export async function fetchDiscussionsFromEdge(statuses?: string[]): Promise<EdgeDiscussionItem[]> {
  const conn = buildEdgeAuthHeaders();
  if (!conn) return [];
  try {
    const query = statuses && statuses.length > 0 ? `?status=${encodeURIComponent(statuses.join(','))}` : '';
    const res = await fetch(`${conn.edgeUrl}/api/discussions${query}`, {
      method: 'GET',
      headers: conn.headers,
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return Array.isArray(data.discussions) ? data.discussions : [];
  } catch {
    return [];
  }
}

export async function pushDiscussionDraftToEdge(
  discussionId: string,
  draftReply: string,
  modelUsed?: string
): Promise<boolean> {
  const conn = buildEdgeAuthHeaders();
  if (!conn) return false;
  try {
    const res = await fetch(`${conn.edgeUrl}/api/discussions/${encodeURIComponent(discussionId)}/draft`, {
      method: 'POST',
      headers: conn.headers,
      body: JSON.stringify({ draftReply, modelUsed }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
