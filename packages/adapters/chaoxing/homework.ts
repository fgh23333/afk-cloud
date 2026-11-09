import { JSDOM } from 'jsdom';
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
    const isPending =
      hasPendingDot ||
      statusText.includes('待做') ||
      statusText.includes('未交') ||
      statusText.includes('重新编辑');
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

    questions.push({
      id: qId,
      type,
      typeName,
      title: fullTitle,
      options: options.length > 0 ? options : undefined,
      score,
    });
  });

  if (questions.length > 0) {
    formParams['answerwqbid'] = `${questions.map((q) => q.id).join(',')},`;
  }

  return { questions, formParams, formAction, rawHtml: html };
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

  const res = await fetch(submitUrl, {
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
