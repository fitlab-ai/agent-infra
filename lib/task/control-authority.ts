import path from 'node:path';

import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import { getAgentClientAdapter } from '../agent-clients/registry.ts';
import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  awaitOrchestrationDelegationActivation,
  beginOrResumeOrchestration,
  dispatchOrchestrationDelegation,
  OrchestrationStateError,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  recoverPreparedOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  statusOrchestration
} from './orchestration.ts';
import type { OrchestrationOptions, OrchestrationResult } from './orchestration.ts';
import {
  applyTaskFinalization,
  type TaskFinalizationRequest,
  type TaskFinalizationResult
} from './finalization.ts';
import {
  applyTaskLifecycle,
  applyTaskLifecycleWithinTaskLock,
  taskLifecycleFailure,
  type TaskLifecycleRequest,
  type TaskLifecycleResult
} from './lifecycle.ts';
import type {
  AgentClientLifecycleRecoveryRequest as LifecycleRecoveryRequest,
  AgentClientLifecycleRecoveryResult as LifecycleRecoveryResult
} from '../agent-clients/adapter.ts';
import { resolveTaskContext, resolveTaskRef, TASK_ID_RE } from './resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { verifyTaskEvent } from './verification.ts';

export type TaskControlControllerBinding = Readonly<{
  instanceDigest: string;
  controlGeneration: string;
}>;

export type TaskControlExecutionContext =
  | Readonly<{
      source: 'direct-host';
      mode: 'direct-host';
      repoRoot: string;
      runtimeDir?: string;
      controllerBinding?: TaskControlControllerBinding | null;
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
      controllerBinding?: TaskControlControllerBinding | null;
    }>;

export type TaskControlOrchestrationIntent =
  | 'begin-or-resume'
  | 'route'
  | 'prepare'
  | 'dispatch'
  | 'await-activation'
  | 'recover-prepared'
  | 'hook-start'
  | 'hook-stop'
  | 'advance'
  | 'pause'
  | 'status';

export type TaskControlOperation =
  | Readonly<{ family: 'task-lifecycle'; request: TaskLifecycleControlRequest }>
  | Readonly<{ family: 'task-finalization'; request: TaskFinalizationRequest }>
  | Readonly<{
      family: 'task-orchestration';
      taskRef: string;
      intent: TaskControlOrchestrationIntent;
      input: Readonly<Record<string, unknown>>;
      options?: Omit<OrchestrationOptions, 'repoRoot'>;
    }>;

export type TaskControlDispatchResult = TaskLifecycleResult | LifecycleRecoveryResult | TaskFinalizationResult | OrchestrationResult;

export function taskControlOperationKey(operation: TaskControlOperation): string {
  if (operation.family === 'task-finalization') return 'complete';
  if (operation.family === 'task-lifecycle') return operation.request.intent;
  return operation.intent === 'route'
    ? operation.input && operation.input.completed === true ? 'route.clean-completion' : 'route.read'
    : operation.intent;
}

export type TaskLifecycleControlRequest = TaskLifecycleRequest;

function invalidContext(message: string): never {
  throw new Error(`TASK_CONTROL_CONTEXT_INVALID: ${message}`);
}

function absolute(name: string, value: string): string {
  if (!value || !path.isAbsolute(value)) invalidContext(`${name} must be absolute`);
  return path.resolve(value);
}

function binding(value: TaskControlControllerBinding | null | undefined): TaskControlControllerBinding | null | undefined {
  if (value === null || value === undefined) return value;
  if (!/^[a-f0-9]{64}$/u.test(value.instanceDigest) || !value.controlGeneration) {
    invalidContext('controller binding is invalid');
  }
  return value;
}

export function createDirectHostExecutionContext(params: Readonly<{
  repoRoot: string;
  runtimeDir?: string;
  controllerBinding?: TaskControlControllerBinding | null;
}>): TaskControlExecutionContext {
  return {
    source: 'direct-host',
    mode: 'direct-host',
    repoRoot: absolute('repoRoot', params.repoRoot),
    ...(params.runtimeDir === undefined ? {} : { runtimeDir: absolute('runtimeDir', params.runtimeDir) }),
    ...(params.controllerBinding === undefined ? {} : { controllerBinding: binding(params.controllerBinding) }),
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
  controllerBinding?: TaskControlControllerBinding | null;
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
    requestId: params.requestId,
    ...(params.controllerBinding === undefined ? {} : { controllerBinding: binding(params.controllerBinding) }),
  };
}

