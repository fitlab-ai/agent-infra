import fs from 'node:fs';
import path from 'node:path';

import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { sandboxControlPaths } from '../sandbox/workspace-view.ts';
import {
  applyTaskFinalization,
  type TaskFinalizationRequest,
  type TaskFinalizationResult
} from './finalization.ts';
import {
  applyTaskLifecycle,
  type TaskLifecycleRequest,
  type TaskLifecycleResult
} from './lifecycle.ts';
import { resolveTaskRef, TASK_ID_RE } from './resolve-ref.ts';
import { verifyTaskEvent } from './verification.ts';
import { releaseStaleShortIdRegistry } from './short-id.ts';

export type TaskControlExecutionContext =
  | Readonly<{
      source: 'direct-host';
      mode: 'direct-host';
      repoRoot: string;
      runtimeDir?: string;
      controlBase?: string;
      project?: string;
    }>
  | Readonly<{
      source: 'sandbox-executor';
      mode: 'task-bound-sandbox';
      repoRoot: string;
      worktreeRoot: string;
      runtimeDir: string;
      taskId: string;
      generation: string;
      manifestPath: string;
      requestId: string;
    }>;

export type TaskControlOperation =
  | Readonly<{ family: 'task-lifecycle'; request: TaskLifecycleControlRequest }>
  | Readonly<{ family: 'task-finalization'; request: TaskFinalizationRequest }>;

export type TaskControlDispatchResult = TaskLifecycleResult | TaskFinalizationResult;

export function taskControlOperationKey(operation: TaskControlOperation): string {
  return operation.family === 'task-finalization' ? 'complete' : operation.request.intent;
}

export type TaskLifecycleControlRequest = TaskLifecycleRequest;

function invalidContext(message: string): never {
  throw new Error(`TASK_CONTROL_CONTEXT_INVALID: ${message}`);
}

function absolute(name: string, value: string): string {
  if (!value || !path.isAbsolute(value)) invalidContext(`${name} must be absolute`);
  return path.resolve(value);
}

export function createDirectHostExecutionContext(params: Readonly<{
  repoRoot: string;
  runtimeDir?: string;
  controlBase?: string;
  project?: string;
}>): TaskControlExecutionContext {
  return {
    source: 'direct-host',
    mode: 'direct-host',
    repoRoot: absolute('repoRoot', params.repoRoot),
    ...(params.controlBase === undefined ? {} : { controlBase: absolute('controlBase', params.controlBase) }),
    ...(params.project === undefined ? {} : { project: params.project }),
    ...(params.runtimeDir === undefined ? {} : { runtimeDir: absolute('runtimeDir', params.runtimeDir) })
  };
}

export function createSandboxExecutorExecutionContext(params: Readonly<{
  repoRoot: string;
  worktreeRoot: string;
  runtimeDir: string;
  taskId: string;
  generation: string;
  manifestPath: string;
  requestId: string;
}>): TaskControlExecutionContext {
  if (!/^TASK-\d{8}-\d{6}$/u.test(params.taskId) || !params.generation || !params.requestId) {
    invalidContext('sandbox binding is incomplete');
  }
  const controlRoot = path.dirname(path.resolve(params.manifestPath));
  if (path.resolve(params.runtimeDir) !== path.join(controlRoot, 'runtime')) {
    invalidContext('runtimeDir is not bound to the manifest control root');
  }
  return {
    source: 'sandbox-executor',
    mode: 'task-bound-sandbox',
    repoRoot: absolute('repoRoot', params.repoRoot),
    worktreeRoot: absolute('worktreeRoot', params.worktreeRoot),
    runtimeDir: absolute('runtimeDir', params.runtimeDir),
    taskId: params.taskId,
    generation: params.generation,
    manifestPath: absolute('manifestPath', params.manifestPath),
    requestId: params.requestId
  };
}

