import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../git/workflow.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
import { resolveTaskContext, resolveTaskRef } from './resolve-ref.ts';
import { commitPushDecision } from './commit-policy.ts';
import { mergeOperationWarnings, type OperationWarning } from './operation-outcome.ts';
import { TaskExecutionLockError, withRepositoryMutationLock, withTaskExecutionLock } from './task-execution-lock.ts';
import { appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation } from './write.ts';
import {
  checkpointIntentDigest,
  readCheckpointIntent,
  removeCheckpointIntent,
  sameCheckpointIntent,
  updateCheckpointIntent,
  writeCheckpointIntent
} from './commit-intent.ts';

type CommitExecutionMode = 'direct' | 'orchestrated';

type CommitOperationInput = Readonly<{
  cwd: string;
  paths: readonly string[];
  message: string;
  expectedHead: string;
  expectedTree: string;
  taskRef?: string;
  agent?: string;
  mode?: CommitExecutionMode;
  round?: number;
  delivery?: Readonly<{
    mode: 'local' | 'push';
    remote: string;
    refs: readonly string[];
  }> | Readonly<{ mode: 'local' }>;
  push?: Readonly<{
    remote: string;
    refs: readonly string[];
  }>;
}>;

type CommitOperationResult = Readonly<{
  status: 'applied' | 'no-op' | 'failed' | 'blocked';
  changed: boolean;
  result: 'committed' | 'no_op' | 'committed_with_warnings' | 'failed' | 'blocked';
  taskId: string | null;
  mode: CommitExecutionMode;
  warnings: readonly OperationWarning[];
  snapshot: ReturnType<typeof inspectGitWorkflow>['snapshot'];
  operations: readonly unknown[];
  error: Readonly<{ code: string; message: string }> | null;
}>;

type BoundTask = Readonly<{
  repoRoot: string;
  taskId: string;
  taskDir: string;
  taskMdPath: string;
  state: 'active' | 'blocked' | 'completed' | 'archive';
  branch: string;
}>;

const HEAD_REF = /^refs\/heads\/(.+)$/;
type CommitDelivery = Readonly<{ mode: 'local' } | { mode: 'push'; remote: string; refs: readonly string[] }>;

