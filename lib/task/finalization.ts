import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { syncPlatformComment } from '../platform/issue-comments.ts';
import { canonicalizeSummaryBody } from '../platform/comment-safety.ts';
import { backfillCompletionComments, inspectCompletionBackfillEligibility } from '../platform/completion-backfill.ts';
import type { PlatformResult } from '../platform/types.ts';
import { taskIssueIdentity } from '../platform/task-identities.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
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

const RECEIPT_VERSION = 4 as const;
const FINALIZATION_STEPS = ['lifecycle', 'task-comment', 'verification', 'summary'] as const;
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
  controlBinding?: Readonly<{ generation: string; requestId: string }>;
  metadataProvider?: TaskLifecycleOptions['metadataProvider'];
  lifecycle?: typeof applyTaskLifecycle;
  backfill?: typeof backfillCompletionComments;
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
  summary: FinalizationStepState;
  warningProjection: WarningProjectionState;
  warnings: readonly FinalizationWarning[];
  controlBinding?: Readonly<{ generation: string; requestId: string }>;
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

type TaskCommentSyncOutcome = Readonly<{
  receipt: TaskFinalizationReceipt;
  step: TaskFinalizationStep;
  changed: boolean;
  error: FinalizationError | null;
}>;

type TaskFinalizationResult = Readonly<{
  status: 'prepared' | 'completed' | 'failed' | 'blocked';
  changed: boolean;
  taskId: string | null;
  backfill: TaskFinalizationStep | null;
  lifecycle: TaskFinalizationStep | null;
  taskComment: TaskFinalizationStep | null;
  verification: TaskFinalizationStep | null;
  summary: TaskFinalizationStep | null;
  completedSteps: readonly FinalizationStep[];
  pendingSteps: readonly FinalizationStep[];
  result: 'prepared' | 'completed' | 'completed_with_warnings' | 'failed' | 'blocked';
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
    backfill: null,
    lifecycle: null,
    taskComment: null,
    verification: null,
    summary: null,
    completedSteps: [],
    pendingSteps: [...FINALIZATION_STEPS],
    result: error.retryable ? 'blocked' : 'failed',
    warnings: [],
    error,
    ...overrides
  };
}

function emptyReceipt(taskId: string, controlBinding?: Readonly<{ generation: string; requestId: string }>): TaskFinalizationReceipt {
  return {
    version: RECEIPT_VERSION,
    taskId,
    intent: 'complete',
    receiptId: randomUUID(),
    revision: 0,
    lifecycle: 'pending',
    taskComment: 'pending',
    verification: 'pending',
    summary: 'pending',
    warningProjection: 'done',
    warnings: [],
    ...(controlBinding ? { controlBinding } : {}),
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
  const controlBinding = receipt.controlBinding as Record<string, unknown> | null | undefined;
  const states = ['pending', 'done', 'skipped'];
  if (
    receipt.version !== RECEIPT_VERSION || receipt.taskId !== taskId || receipt.intent !== 'complete'
    || typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0
    || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 0
    || !states.includes(String(receipt.lifecycle))
    || !states.includes(String(receipt.taskComment))
    || !states.includes(String(receipt.verification))
    || !states.includes(String(receipt.summary))
    || !['pending', 'done'].includes(String(receipt.warningProjection))
    || !Array.isArray(receipt.warnings) || receipt.warnings.some((warning) => !validWarning(warning))
    || typeof receipt.updatedAt !== 'string'
    || (receipt.lastError !== null && (typeof receipt.lastError !== 'object' || Array.isArray(receipt.lastError)))
    || (receipt.controlBinding !== undefined && (!controlBinding || typeof controlBinding !== 'object'
      || Array.isArray(controlBinding)
      || typeof controlBinding.generation !== 'string' || controlBinding.generation.length === 0
      || typeof controlBinding.requestId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(controlBinding.requestId)))
  ) throw new Error('receipt schema is invalid');
  return receipt as TaskFinalizationReceipt;
}

function readReceipt(repoRoot: string, taskId: string): TaskFinalizationReceipt | null {
  const file = receiptPath(repoRoot, taskId);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return validateReceipt(value, taskId);
}

function readTaskFinalizationReceipt(repoRoot: string, taskId: string): TaskFinalizationReceipt | null {
  return readReceipt(path.resolve(repoRoot), taskId);
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
  patch: Partial<Pick<TaskFinalizationReceipt, 'lifecycle' | 'taskComment' | 'verification' | 'summary' | 'warningProjection' | 'warnings' | 'controlBinding' | 'lastError'>>
): TaskFinalizationReceipt {
  const current = readReceipt(repoRoot, receipt.taskId);
  if (!current || current.receiptId !== receipt.receiptId) throw capabilityError(
    'FINALIZATION_SCOPE_INVALID',
    'finalization receipt does not belong to the current task'
  );
  const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now() };
  writeReceipt(repoRoot, next);
  return next;
}

