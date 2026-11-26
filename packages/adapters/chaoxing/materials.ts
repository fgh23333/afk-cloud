import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { extractReadableTextFromBuffer, sniffFileExtension } from '../../core/file-extract';
import { CourseInfo, MaterialItem } from '../../core/types';
import { ChaoxingCookies, CourseSessionInfo, fetchCourseSession } from './session';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 获取课程资料列表（课件、实验指导书、讲义等）
 */
export async function getCourseMaterialsList(
  course: CourseInfo,
  cookies: ChaoxingCookies,
  sessionInfo?: CourseSessionInfo
): Promise<MaterialItem[]> {
  const session = sessionInfo || (await fetchCourseSession(course, cookies));
  const dataUrl = `https://mooc1-1.chaoxing.com/mooc-ans/coursedata?classId=${course.classId}&courseId=${course.courseId}&type=1&ut=s&enc=${session.enc}&cpi=${session.cpi}&openc=${session.openc}`;

  const res = await fetch(dataUrl, {
    headers: {
      Cookie: session.courseCookie,
      'User-Agent': BROWSER_UA,
    },
  });

  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const items: MaterialItem[] = [];
  const rows = doc.querySelectorAll('tr');

  rows.forEach((row) => {
    const fileId =
      row.getAttribute('id') || (row.querySelector('input[name="checkdelete"]') as HTMLInputElement)?.value;
    const nameAnchor = row.querySelector('a[title]') || row.querySelector('a[name]');
    const fileName =
      nameAnchor?.getAttribute('title') || nameAnchor?.getAttribute('name') || nameAnchor?.textContent?.trim();

    if (fileId && fileName && !fileName.includes('新建文件夹') && !fileName.includes('课堂讲义')) {
      const text = row.textContent || '';
      const sizeMatch = text.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|Bytes))/i);
      const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);

      items.push({
        id: fileId,
        name: fileName,
        size: sizeMatch ? sizeMatch[1] : '',
        uploadDate: dateMatch ? dateMatch[1] : '',
      });
    }
  });

  return items;
}

/**
 * 批量下载指定课程的课件与参考资料，并提取 `.extracted.txt` 供 RAG 检索
 */
export async function downloadCourseMaterials(
  course: CourseInfo,
  cookies: ChaoxingCookies,
  options?: { targetDir?: string; maxFiles?: number }
): Promise<{ downloaded: MaterialItem[]; dir: string }> {
  const session = await fetchCourseSession(course, cookies);
  const materials = await getCourseMaterialsList(course, cookies, session);

  const cleanCourseName = (course.courseName || `Course_${course.courseId}`).replace(/[\\/:*?"<>|]/g, '_');
  const baseDir =
    options?.targetDir || path.resolve(process.cwd(), 'downloads', 'courses', cleanCourseName, 'materials');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const downloadedList: MaterialItem[] = [];
  const max = options?.maxFiles || 15;
  const targetMaterials = materials.slice(0, max);

  for (const item of targetMaterials) {
    try {
      const cleanFileName = item.name.replace(/[\\/:*?"<>|]/g, '_');
      const localFilePath = path.join(baseDir, cleanFileName);

      if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 0) {
        item.localPath = localFilePath;
        downloadedList.push(item);
        continue;
      }

      const dlApiUrl = `https://mooc1-1.chaoxing.com/mooc-ans/coursedata/downloadData?dataId=${item.id}&courseId=${course.courseId}&classId=${course.classId}&ut=s&cpi=${session.cpi}`;
      const dlRes = await fetch(dlApiUrl, {
        headers: {
          Cookie: session.courseCookie,
          'User-Agent': BROWSER_UA,
        },
      });

      const dlUrls: string[] = await dlRes.json();
      if (!Array.isArray(dlUrls) || dlUrls.length === 0 || !dlUrls[0]) continue;

      const fileRes = await fetch(dlUrls[0], {
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: 'https://mooc1-1.chaoxing.com/',
        },
      });

      if (!fileRes.ok) continue;

      const buf = Buffer.from(await fileRes.arrayBuffer());
      const realExt = sniffFileExtension(buf, {
        filename: cleanFileName,
        url: dlUrls[0],
        contentDisposition: fileRes.headers.get('content-disposition') || '',
        contentType: fileRes.headers.get('content-type') || '',
      });
      if (realExt === '.html' && !['.html', '.htm'].includes(path.extname(cleanFileName).toLowerCase())) {
        continue;
      }
      fs.writeFileSync(localFilePath, buf);
      item.localPath = localFilePath;
      downloadedList.push(item);

      const ext = path.extname(cleanFileName).toLowerCase() || realExt;
      const extracted = extractReadableTextFromBuffer(buf, ext, 20000);
      if (!extracted.isHtmlWrapper && extracted.text.length >= 10) {
        fs.writeFileSync(localFilePath + '.extracted.txt', extracted.text, 'utf8');
      }
    } catch {
      // 单文件下载容错
    }
  }

  return { downloaded: downloadedList, dir: baseDir };
}

/**
 * 基于题目关键词检索课程讲义 RAG 上下文段落
 */
export function searchCourseMaterialsContext(
  keywords: string[],
  courseDir: string,
  maxContextLength = 2500
): string {
  if (!fs.existsSync(courseDir)) return '';

  const files = fs.readdirSync(courseDir);
  const textFiles = files.filter(
    (f) => f.endsWith('.extracted.txt') || f.endsWith('.txt') || f.endsWith('.md')
  );

  const matchedSnippets: Array<{ text: string; score: number }> = [];

  for (const f of textFiles) {
    try {
      const content = fs.readFileSync(path.join(courseDir, f), 'utf8');
      const paragraphs = content.split(/\n\s*\n|\r\n\s*\r\n/);

      for (const p of paragraphs) {
        const trimmed = p.replace(/\s+/g, ' ').trim();
        if (trimmed.length < 10) continue;

        let score = 0;
        for (const kw of keywords) {
          if (kw && kw.length >= 2 && trimmed.includes(kw)) {
            score += kw.length;
          }
        }
        if (score > 0) {
          matchedSnippets.push({ text: trimmed, score });
        }
      }
    } catch {
      // ignore
    }
  }

  matchedSnippets.sort((a, b) => b.score - a.score);

  let result = '';
  for (const snippet of matchedSnippets) {
    if (result.length + snippet.text.length + 10 > maxContextLength) break;
    result += snippet.text + '\n---\n';
  }
  return result.trim();
}
