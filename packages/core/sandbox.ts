import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SandboxRunResult {
  passed: boolean;
  stage: 'compile' | 'runtime' | 'compare';
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * 隔离沙箱单元测试执行器（用于 PTA / 编程题在提交前验证样例输入输出，驱动 Pro 模型多轮自愈）
 */
export async function runCodeInLocalSandbox(options: {
  code: string;
  language: 'python' | 'cpp' | 'c' | 'javascript';
  sampleInput?: string;
  expectedOutput?: string;
  timeoutMs?: number;
}): Promise<SandboxRunResult> {
  const timeoutMs = options.timeoutMs || 8000;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-sandbox-'));
  const startTime = Date.now();

  try {
    let runCmd = '';
    let runArgs: string[] = [];

    if (options.language === 'python') {
      const srcFile = path.join(tmpDir, 'solution.py');
      fs.writeFileSync(srcFile, options.code, 'utf8');
      runCmd = process.platform === 'win32' ? 'python' : 'python3';
      runArgs = [srcFile];
    } else if (options.language === 'javascript') {
      const srcFile = path.join(tmpDir, 'solution.js');
      fs.writeFileSync(srcFile, options.code, 'utf8');
      runCmd = 'node';
      runArgs = [srcFile];
    } else if (options.language === 'cpp' || options.language === 'c') {
      const ext = options.language === 'cpp' ? 'cpp' : 'c';
      const compiler = options.language === 'cpp' ? 'g++' : 'gcc';
      const srcFile = path.join(tmpDir, `solution.${ext}`);
      const binFile = path.join(tmpDir, process.platform === 'win32' ? 'solution.exe' : 'solution');
      fs.writeFileSync(srcFile, options.code, 'utf8');

      try {
        await execFileAsync(compiler, ['-O2', srcFile, '-o', binFile], { timeout: 10000 });
      } catch (compileErr: any) {
        return {
          passed: false,
          stage: 'compile',
          stdout: compileErr?.stdout || '',
          stderr: compileErr?.stderr || compileErr?.message || 'Compilation failed',
          exitCode: 1,
          durationMs: Date.now() - startTime,
        };
      }
      runCmd = binFile;
      runArgs = [];
    }

    const execResult = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const child = spawn(runCmd, runArgs, { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        if (stdout.length < 65536) stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < 65536) stderr += d.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 127 });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ stdout, stderr: `Time Limit Exceeded (${timeoutMs}ms)`, exitCode: 124 });
        } else {
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        }
      });

      if (options.sampleInput) {
        child.stdin.write(options.sampleInput);
      }
      child.stdin.end();
    });

    if (execResult.exitCode !== 0) {
      return {
        passed: false,
        stage: 'runtime',
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        durationMs: Date.now() - startTime,
      };
    }

    if (options.expectedOutput !== undefined) {
      const actualClean = execResult.stdout.trim().replace(/\r\n/g, '\n');
      const expectedClean = options.expectedOutput.trim().replace(/\r\n/g, '\n');
      const passed = actualClean === expectedClean;
      return {
        passed,
        stage: 'compare',
        stdout: execResult.stdout,
        stderr: passed ? '' : `Expected:\n${expectedClean}\nActual:\n${actualClean}`,
        exitCode: 0,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      passed: true,
      stage: 'compare',
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exitCode: 0,
      durationMs: Date.now() - startTime,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * 弹性算力调度器：
 * - mode === 'cloud-run': 调用 Google Cloud Run Jobs (消耗每月永久免费 36万 vCPU-秒配额)
 * - mode === 'gce': 调用 gcloud 短时拉起带 15 分钟 `at` 自毁熔断的临时 GCE 实例
 */
export async function triggerCloudBurst(options: {
  mode: 'cloud-run' | 'gce';
  taskCommand: string;
  ttlMinutes?: number;
  machineType?: string;
  dryRun?: boolean;
}): Promise<{ command: string; output: string }> {
  const project = process.env.GCP_PROJECT_ID || '<YOUR_GCP_PROJECT_ID>';
  const region = process.env.GCP_REGION || 'asia-east1';
  const zone = process.env.GCP_ZONE || 'asia-east1-b';

  if (options.mode === 'cloud-run') {
    const jobName = process.env.CLOUD_RUN_JOB_NAME || 'afk-sandbox-runner';
    const cmd = `gcloud run jobs execute ${jobName} --region=${region} --project=${project} --args="${options.taskCommand}" --wait`;
    if (options.dryRun) {
      return { command: cmd, output: '[DryRun] Cloud Run Job 免费无服务器容器触发指令已生成' };
    }
    const { stdout, stderr } = await execFileAsync('gcloud', [
      'run',
      'jobs',
      'execute',
      jobName,
      `--region=${region}`,
      `--project=${project}`,
      `--args=${options.taskCommand}`,
      '--wait',
    ], { shell: true, timeout: 600000 });
    return { command: cmd, output: (stdout || '') + (stderr || '') };
  }

  // Tier 2: 高负载 gcloud 短时拉起新机器 + at 物理自毁保险丝 (默认 60 分钟兜底，完工即删)
  const scriptPath = path.resolve(process.cwd(), 'infra', 'gcp', 'spawn-ephemeral-gce.sh');
  const ttl = String(options.ttlMinutes || process.env.GCE_BURST_TTL_MINUTES || 60);
  const machineType = options.machineType || process.env.GCE_BURST_MACHINE_TYPE || 'e2-micro';
  const cmd = `GCE_BURST_TTL_MINUTES=${ttl} GCE_BURST_MACHINE_TYPE=${machineType} GCP_ZONE=${zone} bash "${scriptPath}" "${options.taskCommand}"`;

  if (options.dryRun) {
    return { command: cmd, output: `[DryRun] 临时 GCE 实例 (${machineType}, 兜底TTL=${ttl}min, 完工即销毁) 拉起指令已生成` };
  }

  const timeoutMs = (parseInt(ttl, 10) * 60 + 180) * 1000;
  const { stdout, stderr } = await execFileAsync('bash', [scriptPath, options.taskCommand], {
    env: {
      ...process.env,
      GCE_BURST_TTL_MINUTES: ttl,
      GCE_BURST_MACHINE_TYPE: machineType,
      GCP_ZONE: zone,
    },
    timeout: timeoutMs,
  });

  return { command: cmd, output: (stdout || '') + (stderr || '') };
}
