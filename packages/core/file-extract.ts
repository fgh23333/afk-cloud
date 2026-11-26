import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

export interface ChaoxingViewerMetadata {
  isLoginPage: boolean;
  isViewerHtml: boolean;
  objectId?: string;
  directDownloadUrl?: string;
  filename?: string;
}

export interface TextExtractionResult {
  text: string;
  format: string;
  isHtmlWrapper?: boolean;
}

const KNOWN_DOC_EXT_RE = /\.(txt|md|csv|json|html?|docx?|pdf|pptx?|xlsx?|rtf|c|cpp|py|java|png|jpe?g|gif|webp|bmp|svg|zip)(?:$|[?#\s"'&])/i;

/**
 * 判断二进制缓冲区头部是否为 HTML 网页（如登录跳转页或在线预览外壳页）
 */
export function looksLikeHtmlBuffer(buf: Buffer): boolean {
  if (!buf || buf.length === 0) return false;
  const head = buf
    .subarray(0, Math.min(buf.length, 512))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<!doctype ') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<script') ||
    head.startsWith('<meta') ||
    head.startsWith('<title')
  );
}

/**
 * 解析超星在线浏览外壳 HTML / 登录拦截页元数据（objectId、cldisk 下载直链、原始文件名）
 */
export function parseChaoxingViewerHtml(html: string, baseUrl = ''): ChaoxingViewerMetadata {
  const src = String(html || '');
  const isLoginPage =
    /passport2\.chaoxing\.com|action=["'][^"']*login|<title>\s*用户登录\s*<\/title>/i.test(src) ||
    /name=["']uname["'][^>]*>/i.test(src);

  let objectId = '';
  try {
    if (baseUrl) {
      const u = new URL(baseUrl);
      objectId = u.searchParams.get('objectId') || u.searchParams.get('objectid') || '';
    }
  } catch {
    // ignore URL parse error
  }
  if (!objectId) {
    const m =
      src.match(/objectid\s*[:=]\s*["']([a-f0-9]{16,64})["']/i) ||
      src.match(/["']objectid["']\s*:\s*["']([a-f0-9]{16,64})["']/i) ||
      src.match(/[?&]objectid=([a-f0-9]{16,64})/i);
    if (m) objectId = m[1];
  }

  let directDownloadUrl = '';
  const btnDownMatch =
    src.match(/<a[^>]*class=["'][^"']*btnDown[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
    src.match(/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*btnDown[^"']*["']/i) ||
    src.match(/["'](https?:\/\/d\d+\.cldisk\.com\/download\/[^"']+)["']/i);
  if (btnDownMatch) {
    directDownloadUrl = btnDownMatch[1].replace(/&amp;/g, '&').trim();
  }

  let filename = '';
  const urlToInspect = directDownloadUrl || baseUrl;
  if (urlToInspect) {
    try {
      const u = new URL(urlToInspect);
      const rawFn = u.searchParams.get('fn') || u.searchParams.get('fileOriName') || '';
      if (rawFn) filename = decodeURIComponent(rawFn).trim();
    } catch {
      // ignore
    }
  }
  if (!filename) {
    const hdrMatch = src.match(/<div class="header">\s*([^\r\n<]{2,140})/);
    if (hdrMatch) {
      const cand = hdrMatch[1].trim();
      if (KNOWN_DOC_EXT_RE.test(cand)) filename = cand;
    }
  }

  const isViewerHtml = Boolean(
    objectId ||
      directDownloadUrl ||
      /<title>\s*浏览\s*<\/title>/i.test(src) ||
      src.includes('ans-attach-online') ||
      src.includes('/ananas/modules/')
  );

  return {
    isLoginPage,
    isViewerHtml,
    ...(objectId ? { objectId } : {}),
    ...(directDownloadUrl ? { directDownloadUrl } : {}),
    ...(filename ? { filename } : {}),
  };
}

/**
 * 结合文件魔数（Magic Bytes）与文件名/Header 线索推断真实扩展名，彻底规避外壳页伪装为文档或误标 .bin
 */
export function sniffFileExtension(
  buf: Buffer,
  hints: { filename?: string; label?: string; url?: string; contentDisposition?: string; contentType?: string }
): string {
  const hintTexts = [hints.contentDisposition || '', hints.filename || '', hints.label || ''];
  if (hints.url) {
    try {
      const u = new URL(hints.url);
      hintTexts.push(
        u.searchParams.get('fileOriName') || '',
        u.searchParams.get('fn') || '',
        u.pathname || ''
      );
    } catch {
      hintTexts.push(hints.url);
    }
  }
  const combinedHint = hintTexts.join(' ');

  if (buf && buf.length >= 4) {
    if (looksLikeHtmlBuffer(buf)) return '.html';
    if (buf.subarray(0, 4).toString('ascii') === '%PDF') return '.pdf';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    const gifHead = buf.subarray(0, 6).toString('ascii');
    if (gifHead === 'GIF87a' || gifHead === 'GIF89a') return '.gif';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      return '.webp';
    }
    if (buf.subarray(0, 5).toString('ascii').toLowerCase() === '{\\rtf') return '.rtf';
    // OLE2 Compound Document (.doc / .xls / .ppt)
    if (
      buf.length >= 8 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0 &&
      buf[4] === 0xa1 &&
      buf[5] === 0xb1 &&
      buf[6] === 0x1a &&
      buf[7] === 0xe1
    ) {
      if (/\.pptx?\b/i.test(combinedHint)) return '.ppt';
      if (/\.xlsx?\b/i.test(combinedHint)) return '.xls';
      return '.doc';
    }
    // ZIP / OpenXML (.docx / .pptx / .xlsx)
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
      if (buf.includes('word/document.xml') || /\.docx/i.test(combinedHint)) return '.docx';
      if (buf.includes('ppt/slides/') || /\.pptx/i.test(combinedHint)) return '.pptx';
      if (buf.includes('xl/workbook.xml') || /\.xlsx/i.test(combinedHint)) return '.xlsx';
      return '.zip';
    }
  }

  for (const h of hintTexts) {
    const m = h.match(KNOWN_DOC_EXT_RE);
    if (m) return `.${m[1].toLowerCase()}`;
  }

  const ct = (hints.contentType || '').toLowerCase();
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('wordprocessingml')) return '.docx';
  if (ct.includes('msword')) return '.doc';
  if (ct.includes('presentationml')) return '.pptx';
  if (ct.includes('spreadsheetml')) return '.xlsx';
  if (ct.includes('text/html')) return '.html';
  if (ct.includes('text/plain')) return '.txt';
  if (ct.includes('text/markdown')) return '.md';
  if (ct.includes('application/json')) return '.json';
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/jpeg')) return '.jpg';

  return '.bin';
}

function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    });
}

/**
 * 零依赖纯 Node 解析 ZIP Central Directory，按正则提取并解压指定 XML 条目（支持无 external unzip 的容器与单测）
 */
function readZipEntriesMatching(buf: Buffer, entryNameRe: RegExp): Array<{ name: string; content: Buffer }> {
  const results: Array<{ name: string; content: Buffer }> = [];
  if (!buf || buf.length < 22) return results;

  // Locate End of Central Directory record (0x06054b50) scanning backwards from tail
  const minPos = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return results;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries && ptr + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const entryName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!entryNameRe.test(entryName)) continue;
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;

    const rawData = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) {
        results.push({ name: entryName, content: rawData });
      } else if (method === 8) {
        results.push({ name: entryName, content: zlib.inflateRawSync(rawData) });
      }
    } catch {
      // skip corrupted entry
    }
  }
  return results;
}

