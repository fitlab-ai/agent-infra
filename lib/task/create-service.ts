import fs from 'node:fs';
import path from 'node:path';

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
  task: { id: string | null; shortId: string | null };
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

function validTaskReference(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function validTaskCreateError(value: unknown): value is TaskCreateError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return exactKeys(error, ['code', 'message', 'retryable'])
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(error.code)
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function validTaskCreateControl(value: unknown): value is TaskCreateControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const control = value as Record<string, unknown>;
  return exactKeys(control, ['accepted', 'recovery', 'requestId'])
    && validTaskReference(control.requestId)
    && typeof control.accepted === 'boolean'
    && ['none', 'same-request-id', 'new-request-id', 'inspect-domain-state'].includes(control.recovery as string);
}

export function parseTaskCreateResult(value: unknown): TaskCreateResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidTaskCreateResult();
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ['changed', 'control', 'error', 'issue', 'operations', 'status', 'task', 'warnings'])
    && !exactKeys(result, ['changed', 'error', 'issue', 'operations', 'status', 'task', 'warnings'])) {
    return invalidTaskCreateResult();
  }
  if (!['applied', 'no-op', 'degraded', 'failed', 'blocked'].includes(result.status as string)
    || typeof result.changed !== 'boolean'
    || !result.task || typeof result.task !== 'object' || Array.isArray(result.task)
    || !exactKeys(result.task as Record<string, unknown>, ['id', 'shortId'])
    || !validTaskReference((result.task as { id?: unknown }).id)
    || !validTaskReference((result.task as { shortId?: unknown }).shortId)
    || !Array.isArray(result.operations)
    || !result.operations.every((operation) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
      const value = operation as Record<string, unknown>;
      return exactKeys(value, ['name', 'reasonCode', 'status'])
        && typeof value.name === 'string' && typeof value.status === 'string'
        && (value.reasonCode === null || typeof value.reasonCode === 'string');
    })
    || !Array.isArray(result.warnings)
    || !result.warnings.every((warning) => {
      if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return false;
      const value = warning as Record<string, unknown>;
      return exactKeys(value, ['action', 'code', 'severity'])
        && typeof value.action === 'string' && typeof value.code === 'string' && typeof value.severity === 'string';
    })
    || (result.issue !== null && (
      !result.issue || typeof result.issue !== 'object' || Array.isArray(result.issue)
      || !exactKeys(result.issue as Record<string, unknown>, ['number', 'url'])
      || !Number.isSafeInteger((result.issue as { number?: unknown }).number)
      || ((result.issue as { number: number }).number) <= 0
      || typeof (result.issue as { url?: unknown }).url !== 'string'
    ))
    || (result.error !== null && !validTaskCreateError(result.error))
    || ('control' in result && !validTaskCreateControl(result.control))) {
    return invalidTaskCreateResult();
  }
  if (result.status === 'blocked' && !(result.error as TaskCreateError | null)?.retryable) return invalidTaskCreateResult();
  if (result.status === 'failed' && !(result.error as TaskCreateError | null)) return invalidTaskCreateResult();
  return result as unknown as TaskCreateResult;
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
    task: { id: null, shortId: null },
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

function issueFromTask(repoRoot: string, taskId: string): { number: number; url: string } | null {
  const content = fs.readFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', taskId, 'task.md'), 'utf8');
  const match = /^issue_number:\s*(\d+)\s*$/m.exec(content);
  return match ? { number: Number(match[1]), url: '' } : null;
}

async function createTask(value: unknown, options: CreateTaskOptions): Promise<TaskCreateResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let candidate: TaskCreateCandidateV1;
  let local;
  try {
    candidate = value as TaskCreateCandidateV1;
    local = createLocalTask(candidate, {
      repoRoot: options.repoRoot,
      agentInfraVersion: options.agentInfraVersion ?? VERSION
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'TASK_CREATE_FAILED';
    return taskCreateFailure({ code, message, retryable: code === 'TASK_CREATE_LOCK_TIMEOUT' });
  }

  const operations: TaskCreateOperation[] = [{
    name: 'task:local', status: local.status, reasonCode: null
  }];
  let issue = issueFromTask(options.repoRoot, local.task.id);
  const created = await dependencies.createIssue(local.task.id, { cwd: options.repoRoot, agent: candidate.agent });
  operations.push(...platformOperations('platform-create', created.operations));
  if (created.issue) issue = { number: created.issue.number, url: created.issue.url };

  let platformFailure: PlatformResult | null = created.status === 'failed' || created.status === 'blocked' ? created : null;
  if (!platformFailure && (created.task.issueNumber || issue)) {
    const synced = await dependencies.syncIssue(local.task.id, {
      cwd: options.repoRoot,
      agent: candidate.agent,
      status: 'waiting-for-triage',
      assignees: 'current',
      milestone: 'initial',
      issueType: true,
      fields: true
    });
    operations.push(...platformOperations('platform-sync', synced.operations));
    if (synced.issue) issue = { number: synced.issue.number, url: synced.issue.url };
    if (synced.status === 'failed' || synced.status === 'blocked') platformFailure = synced;
    if (!platformFailure) {
      const commented = await dependencies.syncComment(local.task.id, { cwd: options.repoRoot, kind: 'task', agent: candidate.agent });
      operations.push(...platformOperations('platform-comment', commented.operations));
      if (commented.status === 'failed' || commented.status === 'blocked') platformFailure = commented;
    }
  }

  if (platformFailure) {
    const error = platformFailure.error ?? { code: 'ISSUE_CREATE_FAILED', message: 'Platform operation failed', retryable: false };
    dependencies.addWarning({
      kind: 'add', taskRef: local.task.id, step: 'create-task', severity: 'ACTION_REQUIRED',
      code: 'ISSUE_CREATE_FAILED', target: 'issue', message: `${error.code}: ${error.message}`,
      action: 'Fix platform authentication or connectivity, then retry Issue creation for this task.'
    }, { repoRoot: options.repoRoot });
    const verified = await verifyCreatedTask(options.repoRoot, local.task.id);
    operations.push(verified.operation);
    if (verified.error) return {
      status: verified.error.retryable ? 'blocked' : 'failed', changed: local.changed,
      task: local.task, issue, operations, warnings: [], error: verified.error
    };
    return {
      status: platformFailure.status === 'blocked' ? 'blocked' : 'degraded',
      changed: local.changed,
      task: local.task,
      issue,
      operations,
      warnings: [{ code: 'ISSUE_CREATE_FAILED', severity: 'ACTION_REQUIRED', action: 'Retry Issue creation after fixing the platform failure.' }],
      error
    };
  }

  const verified = await verifyCreatedTask(options.repoRoot, local.task.id);
  operations.push(verified.operation);
  if (verified.error) return {
    status: verified.error.retryable ? 'blocked' : 'failed', changed: local.changed,
    task: local.task, issue, operations, warnings: [], error: verified.error
  };
  return {
    status: local.status,
    changed: local.changed,
    task: local.task,
    issue,
    operations,
    warnings: [],
    error: null
  };
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
