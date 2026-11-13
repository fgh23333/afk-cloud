/**
 * 超星学习通课程讨论区（bbscircle）跨运行时协议模块
 * 无 Node 专有依赖（零 fs / jsdom），可在 Cloudflare Workers Edge 与本地 Node CLI / Shim 共同复用。
 */

export const CHAOXING_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface BbsCourseTarget {
  courseId: string;
  classId: string;
  courseName: string;
  cpi?: string;
  teacherName?: string;
}

export interface BbsReplyParams {
  clazzid: string;
  topicId: string;
  cpi: string;
  ut: string;
  openc: string;
  showChooseClazzId: string;
}

export interface BbsTopicCard {
  topicId: string;
  courseId: string;
  classId: string;
  courseName: string;
  title: string;
  author: string;
  chapterLabel: string;
  detailUrl: string;
  bbsUrl: string;
  replyCount: number;
  isPinned: boolean;
  isTeacherTopic: boolean;
  postedAt?: string;
}

export interface BbsTopicDetail extends BbsTopicCard {
  prompt: string;
  myReplied: boolean;
  canReply: boolean;
  replyParams: BbsReplyParams | null;
}

export function decodeHtmlText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function normalizeBbsDetailUrl(rawPath: string): string {
  const clean = (rawPath || '').replace(/&amp;/g, '&').trim();
  if (!clean) return '';
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  if (clean.startsWith('/mooc-ans/')) {
    return `https://mooc1-1.chaoxing.com${clean}`;
  }
  if (clean.startsWith('/bbscircle/')) {
    return `https://mooc1-1.chaoxing.com/mooc-ans${clean}`;
  }
  if (clean.startsWith('/')) {
    return `https://mooc1-1.chaoxing.com${clean}`;
  }
  return `https://mooc1-1.chaoxing.com/mooc-ans/${clean}`;
}

export function normalizeBbsListUrl(rawPath: string): string {
  return normalizeBbsDetailUrl(rawPath);
}

/**
 * 解析课程 stucoursemiddle 页面以获取带签名的讨论区入口 (/mooc-ans/bbscircle/grouptopic?...)
 */
