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
import { projectFinalizationWarning } from './workflow-warning-intents.ts';
import {
  mergeOperationWarnings,
  type OperationWarning,
  type OperationWarningSeverity
} from './operation-outcome.ts';

const RECEIPT_VERSION = 2 as const;
const FINALIZATION_STEPS = ['lifecycle', 'task-comment', 'verification'] as const;
type FinalizationStep = typeof FINALIZATION_STEPS[number];
type FinalizationStepState = 'pending' | 'done' | 'skipped';
type FinalizationError = { code: string; message: string; retryable: boolean };
type WarningProjectionState = 'pending' | 'done';
type FinalizationWarning = OperationWarning & Readonly<{
  status: 'open' | 'resolved';
  resolvedAt: string | null;
}>;
type FinalizationCapability = Readonly<{
  receiptId: string;
  baseRevision: number;
  scope: Exclude<FinalizationStep, 'lifecycle'> | 'warning-projection';
  nonce: string;
  issuedAt: string;
}>;
type FinalizationMutation =
  | Readonly<{ scope: 'task-comment'; operation: 'succeeded'; state: 'done' | 'skipped' }>
  | Readonly<{ scope: 'task-comment'; operation: 'failed'; error: FinalizationError }>
  | Readonly<{ scope: 'verification'; operation: 'succeeded' }>
  | Readonly<{ scope: 'verification'; operation: 'failed'; error: FinalizationError }>
  | Readonly<{ scope: 'warning-projection'; operation: 'succeeded' }>
  | Readonly<{ scope: 'warning-projection'; operation: 'failed'; error: FinalizationError }>;

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
  preflight?: typeof verifyTaskEvent;
}>;

type TaskFinalizationReceipt = Readonly<{
  version: typeof RECEIPT_VERSION;
  taskId: string;
  intent: 'complete';
  receiptId: string;
  revision: number;
  lifecycle: FinalizationStepState;
  taskComment: FinalizationStepState;
  verification: FinalizationStepState;
  warningProjection: WarningProjectionState;
  warnings: readonly FinalizationWarning[];
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
  result: 'completed' | 'completed_with_warnings' | 'failed' | 'blocked';
  warnings: readonly OperationWarning[];
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
    result: error.retryable ? 'blocked' : 'failed',
    warnings: [],
    error,
    ...overrides
  };
}

function emptyReceipt(taskId: string): TaskFinalizationReceipt {
  return {
    version: RECEIPT_VERSION,
    taskId,
    intent: 'complete',
    receiptId: randomUUID(),
    revision: 0,
    lifecycle: 'pending',
    taskComment: 'pending',
    verification: 'pending',
    warningProjection: 'done',
    warnings: [],
    updatedAt: now(),
    lastError: null
  };
}

function validWarning(value: unknown): value is FinalizationWarning {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const warning = value as Record<string, unknown>;
  if (Object.keys(warning).sort().join('\0') !== [
    'code', 'message', 'retryable', 'step', 'target', 'severity', 'status', 'resolvedAt'
  ].sort().join('\0')) return false;
  return typeof warning.code === 'string' && warning.code.length > 0
    && typeof warning.message === 'string' && warning.message.length > 0
    && typeof warning.retryable === 'boolean'
    && typeof warning.step === 'string' && warning.step.length > 0
    && typeof warning.target === 'string' && warning.target.length > 0
    && (warning.severity === 'IMPORTANT' || warning.severity === 'ACTION_REQUIRED')
    && (warning.status === 'open' || warning.status === 'resolved')
    && (warning.resolvedAt === null || typeof warning.resolvedAt === 'string');
}

