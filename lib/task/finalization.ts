import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { syncPlatformComment } from '../platform/issue-comments.ts';
import type { PlatformResult } from '../platform/types.ts';
import {
  applyTaskLifecycle,
  type TaskLifecycleOptions,
  type TaskLifecycleRequest,
  type TaskLifecycleResult
} from './lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { inspectShortIdRegistry } from './short-id.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { verifyTaskEvent } from './verification.ts';
import type { TaskVerificationResult } from './verification.ts';

const RECEIPT_VERSION = 1 as const;
const FINALIZATION_STEPS = ['lifecycle', 'task-comment', 'verification'] as const;
type FinalizationStep = typeof FINALIZATION_STEPS[number];
type FinalizationStepState = 'pending' | 'done' | 'skipped';
type FinalizationError = { code: string; message: string; retryable: boolean };

type TaskFinalizationRequest = Readonly<{
  taskRef: string;
  intent: 'complete';
  agent: string;
}>;

type TaskFinalizationOptions = Readonly<{
  repoRoot: string;
  metadataProvider?: TaskLifecycleOptions['metadataProvider'];
  lifecycle?: typeof applyTaskLifecycle;
  commentSync?: typeof syncPlatformComment;
  verify?: typeof verifyTaskEvent;
}>;

type TaskFinalizationReceipt = Readonly<{
  version: typeof RECEIPT_VERSION;
  taskId: string;
  intent: 'complete';
  lifecycle: FinalizationStepState;
  taskComment: FinalizationStepState;
  verification: FinalizationStepState;
  updatedAt: string;
  lastError: FinalizationError | null;
}>;

type TaskFinalizationStep = Readonly<{
  status: string;
  changed: boolean;
  error: FinalizationError | null;
  completedSteps?: readonly string[];
  pendingSteps?: readonly string[];
}>;

type TaskFinalizationResult = Readonly<{
  status: 'completed' | 'failed' | 'blocked';
  changed: boolean;
  taskId: string | null;
  lifecycle: TaskFinalizationStep | null;
  taskComment: TaskFinalizationStep | null;
  verification: TaskFinalizationStep | null;
  completedSteps: readonly FinalizationStep[];
  pendingSteps: readonly FinalizationStep[];
  error: FinalizationError | null;
}>;

function finalizationRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.task-finalization');
}

function receiptPath(repoRoot: string, taskId: string): string {
  return path.join(finalizationRoot(repoRoot), `${taskId}.json`);
}

function now(): string {
  return new Date().toISOString();
}

function errorOf(error: unknown, fallbackCode: string, retryable = false): FinalizationError {
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown } | null;
  const code = typeof value?.code === 'string' && value.code ? value.code : fallbackCode;
  const message = typeof value?.message === 'string' && value.message ? value.message : String(error);
  return { code, message, retryable: value?.retryable === true || retryable };
}

function failed(
  taskId: string | null,
  error: FinalizationError,
  overrides: Partial<TaskFinalizationResult> = {}
): TaskFinalizationResult {
  return {
    status: error.retryable ? 'blocked' : 'failed',
    changed: false,
    taskId,
    lifecycle: null,
    taskComment: null,
    verification: null,
    completedSteps: [],
    pendingSteps: [...FINALIZATION_STEPS],
    error,
    ...overrides
  };
}

function emptyReceipt(taskId: string): TaskFinalizationReceipt {
  return {
    version: RECEIPT_VERSION,
    taskId,
    intent: 'complete',
    lifecycle: 'pending',
    taskComment: 'pending',
    verification: 'pending',
    updatedAt: now(),
    lastError: null
  };
}

function validateReceipt(value: unknown, taskId: string): TaskFinalizationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt must be an object');
  const receipt = value as Record<string, unknown>;
  const states = ['pending', 'done', 'skipped'];
  if (
    receipt.version !== RECEIPT_VERSION || receipt.taskId !== taskId || receipt.intent !== 'complete'
    || !states.includes(String(receipt.lifecycle))
    || !states.includes(String(receipt.taskComment))
    || !states.includes(String(receipt.verification))
    || typeof receipt.updatedAt !== 'string'
    || (receipt.lastError !== null && (typeof receipt.lastError !== 'object' || Array.isArray(receipt.lastError)))
  ) throw new Error('receipt schema is invalid');
  return receipt as TaskFinalizationReceipt;
}

function readReceipt(repoRoot: string, taskId: string): TaskFinalizationReceipt | null {
  const file = receiptPath(repoRoot, taskId);
  if (!fs.existsSync(file)) return null;
  return validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, taskId);
}

function writeReceipt(repoRoot: string, receipt: TaskFinalizationReceipt): void {
  const directory = finalizationRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = receiptPath(repoRoot, receipt.taskId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the primary error */ }
    throw error;
  }
}

