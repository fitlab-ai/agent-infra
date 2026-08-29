import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProcessStartTime } from '../../server/process-state.ts';
import { createTask } from '../../task/create-service.ts';
import { applyTaskFinalization } from '../../task/finalization.ts';
import { bindSandboxControlTask, validateSandboxControlRequest, type SandboxControlExecution, type SandboxControlManifest, type SandboxControlRequest } from './protocol.ts';
import { atomicWriteJson, executionPath, readActiveLease, terminateSandboxControlExecution } from './state.ts';
import {
  createSandboxExecutorExecutionContext,
  dispatchTaskControlOperation,
  parseTaskControlOperation,
  type TaskControlOperation
} from '../../task/control-authority.ts';
import { assertSandboxControlBrokerOwner, readSandboxControlManifest, type BrokerOwner } from './lifecycle.ts';
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

function sameBrokerOwner(left: BrokerOwner, right: BrokerOwner): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.startTime === right.startTime
    && left.brokerId === right.brokerId
    && left.token === right.token
    && left.generation === right.generation;
}

export function assertSandboxControlExecutorAuthority(
  manifest: SandboxControlManifest,
  gateOwner?: BrokerOwner
): void {
  const owner = assertSandboxControlBrokerOwner(manifest);
  if (gateOwner && !sameBrokerOwner(owner, gateOwner)) {
    throw new Error('SANDBOX_CONTROL_GATE_OWNER_MISMATCH');
  }
  if (readActiveLease(manifest)) throw new Error('SANDBOX_CONTROL_HANDOFF_ACTIVE');
}

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
      const gateOwner = assertSandboxControlBrokerOwner(params.manifest);
      if (!canWrite()) throw new Error('SANDBOX_CONTROL_OWNER_LOST');
      atomicWriteJson(executionPath(params.manifest, params.request.id), { ...execution, phase: 'running', updatedAt: Date.now() });
      if (!canWrite()) throw new Error('SANDBOX_CONTROL_OWNER_LOST');
      child.send({ version: 1, nonce, owner: gateOwner });
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

function waitForGate(nonce: string, timeoutMs = 2_000): Promise<BrokerOwner> {
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
      const value = message as {
        version?: unknown;
        nonce?: unknown;
        owner?: Partial<BrokerOwner> | null;
      } | null;
      const owner = value?.owner;
      if (!value || value.version !== 1 || value.nonce !== nonce
        || !owner || owner.version !== 3 || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
        || typeof owner.startTime !== 'number' || !Number.isSafeInteger(owner.startTime)
        || typeof owner.brokerId !== 'string' || owner.brokerId.length === 0
        || typeof owner.token !== 'string' || typeof owner.generation !== 'string') {
        reject(new Error('SANDBOX_CONTROL_EXECUTOR_GATE_INVALID'));
        return;
      }
      resolve(owner as BrokerOwner);
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

function lifecycleFailure(code: string, message: string): SandboxControlExecutionResult {
  return {
    exitCode: 1,
    stdout: `${JSON.stringify({
      status: 'failed', changed: false,
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
}>;

export async function executeRequest(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  options: ExecuteRequestOptions = {}
): Promise<SandboxControlExecutionResult> {
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
    const operation = parseTaskControlOperation('task-finalization', [manifest.taskId!], request.agent);
    if (operation.family !== 'task-finalization') throw new Error('SANDBOX_CONTROL_FINALIZATION_OPERATION_INVALID');
    const result = dispatchTaskControlOperation(
      createSandboxExecutorExecutionContext({
        repoRoot: manifest.repoRoot,
        worktreeRoot: manifest.worktreeRoot,
        runtimeDir: manifest.runtimeDir,
        taskId: manifest.taskId!,
        generation: manifest.generation,
        manifestPath,
        requestId: request.id
      }),
      operation
    );
    return finalizationResult(result);
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
  let operation: TaskControlOperation;
  try {
    operation = parseTaskControlOperation(request.family, boundArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'TASK_CONTROL_OPERATION_INVALID';
    return request.family === 'task-lifecycle'
      ? lifecycleFailure('LIFECYCLE_PAYLOAD_INVALID', message)
      : orchestrationFailure(code, message);
  }
  const context = createSandboxExecutorExecutionContext({
    repoRoot: manifest.repoRoot,
    worktreeRoot: manifest.worktreeRoot,
    runtimeDir: manifest.runtimeDir,
    taskId: manifest.taskId!,
    generation: manifest.generation,
    manifestPath,
    requestId: request.id,
    ...(controllerBinding ? { controllerBinding } : {})
  });
  const format = (value: unknown): SandboxControlExecutionResult => {
    const result = value as { status?: string };
    return {
      exitCode: result.status === 'failed' ? 1 : 0,
      stdout: `${JSON.stringify(value)}\n`,
      stderr: ''
    };
  };
  if (request.family === 'task-orchestration') {
    if (operation.family !== 'task-orchestration') throw new Error('SANDBOX_CONTROL_ORCHESTRATION_OPERATION_INVALID');
    return format(await dispatchTaskControlOperation(context, operation));
  }
  if (operation.family !== 'task-lifecycle') throw new Error('SANDBOX_CONTROL_LIFECYCLE_OPERATION_INVALID');
  return format(dispatchTaskControlOperation(context, operation));
}

export async function runSandboxControlExecutor(requestPath: string, nonce: string): Promise<void> {
  const gateOwner = await waitForGate(nonce);
  process.disconnect?.();
  const manifestPath = process.env.AGENT_INFRA_EXECUTOR_MANIFEST;
  if (!manifestPath) throw new Error('SANDBOX_CONTROL_EXECUTOR_MANIFEST_MISSING');
  const manifest = readSandboxControlManifest(manifestPath);
  const root = fs.realpathSync.native(process.cwd());
  if (fs.realpathSync.native(manifest.repoRoot) !== root) throw new Error('SANDBOX_CONTROL_EXECUTOR_ROOT_INVALID');
  const raw = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as unknown;
  const request = validateSandboxControlRequest(raw, manifest);
  const requestDirectory = path.resolve(path.dirname(requestPath));
  const processingDirectory = path.resolve(path.join(manifest.processingDir, request.id));
  const channelRequestDirectory = path.resolve(path.join(manifest.channelDir, 'requests'));
  if (requestDirectory !== processingDirectory && requestDirectory !== channelRequestDirectory) {
    throw new Error('SANDBOX_CONTROL_EXECUTOR_REQUEST_INVALID');
  }
  let result: SandboxControlExecutionResult;
  try {
    assertSandboxControlExecutorAuthority(manifest, gateOwner);
    result = await executeRequest(manifest, manifestPath, request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/u.exec(detail)?.[1] ?? 'SANDBOX_CONTROL_EXECUTOR_FAILED';
    result = request.family === 'task-finalization'
      ? {
        exitCode: 1,
        stdout: `${JSON.stringify({
          version: 1, status: 'failed', changed: false, accepted: true, result: null,
          error: { code, message: detail, retryable: false }
        })}\n`,
        stderr: ''
      }
      : request.family === 'task-lifecycle'
        ? lifecycleFailure(code, detail)
        : orchestrationFailure(code, detail);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

export function disconnectExecutor(child: ChildProcess): void {
  if (child.connected) child.disconnect();
}
