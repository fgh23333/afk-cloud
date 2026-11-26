import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { resolveAgyWorkdir } from '../../core/agy-invoke';
import {
  extractReadableTextFromBuffer,
  looksLikeHtmlBuffer,
  parseChaoxingViewerHtml,
  sniffFileExtension,
} from '../../core/file-extract';
import {
  CourseInfo,
  HomeworkDetail,
  HomeworkSummary,
  QuestionOption,
  QuestionType,
  StandardQuestion,
} from '../../core/types';
import { ChaoxingCookies, CourseSessionInfo, fetchCourseSession } from './session';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHAOXING_REFERER = 'https://mooc1-1.chaoxing.com/';
const MAX_QUESTION_IMAGE_BYTES = 5 * 1024 * 1024;

function resolveChaoxingAssetUrl(rawUrl: string, chaoxingOrigin = 'https://mooc1-1.chaoxing.com'): string {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `${chaoxingOrigin.replace(/\/+$/, '')}${s}`;
  return s;
}

function isDecorativeChaoxingIcon(urlOrSrc: string): boolean {
  return /fileTypeImages\/|\/js\/editor|icon_[a-z]+\.(?:gif|png)|favicon\.ico|spacer\.gif/i.test(urlOrSrc);
}

/**
 * 预下载超星防盗链题面图片（携带 Cookie 与 Referer: https://mooc1-1.chaoxing.com/）至 agy 沙箱可读目录
 */