function isCommitExecutionMode(value: unknown): value is CommitExecutionMode {
  return value === 'direct' || value === 'orchestrated';
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function effectiveDelivery(input: CommitOperationInput): CommitDelivery | null {
  if (input.delivery) return input.delivery;
  if (input.push) return { mode: 'push', remote: input.push.remote, refs: input.push.refs };
  return null;
}

function canonicalRepositoryRoot(cwd: string): string {
  return gitText(cwd, ['rev-parse', '--show-toplevel']);
}

function failure(
  input: CommitOperationInput,
  mode: CommitExecutionMode,
  taskId: string | null,
  code: string,
  message: string,
  status: 'failed' | 'blocked' = 'failed',
  snapshot: ReturnType<typeof inspectGitWorkflow>['snapshot'] = null
): CommitOperationResult {
  return {
    status,
    changed: false,
    result: status,
    taskId,
    mode,
    warnings: [],
    snapshot: snapshot ?? inspectGitWorkflow(input.cwd).snapshot,
    operations: [],
    error: { code, message }
  };
}

function warning(
  code: string,
  message: string,
  retryable: boolean,
  step: string,
  target: string,
  severity: OperationWarning['severity']
): OperationWarning {
  return { code, message, retryable, step, target, severity };
}

function resolveBoundTask(input: CommitOperationInput):
  | { kind: 'none' }
  | { kind: 'bound'; task: BoundTask }
  | { kind: 'error'; result: CommitOperationResult } {
  const mode = input.mode ?? 'direct';
  if (input.taskRef !== undefined) {
    const resolved = resolveTaskRef(input.taskRef, { repoRoot: input.cwd });
    if (!resolved.ok) return {
      kind: 'error',
      result: failure(input, mode, resolved.taskId, resolved.code, resolved.message)
    };
    return boundTask(input, resolved.taskId, resolved.taskDir, resolved.taskMdPath, resolved.repoRoot, resolved.state);
  }
  const context = resolveTaskContext(undefined, { repoRoot: input.cwd });
  if (context.ok) return boundTask(input, context.taskId, context.taskDir, context.taskMdPath, context.repoRoot, context.state);
  if (context.code === 'TASK_CONTEXT_NOT_FOUND') return { kind: 'none' };
  return {
    kind: 'error',
    result: failure(input, mode, context.taskId, context.code, context.message)
  };
}

function boundTask(
  input: CommitOperationInput,
  taskId: string,
  taskDir: string,
  taskMdPath: string,
  repoRoot: string,
  state: BoundTask['state']
): { kind: 'bound'; task: BoundTask } | { kind: 'error'; result: CommitOperationResult } {
  let branch: string;
  try {
    const frontmatter = parseTaskFrontmatter(fs.readFileSync(taskMdPath, 'utf8'));
    branch = frontmatter.branch ?? '';
  } catch (error) {
    return {
      kind: 'error',
      result: failure(input, input.mode ?? 'direct', taskId, 'TASK_CONTEXT_UNREADABLE', error instanceof Error ? error.message : String(error))
    };
  }
  if (!branch) return {
    kind: 'error',
    result: failure(input, input.mode ?? 'direct', taskId, 'TASK_CONTEXT_UNREADABLE', 'task branch is missing')
  };
  return { kind: 'bound', task: { repoRoot, taskId, taskDir, taskMdPath, state, branch } };
}

function validateCommon(input: CommitOperationInput, branch: string | null): Readonly<{ code: string; message: string }> | null {
  if (!input.message.trim()) return { code: 'GIT_COMMIT_INPUT_INVALID', message: 'Commit message is required' };
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedHead)) return { code: 'GIT_HEAD_EXPECTATION_REQUIRED', message: 'A valid expected HEAD is required' };
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedTree)) return { code: 'GIT_TREE_EXPECTATION_REQUIRED', message: 'A valid expected tree is required' };
  const delivery = effectiveDelivery(input);
  if (!delivery) return { code: 'GIT_PUSH_INPUT_INVALID', message: 'Commit delivery requires a delivery policy' };
  if (input.paths.some((candidate) => !candidate || candidate.startsWith('/') || candidate.split(/[\\/]/).includes('..'))) {
    return { code: 'GIT_COMMIT_INPUT_INVALID', message: 'Commit paths must stay inside the repository' };
  }
  if (input.paths.some((candidate) => /(^|\/)(?:\.env|credentials\.json|id_rsa)(?:$|\/)/i.test(candidate))) {
    return { code: 'GIT_COMMIT_INPUT_INVALID', message: 'Sensitive paths cannot be committed' };
  }
  if (branch !== null && branch === '') return { code: 'GIT_BRANCH_INVALID', message: 'A named branch is required' };
  if (delivery.mode === 'push') {
    if (!delivery.remote || delivery.refs.length !== 1) return { code: 'GIT_PUSH_INPUT_INVALID', message: 'Push requires one remote and one ref' };
    const ref = delivery.refs[0] ?? '';
    if (!HEAD_REF.test(ref) || HEAD_REF.exec(ref)?.[1] !== branch) {
      return { code: 'GIT_PUSH_INPUT_INVALID', message: 'Push ref must be the current full heads ref' };
    }
  }
  return null;
}

function syncTaskCommit(
  input: CommitOperationInput,
  task: BoundTask,
  committedHead: string
): OperationWarning | null {
  let content: string;
  try {
    content = fs.readFileSync(task.taskMdPath, 'utf8');
    const activity = locateActivityLog(content);
    if (!activity) return warning(
      'TASK_STATUS_SYNC_FAILED',
      'task has no unique Activity Log section',
      true,
      'task',
      task.taskId,
      'ACTION_REQUIRED'
    );
    const metadata = captureTaskWriteMetadata();
    const commitNote = gitText(task.repoRoot, ['show', '-s', '--format=%h %s', committedHead]);
    const alreadyLogged = activity.entries.some((entry) => entry.step === 'Commit' && entry.note === commitNote);
    const mutations: TaskMutation[] = [];
    if (!alreadyLogged) mutations.push({
      kind: 'section',
      aliases: ['活动日志', 'Activity Log'],
      heading: activity.heading,
      body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Commit', agent: input.agent!, note: commitNote })
    });
    const frontmatter: Record<string, string> = {
      assigned_to: input.agent!,
      checkpoint_commit: committedHead
    };
    mutations.push({ kind: 'frontmatter', set: frontmatter });
    if (mutations.length === 0) return null;
    const written = writeTask({
      taskRef: task.taskId,
      expectedState: 'active',
      mutations
    }, { repoRoot: task.repoRoot, metadataProvider: () => metadata });
    if (written.status === 'failed') return warning(
      'TASK_STATUS_SYNC_FAILED',
      written.error.message,
      true,
      'task',
      task.taskId,
      'ACTION_REQUIRED'
    );
    return null;
  } catch (error) {
    return warning(
      'TASK_STATUS_SYNC_FAILED',
      error instanceof Error ? error.message : String(error),
      true,
      'task',
      task.taskId,
      'ACTION_REQUIRED'
    );
  }
}

