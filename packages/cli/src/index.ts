import fs from 'fs';
import { blue, cyan, green, red, yellow } from 'kolorist';
import path from 'path';
import { ChaoxingAdapter } from '../../adapters/chaoxing';
import { WEB_PLATFORM_PRESETS, WebBrowserAdapter } from '../../adapters/web-agent';
import {
  detectChromiumExecutable,
  getBrowserProfilePaths,
  pullBrowserProfileFromCloud,
  pushBrowserProfileToCloud,
  readLocalStorageState,
} from '../../core/browser-profile';
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
  console.log(
    ` 🔐 Web登录态  : PTA=${ptaState ? green(`${ptaState.cookies.length} Cookies`) : yellow('待导入')} | 智慧树=${zhsState ? green(`${zhsState.cookies.length} Cookies`) : yellow('待导入')}`
  );
  console.log(
    ` 🗄️  Edge D1    : ${process.env.AFK_EDGE_WORKER_URL ? green(process.env.AFK_EDGE_WORKER_URL) : yellow('仅本地缓存 (.cache/)')}`
  );
  console.log(` ⚡ 主力模型   : ${green(process.env.AFK_FLASH_MODEL || 'flash')} (90% 批量客观题 JSON)`);
  console.log(` 🧠 兜底模型   : ${green(process.env.AFK_PRO_MODEL || 'pro')} (10% 主观/编程题 + 沙箱自愈)`);
  console.log(
    ` ☁️  GCP 项目   : ${process.env.GCP_PROJECT_ID || yellow('未显式设置 (使用 gcloud 默认上下文)')}`
  );

  if (process.env.AFK_EDGE_WORKER_URL) {
    try {
      const r = await fetch(`${process.env.AFK_EDGE_WORKER_URL.replace(/\/+$/, '')}/health`);
      const data: any = await r.json();
      console.log(` 🟢 Edge 连通  : D1=${data.hasD1}, KV=${data.hasKV}, Time=${data.time}`);
    } catch (e: any) {
      console.log(` 🔴 Edge 连通异常: ${e?.message || e}`);
    }
  }
  console.log(cyan(`======================================================\n`));
}

async function main(): Promise<void> {
  loadDotEnv();

  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  const autoSubmit = args.includes('--auto-submit') || args.includes('-s');
  const dryRun = args.includes('--dry-run');

  const chaoxing = new ChaoxingAdapter();

  switch (cmd) {
    case 'scan': {
      await chaoxing.scanPendingHomework();
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
      await chaoxing.solveAllPendingHomework(autoSubmit, { flashModel, proModel });
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
      const port = parseInt(getFlagValue(args, '--port') || process.env.SHIM_PORT || '8788', 10);
      const server = createShimServer();
      server.listen(port, '0.0.0.0', () => {
        console.log(green(`✅ afk-cloud Server Shim (Pet Node) 已在端口 ${port} 启动`));
      });
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