export async function downloadChaoxingQuestionImage(
  imgUrl: string,
  courseCookie: string,
  workId: string,
  options?: { allowInTest?: boolean; chaoxingOrigin?: string }
): Promise<string | null> {
  const resolvedUrl = resolveChaoxingAssetUrl(imgUrl, options?.chaoxingOrigin);
  if (
    !resolvedUrl ||
    !/^https?:\/\//i.test(resolvedUrl) ||
    isDecorativeChaoxingIcon(resolvedUrl) ||
    (process.env.NODE_ENV === 'test' && !options?.allowInTest)
  ) {
    return null;
  }
  try {
    const safeWorkDir = String(workId || 'common').replace(/[^a-zA-Z0-9_-]/g, '_');
    const assetDir = path.join(resolveAgyWorkdir(), 'homework_assets', safeWorkDir);
    fs.mkdirSync(assetDir, { recursive: true });
    const extMatch = new URL(resolvedUrl).pathname.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i);
    const hintedExt = extMatch ? extMatch[0].toLowerCase() : '.png';
    const hash = crypto.createHash('sha1').update(resolvedUrl).digest('hex').slice(0, 12);
    const cachedCandidate = path.join(assetDir, `img_${hash}${hintedExt}`);
    if (
      fs.existsSync(cachedCandidate) &&
      fs.statSync(cachedCandidate).size > 0 &&
      !looksLikeHtmlBuffer(fs.readFileSync(cachedCandidate).subarray(0, 512))
    ) {
      return cachedCandidate;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(resolvedUrl, {
        headers: {
          Cookie: courseCookie,
          Referer: CHAOXING_REFERER,
          'User-Agent': BROWSER_UA,
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_QUESTION_IMAGE_BYTES || looksLikeHtmlBuffer(buf)) return null;
      const sniffedExt = sniffFileExtension(buf, {
        url: resolvedUrl,
        contentType: res.headers.get('content-type') || '',
      });
      const finalExt = ['.png', '.jpg', '.gif', '.webp', '.svg', '.bmp'].includes(sniffedExt)
        ? sniffedExt
        : hintedExt;
      const localPath = path.join(assetDir, `img_${hash}${finalExt}`);
      fs.writeFileSync(localPath, buf);
      return localPath;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * 从超星 /ueditorupload/read HTML 浏览壳页面中提取真实文件下载直链（如 https://d0.cldisk.com/download/...）
 */
export function extractClDiskDownloadUrlFromHtml(rawHtml: string): string | null {
  if (!rawHtml) return null;
  return parseChaoxingViewerHtml(rawHtml).directDownloadUrl || null;
}

/**
 * 从二进制/文本 Buffer 中提取可读文本摘要（兼容 Word OLE2 UTF-16LE / DOCX XML / PDF / UTF-8）
 */
export function extractReadableAttachmentText(buf: Buffer, ext: string): string {
  return extractReadableTextFromBuffer(buf, ext, 3500).text;
}

export interface DownloadedAttachmentResult {
  localPath?: string;
  extractedText?: string;
  pageImages?: string[];
  failedReason?: string;
}

async function fetchChaoxingAssetBuffer(
  targetUrl: string,
  courseCookie: string,
  timeoutMs = 12000
): Promise<{ ok: boolean; status: number; buf: Buffer; contentType: string; contentDisposition: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      headers: {
        Cookie: courseCookie,
        Referer: CHAOXING_REFERER,
        'User-Agent': BROWSER_UA,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    const contentDisposition = res.headers.get('content-disposition') || '';
    if (!res.ok) {
      return { ok: false, status: res.status, buf: Buffer.alloc(0), contentType, contentDisposition };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, buf, contentType, contentDisposition };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 预下载超星题干附件（支持 /ueditorupload/read HTML 浏览壳解包、/ananas/status/<objectId> 直链+PDF+页截图拉取与多格式正文提取）
 */
export async function downloadChaoxingQuestionAttachment(
  attUrl: string,
  label: string,
  courseCookie: string,
  workId: string,
  options?: { allowInTest?: boolean; chaoxingOrigin?: string }
): Promise<DownloadedAttachmentResult | null> {
  if (!attUrl || (process.env.NODE_ENV === 'test' && !options?.allowInTest)) {
    return null;
  }
  const chaoxingOrigin = (options?.chaoxingOrigin || 'https://mooc1-1.chaoxing.com').replace(/\/+$/, '');
  const resolvedUrl = resolveChaoxingAssetUrl(attUrl, chaoxingOrigin);
  if (!/^https?:\/\//i.test(resolvedUrl)) {
    return null;
  }

  try {
    const safeWorkDir = String(workId || 'common').replace(/[^a-zA-Z0-9_-]/g, '_');
    const assetDir = path.join(resolveAgyWorkdir(), 'homework_assets', safeWorkDir);
    fs.mkdirSync(assetDir, { recursive: true });
    const hash = crypto.createHash('sha1').update(resolvedUrl).digest('hex').slice(0, 12);

    // 清理历史上误把网页外壳存下的 .bin 缓存文件
    const staleBinPath = path.join(assetDir, `att_${hash}.bin`);
    if (fs.existsSync(staleBinPath) && looksLikeHtmlBuffer(fs.readFileSync(staleBinPath).subarray(0, 512))) {
      try {
        fs.unlinkSync(staleBinPath);
      } catch {}
    }

    // 检查本地是否已有非外壳且有效的文档/截图缓存
    const existingFiles = fs.readdirSync(assetDir).filter((f) => f.startsWith(`att_${hash}`));
    const cachedDocFile = existingFiles.find(
      (f) => !/_p\d+\.(png|jpe?g)$/i.test(f) && !f.endsWith('.bin') && !f.endsWith('.html')
    );
    const cachedPageImgs = existingFiles
      .filter((f) => /^att_[a-f0-9]+_p\d+\.(png|jpe?g)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((f) => path.join(assetDir, f));

    if (cachedDocFile) {
      const fullPath = path.join(assetDir, cachedDocFile);
      const cachedBuf = fs.readFileSync(fullPath);
      if (cachedBuf.length > 0 && !looksLikeHtmlBuffer(cachedBuf)) {
        const ext = path.extname(cachedDocFile).toLowerCase();
        const extracted = extractReadableTextFromBuffer(cachedBuf, ext, 3500);
        if (extracted.text.length >= 10 || cachedPageImgs.length > 0) {
          return {
            localPath: fullPath,
            ...(extracted.text.length >= 10 ? { extractedText: extracted.text } : {}),
            ...(cachedPageImgs.length > 0 ? { pageImages: cachedPageImgs } : {}),
          };
        }
      }
    }

    let docBuf: Buffer | null = null;
    let docExt = '.bin';
    let docUrlUsed = resolvedUrl;
    let docContentType = '';
    let docContentDisposition = '';
    let docFilenameHint = label || '';
    const pageImages: string[] = [...cachedPageImgs];
    let pdfFallbackBuf: Buffer | null = null;

    let objectId = '';
    try {
      const u = new URL(resolvedUrl);
      objectId = u.searchParams.get('objectId') || u.searchParams.get('objectid') || '';
    } catch {}

    let directDownloadUrl = '';
    const initialFetch = await fetchChaoxingAssetBuffer(resolvedUrl, courseCookie);
    if (!initialFetch.ok) {
      return { failedReason: `HTTP ${initialFetch.status} 下载失败` };
    }

    if (looksLikeHtmlBuffer(initialFetch.buf)) {
      const viewer = parseChaoxingViewerHtml(initialFetch.buf.toString('utf8'), resolvedUrl);
      if (viewer.isLoginPage) {
        return { failedReason: '超星附件鉴权失效（重定向至登录页）' };
      }
      if (viewer.objectId) objectId = viewer.objectId;
      if (viewer.directDownloadUrl) directDownloadUrl = viewer.directDownloadUrl;
      if (viewer.filename) docFilenameHint = viewer.filename;
    } else if (initialFetch.buf.length > 0 && initialFetch.buf.length <= MAX_QUESTION_IMAGE_BYTES * 2) {
      docBuf = initialFetch.buf;
      docContentType = initialFetch.contentType;
      docContentDisposition = initialFetch.contentDisposition;
    }

    // 通过 /ananas/status/<objectId> 同时拿原文件下载直链、服务器转码 PDF 及分页高清 PNG 截图
    if (!docBuf && objectId) {
      try {
        const statusRes = await fetchChaoxingAssetBuffer(
          `${chaoxingOrigin}/ananas/status/${objectId}`,
          courseCookie,
          10000
        );
        if (statusRes.ok && statusRes.buf.length > 0) {
          const statusJson = JSON.parse(statusRes.buf.toString('utf8')) as {
            download?: string;
            pdf?: string;
            thumb?: string;
            filename?: string;
            pagenum?: number;
          };
          if (statusJson.filename) docFilenameHint = statusJson.filename;
          if (!directDownloadUrl && statusJson.download) {
            directDownloadUrl = statusJson.download;
          }

          if (statusJson.pdf) {
            const pdfRes = await fetchChaoxingAssetBuffer(statusJson.pdf, courseCookie, 12000).catch(() => null);
            if (
              pdfRes?.ok &&
              pdfRes.buf.length > 0 &&
              pdfRes.buf.length <= MAX_QUESTION_IMAGE_BYTES * 2 &&
              !looksLikeHtmlBuffer(pdfRes.buf)
            ) {
              pdfFallbackBuf = pdfRes.buf;
            }
          }

          if (statusJson.thumb && pageImages.length === 0) {
            const thumbBase = statusJson.thumb.endsWith('/') ? statusJson.thumb : `${statusJson.thumb}/`;
            const pageLimit = Math.min(Math.max(Number(statusJson.pagenum) || 3, 1), 6);
            for (let p = 1; p <= pageLimit; p++) {
              const pRes = await fetchChaoxingAssetBuffer(`${thumbBase}${p}.png`, courseCookie, 8000).catch(() => null);
              if (!pRes?.ok || pRes.buf.length === 0 || looksLikeHtmlBuffer(pRes.buf)) break;
              const pExt = sniffFileExtension(pRes.buf, { url: `${p}.png` });
              if (pExt !== '.png' && pExt !== '.jpg') break;
              const pagePath = path.join(assetDir, `att_${hash}_p${p}${pExt}`);
              fs.writeFileSync(pagePath, pRes.buf);
              pageImages.push(pagePath);
            }
          }
        }
      } catch {
        // /ananas/status 不可用时继续回退到 directDownloadUrl / PDF
      }
    }

    if (!docBuf && directDownloadUrl) {
      const candRes = await fetchChaoxingAssetBuffer(directDownloadUrl, courseCookie, 12000).catch(() => null);
      if (
        candRes?.ok &&
        candRes.buf.length > 0 &&
        candRes.buf.length <= MAX_QUESTION_IMAGE_BYTES * 2 &&
        !looksLikeHtmlBuffer(candRes.buf)
      ) {
        docBuf = candRes.buf;
        docUrlUsed = directDownloadUrl;
        docContentType = candRes.contentType;
        docContentDisposition = candRes.contentDisposition;
      }
    }

    if (!docBuf && pdfFallbackBuf) {
      docBuf = pdfFallbackBuf;
      docExt = '.pdf';
    }

    if (!docBuf || docBuf.length === 0) {
      if (pageImages.length > 0) {
        return { localPath: pageImages[0], pageImages };
      }
      return { failedReason: '附件仅返回网页外壳且无法解析出真实文件流或预览页' };
    }

    docExt = sniffFileExtension(docBuf, {
      filename: docFilenameHint,
      label,
      url: docUrlUsed,
      contentDisposition: docContentDisposition,
      contentType: docContentType,
    });

    if (docExt === '.html') {
      if (pageImages.length > 0) {
        return { localPath: pageImages[0], pageImages };
      }
      return { failedReason: '附件响应为 HTML 页面而非文档正文' };
    }

    const localPath = path.join(assetDir, `att_${hash}${docExt}`);
    fs.writeFileSync(localPath, docBuf);

    let extracted = extractReadableTextFromBuffer(docBuf, docExt, 3500);
    if (extracted.text.length < 20 && pdfFallbackBuf) {
      const pdfExtracted = extractReadableTextFromBuffer(pdfFallbackBuf, '.pdf', 3500);
      if (pdfExtracted.text.length > extracted.text.length) {
        extracted = pdfExtracted;
      }
      const pdfCachePath = path.join(assetDir, `att_${hash}.pdf`);
      if (!fs.existsSync(pdfCachePath)) {
        fs.writeFileSync(pdfCachePath, pdfFallbackBuf);
      }
    }

    const hasReadableText = extracted.text.length >= 10;
    const isDirectImageOrText =
      ['.png', '.jpg', '.gif', '.webp', '.svg', '.bmp', '.txt', '.md', '.csv', '.json', '.c', '.cpp', '.py', '.java'].includes(docExt);

    if (!hasReadableText && pageImages.length === 0 && !isDirectImageOrText) {
      return {
        failedReason: `已下载 ${docExt} 原文件(${docBuf.length}B)但未提取到可读文字且无分页预览图`,
      };
    }

    return {
      localPath,
      ...(hasReadableText ? { extractedText: extracted.text } : {}),
      ...(pageImages.length > 0 ? { pageImages } : {}),
    };
  } catch (err: any) {
    return { failedReason: err?.message || '附件处理异常' };
  }
}

/**
 * 获取单门课程的全部作业列表（含待做、重新编辑、已交状态）
 */
export async function getCourseHomeworkList(
  course: CourseInfo,
  cookies: ChaoxingCookies,
  sessionInfo?: CourseSessionInfo
): Promise<HomeworkSummary[]> {
  const session = sessionInfo || (await fetchCourseSession(course, cookies));

  const workUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/getAllWork?classId=${course.classId}&courseId=${course.courseId}&isdisplaytable=2&mooc=1&ut=s&enc=${session.enc}&cpi=${session.cpi}&openc=${session.openc}`;
  const res = await fetch(workUrl, {
    headers: {
      Cookie: session.courseCookie,
      'User-Agent': BROWSER_UA,
    },
  });

  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const encM =
    html.match(/doHomeWorkNew[\s\S]*?&enc=([a-f0-9]{32})/i) || html.match(/[?&]enc=([a-f0-9]{32})/i);
  const opencM =
    html.match(/doHomeWorkNew[\s\S]*?&openc=([a-f0-9]{32})/i) || html.match(/[?&]openc=([a-f0-9]{32})/i);
  const workEnc = encM ? encM[1] : session.enc;
  const workOpenc = opencM ? opencM[1] : session.openc;

  const items: HomeworkSummary[] = [];
  const listItems = doc.querySelectorAll('li');

  listItems.forEach((li) => {
    const taskLink = li.querySelector('.inspectTask') as HTMLElement | null;
    if (!taskLink) return;

    const workId = taskLink.getAttribute('data');
    const workAnswerId = taskLink.getAttribute('data2') || '0';
    const statusType = taskLink.getAttribute('data3') || '0';
    const title = taskLink.getAttribute('title') || taskLink.textContent?.trim() || '未命名作业';

    const text = li.textContent || '';
    const startM = text.match(/开始时间：\s*([\d\-: ]+)/);
    const endM = text.match(/截止时间：\s*([\d\-: ]+)/);
    const statusM = text.match(/作业状态：\s*([^\s]+)/);

    const statusText = statusM ? statusM[1] : statusType === '1' ? '待批阅' : '待做';
    const isDone =
      statusText.includes('待批') ||
      statusText.includes('已批') ||
      statusText.includes('已交') ||
      statusText.includes('完成');
    const isReturned =
      statusText.includes('打回') || statusText.includes('重做') || statusText.includes('退回');
    const isExpired = statusText.includes('过期') || statusText.includes('截止');
    const isPending =
      !isDone &&
      !isExpired &&
      (isReturned ||
        statusText.includes('待做') ||
        statusText.includes('未交') ||
        statusText.includes('重新编辑'));
    const canEdit = statusType === '0' || statusType === '1' || statusType === '4' || isPending;

    if (workId) {
      items.push({
        workId,
        workAnswerId,
        title,
        statusText,
        isPending,
        canEdit,
        startDate: startM ? startM[1].trim() : '',
        endDate: endM ? endM[1].trim() : '',
        courseId: course.courseId,
        classId: course.classId,
        courseName: course.courseName,
        enc: workEnc,
        cpi: session.cpi,
        openc: workOpenc,
      });
    }
  });

  const uniqueItems: HomeworkSummary[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item.workId)) {
      seen.add(item.workId);
      uniqueItems.push(item);
    }
  }
  return uniqueItems;
}

/**
 * 拉取作业题目详情与隐藏表单参数
 */
export async function getHomeworkDetail(
  homework: HomeworkSummary,
  cookies: ChaoxingCookies
): Promise<HomeworkDetail> {
  const session = await fetchCourseSession(
    {
      courseId: homework.courseId,
      classId: homework.classId,
      courseName: homework.courseName || '',
      cpi: homework.cpi,
    },
    cookies
  );

  const expireUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/isExpire?classId=${homework.classId}&workRelationId=${homework.workId}&cpi=${session.cpi}&courseId=${homework.courseId}`;
  let standardEnc = '';
  try {
    const expireRes = await fetch(expireUrl, {
      headers: {
        Cookie: session.courseCookie,
        'User-Agent': BROWSER_UA,
      },
    });
    const expireJson: any = await expireRes.json();
    if (expireJson.status === 1 || expireJson.status === '1') {
      const standard = expireJson.finishStandard || 0;
      throw new Error(`章节任务点未达标（需前置完成任务点 ${standard}% 后方可作答）`);
    }
    standardEnc = expireJson.standardEnc || '';
  } catch (err: any) {
    if (err.message && err.message.includes('章节任务点')) throw err;
  }

  const reEditParam =
    homework.statusText.includes('编辑') || homework.statusText.includes('批阅') ? '&reEdit=1' : '';
  const hwUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=${homework.courseId}&classId=${homework.classId}&workId=${homework.workId}&workAnswerId=${homework.workAnswerId || 0}${reEditParam}&isdisplaytable=2&mooc=1&enc=${homework.enc || session.enc}&workSystem=0&cpi=${session.cpi}&openc=${homework.openc || session.openc}&standardEnc=${standardEnc}`;

  const res = await fetch(hwUrl, {
    headers: {
      Cookie: session.courseCookie,
      'User-Agent': BROWSER_UA,
    },
  });

  const html = await res.text();
  if (html.includes('章节任务点未达标')) {
    throw new Error('章节任务点未达标，需先完成前置视频/课件方可作答');
  }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const formEl = doc.querySelector('#form1');
  const formAction = formEl?.getAttribute('action') || '';

  const formParams: Record<string, string> = {};
  doc.querySelectorAll('input, textarea, select').forEach((inp) => {
    const name = inp.getAttribute('name') || inp.getAttribute('id');
    const val = inp.getAttribute('value') || inp.textContent || '';
    if (name) formParams[name] = val;
  });

  formParams['workId'] = homework.workId;
  formParams['workRelationId'] = homework.workId;
  formParams['courseId'] = homework.courseId;
  formParams['classId'] = homework.classId;
  formParams['cpi'] = session.cpi;
  if (standardEnc) formParams['standardEnc'] = standardEnc;

  const questions: StandardQuestion[] = [];
  doc.querySelectorAll('.TiMu').forEach((node, index) => {
    const qId = node.getAttribute('data') || node.getAttribute('id') || String(index + 1);
    const titleEl =
      node.querySelector('.Zy_TItle') ||
      node.querySelector('.Cy_TItle1') ||
      node.querySelector('.clearfix') ||
      node;
    const fullTitle = titleEl.textContent?.replace(/\s+/g, ' ').trim() || '';

    const typeInp =
      node.querySelector(`input[name="answertype${qId}"]`) ||
      node.querySelector(`input[id="answertype${qId}"]`);
    const qTypeValue = typeInp?.getAttribute('value');

    let type: QuestionType = 'unknown';
    let typeName = '题目';

    if (qTypeValue === '0') {
      type = 'single';
      typeName = '单选题';
    } else if (qTypeValue === '1' || qTypeValue === '21') {
      type = 'multiple';
      typeName = '多选题';
    } else if (qTypeValue === '3') {
      type = 'judgement';
      typeName = '判断题';
    } else if (qTypeValue === '2' || qTypeValue === '9' || qTypeValue === '10') {
      type = 'blank';
      typeName = '填空题';
    } else if (['4', '5', '6', '7', '8', '18', '26'].includes(qTypeValue || '')) {
      type = 'essay';
      typeName = '简答题';
    } else if (fullTitle.includes('单选题')) {
      type = 'single';
      typeName = '单选题';
    } else if (fullTitle.includes('多选题')) {
      type = 'multiple';
      typeName = '多选题';
    } else if (fullTitle.includes('判断题')) {
      type = 'judgement';
      typeName = '判断题';
    } else if (fullTitle.includes('填空题')) {
      type = 'blank';
      typeName = '填空题';
    } else if (fullTitle.includes('简答题') || fullTitle.includes('主观题') || fullTitle.includes('论述题')) {
      type = 'essay';
      typeName = '简答题';
    }

    const options: QuestionOption[] = [];
    node.querySelectorAll('li.clearfix, .Zy_ulTop li, ul li').forEach((li) => {
      const keyM = li.textContent?.match(/([A-Z])[\.、\s]/);
      const key = keyM ? keyM[1] : '';
      const text =
        li.textContent
          ?.replace(/^[A-Z][\.、\s]*/, '')
          .replace(/\s+/g, ' ')
          .trim() || '';
      if (key && text && !text.includes('var wordNum')) {
        options.push({ key, text });
      }
    });

    const scoreM = fullTitle.match(/（([\d\.]+)分）|\(([\d\.]+)分\)/);
    const score = scoreM ? parseFloat(scoreM[1] || scoreM[2]) : undefined;

    const attachments: string[] = [];
    const seenAttachUrls = new Set<string>();
    titleEl.querySelectorAll('a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      const label = (a.textContent || '').trim();
      if (href && !href.startsWith('javascript:')) {
        seenAttachUrls.add(href);
        attachments.push(`[附件: ${label || '文件'} (${href})]`);
      }
    });
    titleEl.querySelectorAll('[objectid], iframe[data*="objectid"]').forEach((el) => {
      const dataAttr = el.getAttribute('data') || '';
      const oidMatch = dataAttr.match(/['"]?objectid['"]?\s*:\s*['"]([a-f0-9]{16,64})['"]/i);
      const oid = (el.getAttribute('objectid') || (oidMatch ? oidMatch[1] : '') || '').trim();
      if (oid) {
        const pseudoUrl = `/ueditorupload/read?objectId=${oid}`;
        if (!Array.from(seenAttachUrls).some((u) => u.includes(oid))) {
          seenAttachUrls.add(pseudoUrl);
          attachments.push(`[附件: 文档_${oid.slice(0, 8)} (${pseudoUrl})]`);
        }
      }
    });
    titleEl.querySelectorAll('img[src]').forEach((img) => {
      const src = (img.getAttribute('src') || '').trim();
      if (src && !src.startsWith('data:') && !isDecorativeChaoxingIcon(src)) {
        attachments.push(`[图片: ${src}]`);
      }
    });
    const enrichedTitle = attachments.length > 0 ? `${fullTitle}\n${attachments.join('\n')}` : fullTitle;

    questions.push({
      id: qId,
      type,
      typeName,
      title: enrichedTitle,
      options: options.length > 0 ? options : undefined,
      score,
    });
  });

  // 预下载超星题干图片与附件至本地，附上本地路径、分页截图与提取文本供多模态/Pro读取（规避 p.ananas.chaoxing.com 403 防盗链与空壳附件题）
  for (const q of questions) {
    const imgMatches = Array.from(q.title.matchAll(/\[图片:\s*([^\]\s]+)\]/g));
    for (const m of imgMatches) {
      const imgUrl = m[1];
      const localPath = await downloadChaoxingQuestionImage(imgUrl, session.courseCookie, homework.workId);
      if (localPath) {
        q.title = q.title.replace(`[图片: ${imgUrl}]`, `[图片: ${imgUrl} (本地已缓存: ${localPath})]`);
      }
    }
    const attMatches = Array.from(q.title.matchAll(/\[附件:\s*([^\](]+?)\s*\(([^)]+)\)\]/g));
    for (const m of attMatches) {
      const label = (m[1] || '文件').trim();
      const attUrl = (m[2] || '').trim();
      const dl = await downloadChaoxingQuestionAttachment(attUrl, label, session.courseCookie, homework.workId);
      if (dl?.localPath) {
        const pageImgPart =
          dl.pageImages && dl.pageImages.length > 0
            ? ` | 附件页面截图(可用read_file查看): ${dl.pageImages.join(', ')}`
            : '';
        const snippet = dl.extractedText ? ` | 附件摘要: ${dl.extractedText}` : '';
        q.title = q.title.replace(
          m[0],
          `[附件: ${label} (${attUrl} | 本地已缓存: ${dl.localPath}${pageImgPart}${snippet})]`
        );
      } else if (dl?.failedReason) {
        q.title = q.title.replace(
          m[0],
          `[附件: ${label} (${attUrl} | 附件不可读: ${dl.failedReason})]`
        );
      }
    }
  }

  if (questions.length > 0) {
    formParams['answerwqbid'] = `${questions.map((q) => q.id).join(',')},`;
  }

  return { questions, formParams, formAction, rawHtml: html };
}

/**
 * 判断作业是否要求上传源程序/附件/运行截图或手写拍照，无法仅靠纯文本自动作答
 */
export function requiresManualAttachmentUpload(
  questions: Array<{ title: string; options?: unknown[] }>
): boolean {
  if (!questions || questions.length === 0) return false;
  const uploadPattern =
    /(?:请上传|上传.{0,16}(?:源程序|源码|代码|截图|运行截图|结果截图|照片|图片|文件|附件|文档|压缩包|实验报告)|拍照上传)/i;
  return questions.every((q) => (!q.options || q.options.length === 0) && uploadPattern.test(q.title || ''));
}

/**
 * 提交或安全草稿暂存作业答案
 * @param isDraft true=暂存草稿(pyFlag=1，默认安全选项), false=正式提交(pyFlag=3)
 */
export async function submitHomework(
  homework: HomeworkSummary,
  answers: Record<string, string>,
  formParams: Record<string, string>,
  cookies: ChaoxingCookies,
  isDraft = true,
  formAction?: string
): Promise<{ success: boolean; msg: string; raw?: unknown }> {
  const session = await fetchCourseSession(
    {
      courseId: homework.courseId,
      classId: homework.classId,
      courseName: homework.courseName || '',
      cpi: homework.cpi,
    },
    cookies
  );

  const pyFlag = isDraft ? '1' : '3';
  const postData = new URLSearchParams();

  for (const [k, v] of Object.entries(formParams)) {
    postData.append(k, v);
  }

  postData.set('courseId', homework.courseId);
  postData.set('classId', homework.classId);
  postData.set('workId', homework.workId);
  postData.set('workRelationId', homework.workId);
  postData.set('pyFlag', pyFlag);

  for (const [qId, ans] of Object.entries(answers)) {
    postData.set(`answer${qId}`, ans);
  }

  if (!postData.has('answerwqbid') || !postData.get('answerwqbid')) {
    postData.set('answerwqbid', `${Object.keys(answers).join(',')},`);
  }

  const token = formParams['enc_work'] || '';
  const totalQuestionNum = formParams['totalQuestionNum'] || '';

  let submitUrl = '';
  if (isDraft) {
    submitUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/addStudentWorkNew?_classId=${homework.classId}&courseid=${homework.courseId}&pyFlag=1&token=${token}&totalQuestionNum=${totalQuestionNum}&cpi=${session.cpi}&ua=pc&formType=post&saveStatus=1&version=1`;
  } else {
    const actionClean =
      formAction && formAction.includes('addStudentWork')
        ? formAction.startsWith('/')
          ? formAction.substring(1)
          : formAction
        : `addStudentWorkNewWeb?_classId=${homework.classId}&courseid=${homework.courseId}&token=${token}&totalQuestionNum=${totalQuestionNum}&wMicroNodeId=0`;
    submitUrl = `https://mooc1-1.chaoxing.com/mooc-ans/work/${actionClean}&ua=pc&formType=post&saveStatus=1&version=1`;
  }

  const hwReferer = `https://mooc1-1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=${homework.courseId}&classId=${homework.classId}&workId=${homework.workId}&cpi=${session.cpi}`;

  let res: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          Cookie: session.courseCookie,
          'User-Agent': BROWSER_UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: hwReferer,
        },
        body: postData.toString(),
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  if (!res) {
    throw new Error('学习通作业提交/暂存请求未返回响应');
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML response fallback
  }

  const success = json
    ? json.status === true || json.result === 1
    : text.includes('成功') || text.includes('success');
  const msg =
    json?.msg ||
    json?.errorMsg ||
    (success
      ? isDraft
        ? '作业草稿已暂存保存 (pyFlag=1)'
        : '作业已成功正式提交 (pyFlag=3)'
      : `提交响应: ${text.substring(0, 100)}`);

  return { success, msg, raw: json || text };
}