function checkpointChildMatches(task: BoundTask, intent: NonNullable<ReturnType<typeof readCheckpointIntent>>, head: string): boolean {
  try {
    const parent = gitText(task.repoRoot, ['rev-parse', `${head}^`]);
    const tree = gitText(task.repoRoot, ['rev-parse', `${head}^{tree}`]);
    const message = gitText(task.repoRoot, ['show', '-s', '--format=%s', head]);
    const changed = gitText(task.repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]).split('\n').filter(Boolean).sort();
    return parent === intent.expectedHead
      && tree === intent.expectedTree
      && message === intent.message
      && JSON.stringify(changed) === JSON.stringify([...intent.paths].sort());
  } catch {
    return false;
  }
}

function checkpointIdentity(input: CommitOperationInput, task: BoundTask, delivery: CommitDelivery): Parameters<typeof checkpointIntentDigest>[0] {
  if (delivery.mode !== 'local') throw new Error('checkpoint identity requires local delivery');
  return {
    taskId: task.taskId,
    branch: task.branch,
    mode: 'local',
    expectedHead: input.expectedHead,
    expectedTree: input.expectedTree,
    paths: [...input.paths],
    message: input.message,
    round: input.round ?? 1
  };
}

function checkpointTimestamp(): string {
  return new Date().toISOString();
}