function validateReceipt(value: unknown, taskId: string): TaskFinalizationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt must be an object');
  const receipt = value as Record<string, unknown>;
  const states = ['pending', 'done', 'skipped'];
  if (
    receipt.version !== RECEIPT_VERSION || receipt.taskId !== taskId || receipt.intent !== 'complete'
    || typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0
    || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 0
    || !states.includes(String(receipt.lifecycle))
    || !states.includes(String(receipt.taskComment))
    || !states.includes(String(receipt.verification))
    || !['pending', 'done'].includes(String(receipt.warningProjection))
    || !Array.isArray(receipt.warnings) || receipt.warnings.some((warning) => !validWarning(warning))
    || typeof receipt.updatedAt !== 'string'
    || (receipt.lastError !== null && (typeof receipt.lastError !== 'object' || Array.isArray(receipt.lastError)))
  ) throw new Error('receipt schema is invalid');
  return receipt as TaskFinalizationReceipt;
}

function readReceipt(repoRoot: string, taskId: string): TaskFinalizationReceipt | null {
  const file = receiptPath(repoRoot, taskId);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return validateReceipt(value, taskId);
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
  patch: Partial<Pick<TaskFinalizationReceipt, 'lifecycle' | 'taskComment' | 'verification' | 'warningProjection' | 'warnings' | 'lastError'>>
): TaskFinalizationReceipt {
  const current = readReceipt(repoRoot, receipt.taskId);
  if (!current || current.receiptId !== receipt.receiptId || current.revision !== receipt.revision) {
    const error = new Error('finalization receipt revision is stale');
    Object.assign(error, { code: 'FINALIZATION_CAPABILITY_STALE' });
    throw error;
  }
  const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now() };
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

function warningFromError(
  step: FinalizationStep,
  error: FinalizationError,
  severity: OperationWarningSeverity = 'ACTION_REQUIRED'
): OperationWarning {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    step,
    target: step,
    severity
  };
}

function openWarnings(receipt: TaskFinalizationReceipt): readonly OperationWarning[] {
  return mergeOperationWarnings(
    receipt.warnings.filter((warning) => warning.status === 'open').map(({ status: _status, resolvedAt: _resolvedAt, ...warning }) => warning)
  );
}

function warningRecord(warning: OperationWarning, status: FinalizationWarning['status']): FinalizationWarning {
  return { ...warning, status, resolvedAt: status === 'resolved' ? now() : null };
}

function replaceWarning(
  receipt: TaskFinalizationReceipt,
  warning: OperationWarning,
  status: FinalizationWarning['status']
): readonly FinalizationWarning[] {
  const next = warningRecord(warning, status);
  const key = `${warning.step}\0${warning.code}\0${warning.target}`;
  return [
    ...receipt.warnings.filter((item) => `${item.step}\0${item.code}\0${item.target}` !== key),
    next
  ];
}

function resolveStepWarnings(receipt: TaskFinalizationReceipt, step: FinalizationStep): readonly FinalizationWarning[] {
  return receipt.warnings.map((warning) => warning.step === step && warning.status === 'open'
    ? { ...warning, status: 'resolved', resolvedAt: now() }
    : warning);
}

function issueCapability(receipt: TaskFinalizationReceipt, scope: Exclude<FinalizationStep, 'lifecycle'> | 'warning-projection'): FinalizationCapability {
  return {
    receiptId: receipt.receiptId,
    baseRevision: receipt.revision,
    scope,
    nonce: randomUUID(),
    issuedAt: now()
  };
}

function capabilityError(code: 'FINALIZATION_CAPABILITY_STALE' | 'FINALIZATION_SCOPE_INVALID', message: string): Error {
  const error = new Error(message);
  error.name = 'OrchestrationStateError';
  Object.assign(error, { code });
  return error;
}

function mutationKeys(value: FinalizationMutation): string[] {
  return Object.keys(value).sort();
}

