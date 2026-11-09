import { EdgeEnv, nowUtc8 } from './store';

export interface ExtendedNotifyEnv extends EdgeEnv {
  PUSHPLUS_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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

  // 5. Telegram Bot
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    promises.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `🔔 *${title}*\n\n${content}`,
          parse_mode: 'Markdown',
        }),
      }).catch((e) => console.error('Telegram error:', e))
    );
  }

  await Promise.allSettled(promises);
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

  const summaryText = [
    `🕒 统计时间：${nowUtc8()}`,
    `📊 任务总览：⏳ 待完成 ${stats.pendingCount} | 📝 草稿暂存 ${stats.draftCount} | ✅ 已提交 ${stats.submittedCount}`,
    `📍 累计签到：${stats.signinCount} 次 | 🧠 题库缓存：${stats.questionBankCount} 题`,
    ``,
    `📋 近期任务动态：`,
    taskLines,
  ].join('\n');

  await sendNotification(`afk-cloud ${triggerReason}`, summaryText, env);
  return summaryText;
}
