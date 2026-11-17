import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { blue, green, yellow } from 'kolorist';

const execFileAsync = promisify(execFile);

export interface ProvisionCloudflareOptions {
  dryRun?: boolean;
  dbName?: string;
  workerName?: string;
}

export interface ProvisionCloudflareResult {
  databaseId: string;
  workerUrl: string;
  bearerToken: string;
  stepsCompleted: string[];
}

/**
 * Cloudflare 资源安全销毁守卫（爆炸半径围栏）
 * 铁律：仅允许销毁自己创建的资源（带 afk- 或 afk-cloud- 前缀），严禁误删用户账户内已有的其他资源！
 */
export function assertSafeResourceDestruction(resourceType: string, resourceName: string): void {
  const allowedPrefixes = ['afk-', 'afk-cloud-', 'chaoxing-dashboard-worker'];
  const isAllowed = allowedPrefixes.some((prefix) => resourceName.toLowerCase().startsWith(prefix));
  if (!isAllowed) {
    throw new Error(
      `[安全拦截] 严禁销毁未受管的 Cloudflare 资源: ${resourceType} "${resourceName}"。系统仅允许销毁以 'afk-' 或 'afk-cloud-' 开头的受管资源！`
    );
  }
}

/**
 * 更新根目录 .env 文件中的指定键值（保持已有注释与结构不变）
 */