function extractOpenXmlText(buf: Buffer): string {
  const entries = readZipEntriesMatching(
    buf,
    /^(word\/document\.xml|word\/header\d*\.xml|word\/footer\d*\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml)$/i
  );
  if (entries.length === 0) return '';

  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const parts: string[] = [];
  for (const entry of entries) {
    const xml = entry.content.toString('utf8');
    const withNewlines = xml
      .replace(/<\/(?:w:p|a:p|w:tr|si)>/gi, '\n')
      .replace(/<(?:w:br|w:cr|a:br)\b[^>]*\/?>/gi, '\n')
      .replace(/<w:tab\b[^>]*\/?>/gi, '\t');
    const stripped = decodeXmlEntities(withNewlines.replace(/<[^>]+>/g, ''))
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    if (stripped) parts.push(stripped);
  }
  return parts.join('\n');
}

function isLikelyWordBinaryNoise(line: string): boolean {
  if (/^(?:Root Entry|1Table|WordDocument|SummaryInformation|DocumentSummaryInformation|CompObj|Times New Roman|SimSun|Calibri|Cambria|Microsoft YaHei|Microsoft Office Word|Normal\.dotm|__Grammarly|H4sIAAAAA|Header Char|Footer Char)/i.test(line)) {
    return true;
  }
  // 排除因奇数字节错位把 ASCII 字节读进 UTF-16LE 高位 (low byte === 0) 产生的乱码伪汉字（保留真实常用字 U+4E00 '一'）
  let shiftedAsciiCount = 0;
  let totalCjk = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if ((code & 0xff) === 0 && code !== 0x4e00 && code >= 0x2000 && code <= 0x7e00) {
      shiftedAsciiCount++;
    }
    if (code >= 0x4e00 && code <= 0x9fa5) {
      totalCjk++;
    }
  }
  if (shiftedAsciiCount >= 2 && (totalCjk === 0 || shiftedAsciiCount >= totalCjk / 2)) {
    return true;
  }
  return false;
}

