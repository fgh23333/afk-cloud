import { Agent, callable } from 'agents';
import {
  checkHomeworkPendingCourses,
  fetchNoticeList,
  getCourses,
  login,
  performSign,
  resolveSignLocations,
  scanCourseActivities,
  UserSession,
} from './chaoxing';
import { ExtendedNotifyEnv, sendNotification } from './notify';
import { getCachedSession, logExecution, nowUtc8, saveCachedSession, saveNotices } from './store';

export interface SignState {
  lastCheckedAt?: string;
  lastSignAt?: string;
  activeActivitiesCount: number;
  recentSignedIds?: string[];
}

export class SignAgent extends Agent<ExtendedNotifyEnv, SignState> {
  initialState = {
    activeActivitiesCount: 0,
    recentSignedIds: [] as string[],
  };

  onStart(): void {
    console.log(`[SignAgent] SignAgent Durable Object 已启动`);
  }

  /**
   * 巡检核心链路：课表时段巡检 + 秒级签到 + 作业红点探测并自动推入 SolverAgent
   */
  @callable()
  async checkInspection(): Promise<{
    success: boolean;
    msg: string;
    signsFound: number;
    homeworkFound: number;
    noticesFound?: number;
    time: string;
  }> {
    const phone = this.env.CHAOXING_PHONE || this.env.PHONE || '';
    const password = this.env.CHAOXING_PASSWORD || this.env.PASSWORD || '';
    const realname = this.env.CHAOXING_REALNAME || '同学';

    if (!phone || !password) {
      return {
        success: false,
        msg: '未配置学习通账号凭据 (CHAOXING_PHONE/CHAOXING_PASSWORD)',
        signsFound: 0,
        homeworkFound: 0,
        time: nowUtc8(),
      };
    }

    // 1. 获取登录态 (优先复用 D1 / KV 缓存，6 小时免登)
    let session = await getCachedSession<UserSession>(this.env, 'chaoxing', phone);
    if (!session) {
      session = await login(phone, password);
      if (!session) {
        await logExecution(this.env, 'error', 'chaoxing', '登录失败，请检查账号密码');
        return {
          success: false,
          msg: '学习通登录失败',
          signsFound: 0,
          homeworkFound: 0,
          time: nowUtc8(),
        };
      }
      await saveCachedSession(this.env, 'chaoxing', phone, session, 6 * 3600);
    }

    // 2. 拉取课程列表
    let courses = await getCourses(session);
    if (courses.length === 0) {
      // 登录态可能已过期，重登一次
      session = await login(phone, password);
      if (session) {
        await saveCachedSession(this.env, 'chaoxing', phone, session, 6 * 3600);
        courses = await getCourses(session);
      }
    }

    if (!session) {
      return {
        success: false,
        msg: '学习通登录态失效且重登失败',
        signsFound: 0,
        homeworkFound: 0,
        time: nowUtc8(),
      };
    }

    const currentSession = session;

    if (courses.length === 0) {
      return {
        success: true,
        msg: '未获取到学期课程列表',
        signsFound: 0,
        homeworkFound: 0,
        time: nowUtc8(),
      };
    }

    // 3. 扫描各课程活跃签到活动 (优先在读前 20 门课程，分批并发 5 门，将耗时压缩至 4-6 秒)
    let signsHandled = 0;
    const customLocations = resolveSignLocations(this.env);
    const targetCourses = courses.length > 20 ? courses.slice(0, 20) : courses;
    const batchSize = 5;
    const recentSigned = new Set(this.state.recentSignedIds || []);

    for (let i = 0; i < targetCourses.length; i += batchSize) {
      const chunk = targetCourses.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (course) => {
          try {
            const activities = await scanCourseActivities(course, currentSession);
            for (const act of activities) {
              const actIdStr = String(act.id);
              if (recentSigned.has(actIdStr)) {
                continue;
              }
              console.log(`[SignAgent] 发现课程《${course.courseName}》签到活动: ${act.name} (ID: ${act.id})`);
              const signRes = await performSign(act, course, currentSession, realname, customLocations);
              const success = signRes.includes('成功') || signRes.includes('已签');
              signsHandled++;

              if (success) {
                recentSigned.add(actIdStr);
              }

              await logExecution(
                this.env,
                success ? 'sign_success' : 'sign_fail',
                'chaoxing',
                `课程《${course.courseName}》[${act.name}]: ${signRes}`,
                { courseId: course.courseId, classId: course.classId, activeId: act.id }
              );

              await sendNotification(
                `学习通签到${success ? '成功 ✅' : '异常 ⚠️'}`,
                `课程：《${course.courseName}》\n活动：${act.name}\n状态：${signRes}\n时间：${nowUtc8()}`,
                this.env
              );
            }
          } catch (err: any) {
            console.warn(`[SignAgent] 扫描课程《${course.courseName}》异常: ${err?.message || err}`);
          }
        })
      );
    }

    // 4. 红点探测新待办作业 (纯协议读接口，不惊动 agy)
    let homeworkCount = 0;
    try {
      const pendingCourses = await checkHomeworkPendingCourses(courses, currentSession);
      if (pendingCourses.length > 0 && this.env.SOLVER_AGENT) {
        const solverStub = this.env.SOLVER_AGENT.get(this.env.SOLVER_AGENT.idFromName('default'));

        for (const pc of pendingCourses) {
          const jobId = `chaoxing-hw-${pc.courseId}-${pc.classId || Date.now()}`;
          const taskUrl = `https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=${pc.courseId}&classId=${pc.classId}&cpi=${pc.cpi || ''}&workId=`;
          const title = `《${pc.courseName}》待办作业`;

          console.log(`[SignAgent] 探测到新作业红点: ${title} (JobId: ${jobId})`);

          // 调 SolverAgent.enqueue 推入任务队列
          const enqueueRes: any = await (solverStub as any).enqueue({
            jobId,
            platform: 'chaoxing',
            taskUrl,
            courseName: pc.courseName,
            title,
          });

          if (enqueueRes?.accepted) {
            homeworkCount++;
            await sendNotification(
              'afk-cloud 发现新作业待办',
              `课程：《${pc.courseName}》\n作业：${title}\n任务已自动入队派发求解。`,
              this.env
            );
          }
        }
      }
    } catch (err: any) {
      console.warn(`[SignAgent] 作业红点探测异常: ${err?.message || err}`);
    }

    // 5. 抓取超星通知箱消息并持久化到 D1 (涵盖班级通知、随堂测验与新作业)
    let noticesFound = 0;
    try {
      const noticeList = await fetchNoticeList(currentSession, 20);
      if (noticeList.length > 0) {
        noticesFound = await saveNotices(this.env, noticeList);
      }
    } catch (err: any) {
      console.warn(`[SignAgent] 通知箱抓取异常: ${err?.message || err}`);
    }

    this.setState({
      lastCheckedAt: nowUtc8(),
      lastSignAt: signsHandled > 0 ? nowUtc8() : this.state.lastSignAt,
      activeActivitiesCount: signsHandled,
      recentSignedIds: Array.from(recentSigned).slice(-50),
    });

    return {
      success: true,
      msg: `巡检完成: 处理签到 ${signsHandled} 次, 登记作业 ${homeworkCount} 份, 同步通知 ${noticesFound} 条`,
      signsFound: signsHandled,
      homeworkFound: homeworkCount,
      noticesFound,
      time: nowUtc8(),
    };
  }
}
