import { EdgeEnv } from './store';

export async function sendNotification(title: string, content: string, env: EdgeEnv): Promise<void> {
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
          text: { content: `【${title}】\n${content}` },
          content: { text: `【${title}】\n${content}` },
        }),
      }).catch((e) => console.error('Webhook error:', e))
    );
  }

  // 2. Server 酱
  const sctKey = env.SERVERCHAN_KEY;
  if (sctKey) {
    promises.push(
      fetch(
        `https://sctapi.ftqq.com/${sctKey}.send?title=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`
      ).catch((e) => console.error('ServerChan error:', e))
    );
  }

  // 3. Bark iOS 推送
  const barkKey = env.BARK_KEY;
  if (barkKey) {
    promises.push(
      fetch(
        `https://api.day.app/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`
      ).catch((e) => console.error('Bark error:', e))
    );
  }

  await Promise.allSettled(promises);
}