export function assertTaskControlExecutionContext(context: TaskControlExecutionContext): void {
  if (context.source === 'direct-host') {
    if (context.mode !== 'direct-host') invalidContext('direct-host mode is inconsistent');
    absolute('repoRoot', context.repoRoot);
    if (context.runtimeDir !== undefined) absolute('runtimeDir', context.runtimeDir);
    binding(context.controllerBinding);
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
  binding(context.controllerBinding);
}

function boundTaskRef(context: TaskControlExecutionContext, taskRef: string): string {
  return context.source === 'sandbox-executor' ? context.taskId : taskRef;
}

function autoTaskOptions(
  context: TaskControlExecutionContext,
  options: OrchestrationOptions
): OrchestrationOptions {
  if (context.source === 'sandbox-executor') return { ...options, taskId: context.taskId };
  const resolved = resolveTaskContext(undefined, { repoRoot: context.repoRoot });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  return { ...options, taskId: resolved.taskId };
}

function domainOptions(
  context: TaskControlExecutionContext,
  options: Omit<OrchestrationOptions, 'repoRoot'> | undefined
): OrchestrationOptions {
  return {
    ...options,
    repoRoot: context.repoRoot
  };
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
): Promise<TaskLifecycleResult | LifecycleRecoveryResult> {
  const execute = async (underTaskLock = false): Promise<TaskLifecycleResult | LifecycleRecoveryResult> => {
    if (request.intent === 'recover-started') {
      const adapter = isAgentClientId(request.agent)
        ? getAgentClientAdapter(request.agent).orchestrationAdapter
        : undefined;
      if (!adapter?.recoverStarted) {
        return {
          status: 'no-op', changed: false, targetState: 'active',
          requestRef: request.taskRef, intent: 'recover-started', taskId: null,
          receiptId: null, childId: null, error: null
        };
      }
      return adapter.recoverStarted(request as LifecycleRecoveryRequest, { repoRoot: context.repoRoot });
    }
    return underTaskLock
      ? applyTaskLifecycleWithinTaskLock(request, { repoRoot: context.repoRoot }, taskId!)
      : applyTaskLifecycle(request, { repoRoot: context.repoRoot });
  };
  const taskId = lifecycleTaskId(request, context.repoRoot);
  if (!taskId) return await execute();
  try {
    return await withTaskExecutionLock(
      context.repoRoot,
      taskId,
      `task-lifecycle.${request.intent}`,
      () => execute(true)
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    if (request.intent === 'recover-started') {
      return {
        status: 'owner-unknown', changed: false, targetState: 'active',
        requestRef: request.taskRef, intent: 'recover-started', taskId,
        receiptId: null, childId: null,
        error: { code: error.code, message: error.message }
      };
    }
    return taskLifecycleFailure(request, { code: error.code, message: error.message }, taskId);
  }
}

function orchestration(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-orchestration' }>
): OrchestrationResult | Promise<OrchestrationResult> {
  const taskRef = boundTaskRef(context, operation.taskRef);
  const input = operation.input;
  const options = domainOptions(context, operation.options);
  switch (operation.intent) {
    case 'begin-or-resume':
      return beginOrResumeOrchestration(taskRef, {
        ...options,
        client: input.client as AgentClientId,
        maxSteps: input.maxSteps as number | undefined,
        modelPolicy: input.modelPolicy as OrchestrationOptions['modelPolicy']
      });
    case 'route': return routeOrchestration(taskRef, options);
    case 'status': return statusOrchestration(taskRef, options);
    case 'prepare': return prepareTaskOrchestration(context, { ...operation, taskRef }, options);
    case 'dispatch': return dispatchOrchestrationDelegation(taskRef, options);
    case 'await-activation':
      return awaitOrchestrationDelegationActivation(taskRef, input.event as never, options);
    case 'recover-prepared': return recoverPreparedOrchestrationDelegation(taskRef, options);
    case 'hook-start':
      return input.auto === true
        ? activateMatchingOrchestrationDelegation(
            input.client as AgentClientId, input.event as never, autoTaskOptions(context, options)
          )
        : activateOrchestrationDelegation(taskRef, input.event as never, options);
    case 'hook-stop':
      return input.auto === true
        ? sealMatchingOrchestrationDelegation(
            input.client as AgentClientId, input.event as never, autoTaskOptions(context, options)
          )
        : sealOrchestrationDelegation(taskRef, input.event as never, options);
    case 'advance': return advanceOrchestration(taskRef, options);
    case 'pause':
      return pauseOrchestration(
        taskRef,
        input.code as string,
        input.message as string,
        input.recoverable as boolean,
        options
      );
  }
}

function prepareTaskOrchestration(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-orchestration' }>,
  options: OrchestrationOptions
): OrchestrationResult | Promise<OrchestrationResult> {
  const input = operation.input;
  const prepareInput = {
    client: input.client as AgentClientId,
    requestedModel: input.requestedModel as string | undefined,
    requestedReasoningEffort: input.requestedReasoningEffort as string | undefined,
  };
  const prepareDelegation = getAgentClientAdapter(prepareInput.client).orchestrationAdapter?.prepareDelegation;
  return prepareDelegation
    ? prepareDelegation(operation.taskRef, prepareInput, {
      repoRoot: context.repoRoot,
      orchestrationOptions: options,
    })
    : prepareOrchestrationDelegation(operation.taskRef, prepareInput, options);
}

function orchestrationFailure(error: unknown): OrchestrationResult {
  if (error instanceof OrchestrationStateError) {
    return {
      status: 'failed', changed: false, taskId: error.taskId, run: null, next: null,
      error: { code: error.code, message: error.message }
    };
  }
  throw error;
}

export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-lifecycle' }>
): Promise<TaskLifecycleResult | LifecycleRecoveryResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-finalization' }>
): Promise<TaskFinalizationResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-orchestration' }>
): OrchestrationResult | Promise<OrchestrationResult>;
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
    return applyTaskFinalization({
      ...operation.request,
      taskRef: boundTaskRef(context, operation.request.taskRef)
    }, {
      repoRoot: context.repoRoot,
      ...(context.source === 'sandbox-executor' ? {
        controlBinding: { generation: context.generation, requestId: context.requestId },
        manifestPath: context.manifestPath
      } : {}),
      preflight: (request, options) => verifyTaskEvent(
        { ...request, event: 'complete-task.hard-preflight' }, options
      )
    });
  }
  try {
    const result = orchestration(context, operation);
    return result instanceof Promise ? result.catch(orchestrationFailure) : result;
  } catch (error) {
    return orchestrationFailure(error);
  }
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
  if (!operation.taskRef || !operation.intent || !operation.input || typeof operation.input !== 'object' || Array.isArray(operation.input)) {
    throw new Error('TASK_CONTROL_OPERATION_INVALID: orchestration operation is invalid');
  }
}

