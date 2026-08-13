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
type TaskCreateResult = Readonly<{
  status: TaskCreateStatus;
  changed: boolean;
  task: { id: string | null; shortId: string | null };
  issue: { number: number; url: string } | null;
  operations: readonly TaskCreateOperation[];
  warnings: readonly TaskCreateWarning[];
  error: { code: string; message: string; retryable: boolean } | null;
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

function verifyCreatedTask(repoRoot: string, taskId: string): { operation: TaskCreateOperation; error: TaskCreateResult['error'] } {
  const verification = verifyTaskEvent(
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

function createTask(value: unknown, options: CreateTaskOptions): TaskCreateResult {
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
    return {
      status: 'failed', changed: false, task: { id: null, shortId: null }, issue: null,
      operations: [], warnings: [], error: { code, message, retryable: code === 'TASK_CREATE_LOCK_TIMEOUT' }
    };
  }

  const operations: TaskCreateOperation[] = [{
    name: 'task:local', status: local.status, reasonCode: null
  }];
  let issue = issueFromTask(options.repoRoot, local.task.id);
  const created = dependencies.createIssue(local.task.id, { cwd: options.repoRoot, agent: candidate.agent });
  operations.push(...platformOperations('platform-create', created.operations));
  if (created.issue) issue = { number: created.issue.number, url: created.issue.url };

  let platformFailure: PlatformResult | null = created.status === 'failed' || created.status === 'blocked' ? created : null;
  if (!platformFailure && (created.task.issueNumber || issue)) {
    const synced = dependencies.syncIssue(local.task.id, {
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
      const commented = dependencies.syncComment(local.task.id, { cwd: options.repoRoot, kind: 'task', agent: candidate.agent });
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
    const verified = verifyCreatedTask(options.repoRoot, local.task.id);
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

  const verified = verifyCreatedTask(options.repoRoot, local.task.id);
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
export type { CreateTaskOptions, TaskCreateDependencies, TaskCreateOperation, TaskCreateResult, TaskCreateStatus, TaskCreateWarning };