export function upsertEnvVariables(envFilePath: string, updates: Record<string, string>): void {
  let content = '';
  if (fs.existsSync(envFilePath)) {
    content = fs.readFileSync(envFilePath, 'utf8');
  } else {
    const examplePath = path.resolve(path.dirname(envFilePath), '.env.example');
    if (fs.existsSync(examplePath)) {
      content = fs.readFileSync(examplePath, 'utf8');
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}\n`;
    }
  }

  fs.writeFileSync(envFilePath, content, 'utf8');
}

/**
 * 根据模板与自动获取的 D1 database_id 生成 edge/wrangler.jsonc
 */
export function renderWranglerConfig(options: {
  workerName: string;
  dbName: string;
  databaseId: string;
  realname: string;
  autoSubmit: string;
}): string {
  const config = {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: options.workerName,
    main: 'src/index.ts',
    compatibility_date: '2024-11-01',
    compatibility_flags: ['nodejs_compat'],
    triggers: {
      crons: ['*/5 * * * *'],
    },
    vars: {
      CHAOXING_REALNAME: options.realname || '同学',
      AUTO_SUBMIT_HOMEWORK: options.autoSubmit || 'false',
      HOMEWORK_SCAN_INTERVAL_MINUTES: '10',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: options.dbName,
        database_id: options.databaseId,
      },
    ],
    durable_objects: {
      bindings: [
        { name: 'SIGN_AGENT', class_name: 'SignAgent' },
        { name: 'SOLVER_AGENT', class_name: 'SolverAgent' },
      ],
    },
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['SignAgent', 'SolverAgent'] },
    ],
  };

  return JSON.stringify(config, null, 2) + '\n';
}

async function runWrangler(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync('npx', ['wrangler', ...args], {
    cwd,
    shell: true,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180000,
  });
  return `${stdout || ''}\n${stderr || ''}`.trim();
}

/**
 * 全自动幂等编排 Cloudflare 边缘层服务 (D1 创建/复用 -> wrangler.jsonc 注入 -> Schema 迁移 -> Secret Bulk 注入 -> 部署并回填 .env)
 */
export async function provisionCloudflareEdge(
  options?: ProvisionCloudflareOptions
): Promise<ProvisionCloudflareResult> {
  const dryRun = options?.dryRun === true;
  const dbName = options?.dbName || 'afk-cloud-db';
  const workerName = options?.workerName || 'afk-cloud-edge';
  const rootDir = process.cwd();
  const edgeDir = path.resolve(rootDir, 'edge');
  const envPath = path.resolve(rootDir, '.env');
  const wranglerConfigPath = path.resolve(edgeDir, 'wrangler.jsonc');

  const stepsCompleted: string[] = [];

  const bearerToken =
    process.env.AFK_EDGE_BEARER_TOKEN || crypto.randomBytes(24).toString('hex');
  const shimSecret =
    process.env.AFK_SHIM_SECRET || crypto.randomBytes(32).toString('hex');
  const realname = process.env.CHAOXING_REALNAME || '同学';
  const autoSubmit = process.env.CHAOXING_AUTO_SUBMIT || 'false';

  if (dryRun) {
    const previewConfig = renderWranglerConfig({
      workerName,
      dbName,
      databaseId: '00000000-0000-0000-0000-dryrun000000',
      realname,
      autoSubmit,
    });
    stepsCompleted.push(
      `1. [D1] 自动查询或创建 D1 数据库 (${dbName}) 并提取 UUID`,
      `2. [Config] 自动生成 edge/wrangler.jsonc (${previewConfig.length} bytes)`,
      `3. [Migrate] 自动执行 migrations/0001_init.sql 建表`,
      `4. [Secrets] 通过 wrangler secret bulk 非交互式注入 CHAOXING_PHONE / PASSWORD / API_BEARER_TOKEN`,
      `5. [Deploy] 执行 wrangler deploy 并自动将生成的 Worker URL 与 Token 回写至 .env`
    );
    return {
      databaseId: '00000000-0000-0000-0000-dryrun000000',
      workerUrl: `https://${workerName}.example.workers.dev`,
      bearerToken,
      stepsCompleted,
    };
  }

  console.log(blue(`\n🚀 [1/5] 正在检查 Cloudflare D1 数据库 (${dbName})...`));
  let databaseId = '';

  // 1. 幂等检查是否已存在同名 D1 数据库
  try {
    const listOut = await runWrangler(['d1', 'list', '--json'], edgeDir);
    const jsonMatch = listOut.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const dbs: Array<{ name: string; uuid: string }> = JSON.parse(jsonMatch[0]);
      const existing = dbs.find((d) => d.name === dbName);
      if (existing?.uuid) {
        databaseId = existing.uuid;
        console.log(green(`  ✅ 发现已存在的 D1 数据库 [${dbName}]，复用 ID: ${databaseId}`));
      }
    }
  } catch {
    // 若 list 失败则继续尝试创建
  }

  // 若不存在则自动创建并提取 UUID
  if (!databaseId) {
    const createOut = await runWrangler(['d1', 'create', dbName], edgeDir);
    const uuidMatch = createOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!uuidMatch) {
      throw new Error(`无法从 wrangler d1 create 输出中解析 database_id:\n${createOut}`);
    }
    databaseId = uuidMatch[0];
    console.log(green(`  ✅ 已自动创建 D1 数据库 [${dbName}]，ID: ${databaseId}`));
  }
  stepsCompleted.push(`D1 database ready (${databaseId})`);

  // 2. 自动渲染并写入 edge/wrangler.jsonc（免手动复制粘贴）
  console.log(blue(`📝 [2/5] 正在自动写入 edge/wrangler.jsonc 绑定配置...`));
  const configContent = renderWranglerConfig({
    workerName,
    dbName,
    databaseId,
    realname,
    autoSubmit,
  });
  fs.writeFileSync(wranglerConfigPath, configContent, 'utf8');
  stepsCompleted.push('wrangler.jsonc generated');

  // 3. 自动执行远程 D1 Schema 迁移
  console.log(blue(`🗄️  [3/5] 正在初始化远程 D1 表结构 (0001_init.sql)...`));
  await runWrangler(
    ['d1', 'execute', dbName, '--remote', '--file=./migrations/0001_init.sql', '--yes'],
    edgeDir
  );
  console.log(green(`  ✅ D1 数据库表 (sessions, pending_tasks, question_bank, execution_logs) 初始化完成`));
  stepsCompleted.push('D1 schema migrated');

  // 4. 先部署一次 Worker 确保目标服务已创建，再通过 wrangler secret bulk 批量安全注入密钥
  console.log(blue(`☁️  [4/5] 正在部署 Cloudflare Edge Worker (${workerName})...`));
  const deployOut = await runWrangler(['deploy'], edgeDir);
  const urlMatch = deployOut.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  const workerUrl = urlMatch ? urlMatch[0] : `https://${workerName}.workers.dev`;
  console.log(green(`  ✅ Worker 已部署上线: ${workerUrl}`));
  stepsCompleted.push(`Worker deployed (${workerUrl})`);

  // 5. 非交互式批量注入 Secrets (遵循官方 wrangler 技能规范：使用临时文件执行 secret bulk 后立即销毁)
  console.log(blue(`🔐 [5/5] 正在从 .env 批量注入加密 Secrets 到 Cloudflare Worker...`));
  const secretsPayload: Record<string, string> = {
    API_BEARER_TOKEN: bearerToken,
    AFK_SHIM_SECRET: shimSecret,
  };
  if (process.env.CHAOXING_PHONE) secretsPayload.CHAOXING_PHONE = process.env.CHAOXING_PHONE;
  if (process.env.CHAOXING_PASSWORD) secretsPayload.CHAOXING_PASSWORD = process.env.CHAOXING_PASSWORD;
  if (process.env.CHAOXING_SIGN_LON) secretsPayload.CHAOXING_SIGN_LON = process.env.CHAOXING_SIGN_LON;
  if (process.env.CHAOXING_SIGN_LAT) secretsPayload.CHAOXING_SIGN_LAT = process.env.CHAOXING_SIGN_LAT;
  if (process.env.CHAOXING_SIGN_ADDRESS) secretsPayload.CHAOXING_SIGN_ADDRESS = process.env.CHAOXING_SIGN_ADDRESS;
  if (process.env.CHAOXING_LOCATIONS_JSON) secretsPayload.CHAOXING_LOCATIONS_JSON = process.env.CHAOXING_LOCATIONS_JSON;
  if (process.env.WEBHOOK_URL) secretsPayload.WEBHOOK_URL = process.env.WEBHOOK_URL;
  if (process.env.SERVERCHAN_KEY) secretsPayload.SERVERCHAN_KEY = process.env.SERVERCHAN_KEY;
  if (process.env.PUSHPLUS_TOKEN) secretsPayload.PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
  if (process.env.BARK_KEY) secretsPayload.BARK_KEY = process.env.BARK_KEY;
  if (process.env.TELEGRAM_BOT_TOKEN) secretsPayload.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) secretsPayload.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const tmpSecretFile = path.join(os.tmpdir(), `afk-secrets-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpSecretFile, JSON.stringify(secretsPayload), { mode: 0o600 });
    await runWrangler(['secret', 'bulk', tmpSecretFile], edgeDir);
    console.log(
      green(`  ✅ 已加密注入 ${Object.keys(secretsPayload).length} 项密钥 (${Object.keys(secretsPayload).join(', ')})`)
    );
  } finally {
    fs.rmSync(tmpSecretFile, { force: true });
  }
  stepsCompleted.push('Secrets bulk uploaded');

  // 6. 自动将部署生成的 Worker URL 与 Bearer Token 回写至根目录 .env
  upsertEnvVariables(envPath, {
    AFK_EDGE_WORKER_URL: workerUrl,
    AFK_EDGE_BEARER_TOKEN: bearerToken,
    AFK_SHIM_SECRET: shimSecret,
  });
  process.env.AFK_EDGE_WORKER_URL = workerUrl;
  process.env.AFK_EDGE_BEARER_TOKEN = bearerToken;
  process.env.AFK_SHIM_SECRET = shimSecret;
  console.log(green(`🔄 已自动将 AFK_EDGE_WORKER_URL、AFK_EDGE_BEARER_TOKEN 与 AFK_SHIM_SECRET 回写绑定至 .env！\n`));

  if (!process.env.CHAOXING_PHONE || !process.env.CHAOXING_PASSWORD) {
    console.log(
      yellow(
        `⚠️ 提示：当前 .env 中尚未填写 CHAOXING_PHONE / CHAOXING_PASSWORD，填写后再次运行 'pnpm afk setup-cf' 即可自动同步密钥。`
      )
    );
  }

  return {
    databaseId,
    workerUrl,
    bearerToken,
    stepsCompleted,
  };
}
