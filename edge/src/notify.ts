import { EdgeEnv, nowUtc8 } from './store';

export interface ExtendedNotifyEnv extends EdgeEnv {
  PUSHPLUS_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export async function sendTelegramReply(text: string, env: ExtendedNotifyEnv): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text.slice(0, 3800),
    }),
  }).catch((e) => console.error('Telegram reply error:', e));
}

/**
 * 多通道零服务器消息推送引擎（全部在 Cloudflare Edge 异步发起，不占云主机任何资源）
 * 支持：飞书/钉钉/企微 Webhook、Server酱(微信)、PushPlus(微信)、Bark(iOS)、Telegram Bot
 */
export async function sendNotification(
  title: string,
  content: string,
  env: ExtendedNotifyEnv
): Promise<void> {
  const promises: Promise<unknown>[] = [];

  // 1. 通用 Webhook (飞书 / 钉钉 / 企业微信)
  const webhook = env.WEBHOOK_URL;
  if (webhook) {
    promises.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          msgtype: 'text',
          text: { content: `【${title}】\n${content}` },
          content: { text: `【${title}】\n${content}` },
        }),
      }).catch((e) => console.error('Webhook error:', e))
    );
  }

  // 2. Server 酱 (微信服务号/Turbo推送)
  const sctKey = env.SERVERCHAN_KEY;
  if (sctKey) {
    promises.push(
      fetch(`https://sctapi.ftqq.com/${sctKey}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ title, desp: content }).toString(),
      }).catch((e) => console.error('ServerChan error:', e))
    );
  }

  // 3. PushPlus (微信推送)
  const pushPlusToken = env.PUSHPLUS_TOKEN;
  if (pushPlusToken) {
    promises.push(
      fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: pushPlusToken,
          title,
          content,
          template: 'markdown',
        }),
      }).catch((e) => console.error('PushPlus error:', e))
    );
  }

  // 4. Bark (iOS 原生推送)
  const barkKey = env.BARK_KEY;
  if (barkKey) {
    promises.push(
      fetch(
        `https://api.day.app/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`
      ).catch((e) => console.error('Bark error:', e))
    );
  }

  // 5. Telegram Bot（先尝试 Markdown，若因下划线/方括号等特殊字符触发 HTTP 400 则自动降级纯文本重发，防止静默丢消息）
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const apiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const mdText = `🔔 *${title}*\n\n${content}`;
    const plainText = `🔔 【${title}】\n\n${content}`;
    promises.push(
      (async () => {
        try {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: mdText.slice(0, 3900),
              parse_mode: 'Markdown',
            }),
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.warn(`Telegram Markdown HTTP ${res.status}: ${errBody.slice(0, 200)}`);
            if (res.status === 400) {
              const retry = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: env.TELEGRAM_CHAT_ID,
                  text: plainText.slice(0, 3900),
                }),
              });
              if (!retry.ok) {
                console.error(`Telegram plain fallback HTTP ${retry.status}`);
              }
            }
          }
        } catch (e) {
          console.error('Telegram error:', e);
        }
      })()
    );
  }

  await Promise.allSettled(promises);
}

export interface ChapterProgressBriefCourse {
  courseName: string;
  totalUnfinishedPoints?: number;
  completionRate?: number;
  pendingChapters?: number;
}

/**
 * 格式化课程章节任务点进度摘要（供 Telegram /status 与每日定时简报复用）
 */
export function formatChapterProgressSummary(
  stats: {
    chapterTrackedCoursesCount?: number;
    chapterUnfinishedPointsCount?: number;
  },
  courses?: ChapterProgressBriefCourse[]
): string {
  const unfinishedTotal = Math.max(0, Number(stats.chapterUnfinishedPointsCount) || 0);
  const trackedCourses = Math.max(0, Number(stats.chapterTrackedCoursesCount) || 0);
  if (unfinishedTotal <= 0 && trackedCourses <= 0) {
    return '';
  }

  const pendingCourses = (courses || []).filter((c) => (Number(c.totalUnfinishedPoints) || 0) > 0);
  if (unfinishedTotal > 0) {
    const topDetail = pendingCourses
      .slice(0, 3)
      .map((c) => {
        const rate = typeof c.completionRate === 'number' ? ` · ${c.completionRate}%` : '';
        return `《${c.courseName}》待完成 ${c.totalUnfinishedPoints} 个${rate}`;
      })
      .join('；');
    const detailSuffix = topDetail ? `：${topDetail}${pendingCourses.length > 3 ? ' 等' : ''}` : '';
    return `⚠️ 待完成任务点 ${unfinishedTotal} 个（已跟踪 ${trackedCourses || pendingCourses.length} 门课）${detailSuffix}`;
  }

  return `已跟踪 ${trackedCourses} 门课（章节任务点全部完成 ✅）`;
}

/**
 * 生成并推送定期/按需全景任务简报（Daily / On-Demand Digest）
 */
export async function sendDigestNotification(
  env: ExtendedNotifyEnv,
  stats: {
    pendingCount: number;
    draftCount: number;
    submittedCount: number;
    signinCount: number;
    questionBankCount: number;
    chapterTrackedCoursesCount?: number;
    chapterUnfinishedPointsCount?: number;
    unfinishedCourses?: ChapterProgressBriefCourse[];
    recentTasks: Array<{
      platform: string;
      course_name: string;
      title: string;
      status: string;
      deadline?: string;
    }>;
  },
  triggerReason = '定期巡检简报'
): Promise<string> {
  const taskLines =
    stats.recentTasks.length > 0
      ? stats.recentTasks
          .slice(0, 8)
          .map((t, i) => {
            const badge =
              t.status === 'submitted'
                ? '✅已交'
                : t.status === 'draft_saved'
                  ? '📝已暂存'
                  : '⏳待办';
            return `${i + 1}. [${t.platform}] ${badge} 《${t.course_name}》- ${t.title}${t.deadline ? ` (截止: ${t.deadline})` : ''}`;
          })
          .join('\n')
      : '🎉 当前各平台暂无积压待办任务';

  const chapterSummary = formatChapterProgressSummary(stats, stats.unfinishedCourses);
  const summaryLines = [
    `🕒 统计时间：${nowUtc8()}`,
    `📊 任务总览：⏳ 待完成 ${stats.pendingCount} | 📝 草稿暂存 ${stats.draftCount} | ✅ 已提交 ${stats.submittedCount}`,
    `📍 累计签到：${stats.signinCount} 次 | 🧠 题库缓存：${stats.questionBankCount} 题`,
  ];
  if (chapterSummary) {
    summaryLines.push(`📖 章节进度：${chapterSummary}`);
  }
  summaryLines.push('', '📋 近期任务动态：', taskLines);

  const summaryText = summaryLines.join('\n');

  await sendNotification(`afk-cloud ${triggerReason}`, summaryText, env);
  return summaryText;
}
