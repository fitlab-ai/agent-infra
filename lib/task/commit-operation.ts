import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../git/workflow.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
import { checkpointCommitMatches } from './commit-identity.ts';
import { resolveTaskContext, resolveTaskRef } from './resolve-ref.ts';
import { commitPushDecision } from './commit-policy.ts';
import { mergeOperationWarnings, type OperationWarning } from './operation-outcome.ts';
import { activityWarnings, appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskWriteOptions } from './write.ts';
import {
  checkpointIntentDigest,
  readCheckpointIntent,
  removeCheckpointIntent,
  sameCheckpointIntent,
  updateCheckpointIntent,
  writeCheckpointIntent
} from './commit-intent.ts';
import type { CheckpointIntent } from './commit-intent.ts';

type CommitExecutionMode = 'direct';

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
type CommitStepResult = ReturnType<typeof commitExplicitPaths>;
type CommitDeliveryContext = Readonly<{
  input: CommitOperationInput;
  task: BoundTask | null;
  snapshot: NonNullable<ReturnType<typeof inspectGitWorkflow>['snapshot']>;
}>;
type CheckpointCompletion = Readonly<{ taskDir: string; taskId: string; intent: CheckpointIntent; committedHead: string }>;
type CommitDeliveryOutcome = Readonly<{
  committed: CommitStepResult;
  warnings: readonly OperationWarning[];
  checkpoint: CheckpointCompletion | null;
}>;
type CommitDeliveryStrategy = Readonly<{
  execute: (context: CommitDeliveryContext) => CommitDeliveryOutcome;
  afterTaskSync?: (outcome: CommitDeliveryOutcome, taskWarning: OperationWarning | null) => void;
}>;

function isCommitExecutionMode(value: unknown): value is CommitExecutionMode {
  return value === 'direct';
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
  if (!fs.existsSync(path.join(input.cwd, '.agents', '.airc.json'))) return { kind: 'none' };
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

function validatePushDelivery(delivery: Readonly<{ remote: string; refs: readonly string[] }>, branch: string | null): Readonly<{ code: string; message: string }> | null {
  if (!delivery.remote || delivery.refs.length !== 1) return { code: 'GIT_PUSH_INPUT_INVALID', message: 'Push requires one remote and one ref' };
  const ref = delivery.refs[0] ?? '';
  if (!HEAD_REF.test(ref) || HEAD_REF.exec(ref)?.[1] !== branch) {
    return { code: 'GIT_PUSH_INPUT_INVALID', message: 'Push ref must be the current full heads ref' };
  }
  return null;
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
    const pushError = validatePushDelivery(delivery, branch);
    if (pushError) return pushError;
  }
  return null;
}

// Log presentation only; checkpoint identity and recovery never depend on this projection.
function commitLogProjection(activity: ReturnType<typeof locateActivityLog>, timestamp: string, agent: string, commitNote: string): TaskMutation[] {
  if (!activity) return [];
  let lastCommit = -1;
  for (const [index, entry] of activity.entries.entries()) {
    if (entry.step === 'Commit' && entry.note === commitNote) lastCommit = index;
  }
  const reviewedAfter = activity.entries.slice(lastCommit + 1).some((entry) => /^Review Code \(Round \d+\)$/.test(entry.step));
  if (lastCommit >= 0 && !reviewedAfter) return [];
  return [{ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: activity.heading,
    body: appendActivityEntry(activity, { time: timestamp, step: 'Commit', agent, note: commitNote }) }];
}