function extractLegacyDocText(buf: Buffer): string {
  // OLE2 中 Word 正文主要以 UTF-16LE 存入 WordDocument 流，兼容部分 ASCII/UTF-8 英文片段
  const lines: string[] = [];
  const seen = new Set<string>();
  const addLine = (raw: string) => {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean.length < 4) return;
    if (isLikelyWordBinaryNoise(clean)) return;
    if (!/[\u4e00-\u9fa5]/.test(clean) && !/[A-Za-z]{4,}/.test(clean)) return;
    if (!seen.has(clean)) {
      seen.add(clean);
      lines.push(clean);
    }
  };

  for (const offset of [0, 1]) {
    if (offset === 1 && lines.join('\n').length >= 40) break;
    const sub = offset === 0 ? buf : buf.subarray(1);
    const evenLen = sub.length - (sub.length % 2);
    if (evenLen < 8) continue;
    const u16 = sub.subarray(0, evenLen).toString('utf16le');
    // 严格仅保留真实常见汉字、数字、ASCII 可打印符号与中文标点（排除低字节为 00 的错位字符）
    let current = '';
    const flush = () => {
      if (current.length >= 4) {
        addLine(current);
      }
      current = '';
    };
    for (let i = 0; i < u16.length; i++) {
      const code = u16.charCodeAt(i);
      const isAscii = code >= 0x20 && code <= 0x7e;
      const isNewlineOrTab = code === 0x09 || code === 0x0a || code === 0x0d;
      const isCommonCjk =
        (code >= 0x4e00 && code <= 0x9fa5) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff01 && code <= 0xff5e);
      if (isNewlineOrTab) {
        flush();
      } else if (isAscii || isCommonCjk) {
        current += u16[i];
      } else {
        flush();
      }
    }
    flush();
  }

  // 同时补充提取纯 ASCII/UTF-8 段落（部分老文档以 8-bit Windows-1252 保存英文题干或代码）
  const asciiStr = buf.toString('latin1');
  const asciiRuns = asciiStr.match(/[A-Za-z0-9_.,:;!?()\[\]{}<>+\-*\/="' \t]{10,}/g) || [];
  for (const run of asciiRuns) {
    if (/[A-Za-z]{4,}\s+[A-Za-z0-9]{2,}/.test(run)) {
      addLine(run);
    }
  }

  return lines.join('\n');
}

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next >= '0' && next <= '7') {
      const oct = raw.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0] || next;
      i += oct.length - 1;
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function extractPdfText(buf: Buffer): string {
  // 1) 若宿主机安装了 poppler-utils (pdftotext)，优先使用最高精度提取
  try {
    const out = execFileSync('pdftotext', ['-layout', '-nopgbrk', '-', '-'], {
      input: buf,
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString('utf8');
    if (out.trim().length >= 10) return out.trim();
  } catch {
    // pdftotext unavailable, use built-in stream parser
  }

  // 2) 纯 Node FlateDecode 解压提取 ASCII / UTF-16BE PDF 文本指令
  const chunks: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const s = buf.indexOf('stream', pos);
    if (s === -1) break;
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buf[dataStart] === 0x0a) dataStart += 1;
    else {
      pos = s + 6;
      continue;
    }
    const e = buf.indexOf('endstream', dataStart);
    if (e === -1) break;
    const rawStream = buf.subarray(dataStart, e);
    let content = '';
    try {
      content = zlib.inflateSync(rawStream).toString('latin1');
    } catch {
      content = rawStream.toString('latin1');
    }
    const litMatches = content.match(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g) || [];
    for (const m of litMatches) {
      const inner = m.replace(/^\(/, '').replace(/\)\s*(?:Tj|'|")$/, '');
      const decoded = decodePdfLiteralString(inner).trim();
      if (decoded.length >= 2 && /[A-Za-z0-9\u4e00-\u9fa5]/.test(decoded)) {
        chunks.push(decoded);
      }
    }
    // 解析 UTF-16BE <FEFF...> hex string
    const u16Matches = content.match(/<FEFF([0-9A-Fa-f]{8,})>/gi) || [];
    for (const hm of u16Matches) {
      const hex = hm.slice(5, -1);
      const bytes = Buffer.from(hex, 'hex');
      if (bytes.length >= 2) {
        bytes.swap16();
        const text = bytes.toString('utf16le').trim();
        if (text) chunks.push(text);
      }
    }
    pos = e + 9;
  }

  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function extractRtfText(raw: string): string {
  return raw
    .replace(/\{\\\*[^}]*\}/g, ' ')
    .replace(/\\par\b|\\line\b/g, '\n')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, code) => {
      const n = parseInt(code, 10);
      return String.fromCharCode(n < 0 ? n + 65536 : n);
    })
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 统一从本地文档缓冲区提取可读文本（防 HTML 外壳伪装、全面支持 TXT/MD/Code/DOCX/OLE2-DOC/PDF/RTF）
 */
export function extractReadableTextFromBuffer(
  buf: Buffer,
  ext: string,
  maxChars = 3500
): TextExtractionResult {
  const normExt = (ext || '').toLowerCase();
  if (!buf || buf.length === 0) {
    return { text: '', format: normExt || 'empty' };
  }

  if (looksLikeHtmlBuffer(buf)) {
    const html = buf.toString('utf8');
    const viewer = parseChaoxingViewerHtml(html);
    if (viewer.isLoginPage || viewer.isViewerHtml || !['.html', '.htm'].includes(normExt)) {
      return { text: '', format: 'html-wrapper', isHtmlWrapper: true };
    }
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
    return { text: stripped, format: 'html' };
  }

  if (['.txt', '.md', '.csv', '.json', '.c', '.cpp', '.py', '.java'].includes(normExt)) {
    const clean = buf
      .toString('utf8')
      .replace(/\u0000/g, '')
      .replace(/\r/g, '')
      .trim()
      .slice(0, maxChars);
    return { text: clean, format: normExt.slice(1) };
  }

  if (['.docx', '.pptx', '.xlsx'].includes(normExt) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const xmlText = extractOpenXmlText(buf);
    if (xmlText) {
      return { text: xmlText.slice(0, maxChars), format: 'openxml' };
    }
  }

  if (normExt === '.rtf' || buf.subarray(0, 5).toString('ascii').toLowerCase() === '{\\rtf') {
    const rtfText = extractRtfText(buf.toString('latin1'));
    return { text: rtfText.slice(0, maxChars), format: 'rtf' };
  }

  if (normExt === '.doc' || (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf)) {
    const docText = extractLegacyDocText(buf);
    return { text: docText.slice(0, maxChars), format: 'doc-ole2' };
  }

  if (normExt === '.pdf' || buf.subarray(0, 4).toString('ascii') === '%PDF') {
    const pdfText = extractPdfText(buf);
    return { text: pdfText.slice(0, maxChars), format: 'pdf' };
  }

  return { text: '', format: normExt || 'binary' };
}
