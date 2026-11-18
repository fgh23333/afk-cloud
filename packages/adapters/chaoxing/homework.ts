import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { resolveAgyWorkdir } from '../../core/agy-invoke';
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

/**
 * 预下载超星防盗链题面图片（携带 Cookie 与 Referer: https://mooc1-1.chaoxing.com/）至 agy 沙箱可读目录
 */
export async function downloadChaoxingQuestionImage(
  imgUrl: string,
  courseCookie: string,
  workId: string
): Promise<string | null> {
  if (!imgUrl || !/^https?:\/\//i.test(imgUrl) || process.env.NODE_ENV === 'test') {
    return null;
  }
  try {
    const safeWorkDir = String(workId || 'common').replace(/[^a-zA-Z0-9_-]/g, '_');
    const assetDir = path.join(resolveAgyWorkdir(), 'homework_assets', safeWorkDir);
    fs.mkdirSync(assetDir, { recursive: true });
    const extMatch = new URL(imgUrl).pathname.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '.png';
    const hash = crypto.createHash('sha1').update(imgUrl).digest('hex').slice(0, 12);
    const localPath = path.join(assetDir, `img_${hash}${ext}`);
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
      return localPath;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(imgUrl, {
        headers: {
          Cookie: courseCookie,
          Referer: CHAOXING_REFERER,
          'User-Agent': BROWSER_UA,
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_QUESTION_IMAGE_BYTES) return null;
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
 * 获取单门课程的全部作业列表（含待做、重新编辑、已交状态）
 */
export async function getCourseHomeworkList(
  course: CourseInfo,
  cookies: ChaoxingCookies,
  sessionInfo?: CourseSessionInfo
): Promise<HomeworkSummary[]> {
  const session = sessionInfo || (await fetchCourseSession(course, cookies));

  let hasPendingDot = false;
  try {
    const pendingRes = await fetch(
      `https://mooc1-1.chaoxing.com/work/workTestPendingNew?classIds=${course.classId}`,
      {
        headers: {
          Cookie: session.courseCookie,
          'User-Agent': BROWSER_UA,
        },
      }
    );
    const pendingJson: any = await pendingRes.json();
    hasPendingDot = !!pendingJson?.[0]?.hasWorkMsg;
  } catch {
    // ignore
  }

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
    const isPending =
      !isDone &&
      (hasPendingDot ||
        isReturned ||
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
    titleEl.querySelectorAll('a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      const label = (a.textContent || '').trim();
      if (href && !href.startsWith('javascript:')) {
        attachments.push(`[附件: ${label || '文件'} (${href})]`);
      }
    });
    titleEl.querySelectorAll('img[src]').forEach((img) => {
      const src = (img.getAttribute('src') || '').trim();
      if (src && !src.startsWith('data:')) {
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

  // 预下载超星题干图片至本地，附上本地路径供多模态读取（规避 p.ananas.chaoxing.com 403 防盗链）
  for (const q of questions) {
    const imgMatches = Array.from(q.title.matchAll(/\[图片:\s*(https?:\/\/[^\]\s]+)\]/g));
    for (const m of imgMatches) {
      const imgUrl = m[1];
      const localPath = await downloadChaoxingQuestionImage(imgUrl, session.courseCookie, homework.workId);
      if (localPath) {
        q.title = q.title.replace(`[图片: ${imgUrl}]`, `[图片: ${imgUrl} (本地已缓存: ${localPath})]`);
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