function executeUnlocked(input: CommitOperationInput, task: BoundTask | null, mode: CommitExecutionMode): CommitOperationResult {
  const inspected = inspectGitWorkflow(input.cwd);
  if (!inspected.snapshot) return failure(input, mode, task?.taskId ?? null, 'GIT_INSPECT_FAILED', 'Unable to inspect Git repository');
  if (mode === 'orchestrated') return failure(
    input,
    mode,
    task?.taskId ?? null,
    'ORCHESTRATED_COMMIT_REMOVED',
    'Orchestrated commit is no longer a lifecycle stage; use local checkpoint delivery from code-task',
    'blocked',
    inspected.snapshot
  );
  const branch = inspected.snapshot.branch;
  const commonError = validateCommon(input, branch);
  if (commonError) return failure(input, mode, task?.taskId ?? null, commonError.code, commonError.message, 'blocked', inspected.snapshot);
  if (task && task.state !== 'active') return failure(input, mode, task.taskId, 'TASK_STATE_INVALID', 'task-bound commit requires an active task', 'blocked', inspected.snapshot);
  if (task && task.branch !== branch) return failure(input, mode, task.taskId, 'GIT_BRANCH_MISMATCH', `Task branch '${task.branch}' does not match current branch '${branch}'`, 'blocked', inspected.snapshot);
  if (task && !input.agent) return failure(input, mode, task.taskId, 'COMMIT_AGENT_REQUIRED', 'task-bound commit requires an agent', 'blocked', inspected.snapshot);
  const delivery = effectiveDelivery(input)!;
  if (delivery.mode === 'local' && !task) return failure(input, mode, null, 'CHECKPOINT_TASK_REQUIRED', 'local checkpoint delivery requires a task context', 'blocked', inspected.snapshot);
  let pendingIntent: NonNullable<ReturnType<typeof readCheckpointIntent>> | null = null;
  let checkpointCommittedHead: string | null = null;
  const committed = delivery.mode === 'local'
    ? (() => {
      const identity = checkpointIdentity(input, task!, delivery);
      try {
        pendingIntent = readCheckpointIntent(task!.repoRoot, task!.taskId);
      } catch (error) {
        return {
          status: 'failed' as const, changed: false, snapshot: inspected.snapshot, operations: [],
          error: { code: 'COMMIT_INTENT_INVALID', message: error instanceof Error ? error.message : String(error) }
        };
      }
      if (pendingIntent && !sameCheckpointIntent(pendingIntent, identity)) return {
        status: 'failed' as const, changed: false, snapshot: inspected.snapshot, operations: [],
        error: { code: 'COMMIT_INTENT_CONFLICT', message: 'A different checkpoint intent is still pending for this task' }
      };
      if (!pendingIntent) {
        const timestamp = checkpointTimestamp();
        pendingIntent = {
          version: 1, ...identity, digest: checkpointIntentDigest(identity), state: 'prepared',
          committedHead: null, createdAt: timestamp, updatedAt: timestamp
        };
        try { writeCheckpointIntent(task!.repoRoot, pendingIntent); }
        catch (error) {
          return {
            status: 'failed' as const, changed: false, snapshot: inspected.snapshot, operations: [],
            error: { code: 'COMMIT_INTENT_WRITE_FAILED', message: error instanceof Error ? error.message : String(error) }
          };
        }
      }
      if (pendingIntent.state !== 'prepared') {
        checkpointCommittedHead = pendingIntent.committedHead;
        return {
          status: 'no-op' as const, changed: false, snapshot: inspected.snapshot,
          operations: [{ name: 'commit', status: 'no-op' as const }], error: null
        };
      }
      if (inspected.snapshot.head !== identity.expectedHead && !checkpointChildMatches(task!, pendingIntent, inspected.snapshot.head)) return {
        status: 'failed' as const, changed: false, snapshot: inspected.snapshot, operations: [],
        error: { code: 'COMMIT_INTENT_HEAD_CONFLICT', message: 'Current HEAD does not match the pending checkpoint intent' }
      };
      if (inspected.snapshot.head !== identity.expectedHead) {
        checkpointCommittedHead = inspected.snapshot.head;
        pendingIntent = updateCheckpointIntent(pendingIntent, {
          state: 'committed', committedHead: checkpointCommittedHead, updatedAt: checkpointTimestamp()
        });
        writeCheckpointIntent(task!.repoRoot, pendingIntent);
        return {
          status: 'no-op' as const, changed: false, snapshot: inspected.snapshot,
          operations: [{ name: 'commit', status: 'no-op' as const }], error: null
        };
      }
      if (input.paths.length === 0) return {
        status: 'failed' as const, changed: false, snapshot: inspected.snapshot, operations: [],
        error: { code: 'GIT_COMMIT_INPUT_INVALID', message: 'Local checkpoint requires explicit paths' }
      };
      const created = commitExplicitPaths({
        cwd: input.cwd, paths: input.paths, message: input.message,
        expectedHead: identity.expectedHead, expectedTree: identity.expectedTree
      });
      if (created.status === 'applied' && created.snapshot?.head) {
        checkpointCommittedHead = created.snapshot.head;
        pendingIntent = updateCheckpointIntent(pendingIntent, {
          state: 'committed', committedHead: checkpointCommittedHead, updatedAt: checkpointTimestamp()
        });
        writeCheckpointIntent(task!.repoRoot, pendingIntent);
      } else if (created.status === 'no-op') {
        removeCheckpointIntent(task!.repoRoot, task!.taskId);
        pendingIntent = null;
      }
      return created;
    })()
    : input.paths.length === 0
    ? (() => {
      if (inspected.snapshot.worktree.length > 0 || inspected.snapshot.staged.length > 0) return {
        status: 'failed' as const,
        changed: false,
        snapshot: inspected.snapshot,
        operations: [],
        error: { code: 'GIT_COMMIT_INPUT_INVALID', message: 'Push-only retry requires a clean working tree' }
      };
      if (inspected.snapshot.head !== input.expectedHead) return {
        status: 'failed' as const,
        changed: false,
        snapshot: inspected.snapshot,
        operations: [],
        error: { code: 'GIT_HEAD_MISMATCH', message: `Expected HEAD ${input.expectedHead}, received ${inspected.snapshot.head}` }
      };
      const currentTree = gitText(input.cwd, ['rev-parse', 'HEAD^{tree}']);
      if (currentTree !== input.expectedTree) return {
        status: 'failed' as const,
        changed: false,
        snapshot: inspected.snapshot,
        operations: [],
        error: { code: 'GIT_TREE_MISMATCH', message: `Expected current tree ${input.expectedTree}, received ${currentTree}` }
      };
      return {
        status: 'no-op' as const,
        changed: false,
        snapshot: inspected.snapshot,
        operations: [{ name: 'commit', status: 'no-op' as const }],
        error: null
      };
    })()
    : commitExplicitPaths({
      cwd: input.cwd,
      paths: input.paths,
      message: input.message,
      expectedHead: input.expectedHead,
      expectedTree: input.expectedTree
    });
  if (committed.status === 'failed') return {
    ...committed,
    result: 'failed',
    taskId: task?.taskId ?? null,
    mode,
    warnings: [],
    snapshot: committed.snapshot
  };

  const warnings: OperationWarning[] = [];
  let status: CommitOperationResult['status'] = committed.status;
  let result: CommitOperationResult['result'] = committed.status === 'applied' ? 'committed' : 'no_op';
  if (delivery.mode === 'push') {
    const target = `${delivery.remote}:${delivery.refs[0]}`;
    const decision = commitPushDecision({ branch }, target);
    if (!decision.shouldPush) {
      warnings.push(decision.warning!);
    } else {
      const pushed = pushGitRefs({
        cwd: input.cwd, remote: delivery.remote, refs: delivery.refs,
        expectedSha: committed.snapshot?.head ?? gitText(input.cwd, ['rev-parse', 'HEAD'])
      });
      if (pushed.status !== 'applied') warnings.push(warning(
        'COMMIT_PUSH_FAILED', pushed.error?.message ?? 'Git push failed', true, 'push', target, 'ACTION_REQUIRED'
      ));
    }
  }
  if (warnings.length > 0) {
    status = 'applied';
    result = 'committed_with_warnings';
  }
  if (task && (committed.status === 'applied' || committed.status === 'no-op')) {
    const committedHead = checkpointCommittedHead ?? committed.snapshot?.head ?? gitText(task.repoRoot, ['rev-parse', 'HEAD']);
    const taskWarning = syncTaskCommit(input, task, committedHead);
    if (taskWarning) {
      warnings.push(taskWarning);
      status = 'applied';
      result = 'committed_with_warnings';
    }
    if (delivery.mode === 'local' && !taskWarning && pendingIntent && checkpointCommittedHead) {
      const synced = updateCheckpointIntent(pendingIntent, {
        state: 'synced', committedHead: checkpointCommittedHead, updatedAt: checkpointTimestamp()
      });
      writeCheckpointIntent(task.repoRoot, synced);
      removeCheckpointIntent(task.repoRoot, task.taskId);
    }
  }
  return {
    status,
    changed: committed.changed,
    result,
    taskId: task?.taskId ?? null,
    mode,
    warnings: mergeOperationWarnings(warnings),
    snapshot: committed.snapshot,
    operations: committed.operations,
    error: null
  };
}

