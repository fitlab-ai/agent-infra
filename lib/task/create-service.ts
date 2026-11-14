import { syncPlatformComment } from '../platform/issue-comments.ts';
import { createPlatformIssue, syncPlatformIssue } from '../platform/issues.ts';
import type { PlatformResult } from '../platform/types.ts';
import { VERSION } from '../version.ts';
import { applyWorkflowWarningIntent } from './workflow-warning-intents.ts';
import { createLocalTask, type TaskCreateCandidateV1 } from './create.ts';
import { verifyTaskEvent } from './verification.ts';

type TaskCreateStatus = 'applied' | 'no-op' | 'degraded' | 'failed' | 'blocked';
type TaskCreateOperation = { name: string; status: string; reasonCode: string | null };
type TaskCreateWarning = { code: string; severity: string; action: string };
type TaskCreateRecovery = 'none' | 'same-request-id' | 'new-request-id' | 'inspect-domain-state';
type TaskCreateControl = Readonly<{
  requestId: string | null;
  accepted: boolean;
  recovery: TaskCreateRecovery;
}>;
type TaskCreateError = { code: string; message: string; retryable: boolean };
type TaskCreateResult = Readonly<{
  status: TaskCreateStatus;
  changed: boolean;
  task: { id: string | null; shortId: string | null; state: 'active' | 'blocked' | 'completed' | 'archive' | null };
  issue: { number: number; url: string } | null;
  operations: readonly TaskCreateOperation[];
  warnings: readonly TaskCreateWarning[];
  error: TaskCreateError | null;
  control?: TaskCreateControl;
}>;

type CreateTaskOptions = Readonly<{
  repoRoot: string;
  agentInfraVersion?: string;
  dependencies?: Partial<TaskCreateDependencies>;
}>;

type TaskCreatePlatformSummary = Readonly<{
  issue: TaskCreateResult['issue'];
  operations: readonly TaskCreateOperation[];
  failure: PlatformResult | null;
}>;

type TaskCreateDependencies = Readonly<{
  createIssue: typeof createPlatformIssue;
  syncIssue: typeof syncPlatformIssue;
  syncComment: typeof syncPlatformComment;
  addWarning: typeof applyWorkflowWarningIntent;
}>;

const DEFAULT_DEPENDENCIES: TaskCreateDependencies = {
  createIssue: createPlatformIssue,
  syncIssue: syncPlatformIssue,
  syncComment: syncPlatformComment,
  addWarning: applyWorkflowWarningIntent
};

