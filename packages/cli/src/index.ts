import fs from 'fs';
import { blue, cyan, green, red, yellow } from 'kolorist';
import path from 'path';
import { ChaoxingAdapter } from '../../adapters/chaoxing';
import { hasPtaAuthCookie, PtaAdapter } from '../../adapters/pta';
import { WEB_PLATFORM_PRESETS, WebBrowserAdapter } from '../../adapters/web-agent';
import {
  detectChromiumExecutable,
  getBrowserProfilePaths,
  pullBrowserProfileFromCloud,
  pushBrowserProfileToCloud,
  readLocalStorageState,
} from '../../core/browser-profile';
import { DEFAULT_FLASH_MODEL, DEFAULT_PRO_MODEL } from '../../core/agy-invoke';
import { provisionCloudflareEdge } from '../../core/cf-provisioner';
import { triggerEdgeDigestNotification } from '../../core/d1-bridge';
import { triggerCloudBurst } from '../../core/sandbox';
import { formatUtc8Now, PlatformName } from '../../core/types';

/**
 * 自动加载项目根目录 .env 文件 (零外部 dotenv 依赖)
 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed
      .substring(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function runStatus(): Promise<void> {
  const chromeExe = detectChromiumExecutable();
  const ptaState = readLocalStorageState('pta');
  const zhsState = readLocalStorageState('zhihuishu');

  console.log(cyan(`\n======================================================`));
  console.log(cyan(` 🛰️  afk-cloud 个人云端自治 Agent 环境状态自检`));
  console.log(cyan(`======================================================`));
  console.log(` 🕒 当前时间   : ${formatUtc8Now()}`);
  console.log(
    ` 📱 学习通账号 : ${process.env.CHAOXING_PHONE ? green('已配置') : yellow('未配置 (.env CHAOXING_PHONE)')}`
  );
  console.log(
    ` 🌐 无头浏览器 : ${chromeExe ? green(chromeExe) : yellow('未检测到 Chromium (安装 chromium 后可操控 PTA/智慧树)')}`
  );
  const ptaHasAuth = Boolean(
    process.env.PTA_SESSION_COOKIE || (ptaState && hasPtaAuthCookie(ptaState.cookies || []))
  );
  console.log(
    ` 🔐 Web登录态  : PTA=${ptaHasAuth ? green(`${ptaState?.cookies.length || 1} Cookies (已含会话凭证)`) : ptaState ? yellow(`${ptaState.cookies.length} Cookies (缺少 PTASession，需重导)`) : yellow('待导入')} | 智慧树=${zhsState ? green(`${zhsState.cookies.length} Cookies`) : yellow('待导入')}`
  );
  console.log(
    ` 🗄️  Edge D1    : ${process.env.AFK_EDGE_WORKER_URL ? green(process.env.AFK_EDGE_WORKER_URL) : yellow('仅本地缓存 (.cache/)')}`
  );
  console.log(` ⚡ 主力模型   : ${green(process.env.AFK_FLASH_MODEL || DEFAULT_FLASH_MODEL)} (90% 批量客观题 JSON)`);
  console.log(` 🧠 兜底模型   : ${green(process.env.AFK_PRO_MODEL || DEFAULT_PRO_MODEL)} (10% 主观/编程题 + 沙箱自愈)`);
  console.log(
    ` ☁️  GCP 项目   : ${process.env.GCP_PROJECT_ID || yellow('未显式设置 (使用 gcloud 默认上下文)')}`
  );

  if (process.env.AFK_EDGE_WORKER_URL) {
    try {
      const r = await fetch(`${process.env.AFK_EDGE_WORKER_URL.replace(/\/+$/, '')}/health`);
      const data: any = await r.json();
      const d1State = data.components?.d1?.status ?? data.hasD1;
      const kvState = data.components?.kv?.configured ?? data.hasKV;
      console.log(` 🟢 Edge 连通  : Status=${data.status || 'ok'}, D1=${d1State}, KV=${kvState}, Time=${data.timestamp || data.time}`);
    } catch (e: any) {
      console.log(` 🔴 Edge 连通异常: ${e?.message || e}`);
    }
  }
  console.log(cyan(`======================================================\n`));
}

function printCliHelp(): void {
  console.log(cyan(`\nafk-cloud v1.1.0 — 个人云端自治 Agent CLI`));
  console.log(`
用法: pnpm afk <command> [options]

核心指令:
  status                         环境自检、登录态与 Cloudflare Edge 健康探测
  plugins | skills               查看已注册的平台插件与能力清单
  scan [--platform chaoxing|pta|all] [--progress]
                                 扫描在读课程、待办作业或 PTA 活跃题目集
  progress | chapters            扫描超星全部课程章节任务点进度并同步到看板
  solve [--platform chaoxing|pta|all] [--auto-submit] [--tier local|cloud-run|gce]
                                 双轨求解待办作业（默认安全草稿暂存）
  pta [scan|solve|watch]         PTA 拼题 A 专项指令（支持 --id <psId> --auto-submit --interval <min>）
  discuss [--auto-submit]        超星讨论区抓帖、课件 RAG 拟稿与审批/发布
  materials | download           批量下载超星课程资料构建 RAG 上下文
  signin                         执行超星活动签到巡检
  poll [--loop] [--interval 10]  拉取 D1 队列并同时巡检超星与 PTA
  profile <status|import-cookie|push|pull> [--platform pta|zhihuishu] [--cookie "..."]
                                 管理浏览器 Profile 登录态与 D1 双向同步
  web [--platform pta|zhihuishu] 启动挂载持久化 Profile 的无头 CDP 浏览器
  zhihuishu | zhs | watch        [TODO/实验性] 智慧树合规定速播放守护
  notify | digest                手动触发一次全平台汇总简报推送
  shim [--host 127.0.0.1] [--port 8788]
                                 启动宿主机 Server Shim 服务
  setup-cf | setup-vm | setup-gcp | setup-all [--dry-run]
                                 自动化编排 Cloudflare 边缘层与 GCP 基础设施
  burst --mode cloud-run|gce     触发弹性算力任务
  help                           显示本帮助信息
`);
}

async function main(): Promise<void> {
  loadDotEnv();

  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.includes('--help') || args.includes('-h')) {
    printCliHelp();
    return;
  }
  const autoSubmit = args.includes('--auto-submit') || args.includes('-s');
  const dryRun = args.includes('--dry-run');

  const chaoxing = new ChaoxingAdapter();

  switch (cmd) {
    case 'sign':
    case 'signin': {
      const realname = process.env.CHAOXING_REALNAME || '同学';
      await chaoxing.scanAndSignIn(realname);
      break;
    }

    case 'scan': {
      const targetPlatform = (getFlagValue(args, '--platform') || 'chaoxing').toLowerCase();
      if (targetPlatform === 'pta' || targetPlatform === 'all') {
        const pta = new PtaAdapter();
        await pta.scanPendingHomework();
      }
      if (targetPlatform !== 'pta') {
        await chaoxing.scanPendingHomework();
        if (args.includes('--progress') || args.includes('--chapters')) {
          await chaoxing.scanAllCourseChapterProgress(true);
        }
      }
      break;
    }

    case 'progress':
    case 'chapters': {
      await chaoxing.scanAllCourseChapterProgress(true);
      break;
    }

    case 'materials':
    case 'download': {
      await chaoxing.downloadAllMaterials();
      break;
    }

    case 'solve': {
      const tier = getFlagValue(args, '--tier') || 'local';
      if (tier === 'cloud-run' || tier === 'gce') {
        const res = await triggerCloudBurst({
          mode: tier === 'cloud-run' ? 'cloud-run' : 'gce',
          taskCommand: `solve${autoSubmit ? ' --auto-submit' : ''}`,
          dryRun,
        });
        console.log(green(`[弹性算力调度] ${res.command}\n${res.output}`));
        break;
      }

      const flashModel = getFlagValue(args, '--flash-model');
      const proModel = getFlagValue(args, '--pro-model');
      const targetPlatform = (getFlagValue(args, '--platform') || 'chaoxing').toLowerCase();
      if (targetPlatform === 'pta' || targetPlatform === 'all') {
        const pta = new PtaAdapter();
        await pta.solveAllPendingHomework(autoSubmit, {
          flashModel,
          proModel,
          force: args.includes('--force'),
        });
      }
      if (targetPlatform !== 'pta') {
        await chaoxing.solveAllPendingHomework(autoSubmit, { flashModel, proModel });
      }
      break;
    }

    case 'pta': {
      const subCmd = (args[1] || 'scan').toLowerCase();
      const psId = getFlagValue(args, '--id') || getFlagValue(args, '--ps');
      const flashModel = getFlagValue(args, '--flash-model');
      const proModel = getFlagValue(args, '--pro-model');
      const force = args.includes('--force');
      const pta = new PtaAdapter();

      if (subCmd === 'solve') {
        if (psId) {
          const outcome = await pta.solveProblemSetById(psId, autoSubmit, {
            flashModel,
            proModel,
            force,
          });
          console.log(green(`✅ [PTA] ${outcome.title}: ${outcome.summary}`));
        } else {
          await pta.solveAllPendingHomework(autoSubmit, { flashModel, proModel, force });
        }
      } else if (subCmd === 'watch' || subCmd === 'listen') {
        const { runPtaMonitorCycle } = await import('../../shim/src/pta-monitor');
        const intervalMin = Math.max(1, parseInt(getFlagValue(args, '--interval') || '10', 10));
        const autoSolve = args.includes('--auto-solve');
        const runTick = async () => {
          const monitorRes = await runPtaMonitorCycle({ force: true });
          console.log(monitorRes.ok ? green(`🛰️ ${monitorRes.msg}`) : yellow(`⚠️ ${monitorRes.msg}`));
          if (autoSolve && monitorRes.pendingCount > 0) {
            await pta.solveAllPendingHomework(autoSubmit, { flashModel, proModel, force });
          }
        };
        await runTick();
        console.log(green(`🔄 PTA 持续监听已开启 (轮询间隔 ${intervalMin} 分钟${autoSolve ? '，已开启自动作答' : '，仅发现告警与同步'})`));
        setInterval(() => {
          runTick().catch((e) => console.error(red(`[PTA 监听异常] ${e?.message || e}`)));
        }, intervalMin * 60 * 1000);
      } else {
        await pta.scanPendingHomework(true);
      }
      break;
    }

    case 'discuss':
    case 'discussions': {
      const model = getFlagValue(args, '--model') || getFlagValue(args, '--pro-model');
      const courseFilter = getFlagValue(args, '--course');
      const regenerate = args.includes('--regenerate');
      const realname = process.env.CHAOXING_REALNAME || '同学';

      const res = await chaoxing.solveDiscussions({
        realname,
        autoSubmit,
        regenerate,
        courseFilter,
        solveOptions: { proModel: model },
      });
      console.log(
        green(
          `\n💬 [讨论区处理完毕] 扫描=${res.scanned} | 已生成拟稿=${res.drafted} | 已发布=${res.submitted} | 跳过=${res.skipped}`
        )
      );
      if (res.reportPath) {
        console.log(blue(`📄 拟稿报告已保存: ${res.reportPath}`));
      }
      break;
    }

    case 'zhihuishu':
    case 'zhs':
    case 'watch': {
      const { ZHIHUISHU_DEFAULT_STUDY_URL, ZhihuishuAdapter } = await import('../../adapters/zhihuishu');
      const studyUrl =
        getFlagValue(args, '--url') || process.env.ZHIHUISHU_STUDY_URL || ZHIHUISHU_DEFAULT_STUDY_URL;
      const rateStr = getFlagValue(args, '--rate');
      const maxMinStr = getFlagValue(args, '--max-minutes');
      const portStr = getFlagValue(args, '--port');
      const tier = (getFlagValue(args, '--tier') || 'local') as 'local' | 'gce';
      const zhs = new ZhihuishuAdapter();
      const res = await zhs.watchCourse({
        studyUrl,
        targetRate: rateStr ? parseFloat(rateStr) : 1.5,
        maxMinutes: maxMinStr ? parseInt(maxMinStr, 10) : 120,
        headless: !args.includes('--headed'),
        debuggingPort: portStr ? parseInt(portStr, 10) : 9222,
        tier: tier === 'gce' ? 'gce' : 'local',
        dryRun,
        ignoreMemGuard: args.includes('--ignore-mem-guard'),
      });
      console.log(res.status === 'completed' ? green(`✅ ${res.message}`) : yellow(`ℹ️ ${res.message}`));
      break;
    }

    case 'web': {
      const platform = (getFlagValue(args, '--platform') || args[1] || 'pta') as PlatformName;
      const targetUrl = getFlagValue(args, '--url');
      const portStr = getFlagValue(args, '--port');
      const webAdapter = new WebBrowserAdapter(platform);
      const res = await webAdapter.prepareHeadlessSession({
        targetUrl,
        port: portStr ? parseInt(portStr, 10) : 9222,
        headless: !args.includes('--headed'),
      });
      console.log(blue(`📂 Profile 目录 : ${res.userDataDir}`));
      console.log(blue(`📄 状态快照路径 : ${res.storageStatePath}`));
      break;
    }

    case 'profile': {
      const subCmd = args[1] || 'status';
      const platform = (getFlagValue(args, '--platform') || 'pta') as PlatformName;
      const webAdapter = new WebBrowserAdapter(platform);

      if (subCmd === 'import-cookie') {
        const cookieStr = getFlagValue(args, '--cookie') || process.env.PTA_SESSION_COOKIE || '';
        const domain =
          getFlagValue(args, '--domain') || (platform === 'zhihuishu' ? '.zhihuishu.com' : '.pintia.cn');
        if (!cookieStr) {
          throw new Error('请通过 --cookie "key=val; ..." 传入要持久化保存的浏览器 Cookie');
        }
        await webAdapter.importCookieString(cookieStr, domain);
      } else if (subCmd === 'push') {
        const res = await pushBrowserProfileToCloud(platform);
        console.log(res.synced ? green(`✅ ${res.msg}`) : yellow(`⚠️ ${res.msg}`));
      } else if (subCmd === 'pull') {
        const state = await pullBrowserProfileFromCloud(platform);
        console.log(
          state
            ? green(`✅ 已同步 [${platform}] 登录态 (${state.cookies.length} Cookies)`)
            : yellow(`⚠️ 未找到 [${platform}] 云端或本地登录态`)
        );
      } else {
        for (const p of Object.keys(WEB_PLATFORM_PRESETS)) {
          const paths = getBrowserProfilePaths(p);
          const st = readLocalStorageState(p);
          console.log(
            `[${p}] ProfileDir=${paths.userDataDir} | SavedCookies=${st ? st.cookies.length : 0}`
          );
        }
      }
      break;
    }

    case 'burst': {
      const mode = (getFlagValue(args, '--mode') || 'cloud-run') as 'cloud-run' | 'gce';
      const taskCommand = getFlagValue(args, '--task') || 'solve';
      const ttlStr = getFlagValue(args, '--ttl');
      const machineType = getFlagValue(args, '--machine-type');

      console.log(
        blue(
          `[算力拉起] 模式=${mode === 'cloud-run' ? 'Tier 1: Cloud Run Jobs (免费层)' : 'Tier 2: Ephemeral GCE (带 TTL 自毁)'} | 任务="${taskCommand}"`
        )
      );

      const res = await triggerCloudBurst({
        mode,
        taskCommand,
        ttlMinutes: ttlStr ? parseInt(ttlStr, 10) : undefined,
        machineType,
        dryRun,
      });

      console.log(green(`✅ 执行指令: ${res.command}`));
      console.log(res.output);
      break;
    }

    case 'setup-cf': {
      const cfRes = await provisionCloudflareEdge({ dryRun });
      console.log(green(`✅ Cloudflare 边缘层自动编排完成:`));
      for (const s of cfRes.stepsCompleted) {
        console.log(`   - ${s}`);
      }
      break;
    }

    case 'setup-gcp-vm':
    case 'setup-vm': {
      const vmScript = path.resolve(process.cwd(), 'infra', 'gcp', 'provision-free-vm.sh');
      if (dryRun) {
        console.log(green(`✅ [DryRun] GCP Always Free e2-micro 云主机开通计划:`));
        console.log(`   - bash "${vmScript}"`);
      } else {
        const { execFileSync } = await import('child_process');
        execFileSync('bash', [vmScript], { stdio: 'inherit' });
      }
      break;
    }

    case 'setup-gcp': {
      const vmScript = path.resolve(process.cwd(), 'infra', 'gcp', 'provision-free-vm.sh');
      const iamScript = path.resolve(process.cwd(), 'infra', 'gcp', 'setup-iam-guardrails.sh');
      const crScript = path.resolve(process.cwd(), 'infra', 'gcp', 'deploy-cloud-run-job.sh');
      if (dryRun) {
        console.log(green(`✅ [DryRun] GCP Always Free 云主机、安全围栏与 Cloud Run 免费层编排计划:`));
        console.log(`   - bash "${vmScript}"`);
        console.log(`   - bash "${iamScript}"`);
        console.log(`   - bash "${crScript}"`);
      } else {
        const { execFileSync } = await import('child_process');
        execFileSync('bash', [vmScript], { stdio: 'inherit' });
        execFileSync('bash', [iamScript], { stdio: 'inherit' });
        execFileSync('bash', [crScript], { stdio: 'inherit' });
      }
      break;
    }

    case 'setup-all': {
      const cfRes = await provisionCloudflareEdge({ dryRun });
      console.log(green(`✅ [Part 1/2] Cloudflare 边缘层自动编排完成 (${cfRes.workerUrl})`));
      for (const s of cfRes.stepsCompleted) {
        console.log(`   - ${s}`);
      }
      const iamScript = path.resolve(process.cwd(), 'infra', 'gcp', 'setup-iam-guardrails.sh');
      const crScript = path.resolve(process.cwd(), 'infra', 'gcp', 'deploy-cloud-run-job.sh');
      if (dryRun) {
        console.log(green(`✅ [Part 2/2 DryRun] GCP 安全围栏与 Cloud Run 免费层编排就绪`));
      } else {
        const { execFileSync } = await import('child_process');
        execFileSync('bash', [iamScript], { stdio: 'inherit' });
        execFileSync('bash', [crScript], { stdio: 'inherit' });
      }
      break;
    }

    case 'pull':
    case 'poll': {
      const flashModel = getFlagValue(args, '--flash-model');
      const proModel = getFlagValue(args, '--pro-model');
      const loop = args.includes('--loop') || args.includes('--watch');
      const intervalMin = Math.max(1, parseInt(getFlagValue(args, '--interval') || '10', 10));

      const runOnce = async () => {
        console.log(blue(`\n[Edge Pull] 正在检查云端 D1 队列与学习通最新待办作业...`));
        if (process.env.AFK_EDGE_WORKER_URL && process.env.AFK_EDGE_BEARER_TOKEN) {
          try {
            const res = await fetch(`${process.env.AFK_EDGE_WORKER_URL.replace(/\/+$/, '')}/api/tasks/pull`, {
              headers: { Authorization: `Bearer ${process.env.AFK_EDGE_BEARER_TOKEN}` },
            });
            if (res.ok) {
              const data: any = await res.json();
              console.log(blue(`[Edge Pull] 云端 D1 待处理队列任务数: ${(data.tasks || []).length}`));
            }
          } catch (e: any) {
            console.warn(yellow(`[Edge Pull] 拉取云端队列提示: ${e?.message || e}`));
          }
        }
        await chaoxing.scanPendingHomework();
        await chaoxing.solveAllPendingHomework(autoSubmit, { flashModel, proModel });
        await chaoxing
          .solveDiscussions({
            realname: process.env.CHAOXING_REALNAME || '同学',
            autoSubmit: false, // 无人值守 pull/poll 永远只做讨论拟稿，必须由看板人工审批发布
            solveOptions: { proModel },
          })
          .catch((e) => console.warn(yellow(`[Edge Pull] 讨论区拟稿同步提示: ${e?.message || e}`)));

        const { runPtaMonitorCycle } = await import('../../shim/src/pta-monitor');
        await runPtaMonitorCycle({ force: true }).catch((e) =>
          console.warn(yellow(`[Edge Pull] PTA 巡检提示: ${e?.message || e}`))
        );
      };

      await runOnce();
      if (loop) {
        console.log(green(`🔄 常驻轮询模式已开启 (间隔 ${intervalMin} 分钟)`));
        setInterval(() => {
          runOnce().catch((e) => console.error(red(`[轮询异常] ${e?.message || e}`)));
        }, intervalMin * 60 * 1000);
      }
      break;
    }

    case 'notify':
    case 'digest': {
      const res = await triggerEdgeDigestNotification();
      if (res.sent) {
        console.log(green(`✅ 已触发 Cloudflare Edge 推送全平台汇总通知:\n${res.summary}`));
      } else {
        console.log(yellow(`⚠️ 触发结果: ${res.summary || '请先配置 AFK_EDGE_WORKER_URL'}`));
      }
      break;
    }

    case 'shim': {
      const { createShimServer } = await import('../../shim/src/index');
      const { loadShimSecurityConfig } = await import('../../shim/src/security');
      const cfg = loadShimSecurityConfig();
      const host = getFlagValue(args, '--host') || cfg.host;
      const port = parseInt(getFlagValue(args, '--port') || String(cfg.port), 10);
      const server = createShimServer({ host, port });
      server.listen(port, host, () => {
        console.log(green(`✅ afk-cloud Server Shim (Pet Node) 已在 http://${host}:${port} 启动`));
      });
      break;
    }

    case 'plugins':
    case 'skills': {
      const { PluginRegistry } = await import('../../core/plugin');
      const { ChaoxingAdapter } = await import('../../adapters/chaoxing');
      const { PtaAdapter } = await import('../../adapters/pta');
      const { ZhihuishuAdapter } = await import('../../adapters/zhihuishu');

      const registry = PluginRegistry.getInstance();
      registry.register(new ChaoxingAdapter());
      registry.register(new PtaAdapter());
      registry.register(new ZhihuishuAdapter());

      console.log(cyan(`\n======================================================`));
      console.log(cyan(` 🧩 afk-cloud / agy 插件化与 Skills 技能体系`));
      console.log(cyan(`======================================================`));
      for (const m of registry.list()) {
        console.log(green(` ● [${m.id}] ${m.name} (v${m.version})`));
        console.log(`   说明: ${m.description}`);
        console.log(`   能力: ${m.capabilities.join(', ')}\n`);
      }
      break;
    }

    case 'status':
    default: {
      await runStatus();
      break;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(red(`[afk-cloud 执行异常] ${err?.message || err}`));
    process.exit(1);
  });
}