export async function fetchCourseBbsUrl(
  course: BbsCourseTarget,
  cookieStr: string
): Promise<string | null> {
  try {
    const stuUrl = `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${encodeURIComponent(
      course.courseId
    )}&clazzid=${encodeURIComponent(course.classId)}&cpi=${encodeURIComponent(course.cpi || '')}&vc=1`;
    const res = await fetch(stuUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': CHAOXING_WEB_UA,
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/['"]([^'"]*\/bbscircle\/grouptopic[^'"]*)['"]/);
    if (!m) return null;
    return normalizeBbsListUrl(m[1]);
  } catch {
    return null;
  }
}

/**
 * 从 grouptopic HTML 提取讨论话题卡片（同时兼容置顶折叠条与 #showTopics 正文卡片，按 topicId 合并去重）
 */
export function parseTopicCardsFromHtml(
  html: string,
  course: BbsCourseTarget,
  bbsUrl: string
): BbsTopicCard[] {
  const map = new Map<string, BbsTopicCard>();
  const chunks = html.split(/(?=<div[^>]*class=["']content1118["'])/i);

  for (const card of chunks) {
    if (!card.includes('content1118')) continue;

    const idMatch = card.match(/id=["']topic_(\d+)["']/i) || card.match(/topicid=(\d+)/i);
    const topicId = idMatch?.[1];
    if (!topicId) continue;

    const detailMatch = card.match(
      /(?:href\s*=\s*|openDetail\s*\(\s*)["']([^"']*gettopicdetail[^"']*)["']/i
    );
    const detailUrl = detailMatch ? normalizeBbsDetailUrl(detailMatch[1]) : '';
    const chapterMatch = detailUrl.match(/[?&]chapterLabel=([^&]*)/i);
    const chapterLabel = chapterMatch ? decodeURIComponent(chapterMatch[1]).trim() : '';

    const h3Match = card.match(/<h3[^>]*class=["'][^"']*bt[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
    const rawH3 = h3Match
      ? decodeHtmlText(h3Match[1].replace(/<em[^>]*class=["'][^"']*zdi_top[^"']*["'][^>]*>[\s\S]*?<\/em>/gi, ''))
      : '';
    const linkTitleMatch = !rawH3
      ? card.match(/gettopicdetail[^>]*>([\s\S]*?)<\/a>/i)
      : null;
    let title = cleanTopicText(rawH3 || (linkTitleMatch ? decodeHtmlText(linkTitleMatch[1]) : ''));

    const authorMatch =
      card.match(/<span[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/span>/i) ||
      card.match(/<a[^>]*margin-left:\s*91px[^>]*>([\s\S]*?)<\/a>/i);
    const author = authorMatch ? decodeHtmlText(authorMatch[1]) : '';

    const postedMatch = card.match(/<span[^>]*class=["']danwei["'][^>]*>([\s\S]*?)<\/span>/i);
    const postedAt = postedMatch ? decodeHtmlText(postedMatch[1]) : undefined;

    const photoTitleMatch = card.match(/<span[^>]*class=["']fl photo18["'][^>]*title=["']([^"']*)["']/i);
    const photoTitle = (photoTitleMatch?.[1] || '').trim();

    const hiddenReplyMatch = card.match(/id=["']reply_count\d+["'][^>]*value=["'](\d+)["']/i);
    const textReplyMatch = card.match(/回复\s*[（(]?\s*(\d+)/);
    const replyCount = Number(hiddenReplyMatch?.[1] ?? textReplyMatch?.[1] ?? 0);

    const isPinned = card.includes('zdi_top');
    const hasTopicDiscussFlag = /reportTopic\([^)]*_topicDiscuss/i.test(card);
    const matchesCourseTeacher = Boolean(
      course.teacherName &&
        author &&
        (course.teacherName.includes(author) || author.includes(course.teacherName))
    );
    const hasStudentClassBadge = Boolean(
      photoTitle && !['其他', '教师', '老师', '助教'].includes(photoTitle)
    );
    const isTeacherTopic =
      hasTopicDiscussFlag ||
      isPinned ||
      matchesCourseTeacher ||
      (!hasStudentClassBadge && (photoTitle === '其他' || Boolean(chapterLabel)));

    const prev = map.get(topicId);
    if (!prev) {
      map.set(topicId, {
        topicId,
        courseId: course.courseId,
        classId: course.classId,
        courseName: course.courseName,
        title,
        author,
        chapterLabel,
        detailUrl,
        bbsUrl,
        replyCount,
        isPinned,
        isTeacherTopic,
        postedAt,
      });
    } else {
      map.set(topicId, {
        ...prev,
        title: prev.title || title,
        author: prev.author || author,
        chapterLabel: prev.chapterLabel || chapterLabel,
        detailUrl: prev.detailUrl || detailUrl,
        replyCount: Math.max(prev.replyCount, replyCount),
        isPinned: prev.isPinned || isPinned,
        isTeacherTopic: prev.isTeacherTopic || isTeacherTopic,
        postedAt: prev.postedAt || postedAt,
      });
    }
  }

  return Array.from(map.values());
}

/**
 * 扫描单个课程的讨论区列表页
 */
export async function scanCourseBbsTopics(
  course: BbsCourseTarget,
  cookieStr: string
): Promise<{ bbsUrl: string | null; topics: BbsTopicCard[] }> {
  const bbsUrl = await fetchCourseBbsUrl(course, cookieStr);
  if (!bbsUrl) return { bbsUrl: null, topics: [] };

  try {
    const res = await fetch(bbsUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': CHAOXING_WEB_UA,
      },
    });
    if (!res.ok) return { bbsUrl, topics: [] };
    const html = await res.text();
    return {
      bbsUrl,
      topics: parseTopicCardsFromHtml(html, course, bbsUrl),
    };
  } catch {
    return { bbsUrl, topics: [] };
  }
}

export function cleanTopicText(raw: string): string {
  return raw
    .replace(/\[空标题\]/g, '')
    .replace(/\s*赞\s*\d+\s*$/g, '')
    .trim();
}

/**
 * 解析 gettopicdetail HTML：提取完整提问正文、当前用户是否已回复、以及 addreply 提交所需签名参数
 */
export function parseTopicDetailFromHtml(
  html: string,
  base: BbsTopicCard,
  realname?: string
): BbsTopicDetail {
  const h3Match = html.match(/<h3[^>]*class=["'][^"']*bt[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
  let rawTitle = h3Match
    ? decodeHtmlText(
        h3Match[1]
          .replace(/<em[^>]*class=["'][^"']*zdi_top[^"']*["'][^>]*>[\s\S]*?<\/em>/gi, '')
          .replace(/<a[^>]*class=["'][^"']*zan[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '')
      )
    : base.title;
  rawTitle = cleanTopicText(rawTitle) || cleanTopicText(base.title);

  const contentMatch =
    html.match(/<p[^>]*id=["']topicContent["'][^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<div[^>]*class=["'][^"']*topicContent[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const contentText = contentMatch ? cleanTopicText(decodeHtmlText(contentMatch[1])) : '';

  const promptParts: string[] = [];
  if (rawTitle) promptParts.push(rawTitle);
  if (contentText && contentText !== rawTitle) promptParts.push(contentText);
  const prompt = promptParts.join('\n\n') || '（暂无文字描述）';

  const names = [...html.matchAll(/<span[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    decodeHtmlText(m[1])
  );
  const author = names[0] || base.author || '';
  const replyAuthors = names.slice(1);

  const hiddenReplyMatch = html.match(/id=["']reply_count\d+["'][^>]*value=["'](\d+)["']/i);
  const replyCount = Math.max(base.replyCount || 0, Number(hiddenReplyMatch?.[1] ?? replyAuthors.length));

  const normMe = (realname || '').replace(/\s+/g, '').trim();
  const myReplied = Boolean(
    normMe &&
      normMe !== '同学' &&
      replyAuthors.some((n) => n.replace(/\s+/g, '').trim() === normMe)
  );

  const submitMatch = html.match(
    /form_rep_submit2\(\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]?([^'",)]*)['"]?\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/
  );
  const opencHidden =
    html.match(/id=["']openc["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
    html.match(/getOpenc\(\)\s*\{\s*return\s*['"]([^'"]+)['"]/i)?.[1] ||
    base.detailUrl.match(/[?&]openc=([^&]+)/i)?.[1] ||
    '';

  const replyParams: BbsReplyParams | null = submitMatch
    ? {
        topicId: submitMatch[1] || base.topicId,
        clazzid: submitMatch[2] || base.classId,
        cpi: submitMatch[3] || '0',
        ut: submitMatch[4] || 's',
        showChooseClazzId: submitMatch[5] || `list_${base.classId}`,
        openc: decodeURIComponent(opencHidden),
      }
    : null;

  const fallbackTitle = contentText ? contentText.split('\n')[0].slice(0, 60) : `话题 #${base.topicId}`;
  const displayTitle = (rawTitle || fallbackTitle).slice(0, 120);

  return {
    ...base,
    title: displayTitle,
    author,
    prompt,
    replyCount,
    myReplied,
    canReply: Boolean(replyParams),
    replyParams,
  };
}

/**
 * 拉取单条讨论帖详情（回复数 > 30 时额外补查一页，避免漏判已回复状态）
 */
export async function fetchTopicDetail(
  card: BbsTopicCard,
  cookieStr: string,
  realname?: string
): Promise<BbsTopicDetail> {
  if (!card.detailUrl) {
    return {
      ...card,
      title: card.title || `话题 #${card.topicId}`,
      prompt: card.title || '',
      myReplied: false,
      canReply: false,
      replyParams: null,
    };
  }

  try {
    const res = await fetch(card.detailUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': CHAOXING_WEB_UA,
      },
    });
    if (!res.ok) {
      return {
        ...card,
        title: card.title || `话题 #${card.topicId}`,
        prompt: card.title || '',
        myReplied: false,
        canReply: false,
        replyParams: null,
      };
    }
    const html = await res.text();
    const detail = parseTopicDetailFromHtml(html, card, realname);

    const normMe = (realname || '').replace(/\s+/g, '').trim();
    if (!detail.myReplied && normMe && normMe !== '同学' && detail.replyCount > 25 && detail.replyParams) {
      const lastVal = html.match(/id=["']lastValue["'][^>]*value=["']([^"']+)["']/i)?.[1];
      const bbsEnc = html.match(/bbsEnc\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      const uuid = html.match(/uuid\s*:\s*['"]([^'"]+)['"]/i)?.[1] || '';
      if (lastVal && bbsEnc) {
        try {
          const moreRes = await fetch('https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/getreplysbytopicId', {
            method: 'POST',
            headers: {
              Cookie: cookieStr,
              'User-Agent': CHAOXING_WEB_UA,
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: new URLSearchParams({
              clazzid: detail.replyParams.clazzid,
              topicid: detail.replyParams.topicId,
              pagesize: '100',
              order: '1',
              cpi: detail.replyParams.cpi || '0',
              ut: detail.replyParams.ut || 's',
              openc: detail.replyParams.openc || '',
              uuid,
              lastValue: lastVal,
              bbsEnc,
            }).toString(),
          });
          if (moreRes.ok) {
            const moreHtml = await moreRes.text();
            const moreNames = [...moreHtml.matchAll(/<span[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/span>/gi)].map(
              (m) => decodeHtmlText(m[1]).replace(/\s+/g, '').trim()
            );
            if (moreNames.includes(normMe)) {
              detail.myReplied = true;
            }
          }
        } catch {
          // ignore pagination error
        }
      }
    }

    return detail;
  } catch {
    return {
      ...card,
      title: card.title || `话题 #${card.topicId}`,
      prompt: card.title || '',
      myReplied: false,
      canReply: false,
      replyParams: null,
    };
  }
}

/**
 * 提交一级回复至超星讨论区 (POST /mooc-ans/bbscircle/addreply)
 * 注意：超星讨论区无服务端草稿箱，调用此函数会直接公开发布至班级讨论区！
 */
export async function postTopicReply(
  params: BbsReplyParams,
  replyContent: string,
  cookieStr: string,
  refererUrl?: string
): Promise<{ success: boolean; msg: string }> {
  const cleanContent = (replyContent || '').trim();
  if (!cleanContent) {
    return { success: false, msg: '回复内容不能为空' };
  }
  if (cleanContent.length > 20000) {
    return { success: false, msg: '回复内容超过 20000 字限制' };
  }

  const body = new URLSearchParams({
    clazzid: params.clazzid,
    topicId: params.topicId,
    content: cleanContent,
    files: '',
    cpi: params.cpi || '0',
    ut: params.ut || 's',
    attachmentFile: '',
    openc: params.openc || '',
    showChooseClazzId: params.showChooseClazzId || '',
  });

  try {
    const res = await fetch('https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/addreply', {
      method: 'POST',
      headers: {
        Cookie: cookieStr,
        'User-Agent': CHAOXING_WEB_UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer:
          refererUrl ||
          `https://mooc1-1.chaoxing.com/mooc-ans/bbscircle/gettopicdetail?clazzid=${params.clazzid}&topicid=${params.topicId}&ut=${params.ut || 's'}`,
      },
      body: body.toString(),
    });

    const text = (await res.text()).trim();
    if (!res.ok) {
      return { success: false, msg: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    if (text.toLowerCase().startsWith('error')) {
      return { success: false, msg: text.replace(/^error;?/i, '').trim() || '发布被超星拒绝' };
    }
    return { success: true, msg: '已成功公开发布至学习通讨论区' };
  } catch (err: any) {
    return { success: false, msg: `网络请求异常: ${err?.message || err}` };
  }
}