function updateReceipt(
  repoRoot: string,
  receipt: TaskFinalizationReceipt,
  patch: Partial<Pick<TaskFinalizationReceipt, 'lifecycle' | 'taskComment' | 'verification' | 'lastError'>>
): TaskFinalizationReceipt {
  const next = { ...receipt, ...patch, updatedAt: now() };
  writeReceipt(repoRoot, next);
  return next;
}

function completedSteps(receipt: TaskFinalizationReceipt): FinalizationStep[] {
  return FINALIZATION_STEPS.filter((step) => receipt[step === 'task-comment' ? 'taskComment' : step] !== 'pending');
}

function pendingSteps(receipt: TaskFinalizationReceipt): FinalizationStep[] {
  return FINALIZATION_STEPS.filter((step) => receipt[step === 'task-comment' ? 'taskComment' : step] === 'pending');
}

function lifecycleStep(result: TaskLifecycleResult): TaskFinalizationStep {
  return {
    status: result.status,
    changed: result.changed,
    error: result.error ? errorOf(result.error, 'LIFECYCLE_FAILED') : null,
    completedSteps: result.completedSteps ?? [],
    pendingSteps: result.pendingSteps ?? []
  };
}

function commentStep(result: PlatformResult): TaskFinalizationStep {
  return {
    status: result.status,
    changed: result.changed,
    error: result.error ? errorOf(result.error, 'COMMENT_SYNC_FAILED') : null
  };
}

function verificationStep(result: TaskVerificationResult): TaskFinalizationStep {
  return {
    status: result.status,
    changed: false,
    error: result.status === 'pass' ? null : verificationFailure(result)
  };
}

function verificationFailure(result: TaskVerificationResult): FinalizationError {
  if (result.error) return errorOf(result.error, 'VERIFY_FAILED', result.status === 'blocked');
  const invocation = [...result.invocations].reverse().find((item) => item.status !== 'pass');
  const payload = invocation?.payload;
  const details = [payload?.message, payload?.summary, payload?.action]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const code = result.status === 'blocked' || invocation?.status === 'blocked'
    ? 'CHECK_BLOCKED'
    : result.status === 'fail' ? 'CHECK_FAILED' : 'VERIFY_FAILED';
  return {
    code,
    message: details.length > 0 ? details.join(' - ') : `verification ${result.status}`,
    retryable: code === 'CHECK_BLOCKED'
  };
}

function terminalResult(
  taskId: string,
  receipt: TaskFinalizationReceipt,
  steps: Pick<TaskFinalizationResult, 'lifecycle' | 'taskComment' | 'verification'>,
  changed: boolean,
  error: FinalizationError | null = null
): TaskFinalizationResult {
  const pending = pendingSteps(receipt);
  const blocked = [steps.lifecycle, steps.taskComment, steps.verification].some((step) => step?.status === 'blocked');
  return {
    status: pending.length === 0 ? 'completed' : blocked ? 'blocked' : 'failed',
    changed,
    taskId,
    ...steps,
    completedSteps: completedSteps(receipt),
    pendingSteps: pending,
    error
  };
}

