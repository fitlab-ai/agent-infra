import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { parseTaskFrontmatter } from './frontmatter.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { resolveDeliveryTarget, validateBaseRef, validateRemote } from './delivery-target.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import { withRepositoryMutationLock, withTaskExecutionLock } from './task-execution-lock.ts';

export type DeliveryState = 'absent' | 'same' | 'known-old' | 'unknown-drift';

export type DeliveryClassification = Readonly<{
  state: DeliveryState;
  shouldPush: boolean;
}>;

export type TaskBranchDeliveryResult = Readonly<{
  status: 'applied' | 'no-op' | 'failed' | 'blocked' | 'planned';
  changed: boolean;
  taskId: string | null;
  remoteHead: string | null;
  localHead: string | null;
  state: DeliveryState | null;
  error: { code: string; message: string; retryable: boolean } | null;
}>;

function classifyDeliveryState(localHead: string, remoteHead: string | null, lastDelivered: string | null): DeliveryClassification {
  if (remoteHead === null) return { state: 'absent', shouldPush: true };
  if (remoteHead === localHead) return { state: 'same', shouldPush: false };
  if (lastDelivered && remoteHead === lastDelivered) return { state: 'known-old', shouldPush: true };
  return { state: 'unknown-drift', shouldPush: false };
}

function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitValue(cwd: string, args: readonly string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function validateBranch(cwd: string, branch: string): boolean {
  return git(cwd, ['check-ref-format', `refs/heads/${branch}`]).status === 0;
}

function failure(taskId: string | null, code: string, message: string, retryable = false, status: 'failed' | 'blocked' = retryable ? 'blocked' : 'failed'): TaskBranchDeliveryResult {
  return { status, changed: false, taskId, remoteHead: null, localHead: null, state: null, error: { code, message, retryable } };
}

function deliverUnlocked(
  taskId: string,
  taskDir: string,
  repoRoot: string,
  options: { agent: string; remote?: string; baseRef?: string; dryRun?: boolean }
): TaskBranchDeliveryResult {
  let frontmatter: ReturnType<typeof parseTaskFrontmatter>;
  try { frontmatter = parseTaskFrontmatter(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8')); }
  catch (error) { return failure(taskId, 'TASK_CONTEXT_UNREADABLE', error instanceof Error ? error.message : String(error)); }
  if (frontmatter.status !== 'active') return failure(taskId, 'TASK_STATE_INVALID', 'task branch delivery requires an active task');
  const branch = frontmatter.branch ?? '';
  if (!branch) return failure(taskId, 'DELIVERY_BRANCH_MISSING', 'task branch is missing');
  if (!validateBranch(repoRoot, branch)) return failure(taskId, 'DELIVERY_BRANCH_INVALID', 'task branch is invalid');
  if (!frontmatter.delivery_remote || !frontmatter.delivery_base_ref) {
    return failure(taskId, 'DELIVERY_TARGET_MISSING', 'task delivery target is not bound; recreate or repair task metadata before delivery');
  }
  const target = resolveDeliveryTarget(repoRoot, {
    remote: frontmatter.delivery_remote,
    baseRef: frontmatter.delivery_base_ref
  }, {
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef })
  });
  if (!target.ok) return failure(taskId, target.code, target.message);
  if (!validateRemote(target.value.remote) || !validateBaseRef(target.value.baseRef)) return failure(taskId, 'DELIVERY_TARGET_INVALID', 'task delivery target is invalid');
  const localHead = gitValue(repoRoot, ['rev-parse', 'HEAD']);
  if (!localHead) return failure(taskId, 'DELIVERY_LOCAL_HEAD_UNAVAILABLE', 'Unable to resolve local HEAD');
  const status = git(repoRoot, ['status', '--porcelain=v1']);
  if (status.status !== 0) return failure(taskId, 'DELIVERY_GIT_INSPECT_FAILED', status.stderr.trim() || 'Unable to inspect Git state');
  if (status.stdout.trim()) return failure(taskId, 'DELIVERY_WORKTREE_DIRTY', 'Working tree must be clean before branch delivery');
  const ref = `refs/heads/${branch}`;
  const remoteOutput = git(repoRoot, ['ls-remote', '--refs', target.value.remote, ref]);
  if (remoteOutput.status !== 0) return failure(taskId, 'DELIVERY_REMOTE_UNAVAILABLE', remoteOutput.stderr.trim() || 'Unable to inspect the delivery remote', true);
  const remoteHead = remoteOutput.stdout.trim().split(/\s+/)[0] || null;
  const classification = classifyDeliveryState(localHead, remoteHead, frontmatter.delivery_remote_head ?? null);
  if (classification.state === 'unknown-drift') return failure(taskId, 'DELIVERY_REMOTE_DRIFT', `Remote branch ${branch} has an unexpected head; refusing to overwrite it`);
  if (options.dryRun) return { status: 'planned', changed: classification.shouldPush, taskId, remoteHead, localHead, state: classification.state, error: null };
  if (classification.shouldPush) {
    const args = classification.state === 'known-old'
      ? ['push', `--force-with-lease=${ref}:${frontmatter.delivery_remote_head}`, target.value.remote, `HEAD:${ref}`]
      : ['push', `--force-with-lease=${ref}:`, target.value.remote, `HEAD:${ref}`];
    const pushed = git(repoRoot, args);
    if (pushed.status !== 0) return failure(taskId, 'DELIVERY_PUSH_FAILED', pushed.stderr.trim() || 'Task branch delivery was rejected', true, 'blocked');
  }
  const verified = gitValue(repoRoot, ['ls-remote', '--refs', target.value.remote, ref])?.split(/\s+/)[0] ?? null;
  if (verified !== localHead) return failure(taskId, 'DELIVERY_REMOTE_VERIFY_FAILED', `Expected remote head ${localHead}, received ${verified ?? 'unavailable'}`, true, 'blocked');
  const written = writeTask({
    taskRef: taskId,
    expectedState: 'active',
    mutations: [{ kind: 'frontmatter', set: { delivery_remote: target.value.remote, delivery_base_ref: target.value.baseRef, delivery_remote_head: localHead, assigned_to: options.agent } }]
  }, { repoRoot, metadataProvider: captureTaskWriteMetadata });
  if (written.status === 'failed') return failure(taskId, 'DELIVERY_TASK_SYNC_FAILED', written.error.message, true, 'blocked');
  return { status: classification.shouldPush ? 'applied' : 'no-op', changed: classification.shouldPush || written.changed, taskId, remoteHead: localHead, localHead, state: classification.state, error: null };
}

function deliverTaskBranch(taskRef: string, options: { repoRoot?: string; agent: string; remote?: string; baseRef?: string; dryRun?: boolean }): TaskBranchDeliveryResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(resolved.taskId, resolved.code, resolved.message);
  try {
    return withRepositoryMutationLock(resolved.repoRoot, () => withTaskExecutionLock(
      resolved.repoRoot, resolved.taskId, 'task-delivery',
      () => deliverUnlocked(resolved.taskId, resolved.taskDir, resolved.repoRoot, options)
    ));
  } catch (error) {
    return failure(resolved.taskId, 'DELIVERY_LOCK_FAILED', error instanceof Error ? error.message : String(error), true, 'blocked');
  }
}

export { classifyDeliveryState, deliverTaskBranch };