function completedSteps(receipt: TaskFinalizationReceipt): FinalizationStep[] {
  return FINALIZATION_STEPS.filter((step) => stepState(receipt, step) !== 'pending');
}

function pendingSteps(receipt: TaskFinalizationReceipt): FinalizationStep[] {
  return FINALIZATION_STEPS.filter((step) => stepState(receipt, step) === 'pending');
}

function stepState(receipt: TaskFinalizationReceipt, step: FinalizationStep): FinalizationStepState {
  if (step === 'task-comment') return receipt.taskComment;
  return receipt[step];
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
  step: string,
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

function verificationWarnings(result: TaskVerificationResult): readonly OperationWarning[] {
  const warnings: OperationWarning[] = [];
  for (const invocation of result.invocations) {
    const checks = Array.isArray(invocation.payload.checks) ? invocation.payload.checks : [invocation.payload];
    for (const value of checks) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const check = value as Record<string, unknown>;
      const status = check.effectiveStatus ?? check.status;
      const target = typeof check.checkId === 'string' && check.checkId ? check.checkId : typeof check.type === 'string' ? check.type : null;
      if (!target || status === 'pass') continue;
      const blocked = status === 'blocked';
      const message = [check.reason, check.message, check.action]
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .join(' - ');
      warnings.push({
        step: 'verification', target, code: blocked ? 'CHECK_BLOCKED' : 'CHECK_FAILED',
        retryable: blocked, severity: 'ACTION_REQUIRED',
        message: message || `verification ${String(status)}`
      });
    }
  }
  return mergeOperationWarnings(warnings);
}

function applyVerificationWarnings(
  receipt: TaskFinalizationReceipt,
  result: TaskVerificationResult
): readonly FinalizationWarning[] {
  if (result.status === 'pass') return resolveStepWarnings(receipt, 'verification');
  const observed = new Map<string, 'pass' | OperationWarning>();
  for (const invocation of result.invocations) {
    const checks = Array.isArray(invocation.payload.checks) ? invocation.payload.checks : [invocation.payload];
    for (const value of checks) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const check = value as Record<string, unknown>;
      const target = typeof check.checkId === 'string' && check.checkId ? check.checkId : typeof check.type === 'string' ? check.type : null;
      if (!target) continue;
      const status = check.effectiveStatus ?? check.status;
      if (status === 'pass') observed.set(target, 'pass');
    }
  }
  for (const warning of verificationWarnings(result)) observed.set(warning.target, warning);
  if (observed.size === 0) {
    return replaceWarning(receipt, warningFromError('verification', verificationFailure(result)), 'open');
  }
  let warnings = [...receipt.warnings];
  for (const [target, current] of observed) {
    if (current === 'pass') {
      warnings = warnings.map((warning) => warning.step === 'verification' && warning.target === target && warning.status === 'open'
        ? { ...warning, status: 'resolved', resolvedAt: now() }
        : warning);
      continue;
    }
    warnings = warnings.map((warning) => warning.step === 'verification' && warning.target === target
      && warning.status === 'open' && warning.code !== current.code
      ? { ...warning, status: 'resolved', resolvedAt: now() }
      : warning);
    const key = warningKey(current);
    warnings = [...warnings.filter((warning) => warningKey(warning) !== key), warningRecord(current, 'open')];
  }
  return warnings;
}

