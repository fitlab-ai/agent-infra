import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProcessStartTime } from '../../server/process-state.ts';
import { createTask } from '../../task/create-service.ts';
import { bindSandboxControlTask, type SandboxControlExecution, type SandboxControlManifest, type SandboxControlRequest } from './protocol.ts';
import { atomicWriteJson, executionPath, terminateSandboxControlExecution } from './state.ts';

export type SandboxControlExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PreparedSandboxControlExecution = {
  execution: SandboxControlExecution;
  start(canWrite?: () => boolean): void;
  completion: Promise<SandboxControlExecutionResult>;
  terminate(updateState?: boolean): boolean;
};

function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')));
}

export function nodeEntryArgs(entry: string, args: string[]): string[] {
  return path.extname(entry) === '.ts'
    ? ['--experimental-strip-types', '--no-warnings', entry, ...args]
    : [entry, ...args];
}

async function waitForStartTime(pid: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startTime = getProcessStartTime(pid);
    if (startTime !== null) return startTime;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('SANDBOX_CONTROL_EXECUTOR_IDENTITY_UNAVAILABLE');
}

export async function prepareSandboxControlExecution(params: {
  manifest: SandboxControlManifest;
  manifestPath: string;
  request: SandboxControlRequest;
  requestPath: string;
  internalCliPath: string;
}): Promise<PreparedSandboxControlExecution> {
  const nonce = randomUUID();
  const child = spawn(
    process.execPath,
    nodeEntryArgs(params.internalCliPath, [
      'sandbox-control', 'execute', '--request', params.requestPath, '--nonce', nonce
    ]),
    {
      cwd: params.manifest.repoRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...safeEnv(process.env), AGENT_INFRA_EXECUTOR_MANIFEST: params.manifestPath }
    }
  );
  if (typeof child.pid !== 'number') throw new Error('SANDBOX_CONTROL_EXECUTOR_SPAWN_FAILED');
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const completion = new Promise<SandboxControlExecutionResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
  const startTime = await waitForStartTime(child.pid);
  const execution: SandboxControlExecution = {
    version: 2,
    generation: params.manifest.generation,
    requestId: params.request.id,
    nonce,
    child: {
      pid: child.pid,
      startTime,
      processGroupId: process.platform === 'win32' ? null : child.pid
    },
    phase: 'prepared',
    updatedAt: Date.now()
  };
  atomicWriteJson(executionPath(params.manifest, params.request.id), execution);
  return {
    execution,
    start(canWrite = () => true) {
      if (!child.connected) throw new Error('SANDBOX_CONTROL_EXECUTOR_GATE_CLOSED');
      if (!canWrite()) throw new Error('SANDBOX_CONTROL_OWNER_LOST');
      atomicWriteJson(executionPath(params.manifest, params.request.id), { ...execution, phase: 'running', updatedAt: Date.now() });
      if (!canWrite()) throw new Error('SANDBOX_CONTROL_OWNER_LOST');
      child.send({ version: 1, nonce });
    },
    completion,
    terminate(updateState = true) {
      if (updateState) {
        atomicWriteJson(executionPath(params.manifest, params.request.id), {
          ...execution, phase: 'terminating', updatedAt: Date.now()
        });
      }
      return terminateSandboxControlExecution(execution);
    }
  };
}

function waitForGate(nonce: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SANDBOX_CONTROL_EXECUTOR_GATE_TIMEOUT')), timeoutMs);
    const onDisconnect = () => {
      clearTimeout(timer);
      reject(new Error('SANDBOX_CONTROL_EXECUTOR_GATE_CLOSED'));
    };
    process.once('disconnect', onDisconnect);
    process.once('message', (message: unknown) => {
      clearTimeout(timer);
      process.off('disconnect', onDisconnect);
      const value = message as { version?: unknown; nonce?: unknown } | null;
      if (!value || value.version !== 1 || value.nonce !== nonce) {
        reject(new Error('SANDBOX_CONTROL_EXECUTOR_GATE_INVALID'));
        return;
      }
      resolve();
    });
  });
}

function executeRequest(manifest: SandboxControlManifest, request: SandboxControlRequest): SandboxControlExecutionResult {
  if (request.family === 'task-create') {
    const result = createTask(request.candidate, { repoRoot: manifest.repoRoot });
    return {
      exitCode: result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: ''
    };
  }
  const boundArgs = bindSandboxControlTask(request, manifest.taskId!);
  if (request.family === 'task-orchestration') boundArgs.push('--git-worktree-root', manifest.worktreeRoot);
  const result = spawnSync(
    process.execPath,
    nodeEntryArgs(process.argv[1]!, [request.family, ...boundArgs]),
    { cwd: manifest.repoRoot, encoding: 'utf8', env: safeEnv(process.env) }
  );
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function runSandboxControlExecutor(requestPath: string, nonce: string): Promise<void> {
  await waitForGate(nonce);
  process.disconnect?.();
  const root = fs.realpathSync.native(process.cwd());
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as SandboxControlRequest;
  const manifestPath = process.env.AGENT_INFRA_EXECUTOR_MANIFEST;
  if (!manifestPath) throw new Error('SANDBOX_CONTROL_EXECUTOR_MANIFEST_MISSING');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SandboxControlManifest;
  if (fs.realpathSync.native(manifest.repoRoot) !== root) throw new Error('SANDBOX_CONTROL_EXECUTOR_ROOT_INVALID');
  const result = executeRequest(manifest, request);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

export function disconnectExecutor(child: ChildProcess): void {
  if (child.connected) child.disconnect();
}
