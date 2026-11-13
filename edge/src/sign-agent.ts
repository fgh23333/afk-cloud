import { Agent, callable } from 'agents';
import {
  InspectionOptions,
  InspectionSummary,
  runChaoxingInspectionCycle,
  SignState,
} from './inspection';
import { ExtendedNotifyEnv } from './notify';

export type { SignState };

export class SignAgent extends Agent<ExtendedNotifyEnv, SignState> {
  initialState: SignState = {
    activeActivitiesCount: 0,
    recentSignedIds: [],
    seenClassActivityIds: [],
    roundRobinCursor: 0,
    discussionCursor: 0,
    rateLimitUntilMs: 0,
    rateLimitNotifiedAtMs: 0,
    rateLimitBackoffLevel: 0,
  };

  onStart(): void {
    console.log(`[SignAgent] SignAgent Durable Object 已启动`);
  }

  /**
   * 巡检核心链路：分批轮转扫描 + 频控自动冷却退避 + 讨论区捕获 + 作业红点探测
   */
  @callable()
  async checkInspection(options?: Pick<InspectionOptions, 'force' | 'bypassCooldown' | 'scanDiscussions' | 'checkHomework'>): Promise<InspectionSummary> {
    return runChaoxingInspectionCycle(this.env, {
      ...options,
      state: this.state,
      onStateUpdate: (nextState) => this.setState(nextState),
    });
  }
}