function validateCapabilityMutation(
  current: TaskFinalizationReceipt,
  capability: FinalizationCapability,
  mutation: FinalizationMutation,
  consumed: Set<string>
): void {
  if (capability.receiptId !== current.receiptId || capability.baseRevision !== current.revision || consumed.has(capability.nonce)) {
    throw capabilityError('FINALIZATION_CAPABILITY_STALE', 'finalization capability is stale or outside its scope');
  }
  if (capability.scope !== mutation.scope) {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability mutation scope does not match its capability');
  }
  if (mutation.operation !== 'succeeded' && mutation.operation !== 'failed') {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability operation is invalid');
  }
  if (mutation.scope === 'task-comment') {
    if (current.taskComment !== 'pending') throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability scope task-comment is not pending');
    const expected = mutation.operation === 'succeeded' ? ['operation', 'scope', 'state'] : ['error', 'operation', 'scope'];
    if (mutationKeys(mutation).join('\0') !== expected.join('\0')) throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability mutation shape is invalid');
    if (mutation.operation === 'succeeded' && mutation.state !== 'done' && mutation.state !== 'skipped') {
      throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability transition is invalid');
    }
  } else if (mutation.scope === 'verification') {
    if (current.verification !== 'pending') throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability scope verification is not pending');
    const expected = mutation.operation === 'succeeded' ? ['operation', 'scope'] : ['error', 'operation', 'scope'];
    if (mutationKeys(mutation).join('\0') !== expected.join('\0')) throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability mutation shape is invalid');
  } else {
    if (current.warningProjection !== 'pending') throw capabilityError('FINALIZATION_SCOPE_INVALID', 'warning projection capability is not pending');
    const expected = mutation.operation === 'succeeded' ? ['operation', 'scope'] : ['error', 'operation', 'scope'];
    if (mutationKeys(mutation).join('\0') !== expected.join('\0')) throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability mutation shape is invalid');
  }
  if (mutation.operation === 'failed' && (!mutation.error.code || !mutation.error.message || typeof mutation.error.retryable !== 'boolean')) {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability failure detail is invalid');
  }
}

function mutationPatch(current: TaskFinalizationReceipt, mutation: FinalizationMutation): Partial<Pick<TaskFinalizationReceipt, 'taskComment' | 'verification' | 'warningProjection' | 'warnings' | 'lastError'>> {
  if (mutation.scope === 'task-comment') {
    if (mutation.operation === 'succeeded') {
      const warnings = resolveStepWarnings(current, 'task-comment');
      return { taskComment: mutation.state, warningProjection: warnings.length > 0 ? 'pending' : 'done', warnings, lastError: null };
    }
    const warnings = replaceWarning(current, warningFromError('task-comment', mutation.error), 'open');
    return { taskComment: 'pending', warningProjection: 'pending', warnings, lastError: mutation.error };
  }
  if (mutation.scope === 'verification') {
    if (mutation.operation === 'succeeded') {
      const warnings = resolveStepWarnings(current, 'verification');
      return { verification: 'done', warningProjection: warnings.length > 0 ? 'pending' : 'done', warnings, lastError: null };
    }
    const warnings = replaceWarning(current, warningFromError('verification', mutation.error), 'open');
    return { verification: 'pending', warningProjection: 'pending', warnings, lastError: mutation.error };
  }
  return mutation.operation === 'succeeded'
    ? { warningProjection: 'done', lastError: null }
    : { warningProjection: 'pending', lastError: mutation.error };
}

function applyFinalizationReceiptMutationUnderLock(
  repoRoot: string,
  receipt: TaskFinalizationReceipt,
  capability: FinalizationCapability,
  mutation: FinalizationMutation,
  consumed: Set<string>
): TaskFinalizationReceipt {
  const resolved = resolveTaskRef(receipt.taskId, { repoRoot });
  if (!resolved.ok || resolved.state !== 'completed') {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability requires a completed task');
  }
  const current = readReceipt(repoRoot, receipt.taskId);
  if (!current || current.receiptId !== receipt.receiptId || current.revision !== receipt.revision) {
    throw capabilityError('FINALIZATION_CAPABILITY_STALE', 'finalization receipt revision is stale');
  }
  validateCapabilityMutation(current, capability, mutation, consumed);
  const next = updateReceipt(repoRoot, current, mutationPatch(current, mutation));
  consumed.add(capability.nonce);
  return next;
}

