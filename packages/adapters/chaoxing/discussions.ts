import fs from 'fs';
import path from 'path';
import { blue, green, yellow } from 'kolorist';
import {
  fetchDiscussionsFromEdge,
  publishDiscussionOnEdge,
  pushDiscussionDraftToEdge,
  triggerDiscussionScanOnEdge,
} from '../../core/d1-bridge';
import { extractKeywords, solveDiscussionTopicWithAgy } from '../../core/solver';
import { CourseInfo, SolveOptions } from '../../core/types';
import {
  BbsTopicDetail,
  fetchTopicDetail,
  postTopicReply,
  scanCourseBbsTopics,
} from './bbs-protocol';
import { downloadCourseMaterials, searchCourseMaterialsContext } from './materials';
import { ChaoxingCookies } from './session';

export * from './bbs-protocol';

export interface DiscussionRunSummary {
  scanned: number;
  drafted: number;
  submitted: number;
  skipped: number;
  reportPath?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 将本地检测到的已回复/已忽略状态安全同步回 Edge 看板 D1（严禁覆盖为 submitted）
 */
export async function syncDiscussionStatusToEdge(
  discussionId: string,
  status: 'replied_externally' | 'ignored'
): Promise<boolean> {
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;
  if (!edgeUrl || !discussionId) return false;
  const edgeToken = process.env.AFK_EDGE_BEARER_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (edgeToken) headers['Authorization'] = `Bearer ${edgeToken}`;
  try {
    const res = await fetch(
      `${edgeUrl.replace(/\/+$/, '')}/api/discussions/${encodeURIComponent(discussionId)}/status`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ status }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 本地直接扫描课程讨论区教师话题及详情
 */
export async function scanCourseDiscussions(
  courses: CourseInfo[],
  cookies: ChaoxingCookies,
  options?: { realname?: string; includeStudentTopics?: boolean }
): Promise<BbsTopicDetail[]> {
  const details: BbsTopicDetail[] = [];

  for (const course of courses) {
    try {
      const { topics } = await scanCourseBbsTopics(course, cookies.cookieStr);
      const filtered = options?.includeStudentTopics ? topics : topics.filter((t) => t.isTeacherTopic);
      for (const card of filtered) {
        const detail = await fetchTopicDetail(card, cookies.cookieStr, options?.realname);
        details.push(detail);
        await sleep(80);
      }
      await sleep(120);
    } catch {
      // 单门课程讨论区容错
    }
  }

  return details;
}

/**
 * 拉取未回复讨论话题，结合对应课程课件 RAG 调用 agy 生成拟稿并推送到 Edge 看板待审批 (awaiting_approval)
 * 默认绝不自动调用 addreply 公开发布，除非显式传入 autoSubmit: true
 */
export async function solvePendingDiscussions(
  courses: CourseInfo[],
  cookies: ChaoxingCookies,
  options?: {
    realname?: string;
    autoSubmit?: boolean;
    regenerate?: boolean;
    courseFilter?: string;
    solveOptions?: SolveOptions;
  }
): Promise<DiscussionRunSummary> {
  const realname = options?.realname || process.env.CHAOXING_REALNAME || '同学';
  const isAutoSubmit = Boolean(options?.autoSubmit);
  const courseMap = new Map<string, CourseInfo>(courses.map((c) => [c.courseId, c]));

  const summary: DiscussionRunSummary = {
    scanned: 0,
    drafted: 0,
    submitted: 0,
    skipped: 0,
  };

  let candidateTopics: Array<{
    discussionId: string;
    topicId: string;
    courseId: string;
    classId: string;
    courseName: string;
    title: string;
    prompt: string;
    author: string;
    chapterLabel: string;
    detailUrl: string;
    bbsUrl: string;
    replyCount: number;
  }> = [];

  const targetStatuses = options?.regenerate ? ['pending', 'awaiting_approval'] : ['pending'];
  const edgeUrl = process.env.AFK_EDGE_WORKER_URL;

  if (edgeUrl) {
    let edgeItems = await fetchDiscussionsFromEdge(targetStatuses);
    // 若 Edge 尚无记录且未强制跳过扫描，自动分页触发一次 Edge 讨论区扫描
    if (edgeItems.length === 0) {
      let offset = 0;
      let hasMore = true;
      let rounds = 0;
      while (hasMore && rounds < 10) {
        rounds++;
        const scanRes = await triggerDiscussionScanOnEdge(offset, 9);
        if (!scanRes.ok) break;
        hasMore = Boolean(scanRes.hasMore);
        offset = Number(scanRes.nextOffset || 0);
      }
      edgeItems = await fetchDiscussionsFromEdge(targetStatuses);
    }

    candidateTopics = edgeItems.map((item) => ({
      discussionId: item.discussion_id,
      topicId: item.topic_id,
      courseId: item.course_id,
      classId: item.class_id,
      courseName: item.course_name,
      title: item.title,
      prompt: item.prompt,
      author: item.author || '',
      chapterLabel: item.chapter_label || '',
      detailUrl: item.topic_url,
      bbsUrl: item.bbs_url || '',
      replyCount: Number(item.reply_count || 0),
    }));
  } else {
    const filteredCourses = options?.courseFilter
      ? courses.filter((c) => c.courseName.includes(options.courseFilter!))
      : courses;
    const localDetails = await scanCourseDiscussions(filteredCourses, cookies, { realname });
    candidateTopics = localDetails
      .filter((d) => d.isTeacherTopic && !d.myReplied && d.canReply)
      .map((d) => ({
        discussionId: `chaoxing-disc-${d.topicId}`,
        topicId: d.topicId,
        courseId: d.courseId,
        classId: d.classId,
        courseName: d.courseName,
        title: d.title,
        prompt: d.prompt,
        author: d.author,
        chapterLabel: d.chapterLabel,
        detailUrl: d.detailUrl,
        bbsUrl: d.bbsUrl,
        replyCount: d.replyCount,
      }));
  }

  if (options?.courseFilter) {
    candidateTopics = candidateTopics.filter((t) => t.courseName.includes(options.courseFilter!));
  }

  summary.scanned = candidateTopics.length;
  if (candidateTopics.length === 0) {
    console.log(green('✨ 当前没有待拟稿的课程教师话题讨论。'));
    return summary;
  }

  console.log(blue(`\n💬 共发现 ${candidateTopics.length} 个待拟稿话题讨论，开始结合课件 RAG 生成拟稿...`));

  const materialsDirCache = new Map<string, string>();
  const draftReportBlocks: string[] = [];

  for (const item of candidateTopics) {
    try {
      const detail = await fetchTopicDetail(
        {
          topicId: item.topicId,
          courseId: item.courseId,
          classId: item.classId,
          courseName: item.courseName,
          title: item.title,
          author: item.author,
          chapterLabel: item.chapterLabel,
          detailUrl: item.detailUrl,
          bbsUrl: item.bbsUrl,
          replyCount: item.replyCount,
          isPinned: false,
          isTeacherTopic: true,
        },
        cookies.cookieStr,
        realname
      );

      if (detail.myReplied) {
        const syncedStatus = edgeUrl
          ? await syncDiscussionStatusToEdge(item.discussionId, 'replied_externally')
          : false;
        console.log(
          yellow(
            `  ⏭️ 跳过 《${item.courseName}》"${item.title}" (检测到本人已回复${syncedStatus ? '，已回写状态至云端' : ''})`
          )
        );
        summary.skipped++;
        continue;
      }

      if (!detail.canReply) {
        console.log(yellow(`  ⏭️ 跳过 《${item.courseName}》"${item.title}" (话题已关闭回复)`));
        summary.skipped++;
        continue;
      }

      // 检索对应课程讲义上下文
      let materialsContext = '';
      const course = courseMap.get(item.courseId);
      if (course) {
        let dir = materialsDirCache.get(item.courseId);
        if (!dir) {
          try {
            const dl = await downloadCourseMaterials(course, cookies, { maxFiles: 10 });
            dir = dl.dir;
            materialsDirCache.set(item.courseId, dir);
          } catch {
            dir = '';
          }
        }
        if (dir) {
          const keywords = extractKeywords(`${item.title} ${detail.prompt}`);
          materialsContext = searchCourseMaterialsContext(keywords, dir, 3200);
        }
      }

      console.log(blue(`  🧠 正在为 《${item.courseName}》"${item.title}" 生成拟稿...`));
      const solved = await solveDiscussionTopicWithAgy(
        {
          discussionId: item.discussionId,
          courseName: item.courseName,
          title: item.title,
          prompt: detail.prompt || item.prompt || item.title,
          author: detail.author || item.author,
          chapterLabel: detail.chapterLabel || item.chapterLabel,
        },
        materialsContext,
        options?.solveOptions
      );

      const synced = await pushDiscussionDraftToEdge(item.discussionId, solved.reply, solved.modelUsed);
      summary.drafted++;

      console.log(green(`  ✅ 拟稿完成 (${solved.modelUsed})${synced ? '，已同步至云端看板【待审批】' : ''}`));
      console.log(`     预览: ${solved.reply.replace(/\s+/g, ' ').substring(0, 100)}...`);

      draftReportBlocks.push(
        `### 《${item.courseName}》 ${item.title}\n- 链接: ${item.detailUrl}\n- 状态: ${synced ? '已推送至看板 awaiting_approval' : '仅本地草稿'}\n\n${solved.reply}\n`
      );

      if (isAutoSubmit) {
        if (edgeUrl) {
          const pubRes = await publishDiscussionOnEdge(item.discussionId, solved.reply);
          if (pubRes.ok) {
            summary.submitted++;
            console.log(green(`  🚀 [auto-submit] 已通过 Edge 自动发布至学习通讨论区`));
          } else {
            console.log(yellow(`  ⚠️ [auto-submit] Edge 发布失败: ${pubRes.msg || '未知错误'}`));
          }
        } else if (detail.replyParams) {
          const postRes = await postTopicReply(detail.replyParams, solved.reply, cookies.cookieStr, detail.detailUrl);
          if (postRes.success) {
            summary.submitted++;
            console.log(green(`  🚀 [auto-submit] 已发布至学习通讨论区`));
          } else {
            console.log(yellow(`  ⚠️ [auto-submit] 发布失败: ${postRes.msg}`));
          }
        }
      }
    } catch (err: any) {
      console.log(yellow(`  ⚠️ 处理话题 "${item.title}" 失败: ${err?.message || err}`));
      summary.skipped++;
    }
  }

  if (draftReportBlocks.length > 0) {
    const outDir = path.resolve(process.cwd(), 'downloads', 'discussions');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, `discussion_drafts_${Date.now()}.md`);
    fs.writeFileSync(reportPath, `# 超星讨论区 AI 拟稿报告\n\n${draftReportBlocks.join('\n---\n\n')}`, 'utf8');
    summary.reportPath = reportPath;
  }

  return summary;
}