function applyUnderLock(
  request: TaskFinalizationRequest,
  taskId: string,
  options: TaskFinalizationOptions
): TaskFinalizationResult {
  const repoRoot = path.resolve(options.repoRoot);
  const lifecycle = options.lifecycle ?? applyTaskLifecycle;
  const commentSync = options.commentSync ?? syncPlatformComment;
  const verify = options.verify ?? verifyTaskEvent;
  let receipt: TaskFinalizationReceipt;
  try {
    receipt = readReceipt(repoRoot, taskId) ?? emptyReceipt(taskId);
    if (!fs.existsSync(receiptPath(repoRoot, taskId))) writeReceipt(repoRoot, receipt);
  } catch (error) {
    return failed(taskId, errorOf(error, 'TASK_FINALIZATION_RECEIPT_INVALID'));
  }

  let lifecycleResult: TaskFinalizationStep | null = null;
  let changed = false;
  try {
    const resolved = resolveTaskRef(taskId, { repoRoot });
    const registry = resolved.ok && resolved.state === 'completed' ? inspectShortIdRegistry(repoRoot) : null;
    if (registry && registry.status !== 'valid') {
      const detail: FinalizationError = {
        code: 'TASK_FINALIZATION_SHORT_ID_REGISTRY_UNAVAILABLE',
        message: `cannot verify canonical short-id registry: ${registry.error.code}: ${registry.error.message}`,
        retryable: false
      };
      receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: detail });
      return terminalResult(taskId, receipt, {
        lifecycle: { status: 'failed', changed: false, error: detail },
        taskComment: null,
        verification: null
      }, changed, detail);
    }
    const shortIds = registry?.status === 'valid' ? registry.shortIds : null;
    if (shortIds?.has(taskId)) {
      const detail: FinalizationError = {
        code: 'TASK_FINALIZATION_CANONICAL_STATE_INVALID',
        message: 'completed task still has an active short-id registry entry',
        retryable: false
      };
      receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: detail });
      return terminalResult(taskId, receipt, {
        lifecycle: { status: 'failed', changed: false, error: detail },
        taskComment: null,
        verification: null
      }, changed, detail);
    }
    const lifecycleDone = receipt.lifecycle === 'done' && resolved.ok && resolved.state === 'completed' && shortIds !== null;
    if (lifecycleDone) {
      lifecycleResult = { status: 'no-op', changed: false, error: null };
      receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'done', lastError: null });
    } else {
      const result = lifecycle(
        { taskRef: taskId, intent: 'complete', agent: request.agent },
        { repoRoot, ...(options.metadataProvider ? { metadataProvider: options.metadataProvider } : {}) }
      );
      lifecycleResult = lifecycleStep(result);
      if (result.status !== 'applied' && result.status !== 'no-op') {
        receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: lifecycleResult.error });
        return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment: null, verification: null }, result.changed, lifecycleResult.error);
      }
      changed = result.changed;
      receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'done', lastError: null });
    }
  } catch (error) {
    const detail = errorOf(error, 'TASK_FINALIZATION_LIFECYCLE_FAILED');
    try { receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: detail }); } catch { /* preserve the primary error */ }
    return failed(taskId, detail, { lifecycle: lifecycleResult });
  }

  let taskComment: TaskFinalizationStep | null = null;
  try {
    const result = commentSync(taskId, { kind: 'task', agent: request.agent, cwd: repoRoot });
    taskComment = commentStep(result);
    if (result.status === 'applied' || result.status === 'no-op') {
      const skipped = result.error?.code === 'ISSUE_NOT_LINKED';
      receipt = updateReceipt(repoRoot, receipt, { taskComment: skipped ? 'skipped' : 'done', lastError: null });
      taskComment = skipped ? { ...taskComment, status: 'skipped' } : taskComment;
      changed = changed || result.changed;
    } else {
      receipt = updateReceipt(repoRoot, receipt, { taskComment: 'pending', lastError: taskComment.error });
      return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification: null }, changed, taskComment.error);
    }
  } catch (error) {
    const detail = errorOf(error, 'COMMENT_SYNC_FAILED', true);
    try { receipt = updateReceipt(repoRoot, receipt, { taskComment: 'pending', lastError: detail }); } catch { /* preserve the primary error */ }
    return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment: { status: 'blocked', changed: false, error: detail }, verification: null }, changed, detail);
  }

  let verification: TaskFinalizationStep | null = null;
  try {
    const result = verify(
      { taskRef: taskId, event: 'complete-task.completed' },
      { repoRoot }
    );
    verification = verificationStep(result);
    if (result.status === 'pass') {
      receipt = updateReceipt(repoRoot, receipt, { verification: 'done', lastError: null });
    } else {
      receipt = updateReceipt(repoRoot, receipt, { verification: 'pending', lastError: verification.error });
      return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification }, changed, verification.error);
    }
  } catch (error) {
    const detail = errorOf(error, 'VERIFY_FAILED', true);
    try { receipt = updateReceipt(repoRoot, receipt, { verification: 'pending', lastError: detail }); } catch { /* preserve the primary error */ }
    return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification: { status: 'blocked', changed: false, error: detail } }, changed, detail);
  }
  return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification }, changed);
}

function applyTaskFinalization(request: TaskFinalizationRequest, options: TaskFinalizationOptions): TaskFinalizationResult {
  if (request.intent !== 'complete' || !request.taskRef || !request.agent) {
    return failed(null, { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message: 'complete finalization requires taskRef and agent', retryable: false });
  }
  const repoRoot = path.resolve(options.repoRoot);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot });
  if (!resolved.ok) return failed(resolved.taskId, { code: resolved.code, message: resolved.message, retryable: false });
  try {
    return withTaskExecutionLock(repoRoot, resolved.taskId, 'task-finalization.complete', () => applyUnderLock(request, resolved.taskId, options));
  } catch (error) {
    const detail = error instanceof TaskExecutionLockError
      ? { code: error.code, message: error.message, retryable: error.code === 'ORCHESTRATION_LOCK_BUSY' }
      : errorOf(error, 'TASK_FINALIZATION_FAILED');
    return failed(resolved.taskId, detail);
  }
}

export { applyTaskFinalization };
export type {
  FinalizationError,
  FinalizationStep,
  TaskFinalizationOptions,
  TaskFinalizationReceipt,
  TaskFinalizationRequest,
  TaskFinalizationResult,
  TaskFinalizationStep
};
