import {
  Course,
  fetchTopicDetail,
  login,
  postTopicReply,
  scanCourseBbsTopics,
  type BbsReplyParams,
  UserSession,
} from './chaoxing';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import {
  getCachedSession,
  getDiscussionById,
  getKnownDiscussionMetaMap,
  logExecution,
  markDiscussionPublished,
  saveCachedSession,
  upsertDiscoveredDiscussion,
} from './store';

export interface DiscussionScanSummary {
  scannedCourses: number;
  totalCourses: number;
  nextOffset: number;
  hasMore: boolean;
  topicsFound: number;
  newPendingTopics: number;
  repliedExternallyCount: number;
}

/**
 * 分批扫描在读课程的讨论区（控制单次 Workers 子请求数量在安全阈值内）
 */
export async function scanDiscussionsBatch(
  env: ExtendedNotifyEnv,
  session: UserSession,
  courses: Course[],
  options?: {
    realname?: string;
    offset?: number;
    limit?: number;
    forceDetailRefresh?: boolean;
    notifyOnNew?: boolean;
  }
): Promise<DiscussionScanSummary> {
  const totalCourses = courses.length;
  if (totalCourses === 0) {
    return {
      scannedCourses: 0,
      totalCourses: 0,
      nextOffset: 0,
      hasMore: false,
      topicsFound: 0,
      newPendingTopics: 0,
      repliedExternallyCount: 0,
    };
  }

  const limit = Math.max(1, Math.min(options?.limit ?? 9, totalCourses));
  const rawOffset = Math.max(0, options?.offset ?? 0) % totalCourses;
  const end = Math.min(rawOffset + limit, totalCourses);
  const batch = courses.slice(rawOffset, end);
  const nextOffset = end >= totalCourses ? 0 : end;
  const hasMore = end < totalCourses;

  let topicsFound = 0;
  let newPendingTopics = 0;
  let repliedExternallyCount = 0;

  for (const course of batch) {
    try {
      const { topics } = await scanCourseBbsTopics(course, session.cookie);
      const teacherTopics = topics.filter((t) => t.isTeacherTopic);
      if (teacherTopics.length === 0) continue;

      topicsFound += teacherTopics.length;
      const knownMap = await getKnownDiscussionMetaMap(env, course.courseId);

      for (const topic of teacherTopics) {
        const known = knownMap.get(topic.topicId);
        const shouldFetchDetail =
          Boolean(options?.forceDetailRefresh) ||
          !known ||
          (known.status === 'pending' && topic.replyCount !== known.replyCount);

        if (!shouldFetchDetail) continue;

        const detail = await fetchTopicDetail(topic, session.cookie, options?.realname);
        if (!detail.canReply && !detail.myReplied && known?.status === 'ignored') {
          continue;
        }

        const discussionId = `chaoxing-bbs-${detail.topicId}`;
        const isNewPending = await upsertDiscoveredDiscussion(env, {
          discussionId,
          platform: 'chaoxing',
          topicId: detail.topicId,
          courseId: detail.courseId,
          classId: detail.classId,
          courseName: detail.courseName,
          author: detail.author,
          title: detail.title,
          prompt: detail.prompt,
          chapterLabel: detail.chapterLabel,
          topicUrl: detail.detailUrl,
          bbsUrl: detail.bbsUrl,
          replyParams: detail.replyParams as Record<string, unknown> | null,
          replyCount: detail.replyCount,
          isTeacherTopic: detail.isTeacherTopic,
          myReplied: detail.myReplied,
        });

        if (detail.myReplied) {
          repliedExternallyCount++;
        }

        if (isNewPending && !detail.myReplied) {
          newPendingTopics++;
          if (options?.notifyOnNew !== false) {
            await logExecution(
              env,
              'discussion_detected',
              'chaoxing',
              `发现新话题讨论：《${detail.courseName}》- ${detail.title}`,
              { discussionId, topicId: detail.topicId, courseId: detail.courseId }
            );
            await sendNotification(
              'afk-cloud 发现新话题讨论 💬',
              `课程：《${detail.courseName}》${detail.author ? `（${detail.author}）` : ''}\n题目：${detail.title}\n说明：讨论区无服务端草稿箱，可在看板编辑或运行 pnpm afk discuss 生成 AI 拟稿后一键审批发布。\n直达：${detail.detailUrl}`,
              env
            );
          }
        }
      }
    } catch (err: any) {
      console.warn(`[scanDiscussionsBatch] 课程《${course.courseName}》扫描异常: ${err?.message || err}`);
    }
  }

  return {
    scannedCourses: batch.length,
    totalCourses,
    nextOffset,
    hasMore,
    topicsFound,
    newPendingTopics,
    repliedExternallyCount,
  };
}