export function assertTaskControlExecutionContext(context: TaskControlExecutionContext): void {
  if (context.source === 'direct-host') {
    if (context.mode !== 'direct-host') invalidContext('direct-host mode is inconsistent');
    absolute('repoRoot', context.repoRoot);
    if (context.runtimeDir !== undefined) absolute('runtimeDir', context.runtimeDir);
    if (Boolean(context.controlBase) !== Boolean(context.project)) invalidContext('control configuration is incomplete');
    if (context.controlBase !== undefined) absolute('controlBase', context.controlBase);
    return;
  }
  if (context.mode !== 'task-bound-sandbox' || !/^TASK-\d{8}-\d{6}$/u.test(context.taskId)
    || !context.generation || !context.requestId) {
    invalidContext('sandbox executor context is incomplete');
  }
  absolute('repoRoot', context.repoRoot);
  absolute('worktreeRoot', context.worktreeRoot);
  absolute('runtimeDir', context.runtimeDir);
  absolute('manifestPath', context.manifestPath);
  if (path.resolve(context.runtimeDir) !== path.join(path.dirname(path.resolve(context.manifestPath)), 'runtime')) {
    invalidContext('runtimeDir is not bound to the manifest control root');
  }
}

function boundTaskRef(context: TaskControlExecutionContext, taskRef: string): string {
  return context.source === 'sandbox-executor' ? context.taskId : taskRef;
}

function lifecycleTaskId(request: TaskLifecycleControlRequest, repoRoot: string): string | null {
  if (request.intent === 'restore') return TASK_ID_RE.test(request.taskRef) ? request.taskRef : null;
  try {
    const resolved = resolveTaskRef(request.taskRef, { repoRoot });
    return resolved.ok ? resolved.taskId : null;
  } catch {
    return null;
  }
}

async function applyLifecycleWithAuthority(
  context: TaskControlExecutionContext,
  request: TaskLifecycleControlRequest
): Promise<TaskLifecycleResult> {
  const taskId = lifecycleTaskId(request, context.repoRoot);
  const controlRoot = taskId ? controlRootForTask(context, taskId) : undefined;
  const execute = async (): Promise<TaskLifecycleResult> => {
    return applyTaskLifecycle(request, {
      repoRoot: context.repoRoot,
      ...(controlRoot ? { controlRoot } : {}),
      ...(context.source === 'direct-host' && context.project ? { controlProject: context.project } : {})
    });
  };
  return await execute();
}

function controlRootForTask(context: TaskControlExecutionContext, taskId: string): string | undefined {
  if (context.source === 'sandbox-executor') return path.dirname(context.manifestPath);
  if (!context.controlBase || !context.project) return undefined;
  return sandboxControlPaths({
    base: context.controlBase,
    project: context.project,
    container: '',
    identity: { mode: 'task-bound', taskId }
  }).root;
}

export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-lifecycle' }>
): Promise<TaskLifecycleResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-finalization' }>
): Promise<TaskFinalizationResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: TaskControlOperation
): TaskControlDispatchResult | Promise<TaskControlDispatchResult> {
  assertTaskControlExecutionContext(context);
  assertTaskControlOperation(operation);
  if (operation.family === 'task-lifecycle') {
    return applyLifecycleWithAuthority(context, {
      ...operation.request,
      taskRef: boundTaskRef(context, operation.request.taskRef)
    });
  }
  if (operation.family === 'task-finalization') {
    const resolved = resolveTaskRef(boundTaskRef(context, operation.request.taskRef), { repoRoot: context.repoRoot });
    const controlRoot = context.source === 'sandbox-executor'
      ? path.dirname(context.manifestPath)
      : resolved.ok ? controlRootForTask(context, resolved.taskId) : undefined;
    return applyTaskFinalization({
      ...operation.request,
      taskRef: boundTaskRef(context, operation.request.taskRef)
    }, {
      repoRoot: context.repoRoot,
      ...(context.source === 'sandbox-executor' ? {
        controlBinding: { generation: context.generation, requestId: context.requestId },
        manifestPath: context.manifestPath
      } : {}),
      ...(controlRoot ? { controlRoot } : {}),
      ...(context.source === 'direct-host' && context.project ? { controlProject: context.project } : {}),
      preflight: (request, options) => verifyTaskEvent(
        { ...request, event: 'complete-task.hard-preflight' }, options
      )
    }).then((result) => {
      if (context.source !== 'direct-host' || !controlRoot || result.status !== 'completed' || !result.taskId) return result;
      try {
        if (fs.lstatSync(controlRoot, { throwIfNoEntry: false }) === undefined) {
          const released = releaseStaleShortIdRegistry(context.repoRoot, result.taskId);
          return { ...result, changed: result.changed || released.changed };
        }
        return result;
      } catch (error) {
        return {
          ...result,
          status: 'blocked',
          result: 'blocked',
          error: {
            code: 'TASK_FINALIZATION_SHORT_ID_RELEASE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true
          }
        };
      }
    });
  }
  throw new Error('TASK_CONTROL_OPERATION_INVALID: unsupported operation family');
}

