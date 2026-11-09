/**
 * 边缘环境下的题目 SHA-256 确定性哈希计算 (基于 Web Crypto API，与 Node.js 100% 确定性兼容)
 */
export async function computeQuestionHash(
  type: string,
  title: string,
  options?: Array<{ key: string; text: string }>
): Promise<string> {
  const normTitle = title
    .replace(/^\d+[\.、\s]*/, '')
    .replace(/（[\d\.]+分）|\([\d\.]+分\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normOpts = (options || [])
    .map((o) => `${o.key.trim()}:${o.text.replace(/\s+/g, ' ').trim()}`)
    .join('|');

  const raw = `${type}::${normTitle}::${normOpts}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