/**
 * 获取可用超星 Edge 登录态（优先复用缓存，过期自动重登）
 */
export async function ensureChaoxingEdgeSession(env: ExtendedNotifyEnv): Promise<UserSession | null> {
  const phone = env.CHAOXING_PHONE || env.PHONE || '';
  const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
  if (!phone || !password) return null;

  let session = await getCachedSession<UserSession>(env, 'chaoxing', phone);
  if (session?.cookie) return session;

  session = await login(phone, password);
  if (session) {
    await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
  }
  return session;
}

/**
 * 人工审批后，由 Edge Worker 携带签名与登录态直接公开发布回复至学习通讨论区 (/mooc-ans/bbscircle/addreply)
 */
export async function approveAndPublishDiscussion(
  env: ExtendedNotifyEnv,
  discussionId: string,
  overrideReplyText?: string
): Promise<{ success: boolean; msg: string; discussionId: string; postedReply?: string }> {
  const row = await getDiscussionById(env, discussionId);
  if (!row) {
    return { success: false, msg: '讨论记录不存在', discussionId };
  }

  const content = (overrideReplyText !== undefined ? overrideReplyText : row.draft_reply || '').trim();
  if (!content) {
    return { success: false, msg: '回复内容为空，请先在看板填写或由 AI 生成拟稿后再审批发布', discussionId };
  }

  let session = await ensureChaoxingEdgeSession(env);
  if (!session) {
    return { success: false, msg: '未配置或无法获取学习通登录态', discussionId };
  }

  let replyParams: BbsReplyParams | null = null;
  if (row.reply_params_json) {
    try {
      replyParams = JSON.parse(row.reply_params_json) as BbsReplyParams;
    } catch {
      replyParams = null;
    }
  }

  // 若缺少 openc 或签名参数，从详情页实时拉取一次补齐
  if ((!replyParams || !replyParams.openc) && row.topic_url) {
    const freshDetail = await fetchTopicDetail(
      {
        topicId: String(row.topic_id),
        courseId: String(row.course_id),
        classId: String(row.class_id),
        courseName: String(row.course_name || ''),
        title: String(row.title || ''),
        author: String(row.author || ''),
        chapterLabel: String(row.chapter_label || ''),
        detailUrl: String(row.topic_url),
        bbsUrl: String(row.bbs_url || ''),
        replyCount: Number(row.reply_count || 0),
        isPinned: false,
        isTeacherTopic: true,
      },
      session.cookie,
      env.CHAOXING_REALNAME
    );
    replyParams = freshDetail.replyParams;
  }

  if (!replyParams) {
    return { success: false, msg: '未能解析该讨论帖的提交参数 (话题可能已关闭回复)', discussionId };
  }

  let postRes = await postTopicReply(replyParams, content, session.cookie, row.topic_url);
  // 若疑似会话过期导致失败，重登刷新一次后再试
  if (!postRes.success && /登录|超时|过期|HTTP 302|HTTP 403/i.test(postRes.msg)) {
    const phone = env.CHAOXING_PHONE || env.PHONE || '';
    const password = env.CHAOXING_PASSWORD || env.PASSWORD || '';
    if (phone && password) {
      const freshSession = await login(phone, password);
      if (freshSession) {
        session = freshSession;
        await saveCachedSession(env, 'chaoxing', phone, session, 6 * 3600);
        postRes = await postTopicReply(replyParams, content, session.cookie, row.topic_url);
      }
    }
  }

  if (!postRes.success) {
    return { success: false, msg: postRes.msg, discussionId };
  }

  await markDiscussionPublished(env, discussionId, content);
  await logExecution(
    env,
    'discussion_replied',
    'chaoxing',
    `已批准并发布讨论回复：《${row.course_name}》- ${row.title}`,
    { discussionId, topicId: row.topic_id, replyLength: content.length }
  );
  await sendNotification(
    '学习通话题讨论回复已发布 ✅',
    `课程：《${row.course_name}》\n话题：${row.title}\n字数：${content.length} 字`,
    env
  );

  return {
    success: true,
    msg: postRes.msg,
    discussionId,
    postedReply: content,
  };
}