function syncTaskCommit(
  input: CommitOperationInput,
  task: BoundTask,
  committedHead: string,
  writeOptions: TaskWriteOptions = {}
): OperationWarning | null {
  let content: string;
  try {
    content = fs.readFileSync(task.taskMdPath, 'utf8');
    const activity = locateActivityLog(content);
    const metadata = captureTaskWriteMetadata();
    const commitNote = gitText(task.repoRoot, ['show', '-s', '--format=%h %s', committedHead]);
    const mutations = commitLogProjection(activity, metadata.timestamp, input.agent!, commitNote);
    const frontmatter: Record<string, string> = {
      assigned_to: input.agent!,
      checkpoint_commit: committedHead
    };
    mutations.push({ kind: 'frontmatter', set: frontmatter });
    const written = writeTask({
      taskRef: task.taskId,
      expectedState: 'active',
      mutations
    }, { ...writeOptions, repoRoot: task.repoRoot, metadataProvider: () => metadata });
    if (written.status === 'failed') return warning(
      'TASK_STATUS_SYNC_FAILED',
      written.error.message,
      true,
      'task',
      task.taskId,
      'ACTION_REQUIRED'
    );
    const logWarning = activityWarnings(content)[0];
    return logWarning ? warning(logWarning.code, logWarning.message, true, 'task', task.taskId, 'IMPORTANT') : null;
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

function commitStepFailure(
  snapshot: NonNullable<ReturnType<typeof inspectGitWorkflow>['snapshot']>,
  code: string,
  message: string
): CommitStepResult {
  return { status: 'failed', changed: false, snapshot, operations: [], error: { code, message } };
}

function commitStepNoop(snapshot: NonNullable<ReturnType<typeof inspectGitWorkflow>['snapshot']>): CommitStepResult {
  return { status: 'no-op', changed: false, snapshot, operations: [{ name: 'commit', status: 'no-op' }], error: null };
}

function deliveryOutcome(
  committed: CommitStepResult,
  warnings: readonly OperationWarning[] = [],
  checkpoint: CheckpointCompletion | null = null
): CommitDeliveryOutcome {
  return { committed, warnings, checkpoint };
}

function preparedCheckpointIntent(identity: Parameters<typeof checkpointIntentDigest>[0]): CheckpointIntent {
  const timestamp = checkpointTimestamp();
  return {
    version: 1, ...identity,
    digest: checkpointIntentDigest(identity),
    state: 'prepared', committedHead: null, createdAt: timestamp, updatedAt: timestamp
  };
}

function intentReadFailure(snapshot: CommitDeliveryContext['snapshot'], error: unknown): CommitStepResult {
  return commitStepFailure(snapshot, 'COMMIT_INTENT_INVALID', error instanceof Error ? error.message : String(error));
}

function intentWriteFailure(snapshot: CommitDeliveryContext['snapshot'], error: unknown): CommitStepResult {
  return commitStepFailure(snapshot, 'COMMIT_INTENT_WRITE_FAILED', error instanceof Error ? error.message : String(error));
}

type CheckpointIntentPreparation = Readonly<
  | { status: 'ready'; intent: CheckpointIntent }
  | { status: 'failed'; result: CommitStepResult }
>;

function prepareCheckpointIntent(
  task: BoundTask,
  identity: Parameters<typeof checkpointIntentDigest>[0],
  snapshot: CommitDeliveryContext['snapshot']
): CheckpointIntentPreparation {
  let intent: CheckpointIntent | null;
  try { intent = readCheckpointIntent(task.taskDir, task.taskId); }
  catch (error) { return { status: 'failed', result: intentReadFailure(snapshot, error) }; }
  if (intent && !sameCheckpointIntent(intent, identity)) {
    if (intent.state !== 'prepared') return {
      status: 'failed',
      result: commitStepFailure(snapshot, 'COMMIT_INTENT_INVALID', 'A committed checkpoint intent must be recovered with its original request')
    };
    intent = preparedCheckpointIntent(identity);
    try { writeCheckpointIntent(task.taskDir, intent); }
    catch (error) { return { status: 'failed', result: intentWriteFailure(snapshot, error) }; }
  }
  if (intent && intent.state !== 'prepared'
    && !checkpointCommitMatches(task.repoRoot, intent, intent.committedHead!)) return {
    status: 'failed',
    result: commitStepFailure(snapshot, 'COMMIT_INTENT_INVALID', 'Committed checkpoint intent does not match its Git commit')
  };
  if (!intent) {
    intent = preparedCheckpointIntent(identity);
    try { writeCheckpointIntent(task.taskDir, intent); }
    catch (error) { return { status: 'failed', result: intentWriteFailure(snapshot, error) }; }
  }
  return { status: 'ready', intent };
}

function executeLocalCheckpoint(context: CommitDeliveryContext): CommitDeliveryOutcome {
  const { input, task, snapshot } = context;
  if (!task) return deliveryOutcome(commitStepFailure(snapshot, 'CHECKPOINT_TASK_REQUIRED', 'local checkpoint delivery requires a task context'));
  const identity = checkpointIdentity(input, task, { mode: 'local' });
  const prepared = prepareCheckpointIntent(task, identity, snapshot);
  if (prepared.status === 'failed') return deliveryOutcome(prepared.result);
  let intent = prepared.intent;
  if (intent.state !== 'prepared') {
    return deliveryOutcome(commitStepNoop(snapshot), [], {
      taskDir: task.taskDir, taskId: task.taskId, intent, committedHead: intent.committedHead!
    });
  }
  if (snapshot.head !== identity.expectedHead && !checkpointCommitMatches(task.repoRoot, intent, snapshot.head)) {
    return deliveryOutcome(commitStepFailure(snapshot, 'COMMIT_INTENT_HEAD_CONFLICT', 'Current HEAD does not match the pending checkpoint intent'));
  }
  if (snapshot.head !== identity.expectedHead) {
    const committedHead = snapshot.head;
    intent = updateCheckpointIntent(intent, { state: 'committed', committedHead, updatedAt: checkpointTimestamp() });
    writeCheckpointIntent(task.taskDir, intent);
    return deliveryOutcome(commitStepNoop(snapshot), [], { taskDir: task.taskDir, taskId: task.taskId, intent, committedHead });
  }
  if (input.paths.length === 0) return deliveryOutcome(commitStepFailure(snapshot, 'GIT_COMMIT_INPUT_INVALID', 'Local checkpoint requires explicit paths'));
  const committed = commitExplicitPaths({
    cwd: input.cwd, paths: input.paths, message: input.message,
    expectedHead: identity.expectedHead, expectedTree: identity.expectedTree
  });
  if (committed.status === 'applied' && committed.snapshot?.head) {
    const committedHead = committed.snapshot.head;
    intent = updateCheckpointIntent(intent, { state: 'committed', committedHead, updatedAt: checkpointTimestamp() });
    writeCheckpointIntent(task.taskDir, intent);
    return deliveryOutcome(committed, [], { taskDir: task.taskDir, taskId: task.taskId, intent, committedHead });
  }
  if (committed.status === 'no-op') removeCheckpointIntent(task.taskDir, task.taskId);
  return deliveryOutcome(committed);
}

function completeLocalCheckpoint(outcome: CommitDeliveryOutcome, taskWarning: OperationWarning | null): void {
  if (taskWarning?.code === 'TASK_STATUS_SYNC_FAILED' || !outcome.checkpoint) return;
  const { taskDir, taskId, intent, committedHead } = outcome.checkpoint;
  const synced = updateCheckpointIntent(intent, { state: 'synced', committedHead, updatedAt: checkpointTimestamp() });
  writeCheckpointIntent(taskDir, synced);
  removeCheckpointIntent(taskDir, taskId);
}

function pushOnlyRetry(input: CommitOperationInput, snapshot: CommitDeliveryContext['snapshot']): CommitStepResult {
  if (snapshot.worktree.length > 0 || snapshot.staged.length > 0) {
    return commitStepFailure(snapshot, 'GIT_COMMIT_INPUT_INVALID', 'Push-only retry requires a clean working tree');
  }
  if (snapshot.head !== input.expectedHead) {
    return commitStepFailure(snapshot, 'GIT_HEAD_MISMATCH', `Expected HEAD ${input.expectedHead}, received ${snapshot.head}`);
  }
  const currentTree = gitText(input.cwd, ['rev-parse', 'HEAD^{tree}']);
  if (currentTree !== input.expectedTree) {
    return commitStepFailure(snapshot, 'GIT_TREE_MISMATCH', `Expected current tree ${input.expectedTree}, received ${currentTree}`);
  }
  return commitStepNoop(snapshot);
}

function executePushDelivery(context: CommitDeliveryContext, delivery: Extract<CommitDelivery, { mode: 'push' }>): CommitDeliveryOutcome {
  const { input, snapshot } = context;
  const committed = input.paths.length === 0
    ? pushOnlyRetry(input, snapshot)
    : commitExplicitPaths({
      cwd: input.cwd, paths: input.paths, message: input.message,
      expectedHead: input.expectedHead, expectedTree: input.expectedTree
    });
  if (committed.status === 'failed') return deliveryOutcome(committed);
  const target = `${delivery.remote}:${delivery.refs[0]}`;
  const decision = commitPushDecision({ branch: snapshot.branch }, target);
  if (!decision.shouldPush) return deliveryOutcome(committed, [decision.warning!]);
  const pushed = pushGitRefs({
    cwd: input.cwd, remote: delivery.remote, refs: delivery.refs,
    expectedSha: committed.snapshot?.head ?? gitText(input.cwd, ['rev-parse', 'HEAD'])
  });
  const warnings = pushed.status === 'applied' ? [] : [warning(
    'COMMIT_PUSH_FAILED', pushed.error?.message ?? 'Git push failed', true, 'push', target, 'ACTION_REQUIRED'
  )];
  return deliveryOutcome(committed, warnings);
}

function selectCommitDeliveryStrategy(delivery: CommitDelivery): CommitDeliveryStrategy {
  if (delivery.mode === 'local') return { execute: executeLocalCheckpoint, afterTaskSync: completeLocalCheckpoint };
  return { execute: (context) => executePushDelivery(context, delivery) };
}

function executeCommitOperationCore(input: CommitOperationInput, task: BoundTask | null, mode: CommitExecutionMode, writeOptions: TaskWriteOptions): CommitOperationResult {
  const inspected = inspectGitWorkflow(input.cwd);
  if (!inspected.snapshot) return failure(input, mode, task?.taskId ?? null, 'GIT_INSPECT_FAILED', 'Unable to inspect Git repository');
  const branch = inspected.snapshot.branch;
  const commonError = validateCommon(input, branch);
  if (commonError) return failure(input, mode, task?.taskId ?? null, commonError.code, commonError.message, 'blocked', inspected.snapshot);
  if (task && task.state !== 'active') return failure(input, mode, task.taskId, 'TASK_STATE_INVALID', 'task-bound commit requires an active task', 'blocked', inspected.snapshot);
  if (task && task.branch !== branch) return failure(input, mode, task.taskId, 'GIT_BRANCH_MISMATCH', `Task branch '${task.branch}' does not match current branch '${branch}'`, 'blocked', inspected.snapshot);
  if (task && !input.agent) return failure(input, mode, task.taskId, 'COMMIT_AGENT_REQUIRED', 'task-bound commit requires an agent', 'blocked', inspected.snapshot);
  const delivery = effectiveDelivery(input)!;
  if (delivery.mode === 'local' && !task) return failure(input, mode, null, 'CHECKPOINT_TASK_REQUIRED', 'local checkpoint delivery requires a task context', 'blocked', inspected.snapshot);
  const strategy = selectCommitDeliveryStrategy(delivery);
  const outcome = strategy.execute({ input, task, snapshot: inspected.snapshot });
  const committed = outcome.committed;
  if (committed.status === 'failed') return {
    ...committed,
    result: 'failed',
    taskId: task?.taskId ?? null,
    mode,
    warnings: [],
    snapshot: committed.snapshot
  };

  const warnings = [...outcome.warnings];
  let status: CommitOperationResult['status'] = committed.status;
  let result: CommitOperationResult['result'] = committed.status === 'applied' ? 'committed' : 'no_op';
  if (warnings.length > 0) {
    status = 'applied';
    result = 'committed_with_warnings';
  }
  if (task && (committed.status === 'applied' || committed.status === 'no-op')) {
    const committedHead = outcome.checkpoint?.committedHead ?? committed.snapshot?.head ?? gitText(task.repoRoot, ['rev-parse', 'HEAD']);
    const taskWarning = syncTaskCommit(input, task, committedHead, writeOptions);
    if (taskWarning) {
      warnings.push(taskWarning);
      status = 'applied';
      result = 'committed_with_warnings';
    }
    strategy.afterTaskSync?.(outcome, taskWarning);
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

function executeCommitOperation(input: CommitOperationInput, writeOptions: TaskWriteOptions = {}): CommitOperationResult {
  if (input.mode !== undefined && !isCommitExecutionMode(input.mode)) return {
    status: 'blocked',
    changed: false,
    result: 'blocked',
    taskId: null,
    mode: 'direct',
    warnings: [],
    snapshot: null,
    operations: [],
    error: { code: 'COMMIT_MODE_INVALID', message: 'commit mode must be direct' }
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
  try {
    return executeCommitOperationCore(normalizedInput, task, mode, writeOptions);
  } catch (error) {
    const code = 'COMMIT_OPERATION_FAILED';
    return failure(normalizedInput, mode, task?.taskId ?? null, code, error instanceof Error ? error.message : String(error), 'blocked');
  }
}

export { executeCommitOperation };
export type { CommitExecutionMode, CommitOperationInput, CommitOperationResult };