function applyFinalizationReceiptMutation(
  repoRoot: string,
  receipt: TaskFinalizationReceipt,
  capability: FinalizationCapability,
  mutation: FinalizationMutation
): TaskFinalizationReceipt {
  const resolved = resolveTaskRef(receipt.taskId, { repoRoot });
  if (!resolved.ok || resolved.state !== 'completed') {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability requires a completed task');
  }
  return withTaskExecutionLock(repoRoot, resolved.taskId, 'task-finalization.receipt-mutation', () =>
    applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, mutation, new Set<string>())
  );
}

function warningKey(warning: Pick<FinalizationWarning, 'step' | 'code' | 'target'>): string {
  return `${warning.step}\0${warning.code}\0${warning.target}`;
}

function reconcileWarningProjection(repoRoot: string, taskId: string, receipt: TaskFinalizationReceipt, consumed: Set<string>): TaskFinalizationReceipt {
  if (receipt.warningProjection === 'done') return receipt;
  const warnings = [...new Map(receipt.warnings.map((warning) => [warningKey(warning), warning])).values()];
  for (const warning of warnings) {
    try {
      const projected = projectFinalizationWarning(taskId, warning, { repoRoot });
      if (projected.status === 'failed') {
        const detail: FinalizationError = {
          code: projected.error?.code || 'FINALIZATION_WARNING_PROJECTION_FAILED',
          message: projected.error?.message || 'workflow warning projection failed',
          retryable: true
        };
        const capability = issueCapability(receipt, 'warning-projection');
        return applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, { scope: 'warning-projection', operation: 'failed', error: detail }, consumed);
      }
    } catch (error) {
      const detail = errorOf(error, 'FINALIZATION_WARNING_PROJECTION_FAILED', true);
      try {
        const capability = issueCapability(receipt, 'warning-projection');
        return applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, { scope: 'warning-projection', operation: 'failed', error: detail }, consumed);
      }
      catch { return receipt; }
    }
  }
  try {
    const capability = issueCapability(receipt, 'warning-projection');
    return applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, { scope: 'warning-projection', operation: 'succeeded' }, consumed);
  }
  catch { return receipt; }
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
  const warnings = openWarnings(receipt);
  const postLifecyclePending = receipt.lifecycle === 'done' && (pending.some((step) => step !== 'lifecycle') || receipt.warningProjection === 'pending');
  const hardError = error?.code.startsWith('FINALIZATION_') || error?.code === 'TASK_FINALIZATION_RECEIPT_INVALID';
  return {
    status: hardError ? (error?.retryable ? 'blocked' : 'failed') : pending.length === 0 ? 'completed' : postLifecyclePending ? 'completed' : blocked ? 'blocked' : 'failed',
    changed,
    taskId,
    ...steps,
    completedSteps: completedSteps(receipt),
    pendingSteps: pending,
    result: postLifecyclePending && (warnings.length > 0 || receipt.warningProjection === 'pending')
      ? 'completed_with_warnings'
      : hardError
        ? (error?.retryable ? 'blocked' : 'failed')
        : pending.length === 0 || postLifecyclePending
          ? 'completed'
          : blocked
            ? 'blocked'
            : 'failed',
    warnings,
    error: hardError ? error : postLifecyclePending ? null : error
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
  const consumedCapabilities = new Set<string>();
  let receipt: TaskFinalizationReceipt;
  try {
    const file = receiptPath(repoRoot, taskId);
    const existed = fs.existsSync(file);
    receipt = readReceipt(repoRoot, taskId) ?? emptyReceipt(taskId);
    if (!existed) writeReceipt(repoRoot, receipt);
  } catch (error) {
    return failed(taskId, errorOf(error, 'TASK_FINALIZATION_RECEIPT_INVALID'));
  }

  const preflightState = resolveTaskRef(taskId, { repoRoot });
  if (options.preflight && preflightState.ok && preflightState.state === 'active') {
    try {
      const preflight = options.preflight(
        { taskRef: taskId, event: 'complete-task.preflight' },
        { repoRoot }
      );
      if (preflight.status !== 'pass') {
        const detail = verificationFailure(preflight);
        return failed(taskId, detail, {
          lifecycle: null,
          taskComment: null,
          verification: null,
          completedSteps: completedSteps(receipt),
          pendingSteps: pendingSteps(receipt)
        });
      }
    } catch (error) {
      return failed(taskId, errorOf(error, 'TASK_FINALIZATION_PREFLIGHT_FAILED', true));
    }
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
    receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    if (receipt.taskComment !== 'pending') {
      taskComment = {
        status: receipt.taskComment === 'skipped' ? 'skipped' : 'no-op',
        changed: false,
        error: null
      };
    } else {
      const result = commentSync(taskId, { kind: 'task', agent: request.agent, cwd: repoRoot });
      taskComment = commentStep(result);
      if (result.status === 'applied' || result.status === 'no-op') {
        const skipped = result.error?.code === 'ISSUE_NOT_LINKED';
        const capability = issueCapability(receipt, 'task-comment');
        receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
          scope: 'task-comment', operation: 'succeeded', state: skipped ? 'skipped' : 'done'
        }, consumedCapabilities);
        receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
        taskComment = skipped ? { ...taskComment, status: 'skipped' } : taskComment;
        changed = changed || result.changed;
      } else {
        const detail = taskComment.error ?? { code: 'COMMENT_SYNC_FAILED', message: 'task comment synchronization failed', retryable: true };
        const capability = issueCapability(receipt, 'task-comment');
        receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
          scope: 'task-comment', operation: 'failed', error: detail
        }, consumedCapabilities);
        receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
        return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification: null }, changed, taskComment.error);
      }
    }
  } catch (error) {
    const detail = errorOf(error, 'COMMENT_SYNC_FAILED', true);
    try {
      const capability = issueCapability(receipt, 'task-comment');
      receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
        scope: 'task-comment', operation: 'failed', error: detail
      }, consumedCapabilities);
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    } catch { /* preserve the primary error */ }
    return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment: { status: 'blocked', changed: false, error: detail }, verification: null }, changed, detail);
  }

  let verification: TaskFinalizationStep | null = null;
  try {
    receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    if (receipt.verification !== 'pending') {
      verification = { status: 'no-op', changed: false, error: null };
    } else {
      const result = verify(
        { taskRef: taskId, event: 'complete-task.completed' },
        { repoRoot }
      );
      verification = verificationStep(result);
      if (result.status === 'pass') {
        const capability = issueCapability(receipt, 'verification');
        receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
          scope: 'verification', operation: 'succeeded'
        }, consumedCapabilities);
        receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      } else {
        const detail = verification.error ?? { code: 'VERIFY_FAILED', message: 'verification failed', retryable: true };
        const capability = issueCapability(receipt, 'verification');
        receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
          scope: 'verification', operation: 'failed', error: detail
        }, consumedCapabilities);
        receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
        return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification }, changed, verification.error);
      }
    }
  } catch (error) {
    const detail = errorOf(error, 'VERIFY_FAILED', true);
    try {
      const capability = issueCapability(receipt, 'verification');
      receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
        scope: 'verification', operation: 'failed', error: detail
      }, consumedCapabilities);
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    } catch { /* preserve the primary error */ }
    return terminalResult(taskId, receipt, { lifecycle: lifecycleResult, taskComment, verification: { status: 'blocked', changed: false, error: detail } }, changed, detail);
  }
  receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
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

export { applyFinalizationReceiptMutation, applyTaskFinalization, issueCapability as createFinalizationCapability };
export type {
  FinalizationError,
  FinalizationCapability,
  FinalizationMutation,
  FinalizationWarning,
  FinalizationStep,
  TaskFinalizationOptions,
  TaskFinalizationReceipt,
  TaskFinalizationRequest,
  TaskFinalizationResult,
  TaskFinalizationStep
};