function shouldRunBackfill(receipt: TaskFinalizationReceipt): boolean {
  return receipt.lifecycle !== 'done'
    || receipt.taskComment === 'pending'
    || receipt.verification === 'pending'
    || receipt.warnings.some((warning) => warning.step === 'backfill' && warning.status === 'open');
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

function hasPreparedTaskDocument(repoRoot: string, taskId: string): boolean {
  const resolved = resolveTaskRef(taskId, { repoRoot });
  if (!resolved.ok) return false;
  if (resolved.state === 'completed') return true;
  if (resolved.state !== 'active') return false;
  try { return parseTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8')).status === 'completed'; }
  catch { return false; }
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
  if (capability.receiptId !== current.receiptId) throw capabilityError(
    'FINALIZATION_SCOPE_INVALID',
    'finalization mutation belongs to a different task receipt'
  );
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
      const resolvedTaskWarning = current.warnings.some((warning) => warning.step === 'verification' && warning.status === 'open');
      const warnings = resolveStepWarnings(current, 'verification');
      return {
        verification: 'done',
        taskComment: resolvedTaskWarning ? 'pending' : current.taskComment,
        warningProjection: warnings.length > 0 ? 'pending' : 'done',
        warnings,
        lastError: null
      };
    }
    const warnings = replaceWarning(current, warningFromError('verification', mutation.error), 'open');
    return { verification: 'pending', taskComment: 'pending', warningProjection: 'pending', warnings, lastError: mutation.error };
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
  if (!hasPreparedTaskDocument(repoRoot, receipt.taskId)) {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability requires an active prepared task or a completed task');
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
  if (!hasPreparedTaskDocument(repoRoot, receipt.taskId)) {
    throw capabilityError('FINALIZATION_SCOPE_INVALID', 'finalization capability requires an active prepared task or a completed task');
  }
  return withTaskExecutionLock(repoRoot, receipt.taskId, 'task-finalization.receipt-mutation', () =>
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
      const superseded = warning.status === 'resolved' && receipt.warnings.some((item) =>
        item.status === 'open' && item.step === warning.step && item.target === warning.target && item.code !== warning.code
      );
      const projected = projectFinalizationWarning(taskId, warning, { repoRoot, resolution: superseded ? 'superseded' : 'passed' });
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

async function syncPendingTaskComment(input: {
  repoRoot: string;
  taskId: string;
  agent: string;
  receipt: TaskFinalizationReceipt;
  commentSync: typeof syncPlatformComment;
  consumedCapabilities: Set<string>;
}): Promise<TaskCommentSyncOutcome> {
  const { repoRoot, taskId, agent, commentSync, consumedCapabilities } = input;
  let receipt = input.receipt;
  if (receipt.taskComment !== 'pending') {
    return {
      receipt,
      step: { status: receipt.taskComment === 'skipped' ? 'skipped' : 'no-op', changed: false, error: null },
      changed: false,
      error: null
    };
  }
  try {
    const result = await commentSync(taskId, { kind: 'task', agent, cwd: repoRoot });
    const step = commentStep(result);
    if (result.status === 'applied' || result.status === 'no-op') {
      const skipped = result.error?.code === 'ISSUE_NOT_LINKED';
      const capability = issueCapability(receipt, 'task-comment');
      receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
        scope: 'task-comment', operation: 'succeeded', state: skipped ? 'skipped' : 'done'
      }, consumedCapabilities);
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      return { receipt, step: skipped ? { ...step, status: 'skipped' } : step, changed: result.changed, error: null };
    }
    const detail = step.error ?? { code: 'COMMENT_SYNC_FAILED', message: 'task comment synchronization failed', retryable: true };
    const capability = issueCapability(receipt, 'task-comment');
    receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
      scope: 'task-comment', operation: 'failed', error: detail
    }, consumedCapabilities);
    receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    return { receipt, step, changed: result.changed, error: detail };
  } catch (error) {
    const detail = errorOf(error, 'COMMENT_SYNC_FAILED', true);
    try {
      const capability = issueCapability(receipt, 'task-comment');
      receipt = applyFinalizationReceiptMutationUnderLock(repoRoot, receipt, capability, {
        scope: 'task-comment', operation: 'failed', error: detail
      }, consumedCapabilities);
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    } catch { /* preserve the primary error */ }
    return { receipt, step: { status: 'blocked', changed: false, error: detail }, changed: false, error: detail };
  }
}

function readDeliverySummary(taskDir: string, taskId: string): { body: string; sha256: string } {
  const file = path.join(taskDir, '.delivery-summary.json');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('delivery summary staging record is unavailable'), { code: 'SUMMARY_STAGING_INVALID' });
  }
  if (value.taskId !== taskId || typeof value.body !== 'string' || typeof value.sha256 !== 'string') {
    throw Object.assign(new Error('delivery summary staging record is invalid'), { code: 'SUMMARY_STAGING_INVALID' });
  }
  const canonical = canonicalizeSummaryBody(value.body);
  if (!canonical.ok || canonical.value !== value.body) {
    throw Object.assign(new Error('delivery summary staging body is not canonical'), { code: 'SUMMARY_STAGING_INVALID' });
  }
  const digest = createHash('sha256').update(canonical.value).digest('hex');
  if (digest !== value.sha256) throw Object.assign(new Error('delivery summary staging digest does not match body'), { code: 'SUMMARY_STAGING_INVALID' });
  return { body: canonical.value, sha256: value.sha256 };
}

