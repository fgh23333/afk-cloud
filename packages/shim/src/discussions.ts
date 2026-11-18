import {
  acquireLock,
  getLinuxMemAvailableMb,
  releaseLock,
  runWithAgyLock,
} from '../../core/agy-invoke';

let isDiscussionProcessing = false;
let lastAttemptAtMs = 0;
const DISCUSSION_RETRY_COOLDOWN_MS = 2 * 60 * 1000;

export function triggerDiscussionProcessing(options?: {
  autoSubmit?: boolean;
  force?: boolean;
}): { accepted: boolean; reason: string } {
  if (isDiscussionProcessing) {
    return { accepted: false, reason: '讨论区批处理任务正在运行中' };
  }

  const now = Date.now();
  if (!options?.force && now - lastAttemptAtMs < DISCUSSION_RETRY_COOLDOWN_MS) {
    return { accepted: false, reason: '处于 2 分钟防抖冷却窗口' };
  }

  const memMb = getLinuxMemAvailableMb();
  if (memMb > 0 && memMb < 150) {
    return { accepted: false, reason: `主机可用内存不足 (${memMb} MB < 150 MB)` };
  }

  const jobId = `chaoxing-discussions-${now}`;
  if (!acquireLock(jobId)) {
    return { accepted: false, reason: '硬件互斥锁被其他 AGY 任务占用，等待下轮巡检' };
  }

  isDiscussionProcessing = true;
  lastAttemptAtMs = now;
  const autoSubmit = options?.autoSubmit !== false;

  void (async () => {
    try {
      await runWithAgyLock(jobId, async () => {
        const phone = process.env.CHAOXING_PHONE || '';
        const password = process.env.CHAOXING_PASSWORD || '';
        const realname = process.env.CHAOXING_REALNAME || '同学';
        if (!phone || !password) {
          console.warn('[Shim Discussions] 未配置 CHAOXING_PHONE / CHAOXING_PASSWORD，跳过自动讨论拟稿');
          return;
        }
        const { chaoxingLogin, getChaoxingCourses, solvePendingDiscussions } = await import(
          '../../adapters/chaoxing/index'
        );
        const cookies = await chaoxingLogin(phone, password);
        const courses = await getChaoxingCourses(cookies);
        const summary = await solvePendingDiscussions(courses, cookies, {
          autoSubmit,
          realname,
        });
        console.log(
          `[Shim Discussions] 处理完毕: scanned=${summary.scanned}, drafted=${summary.drafted}, submitted=${summary.submitted}, skipped=${summary.skipped}`
        );
      });
    } catch (err: any) {
      console.warn(`[Shim Discussions Error] 自动讨论处理异常: ${err?.message || err}`);
    } finally {
      isDiscussionProcessing = false;
      releaseLock(jobId);
    }
  })();

  return { accepted: true, reason: `已启动后台讨论区自动处理 (autoSubmit=${autoSubmit})` };
}