export function assertTaskControlOperation(operation: TaskControlOperation): void {
  if (operation.family === 'task-lifecycle') {
    if (!operation.request.taskRef || !normalizeAgentToken(operation.request.agent)) {
      throw new Error('TASK_CONTROL_OPERATION_INVALID: lifecycle request is invalid');
    }
    return;
  }
  if (operation.family === 'task-finalization') {
    if (!operation.request.taskRef || !normalizeAgentToken(operation.request.agent)) {
      throw new Error('TASK_CONTROL_OPERATION_INVALID: finalization request is invalid');
    }
    return;
  }
}

function operationInvalid(message: string): never {
  throw new Error(`TASK_CONTROL_OPERATION_INVALID: ${message}`);
}

const LIFECYCLE_FLAGS = new Set([
  '--agent', '--reason', '--unblock-condition', '--note', '--alert-number', '--staging-dir', '--issue-number',
  '--dry-run'
]);

const FINALIZATION_FLAGS = new Set(['--agent']);

function parseValues(
  args: readonly string[],
  start: number,
  flags: ReadonlySet<string>
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (!flags.has(flag)) operationInvalid(`unknown option '${flag}'`);
      if (values[flag] !== undefined) operationInvalid(`duplicate option '${flag}'`);
      values[flag] = true;
      continue;
    }
    if (!flags.has(flag)) operationInvalid(`unknown option '${flag}'`);
    if (values[flag] !== undefined) operationInvalid(`duplicate option '${flag}'`);
    const value = args[++index];
    if (!value || value.startsWith('--')) operationInvalid(`option '${flag}' requires a value`);
    values[flag] = value;
  }
  return values;
}

function value(values: Record<string, string | boolean>, flag: string): string | undefined {
  const current = values[flag];
  return typeof current === 'string' ? current : undefined;
}

function required(values: Record<string, string | boolean>, flags: readonly string[]): void {
  const missing = flags.find((flag) => value(values, flag) === undefined);
  if (missing) operationInvalid(`option '${missing}' is required`);
}

export function parseTaskControlOperation(
  family: 'task-lifecycle' | 'task-finalization',
  args: readonly string[]
): TaskControlOperation {
  if (family === 'task-finalization') {
    if (args.length !== 4 || args[1] !== 'complete' || args[2] !== '--agent' || !args[0] || !args[3]) {
      operationInvalid('task ref, complete intent, and --agent are required');
    }
    const values = parseValues(args, 2, FINALIZATION_FLAGS);
    const agent = normalizeAgentToken(value(values, '--agent') ?? '');
    if (!agent) operationInvalid('finalization agent is invalid');
    return { family, request: { taskRef: args[0]!, intent: 'complete', agent } };
  }
  if (args.length < 2) operationInvalid('task ref and intent are required');
  const taskRef = args[0]!;
  const intent = args[1]!;
  if (intent === 'complete') operationInvalid('complete must use task-finalization');
  const values = parseValues(args, 2, LIFECYCLE_FLAGS);
  const agent = normalizeAgentToken(value(values, '--agent') ?? '');
  if (!agent) operationInvalid('lifecycle agent is invalid');
  const request: Record<string, unknown> = {
    taskRef,
    intent,
    agent,
    ...(value(values, '--reason') ? { reason: value(values, '--reason') } : {}),
    ...(value(values, '--unblock-condition') ? { unblockCondition: value(values, '--unblock-condition') } : {}),
    ...(value(values, '--note') ? { note: value(values, '--note') } : {}),
    ...(value(values, '--staging-dir') ? { stagingDir: value(values, '--staging-dir') } : {}),
    ...(value(values, '--alert-number') ? { alertNumber: Number(value(values, '--alert-number')) } : {}),
    ...(value(values, '--issue-number') ? { issueNumber: Number(value(values, '--issue-number')) } : {}),
    ...(values['--dry-run'] === true ? { dryRun: true } : {})
  };
  return { family, request: request as unknown as TaskLifecycleControlRequest };
}
