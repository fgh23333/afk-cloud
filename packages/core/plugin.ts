import { CourseInfo, HomeworkSummary, MaterialItem, SolveOptions, SolveResult } from './types';

export type PluginCapability =
  | 'courses'
  | 'materials'
  | 'homework'
  | 'signin'
  | 'browser-cdp'
  | 'sandbox';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  capabilities: PluginCapability[];
  configSchema?: Record<string, { type: string; required?: boolean; description?: string }>;
}

export interface PluginContext {
  env: Record<string, string | undefined>;
  d1SyncUrl?: string;
  d1BearerToken?: string;
  cacheDir: string;
  materialsDir: string;
}

/**
 * 教学/评测平台标准化插件契约 (Platform Plugin Contract)
 * 使得超星学习通、智慧树、PTA 等平台均作为纯解耦的可选 Skill / 插件挂载到 agy
 */
export interface PlatformPlugin {
  readonly manifest: PluginManifest;

  /**
   * 插件初始化，注入宿主 agy 运行环境上下文
   */
  init(ctx: PluginContext): Promise<void>;

  /**
   * 校验或执行平台身份鉴权
   */
  authenticate(): Promise<boolean>;

  /**
   * 扫描平台在读课程/班级列表
   */
  scanCourses?(): Promise<CourseInfo[]>;

  /**
   * 扫描待办作业、实验或编程测试
   */
  scanTasks?(course?: CourseInfo): Promise<HomeworkSummary[]>;

  /**
   * 下载或同步课程课件资料
   */
  downloadMaterials?(course: CourseInfo): Promise<MaterialItem[]>;

  /**
   * 作业解答与提交（可选用 agy 双轨模型 Flash/Pro）
   */
  solveTask?(task: HomeworkSummary, autoSubmit?: boolean, options?: SolveOptions): Promise<SolveResult>;

  /**
   * 执行每日自动巡检或签到
   */
  inspectAndSign?(): Promise<{ executed: string[] }>;
}

/**
 * agy 插件中央注册中心 (Plugin Registry)
 */
export class PluginRegistry {
  private static instance: PluginRegistry;
  private plugins = new Map<string, PlatformPlugin>();
  private initialized = false;

  public static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  public register(plugin: PlatformPlugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      console.warn(`[PluginRegistry] 覆盖已有插件: ${plugin.manifest.id}`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  public get(id: string): PlatformPlugin | undefined {
    return this.plugins.get(id);
  }

  public list(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((p) => p.manifest);
  }

  public has(id: string): boolean {
    return this.plugins.has(id);
  }

  public async initAll(ctx: PluginContext): Promise<void> {
    if (this.initialized) return;
    for (const [id, plugin] of this.plugins.entries()) {
      try {
        await plugin.init(ctx);
      } catch (err: any) {
        console.error(`[PluginRegistry] 初始化插件 ${id} 失败: ${err?.message || err}`);
      }
    }
    this.initialized = true;
  }
}