function invalidTaskCreateResult(): never {
  throw new Error('TASK_CREATE_RESULT_INVALID');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validTaskReference(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function validTaskCreateError(value: unknown): value is TaskCreateError {
  if (!isRecord(value)) return false;
  const error = value;
  return exactKeys(error, ['code', 'message', 'retryable'])
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(error.code)
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function validTaskCreateControl(value: unknown): value is TaskCreateControl {
  if (!isRecord(value)) return false;
  const control = value;
  return exactKeys(control, ['accepted', 'recovery', 'requestId'])
    && validTaskReference(control.requestId)
    && typeof control.accepted === 'boolean'
    && ['none', 'same-request-id', 'new-request-id', 'inspect-domain-state'].includes(control.recovery as string);
}

function validTaskCreateStatus(value: unknown): value is TaskCreateStatus {
  return ['applied', 'no-op', 'degraded', 'failed', 'blocked'].includes(value as string);
}

function validTaskCreateTask(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeys(value, ['id', 'shortId', 'state'])
    && validTaskReference(value.id)
    && validTaskReference(value.shortId)
    && [null, 'active', 'blocked', 'completed', 'archive'].includes(value.state as string | null);
}

function validTaskCreateOperation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeys(value, ['name', 'reasonCode', 'status'])
    && typeof value.name === 'string'
    && typeof value.status === 'string'
    && (value.reasonCode === null || typeof value.reasonCode === 'string');
}

function validTaskCreateWarning(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeys(value, ['action', 'code', 'severity'])
    && typeof value.action === 'string'
    && typeof value.code === 'string'
    && typeof value.severity === 'string';
}

function validTaskCreateIssue(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return exactKeys(value, ['number', 'url'])
    && Number.isSafeInteger(value.number)
    && (value.number as number) > 0
    && typeof value.url === 'string';
}

function validTaskCreateResultEnvelope(result: Record<string, unknown>): boolean {
  return exactKeys(result, ['changed', 'control', 'error', 'issue', 'operations', 'status', 'task', 'warnings'])
    || exactKeys(result, ['changed', 'error', 'issue', 'operations', 'status', 'task', 'warnings']);
}

function validTaskCreateResultFields(result: Record<string, unknown>): boolean {
  return validTaskCreateStatus(result.status)
    && typeof result.changed === 'boolean'
    && validTaskCreateTask(result.task)
    && Array.isArray(result.operations)
    && result.operations.every(validTaskCreateOperation)
    && Array.isArray(result.warnings)
    && result.warnings.every(validTaskCreateWarning)
    && validTaskCreateIssue(result.issue)
    && (result.error === null || validTaskCreateError(result.error))
    && (!('control' in result) || validTaskCreateControl(result.control));
}

function validTaskCreateStatusError(result: Record<string, unknown>): boolean {
  if (result.status === 'blocked') return (result.error as TaskCreateError | null)?.retryable === true;
  if (result.status === 'failed') return !!result.error;
  return true;
}

export function parseTaskCreateResult(value: unknown): TaskCreateResult {
  if (!isRecord(value)
    || !validTaskCreateResultEnvelope(value)
    || !validTaskCreateResultFields(value)
    || !validTaskCreateStatusError(value)) {
    return invalidTaskCreateResult();
  }
  return value as unknown as TaskCreateResult;
}

export function projectTaskCreateResult(result: TaskCreateResult, control: TaskCreateControl): TaskCreateResult {
  return { ...result, control };
}

export function taskCreateExitCode(result: Pick<TaskCreateResult, 'status'>): number {
  return result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

export function taskCreateFailure(
  error: TaskCreateError,
  control?: TaskCreateControl
): TaskCreateResult {
  return {
    status: error.retryable ? 'blocked' : 'failed',
    changed: false,
    task: { id: null, shortId: null, state: null },
    issue: null,
    operations: [],
    warnings: [],
    error,
    ...(control ? { control } : {})
  };
}

export function taskCreateOutputUnavailableResult(requestId: string): TaskCreateResult {
  return taskCreateFailure({
    code: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE',
    message: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: task-create result output was not retained; inspect domain state before retrying',
    retryable: false
  }, {
    requestId,
    accepted: true,
    recovery: 'inspect-domain-state'
  });
}

async function verifyCreatedTask(repoRoot: string, taskId: string): Promise<{ operation: TaskCreateOperation; error: TaskCreateResult['error'] }> {
  const verification = await verifyTaskEvent(
    { taskRef: taskId, event: 'create-task.completed' },
    { repoRoot }
  );
  if (verification.status === 'pass') {
    return { operation: { name: 'task:verify', status: 'pass', reasonCode: null }, error: null };
  }
  const blocked = verification.status === 'blocked';
  return {
    operation: {
      name: 'task:verify', status: verification.status,
      reasonCode: verification.error?.code ?? 'TASK_CREATE_VERIFICATION_FAILED'
    },
    error: {
      code: verification.error?.code ?? 'TASK_CREATE_VERIFICATION_FAILED',
      message: `Created task did not pass the ${verification.event} gate`,
      retryable: blocked
    }
  };
}

function platformOperations(prefix: string, operations: readonly { name: string; status: string; reasonCode?: string | null }[]): TaskCreateOperation[] {
  return operations.map((operation) => ({
    name: `${prefix}:${operation.name}`,
    status: operation.status,
    reasonCode: operation.reasonCode ?? null
  }));
}

async function createPlatformTask(
  candidate: TaskCreateCandidateV1,
  taskId: string,
  repoRoot: string,
  dependencies: TaskCreateDependencies
): Promise<TaskCreatePlatformSummary> {
  const operations: TaskCreateOperation[] = [];
  let issue: TaskCreateResult['issue'] = null;
  const created = await dependencies.createIssue(taskId, { cwd: repoRoot, agent: candidate.agent });
  operations.push(...platformOperations('platform-create', created.operations));
  if (created.issue) issue = { number: created.issue.number, url: created.issue.url };

  let failure: PlatformResult | null = created.status === 'failed' || created.status === 'blocked' ? created : null;
  if (!failure && (created.task.issueNumber || issue)) {
    const synced = await dependencies.syncIssue(taskId, {
      cwd: repoRoot,
      agent: candidate.agent,
      status: 'waiting-for-triage',
      assignees: 'current',
      milestone: 'initial',
      issueType: true,
      fields: true
    });
    operations.push(...platformOperations('platform-sync', synced.operations));
    if (synced.issue) issue = { number: synced.issue.number, url: synced.issue.url };
    if (synced.status === 'failed' || synced.status === 'blocked') failure = synced;
    if (!failure) {
      const commented = await dependencies.syncComment(taskId, { cwd: repoRoot, kind: 'task', agent: candidate.agent });
      operations.push(...platformOperations('platform-comment', commented.operations));
      if (commented.status === 'failed' || commented.status === 'blocked') failure = commented;
    }
  }
  return { issue, operations, failure };
}

async function completeTaskCreate(
  local: ReturnType<typeof createLocalTask>,
  platform: TaskCreatePlatformSummary,
  operations: TaskCreateOperation[],
  options: CreateTaskOptions,
  dependencies: TaskCreateDependencies
): Promise<TaskCreateResult> {
  if (platform.failure) {
    const error = platform.failure.error ?? { code: 'ISSUE_CREATE_FAILED', message: 'Platform operation failed', retryable: false };
    dependencies.addWarning({
      kind: 'add', taskRef: local.task.id, step: 'create-task', severity: 'ACTION_REQUIRED',
      code: 'ISSUE_CREATE_FAILED', target: 'issue', message: `${error.code}: ${error.message}`,
      action: 'Fix platform authentication or connectivity, then retry Issue creation for this task.'
    }, { repoRoot: options.repoRoot });
  }

  const verified = await verifyCreatedTask(options.repoRoot, local.task.id);
  operations.push(verified.operation);
  if (verified.error) return {
    status: verified.error.retryable ? 'blocked' : 'failed',
    changed: local.changed,
    task: local.task,
    issue: platform.issue,
    operations,
    warnings: [],
    error: verified.error
  };
  if (platform.failure) return {
    status: 'degraded',
    changed: local.changed,
    task: local.task,
    issue: platform.issue,
    operations,
    warnings: [{ code: 'ISSUE_CREATE_FAILED', severity: 'ACTION_REQUIRED', action: 'Retry Issue creation after fixing the platform failure.' }],
    error: platform.failure.error ?? { code: 'ISSUE_CREATE_FAILED', message: 'Platform operation failed', retryable: false }
  };
  return {
    status: local.status,
    changed: local.changed,
    task: local.task,
    issue: platform.issue,
    operations,
    warnings: [],
    error: null
  };
}

async function createTask(value: unknown, options: CreateTaskOptions): Promise<TaskCreateResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let candidate: TaskCreateCandidateV1;
  let local: ReturnType<typeof createLocalTask>;
  try {
    candidate = value as TaskCreateCandidateV1;
    local = createLocalTask(candidate, {
      repoRoot: options.repoRoot,
      agentInfraVersion: options.agentInfraVersion ?? VERSION
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'TASK_CREATE_FAILED';
    return taskCreateFailure({ code, message, retryable: false });
  }

  const operations: TaskCreateOperation[] = [{
    name: 'task:local', status: local.status, reasonCode: null
  }];
  if (local.status === 'no-op' && local.task.state !== 'active') {
    return { status: 'no-op', changed: false, task: local.task, issue: null, operations, warnings: [], error: null };
  }
  const platform = await createPlatformTask(candidate, local.task.id, options.repoRoot, dependencies);
  operations.push(...platform.operations);
  return completeTaskCreate(local, platform, operations, options, dependencies);
}

export { createTask };
export type {
  CreateTaskOptions,
  TaskCreateControl,
  TaskCreateDependencies,
  TaskCreateError,
  TaskCreateOperation,
  TaskCreateRecovery,
  TaskCreateResult,
  TaskCreateStatus,
  TaskCreateWarning
};