function executeCommitOperation(input: CommitOperationInput): CommitOperationResult {
  if (input.mode !== undefined && !isCommitExecutionMode(input.mode)) return {
    status: 'blocked',
    changed: false,
    result: 'blocked',
    taskId: null,
    mode: 'direct',
    warnings: [],
    snapshot: null,
    operations: [],
    error: { code: 'COMMIT_MODE_INVALID', message: 'commit mode must be direct or orchestrated' }
  };
  const mode: CommitExecutionMode = input.mode ?? 'direct';
  let normalizedInput: CommitOperationInput;
  try {
    normalizedInput = { ...input, cwd: canonicalRepositoryRoot(input.cwd) };
  } catch (error) {
    return failure(input, mode, null, 'GIT_INSPECT_FAILED', error instanceof Error ? error.message : 'Unable to resolve Git repository root', 'blocked');
  }
  const resolved = resolveBoundTask(normalizedInput);
  if (resolved.kind === 'error') return resolved.result;
  const task = resolved.kind === 'bound' ? resolved.task : null;
  if (mode === 'orchestrated' && !task) return failure(normalizedInput, mode, null, 'ORCHESTRATION_TASK_REQUIRED', 'orchestrated commit requires a task context', 'blocked');
  try {
    return task
      ? withRepositoryMutationLock(normalizedInput.cwd, () => withTaskExecutionLock(normalizedInput.cwd, task.taskId, 'commit-operation', () => executeUnlocked(normalizedInput, task, mode)))
      : withRepositoryMutationLock(normalizedInput.cwd, () => executeUnlocked(normalizedInput, null, mode));
  } catch (error) {
    const code = error instanceof TaskExecutionLockError ? error.code : 'COMMIT_OPERATION_FAILED';
    return failure(normalizedInput, mode, task?.taskId ?? null, code, error instanceof Error ? error.message : String(error), 'blocked');
  }
}

export { executeCommitOperation };
export type { CommitExecutionMode, CommitOperationInput, CommitOperationResult };