function operationInvalid(message: string): never {
  throw new Error(`TASK_CONTROL_OPERATION_INVALID: ${message}`);
}

const LIFECYCLE_FLAGS = new Set([
  '--agent', '--reason', '--unblock-condition', '--note', '--alert-number', '--staging-dir', '--issue-number',
  '--auto', '--dry-run'
]);

const FINALIZATION_FLAGS = new Set(['--agent']);

const ORCHESTRATION_FLAGS = new Set([
  '--agent', '--max-steps', '--executor-model', '--executor-reasoning-effort', '--reviewer-model',
  '--reviewer-reasoning-effort', '--client', '--requested-model', '--requested-reasoning-effort',
  '--parent-id', '--before-fingerprint', '--stage', '--round', '--artifact', '--role',
  '--native-agent', '--child-id', '--spawn-mode', '--actual-model', '--actual-reasoning-effort',
  '--model-fallback-reason', '--reasoning-effort-fallback-reason', '--exit-code', '--after-fingerprint',
  '--changed-paths', '--code', '--message', '--recoverable'
]);

function parseValues(
  args: readonly string[],
  start: number,
  flags: ReadonlySet<string>
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run' || flag === '--auto') {
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
  family: 'task-lifecycle' | 'task-orchestration' | 'task-finalization',
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
  if (family === 'task-lifecycle') {
    const values = parseValues(args, 2, LIFECYCLE_FLAGS);
    const agent = normalizeAgentToken(value(values, '--agent') ?? '');
    if (!agent) operationInvalid('lifecycle agent is invalid');
    const input: Record<string, unknown> = {
      taskRef,
      intent,
      agent,
      ...(value(values, '--reason') ? { reason: value(values, '--reason') } : {}),
      ...(value(values, '--unblock-condition') ? { unblockCondition: value(values, '--unblock-condition') } : {}),
      ...(value(values, '--note') ? { note: value(values, '--note') } : {}),
      ...(value(values, '--staging-dir') ? { stagingDir: value(values, '--staging-dir') } : {}),
      ...(value(values, '--alert-number') ? { alertNumber: Number(value(values, '--alert-number')) } : {}),
      ...(value(values, '--issue-number') ? { issueNumber: Number(value(values, '--issue-number')) } : {}),
      ...(values['--auto'] === true ? { auto: true } : {}),
      ...(values['--dry-run'] === true ? { dryRun: true } : {})
    };
    if (intent === 'recover-started') {
      const recoveryFlags = new Set(['--agent', '--auto']);
      for (const flag of Object.keys(values)) {
        if (!recoveryFlags.has(flag)) operationInvalid(`option '${flag}' is not supported for recover-started`);
      }
      if (values['--auto'] !== true) operationInvalid('--auto is required for recover-started');
      return { family, request: input as unknown as TaskLifecycleControlRequest };
    } else if (values['--auto'] !== undefined) {
      operationInvalid('--auto is only supported for recover-started');
    }
    return { family, request: input as unknown as TaskLifecycleControlRequest };
  }

  const values = parseValues(args, 2, ORCHESTRATION_FLAGS);
  const orchestrationIntents = new Set<TaskControlOrchestrationIntent>([
    'begin-or-resume', 'route', 'prepare', 'dispatch', 'await-activation', 'recover-prepared',
    'hook-start', 'hook-stop', 'advance', 'pause', 'status'
  ]);
  if (!orchestrationIntents.has(intent as TaskControlOrchestrationIntent)) {
    operationInvalid(`unknown orchestration intent '${intent}'`);
  }
  const client = value(values, '--client');
  if (client !== undefined && !isAgentClientId(client)) operationInvalid(`unknown client '${client}'`);
  const parsedIntent = intent as TaskControlOrchestrationIntent;
  const input: Record<string, unknown> = {};
  if (parsedIntent === 'begin-or-resume' || parsedIntent === 'prepare') {
    required(values, ['--client']);
    if (!client || !isAgentClientId(client)) operationInvalid(`unknown client '${client ?? ''}'`);
    input.client = client;
  }
  if (parsedIntent === 'begin-or-resume') {
    const maxSteps = value(values, '--max-steps');
    if (maxSteps !== undefined) {
      const parsed = Number(maxSteps);
      if (!Number.isInteger(parsed) || parsed < 1) operationInvalid('--max-steps must be a positive integer');
      input.maxSteps = parsed;
    }
    const policyFlags = ['--executor-model', '--executor-reasoning-effort', '--reviewer-model', '--reviewer-reasoning-effort'];
    const hasPolicy = policyFlags.some((flag) => value(values, flag) !== undefined);
    if (hasPolicy && policyFlags.some((flag) => value(values, flag) === undefined)) {
      operationInvalid('explicit model policy requires executor/reviewer model and reasoning effort');
    }
    if (hasPolicy) {
      input.modelPolicy = {
        executor: { model: value(values, '--executor-model'), reasoningEffort: value(values, '--executor-reasoning-effort') },
        reviewer: { model: value(values, '--reviewer-model'), reasoningEffort: value(values, '--reviewer-reasoning-effort') }
      };
    }
  }
  if (parsedIntent === 'prepare') {
    input.requestedModel = value(values, '--requested-model');
    input.requestedReasoningEffort = value(values, '--requested-reasoning-effort');
  }
  if (parsedIntent === 'await-activation') {
    required(values, ['--stage', '--round', '--artifact', '--role']);
    const round = Number(value(values, '--round'));
    if (!Number.isSafeInteger(round) || round < 1) operationInvalid('--round must be a positive integer');
    const role = value(values, '--role');
    if (role !== 'executor' && role !== 'reviewer') operationInvalid('--role must be executor or reviewer');
    input.event = { stage: value(values, '--stage'), round, artifact: value(values, '--artifact'), role };
  }
  if (parsedIntent === 'hook-start') {
    required(values, ['--native-agent', '--child-id', '--parent-id']);
    if (taskRef === 'auto') required(values, ['--client']);
    input.auto = taskRef === 'auto';
    input.client = value(values, '--client');
    input.event = {
      nativeAgent: value(values, '--native-agent'), childId: value(values, '--child-id'), parentId: value(values, '--parent-id'),
      spawnMode: value(values, '--spawn-mode'), actualModel: value(values, '--actual-model'),
      actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
      reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
    };
  }
  if (parsedIntent === 'hook-stop') {
    input.auto = taskRef === 'auto';
    if (input.auto) {
      required(values, ['--client', '--native-agent', '--child-id']);
      input.client = value(values, '--client');
      input.event = {
        nativeAgent: value(values, '--native-agent'), childId: value(values, '--child-id'), actualModel: value(values, '--actual-model'),
        actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
        reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
      };
    } else {
      required(values, ['--child-id', '--exit-code', '--after-fingerprint']);
      const exitCode = Number(value(values, '--exit-code'));
      if (!Number.isInteger(exitCode)) operationInvalid('--exit-code must be an integer');
      input.event = {
        childId: value(values, '--child-id'), exitCode, afterFingerprint: value(values, '--after-fingerprint'),
        changedPaths: value(values, '--changed-paths')?.split(',').filter(Boolean) ?? [], actualModel: value(values, '--actual-model'),
        actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
        reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
      };
    }
  }
  if (parsedIntent === 'pause') {
    required(values, ['--code', '--message', '--recoverable']);
    const recoverable = value(values, '--recoverable');
    if (recoverable !== 'true' && recoverable !== 'false') operationInvalid('--recoverable must be true or false');
    input.code = value(values, '--code'); input.message = value(values, '--message'); input.recoverable = recoverable === 'true';
  }
  return { family, taskRef, intent: parsedIntent, input };
}
