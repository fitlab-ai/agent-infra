import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProcessStartTime } from '../../server/process-state.ts';
import { createTask } from '../../task/create-service.ts';
import { applyTaskFinalization } from '../../task/finalization.ts';
import { verifyTaskEvent } from '../../task/verification.ts';
import { bindSandboxControlTask, type SandboxControlExecution, type SandboxControlManifest, type SandboxControlRequest } from './protocol.ts';
import { atomicWriteJson, executionPath, terminateSandboxControlExecution } from './state.ts';
import { computeLifecycleBuildIdentity } from '../../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import {
  closeCodexControllerRegistration,
  CodexControllerRegistrationError,
  openCodexControllerRegistration,
  resolveCodexControllerBinding
} from './controller-registration.ts';

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
      env: {
        ...safeEnv(process.env),
        AGENT_INFRA_EXECUTOR_MANIFEST: params.manifestPath,
        AGENT_INFRA_RUNTIME_DIR: params.manifest.runtimeDir
      }
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

function controllerFailure(error: unknown): SandboxControlExecutionResult {
  const code = error instanceof CodexControllerRegistrationError
    ? error.code
    : /^([A-Z][A-Z0-9_]+)/u.exec(error instanceof Error ? error.message : String(error))?.[1]
      ?? 'CODEX_SANDBOX_CONTROLLER_FAILED';
  const message = error instanceof CodexControllerRegistrationError
    ? error.message
    : `${code}: controller operation failed; inspect the sandbox controller and rebuild the sandbox if needed`;
  const payload = {
    version: 1,
    status: 'failed',
    changed: false,
    lease: null,
    error: { code, message, retryable: false }
  };
  return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: '' };
}

function orchestrationFailure(code: string, message: string): SandboxControlExecutionResult {
  return {
    exitCode: 1,
    stdout: `${JSON.stringify({
      status: 'failed', changed: false, taskId: null, run: null, next: null,
      error: { code, message }
    })}\n`,
    stderr: ''
  };
}

function finalizationResult(result: ReturnType<typeof applyTaskFinalization>): SandboxControlExecutionResult {
  const payload = {
    version: 1,
    status: result.status,
    changed: result.changed,
    accepted: true,
    result,
    error: result.error
  };
  return {
    exitCode: result.status === 'completed' ? 0 : result.status === 'blocked' ? 2 : 1,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: ''
  };
}

function isCodexPrepare(args: readonly string[]): boolean {
  if (args[1] !== 'prepare') return false;
  const values: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--client') values.push(args[index + 1] ?? '');
    else if (args[index]?.startsWith('--client=')) values.push(args[index]!.slice('--client='.length));
  }
  return values.length === 1 && values[0] === 'codex';
}

type ExecuteRequestOptions = Readonly<{
  buildIdentity?: typeof computeLifecycleBuildIdentity;
  resolveControllerBinding?: typeof resolveCodexControllerBinding;
  spawnDomain?: typeof spawnSync;
}>;

export function executeRequest(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  options: ExecuteRequestOptions = {}
): SandboxControlExecutionResult {
  if (request.family === 'task-create') {
    const result = createTask(request.candidate, { repoRoot: manifest.repoRoot });
    return {
      exitCode: result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: ''
    };
  }
  if (request.family === 'codex-controller') {
    try {
      if (request.command === 'verify') {
        const binding = (options.resolveControllerBinding ?? resolveCodexControllerBinding)({
          manifest,
          manifestPath,
          proof: request.controllerProof!,
          buildIdentity: (options.buildIdentity ?? computeLifecycleBuildIdentity)(manifest.repoRoot)
        });
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            version: 1,
            status: 'verified',
            changed: false,
            lease: null,
            binding: {
              taskId: manifest.taskId,
              controlGeneration: binding.controlGeneration,
              controllerInstanceDigest: binding.instanceDigest
            },
            error: null
          })}\n`,
          stderr: ''
        };
      }
      const result = request.command === 'open'
        ? openCodexControllerRegistration({
            manifest,
            manifestPath,
            controllerProcess: request.controllerProcess!,
            buildIdentity: (options.buildIdentity ?? computeLifecycleBuildIdentity)(manifest.repoRoot)
          })
        : closeCodexControllerRegistration({
            manifest,
            manifestPath,
            proof: request.controllerProof!
          });
      return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    } catch (error) {
      return controllerFailure(error);
    }
  }
  if (request.family === 'task-finalization') {
    return finalizationResult(applyTaskFinalization(
      { taskRef: manifest.taskId!, intent: 'complete', agent: request.agent },
      { repoRoot: manifest.repoRoot, preflight: (input, options) => verifyTaskEvent(
        { ...input, event: 'complete-task.hard-preflight' }, options
      ) }
    ));
  }
  const boundArgs = bindSandboxControlTask(request, manifest.taskId!);
  let controllerBinding: Readonly<{
    instanceDigest: string;
    controlGeneration: string;
  }> | null = null;
  if (request.family === 'task-orchestration') {
    if (isCodexPrepare(request.args)) {
      if (!request.controllerProof) {
        return orchestrationFailure(
          'CODEX_SANDBOX_CONTROLLER_PROOF_REQUIRED',
          'Codex prepare requires a current controller lease proof'
        );
      }
      try {
        controllerBinding = (options.resolveControllerBinding ?? resolveCodexControllerBinding)({
          manifest,
          manifestPath,
          proof: request.controllerProof,
          buildIdentity: (options.buildIdentity ?? computeLifecycleBuildIdentity)(manifest.repoRoot)
        });
      } catch (error) {
        const code = error instanceof CodexControllerRegistrationError
          ? error.code
          : 'CODEX_SANDBOX_CONTROLLER_PROOF_INVALID';
        return orchestrationFailure(code, `${code}: Codex controller proof was rejected`);
      }
    } else if (request.controllerProof !== null) {
      return orchestrationFailure(
        'CODEX_SANDBOX_CONTROLLER_PROOF_INVALID',
        'Controller proof is only accepted for canonical Codex prepare'
      );
    }
    boundArgs.push('--git-worktree-root', manifest.worktreeRoot);
  }
  const result = (options.spawnDomain ?? spawnSync)(
    process.execPath,
    nodeEntryArgs(process.argv[1]!, [request.family, ...boundArgs]),
    {
      cwd: manifest.repoRoot,
      encoding: 'utf8',
      env: {
        ...safeEnv(process.env),
        AGENT_INFRA_RUNTIME_DIR: manifest.runtimeDir,
        ...(controllerBinding
          ? { AGENT_INFRA_CONTROL_CONTROLLER_BINDING: JSON.stringify(controllerBinding) }
          : {})
      }
    }
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
  const result = executeRequest(manifest, manifestPath, request);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

export function disconnectExecutor(child: ChildProcess): void {
  if (child.connected) child.disconnect();
}