async function syncPendingSummary(input: {
  repoRoot: string;
  taskId: string;
  agent: string;
  receipt: TaskFinalizationReceipt;
  commentSync: typeof syncPlatformComment;
}): Promise<{ receipt: TaskFinalizationReceipt; step: TaskFinalizationStep; changed: boolean; error: FinalizationError | null }> {
  let { receipt } = input;
  try {
    const resolved = resolveTaskRef(input.taskId, { repoRoot: input.repoRoot });
    if (!resolved.ok || !hasPreparedTaskDocument(input.repoRoot, input.taskId)) throw Object.assign(new Error('prepared task is unavailable for summary sync'), { code: 'SUMMARY_STAGING_INVALID' });
    if (!fs.existsSync(path.join(resolved.taskDir, '.delivery-summary.json'))) {
      receipt = updateReceipt(input.repoRoot, receipt, { summary: 'skipped', lastError: null });
      return { receipt, step: { status: 'skipped', changed: false, error: null }, changed: false, error: null };
    }
    if (!taskIssueIdentity(parseTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8')))) {
      receipt = updateReceipt(input.repoRoot, receipt, {
        summary: 'skipped', lastError: null
      });
      return { receipt, step: { status: 'skipped', changed: false, error: null }, changed: false, error: null };
    }
    const summary = readDeliverySummary(resolved.taskDir, input.taskId);
    const result = await input.commentSync(input.taskId, {
      kind: 'summary', agent: input.agent, body: summary.body, cwd: input.repoRoot,
      summaryAuthorization: { sha256: summary.sha256 }
    });
    const step = commentStep(result);
    if (result.status === 'applied' || result.status === 'no-op') {
      const skipped = result.error?.code === 'ISSUE_NOT_LINKED';
      const resolvedWarning = receipt.warnings.some((warning) => warning.step === 'summary' && warning.status === 'open');
      const warnings = resolveStepWarnings(receipt, 'summary');
      receipt = updateReceipt(input.repoRoot, receipt, {
        summary: skipped ? 'skipped' : 'done',
        taskComment: resolvedWarning ? 'pending' : receipt.taskComment,
        warningProjection: warnings.some((warning) => warning.status === 'open') ? 'pending' : 'done',
        warnings,
        lastError: null
      });
      return { receipt, step: skipped ? { ...step, status: 'skipped' } : step, changed: result.changed, error: null };
    }
    const error = step.error ?? { code: 'SUMMARY_SYNC_FAILED', message: 'delivery summary synchronization failed', retryable: true };
    const warning = warningFromError('summary', error);
    const alreadyOpen = receipt.warnings.some((item) => item.step === warning.step && item.code === warning.code && item.target === warning.target && item.status === 'open');
    const warnings = replaceWarning(receipt, warning, 'open');
    receipt = updateReceipt(input.repoRoot, receipt, { summary: 'pending', taskComment: alreadyOpen ? receipt.taskComment : 'pending', warningProjection: 'pending', warnings, lastError: error });
    return { receipt, step, changed: result.changed, error };
  } catch (cause) {
    const error = errorOf(cause, 'SUMMARY_SYNC_FAILED', true);
    try {
      const warning = warningFromError('summary', error);
      const alreadyOpen = receipt.warnings.some((item) => item.step === warning.step && item.code === warning.code && item.target === warning.target && item.status === 'open');
      const warnings = replaceWarning(receipt, warning, 'open');
      receipt = updateReceipt(input.repoRoot, receipt, { summary: 'pending', taskComment: alreadyOpen ? receipt.taskComment : 'pending', warningProjection: 'pending', warnings, lastError: error });
    } catch { /* preserve primary error */ }
    return { receipt, step: { status: 'blocked', changed: false, error }, changed: false, error };
  }
}

function terminalResult(
  taskId: string,
  receipt: TaskFinalizationReceipt,
  steps: Partial<Pick<TaskFinalizationResult, 'backfill' | 'lifecycle' | 'taskComment' | 'verification' | 'summary'>>,
  changed: boolean,
  error: FinalizationError | null = null
): TaskFinalizationResult {
  const pending = pendingSteps(receipt);
  const blocked = [steps.backfill, steps.lifecycle, steps.taskComment, steps.verification, steps.summary].some((step) => step?.status === 'blocked');
  const warnings = openWarnings(receipt);
  const postLifecyclePending = receipt.lifecycle === 'done' && (pending.some((step) => step !== 'lifecycle') || receipt.warningProjection === 'pending');
  const hardError = error?.code.startsWith('FINALIZATION_') || error?.code === 'TASK_FINALIZATION_RECEIPT_INVALID';
  return {
    status: hardError ? (error?.retryable ? 'blocked' : 'failed') : pending.length === 0 ? 'completed' : postLifecyclePending ? 'completed' : blocked ? 'blocked' : 'failed',
    changed,
    taskId,
    backfill: steps.backfill ?? null,
    lifecycle: steps.lifecycle ?? null,
    taskComment: steps.taskComment ?? null,
    verification: steps.verification ?? null,
    summary: steps.summary ?? null,
    completedSteps: completedSteps(receipt),
    pendingSteps: pending,
    result: hardError
      ? (error?.retryable ? 'blocked' : 'failed')
      : postLifecyclePending
        ? 'completed_with_warnings'
        : pending.length === 0
          ? 'completed'
          : blocked
            ? 'blocked'
            : 'failed',
    warnings,
    error: hardError ? error : postLifecyclePending ? null : error
  };
}

function preparedResult(
  taskId: string,
  receipt: TaskFinalizationReceipt,
  steps: Partial<Pick<TaskFinalizationResult, 'backfill' | 'lifecycle' | 'taskComment' | 'verification' | 'summary'>>,
  changed: boolean
): TaskFinalizationResult {
  return {
    status: 'prepared', changed, taskId,
    backfill: steps.backfill ?? null,
    lifecycle: steps.lifecycle ?? null,
    taskComment: steps.taskComment ?? null,
    verification: steps.verification ?? null,
    summary: steps.summary ?? null,
    completedSteps: completedSteps(receipt), pendingSteps: pendingSteps(receipt),
    result: 'prepared', warnings: openWarnings(receipt), error: null
  };
}

async function prepareUnderLock(
  request: TaskFinalizationRequest,
  taskId: string,
  options: TaskFinalizationOptions
): Promise<TaskFinalizationResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const lifecycle = options.lifecycle ?? applyTaskLifecycle;
  const backfill = options.backfill ?? backfillCompletionComments;
  const commentSync = options.commentSync ?? syncPlatformComment;
  const verify = options.verify ?? verifyTaskEvent;
  const consumedCapabilities = new Set<string>();
  let receipt: TaskFinalizationReceipt;
  try {
    const file = receiptPath(repoRoot, taskId);
    const existed = fs.existsSync(file);
    receipt = readReceipt(repoRoot, taskId) ?? emptyReceipt(taskId, options.controlBinding);
    if (!existed) writeReceipt(repoRoot, receipt);
  } catch (error) {
    return failed(taskId, errorOf(error, 'TASK_FINALIZATION_RECEIPT_INVALID'));
  }
  if (options.controlBinding && (
    receipt.controlBinding?.generation !== options.controlBinding.generation
    || receipt.controlBinding.requestId !== options.controlBinding.requestId
  )) receipt = updateReceipt(repoRoot, receipt, { controlBinding: options.controlBinding });

  const preflightState = resolveTaskRef(taskId, { repoRoot });
  if (options.preflight && preflightState.ok && preflightState.state === 'active') {
    try {
      const preflight = await options.preflight(
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

  let changed = false;
  let backfillResult: TaskFinalizationStep | null = null;
  let runBackfill = shouldRunBackfill(receipt);
  if (!runBackfill && receipt.lifecycle === 'done') {
    const eligibility = inspectCompletionBackfillEligibility(taskId, { cwd: repoRoot });
    if (eligibility.status === 'failed') return failed(taskId, eligibility.error!, {
      completedSteps: completedSteps(receipt), pendingSteps: pendingSteps(receipt), warnings: openWarnings(receipt)
    });
    runBackfill = eligibility.eligible;
  }
  if (receipt.lifecycle === 'done' && runBackfill && receipt.summary === 'done') {
    receipt = updateReceipt(repoRoot, receipt, { summary: 'pending' });
  }
  if (runBackfill) try {
    const result = await backfill(taskId, { agent: request.agent, cwd: repoRoot });
    backfillResult = commentStep(result);
    const issueNotLinked = result.status === 'no-op' && result.error?.code === 'ISSUE_NOT_LINKED';
    if (!issueNotLinked && (result.status !== 'applied' && result.status !== 'no-op' || result.error)) {
      const detail = backfillResult.error ?? {
        code: 'COMPLETION_BACKFILL_FAILED', message: 'completion artifact backfill did not reach a successful terminal result', retryable: true
      };
      if (receipt.lifecycle !== 'done') return failed(taskId, detail, {
        backfill: backfillResult,
        completedSteps: completedSteps(receipt),
        pendingSteps: pendingSteps(receipt)
      });
      const warnings = replaceWarning(receipt, warningFromError('backfill', detail), 'open');
      receipt = updateReceipt(repoRoot, receipt, { warningProjection: 'pending', warnings, lastError: detail });
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      if (!detail.retryable) return failed(taskId, detail, {
        changed, backfill: backfillResult, completedSteps: completedSteps(receipt),
        pendingSteps: pendingSteps(receipt), warnings: openWarnings(receipt)
      });
      return terminalResult(taskId, receipt, { backfill: backfillResult }, changed, detail);
    }
    changed = result.changed;
    if (receipt.warnings.some((warning) => warning.step === 'backfill' && warning.status === 'open')) {
      const warnings = receipt.warnings.map((warning) => warning.step === 'backfill' && warning.status === 'open'
        ? { ...warning, status: 'resolved' as const, resolvedAt: now() }
        : warning);
      receipt = updateReceipt(repoRoot, receipt, { warningProjection: 'pending', warnings, lastError: null });
    }
    if (result.changed && receipt.taskComment !== 'pending') {
      receipt = updateReceipt(repoRoot, receipt, { taskComment: 'pending' });
    }
  } catch (error) {
    const detail = errorOf(error, 'COMPLETION_BACKFILL_FAILED', true);
    if (receipt.lifecycle === 'done') {
      const warnings = replaceWarning(receipt, warningFromError('backfill', detail), 'open');
      receipt = updateReceipt(repoRoot, receipt, { warningProjection: 'pending', warnings, lastError: detail });
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      return terminalResult(taskId, receipt, {
        backfill: { status: 'blocked', changed: false, error: detail }
      }, changed, detail);
    }
    return failed(taskId, detail, {
      backfill: { status: detail.retryable ? 'blocked' : 'failed', changed: false, error: detail },
      completedSteps: completedSteps(receipt),
      pendingSteps: pendingSteps(receipt)
    });
  } else backfillResult = { status: 'no-op', changed: false, error: null };

  let lifecycleResult: TaskFinalizationStep | null = null;
  try {
    const resolved = resolveTaskRef(taskId, { repoRoot });
    if (receipt.lifecycle === 'done' && resolved.ok && resolved.state === 'completed') {
      lifecycleResult = { status: 'no-op', changed: false, error: null };
      receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'done', lastError: null });
    } else {
      const result = lifecycle(
        { taskRef: taskId, intent: 'complete', agent: request.agent },
        { repoRoot, prepareOnly: true, ...(options.metadataProvider ? { metadataProvider: options.metadataProvider } : {}) }
      );
      lifecycleResult = lifecycleStep(result);
      if (result.status !== 'applied' && result.status !== 'no-op') {
        receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: lifecycleResult.error });
        return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment: null, verification: null }, result.changed, lifecycleResult.error);
      }
      changed = changed || result.changed;
    }
  } catch (error) {
    const detail = errorOf(error, 'TASK_FINALIZATION_LIFECYCLE_FAILED');
    try { receipt = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: detail }); } catch { /* preserve the primary error */ }
    return failed(taskId, detail, { backfill: backfillResult, lifecycle: lifecycleResult });
  }

  let taskComment: TaskFinalizationStep | null = null;
  receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);

  let verification: TaskFinalizationStep | null = null;
  if (receipt.verification !== 'pending') {
    verification = { status: receipt.verification === 'skipped' ? 'skipped' : 'no-op', changed: false, error: null };
  } else {
    try {
    receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    const result = await verify(
      { taskRef: taskId, event: 'complete-task.prepared' },
      { repoRoot }
    );
    verification = verificationStep(result);
    if (result.status === 'pass') {
      const resolvedTaskWarning = receipt.warnings.some((warning) => warning.step === 'verification' && warning.status === 'open');
      const warnings = applyVerificationWarnings(receipt, result);
      receipt = updateReceipt(repoRoot, receipt, {
        verification: 'done', taskComment: resolvedTaskWarning ? 'pending' : receipt.taskComment,
        warningProjection: warnings.length > 0 ? 'pending' : 'done', warnings, lastError: null
      });
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      const finalComment = await syncPendingTaskComment({
        repoRoot, taskId, agent: request.agent, receipt, commentSync, consumedCapabilities
      });
      receipt = finalComment.receipt;
      if (finalComment.step.status !== 'no-op') taskComment = finalComment.step;
      changed = changed || finalComment.changed;
      if (finalComment.error) {
        return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification }, changed, finalComment.error);
      }
    } else {
      const detail = verification.error ?? { code: 'VERIFY_FAILED', message: 'verification failed', retryable: true };
      const warnings = applyVerificationWarnings(receipt, result);
      receipt = updateReceipt(repoRoot, receipt, {
        verification: 'pending', taskComment: 'pending', warningProjection: 'pending', warnings, lastError: detail
      });
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
      const warningComment = await syncPendingTaskComment({
        repoRoot, taskId, agent: request.agent, receipt, commentSync, consumedCapabilities
      });
      receipt = warningComment.receipt;
      taskComment = warningComment.step;
      changed = changed || warningComment.changed;
      if (warningComment.error) {
        return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification }, changed, warningComment.error);
      }
      return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification }, changed, detail);
    }
  } catch (error) {
    const detail = errorOf(error, 'VERIFY_FAILED', true);
    try {
      const warnings = replaceWarning(receipt, warningFromError('verification', detail), 'open');
      receipt = updateReceipt(repoRoot, receipt, {
        verification: 'pending', taskComment: 'pending', warningProjection: 'pending', warnings, lastError: detail
      });
      receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    } catch (writeError) {
      const persistence = errorOf(writeError, 'FINALIZATION_RECEIPT_WRITE_FAILED', true);
      const hardError: FinalizationError = {
        code: 'FINALIZATION_RECEIPT_WRITE_FAILED',
        message: `Unable to persist verification failure (${detail.code}: ${detail.message}): ${persistence.message}`,
        retryable: true
      };
      return terminalResult(taskId, receipt, {
        backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification: { status: 'blocked', changed: false, error: detail }
      }, changed, hardError);
    }
    try {
      const warningComment = await syncPendingTaskComment({ repoRoot, taskId, agent: request.agent, receipt, commentSync, consumedCapabilities });
      receipt = warningComment.receipt;
      if (warningComment.step.status !== 'no-op') taskComment = warningComment.step;
      changed = changed || warningComment.changed;
    } catch { /* preserve the primary error */ }
    return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification: { status: 'blocked', changed: false, error: detail } }, changed, detail);
    }
  }

  let summary = receipt.summary === 'pending'
    ? await syncPendingSummary({ repoRoot, taskId, agent: request.agent, receipt, commentSync })
    : { receipt, step: { status: 'no-op', changed: false, error: null }, changed: false, error: null };
  receipt = summary.receipt;
  changed = changed || summary.changed;
  if (summary.error) {
    receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
    return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification, summary: summary.step }, changed, summary.error);
  }
  receipt = reconcileWarningProjection(repoRoot, taskId, receipt, consumedCapabilities);
  if (receipt.taskComment === 'pending') {
    const finalComment = await syncPendingTaskComment({
      repoRoot, taskId, agent: request.agent, receipt, commentSync, consumedCapabilities
    });
    receipt = finalComment.receipt;
    taskComment = finalComment.step;
    changed = changed || finalComment.changed;
    if (finalComment.error) {
      return terminalResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification, summary: summary.step }, changed, finalComment.error);
    }
  }
  return preparedResult(taskId, receipt, { backfill: backfillResult, lifecycle: lifecycleResult, taskComment, verification, summary: summary.step }, changed);
}

async function prepareTaskFinalization(request: TaskFinalizationRequest, options: TaskFinalizationOptions): Promise<TaskFinalizationResult> {
  if (request.intent !== 'complete' || !request.taskRef || !request.agent) {
    return failed(null, { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message: 'complete finalization requires taskRef and agent', retryable: false });
  }
  const repoRoot = path.resolve(options.repoRoot);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot });
  if (!resolved.ok) return failed(resolved.taskId, { code: resolved.code, message: resolved.message, retryable: false });
  try {
    return await withTaskExecutionLock(repoRoot, resolved.taskId, 'task-finalization.prepare', () => prepareUnderLock(request, resolved.taskId, options));
  } catch (error) {
    const detail = error instanceof TaskExecutionLockError
      ? { code: error.code, message: error.message, retryable: error.code === 'ORCHESTRATION_LOCK_BUSY' }
      : errorOf(error, 'TASK_FINALIZATION_FAILED');
    return failed(resolved.taskId, detail);
  }
}

async function commitPreparedTaskFinalization(request: TaskFinalizationRequest, options: TaskFinalizationOptions): Promise<TaskFinalizationResult> {
  if (request.intent !== 'complete' || !request.taskRef || !request.agent) {
    return failed(null, { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message: 'complete finalization requires taskRef and agent', retryable: false });
  }
  const repoRoot = path.resolve(options.repoRoot);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot });
  if (!resolved.ok) return failed(resolved.taskId, { code: resolved.code, message: resolved.message, retryable: false });
  try {
    return await withTaskExecutionLock(repoRoot, resolved.taskId, 'task-finalization.commit', () => {
      const receipt = readReceipt(repoRoot, resolved.taskId);
      if (!receipt) return failed(resolved.taskId, {
        code: 'TASK_FINALIZATION_PREPARATION_REQUIRED', message: 'sandbox preparation receipt is unavailable', retryable: true
      });
      if (receipt.lifecycle === 'done' && resolved.state === 'completed') {
        return terminalResult(resolved.taskId, receipt, { lifecycle: { status: 'no-op', changed: false, error: null } }, false);
      }
      if (receipt.taskComment === 'pending' || receipt.verification === 'pending' || receipt.summary === 'pending' || receipt.warningProjection === 'pending') {
        return failed(resolved.taskId, {
          code: 'TASK_FINALIZATION_PREPARATION_REQUIRED', message: 'sandbox preparation has pending external steps', retryable: true
        }, { completedSteps: completedSteps(receipt), pendingSteps: pendingSteps(receipt), warnings: openWarnings(receipt) });
      }
      const registry = inspectShortIdRegistry(repoRoot);
      if (registry.status !== 'valid') return failed(resolved.taskId, {
        code: 'TASK_FINALIZATION_SHORT_ID_REGISTRY_UNAVAILABLE',
        message: `cannot verify canonical short-id registry: ${registry.error.code}: ${registry.error.message}`,
        retryable: false
      });
      const lifecycle = options.lifecycle ?? applyTaskLifecycle;
      const result = lifecycle(
        { taskRef: resolved.taskId, intent: 'complete', agent: request.agent },
        { repoRoot, ...(options.metadataProvider ? { metadataProvider: options.metadataProvider } : {}) }
      );
      const step = lifecycleStep(result);
      if (result.status !== 'applied' && result.status !== 'no-op') {
        const updated = updateReceipt(repoRoot, receipt, { lifecycle: 'pending', lastError: step.error });
        return terminalResult(resolved.taskId, updated, { lifecycle: step }, result.changed, step.error);
      }
      const updated = updateReceipt(repoRoot, receipt, { lifecycle: 'done', lastError: null });
      return terminalResult(resolved.taskId, updated, { lifecycle: step }, result.changed);
    });
  } catch (error) {
    const detail = error instanceof TaskExecutionLockError
      ? { code: error.code, message: error.message, retryable: error.code === 'ORCHESTRATION_LOCK_BUSY' }
      : errorOf(error, 'TASK_FINALIZATION_FAILED');
    return failed(resolved.taskId, detail);
  }
}

async function applyTaskFinalization(request: TaskFinalizationRequest, options: TaskFinalizationOptions): Promise<TaskFinalizationResult> {
  const prepared = await prepareTaskFinalization(request, options);
  if (prepared.status !== 'prepared') return prepared;
  return commitPreparedTaskFinalization(request, options);
}

export {
  applyFinalizationReceiptMutation,
  commitPreparedTaskFinalization,
  applyTaskFinalization,
  prepareTaskFinalization,
  issueCapability as createFinalizationCapability,
  readTaskFinalizationReceipt,
  terminalResult
};
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
