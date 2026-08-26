import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseSandboxWorkspaceIdentity,
  resolveSandboxCleanupTarget,
  resolveSandboxTarget,
  sameSandboxWorkspaceIdentity
} from '../../../lib/sandbox/workspace-identity.ts';

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-identity-'));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  return root;
}

function addTask(root: string, taskId: string, branch: string, shortId: string): void {
  const active = path.join(root, '.agents', 'workspace', 'active');
  const taskDir = path.join(active, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: ${branch}\n---\n`);
  const registryPath = path.join(active, '.short-ids.json');
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { version: number; ids: Record<string, string> }
    : { version: 1, ids: {} };
  registry.ids[shortId] = taskId;
  fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
}

function addTaskInState(root: string, state: string, taskId: string, branch: string): void {
  const taskDir = path.join(root, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: ${branch}\n---\n`);
}

test('resolveSandboxTarget preserves task identity for TASK-id and short id', () => {
  const root = fixture();
  addTask(root, 'TASK-20260809-010203', 'agent-infra-feature-one', '8');

  assert.deepEqual(resolveSandboxTarget('TASK-20260809-010203', root), {
    requestedRef: 'TASK-20260809-010203',
    branch: 'agent-infra-feature-one',
    workspace: { mode: 'task-bound', taskId: 'TASK-20260809-010203', shortId: '8' }
  });
  assert.equal(resolveSandboxTarget('8', root).workspace.mode, 'task-bound');
});

test('resolveSandboxTarget distinguishes branch-only and rejects ambiguous branches', () => {
  const root = fixture();
  assert.equal(resolveSandboxTarget('agent-infra-feature-free', root).workspace.mode, 'branch-only');

  addTask(root, 'TASK-20260809-010203', 'agent-infra-feature-shared', '8');
  addTask(root, 'TASK-20260809-010204', 'agent-infra-feature-shared', '9');
  assert.throws(
    () => resolveSandboxTarget('agent-infra-feature-shared', root),
    /SANDBOX_TASK_IDENTITY_AMBIGUOUS/
  );
});

test('resolveSandboxCleanupTarget keeps completed task identity after short-id release', () => {
  const root = fixture();
  const taskId = 'TASK-20260809-010205';
  addTaskInState(root, 'completed', taskId, 'agent-infra-fix-completed');

  assert.deepEqual(resolveSandboxCleanupTarget(taskId, root), {
    requestedRef: taskId,
    branch: 'agent-infra-fix-completed',
    workspace: { mode: 'task-bound', taskId },
    taskState: 'completed'
  });
});

test('resolveSandboxCleanupTarget rejects protected task states unless explicitly inspecting them', () => {
  const root = fixture();
  const taskId = 'TASK-20260809-010206';
  addTaskInState(root, 'blocked', taskId, 'agent-infra-fix-blocked');

  assert.throws(() => resolveSandboxCleanupTarget(taskId, root), /SANDBOX_CLEANUP_STATE_UNSUPPORTED/);
  assert.deepEqual(resolveSandboxCleanupTarget(taskId, root, { allowProtected: true }).taskState, 'blocked');
});

test('resolveSandboxCleanupTarget rejects a task id present in multiple workspace states', () => {
  const root = fixture();
  const taskId = 'TASK-20260809-010207';
  addTaskInState(root, 'completed', taskId, 'agent-infra-fix-duplicate');
  addTaskInState(root, 'blocked', taskId, 'agent-infra-fix-duplicate');

  assert.throws(
    () => resolveSandboxCleanupTarget(taskId, root, { allowProtected: true }),
    /SANDBOX_TASK_STATE_AMBIGUOUS/
  );
});

test('resolveSandboxCleanupTarget preserves branch-only test sandboxes', () => {
  const root = fixture();

  assert.deepEqual(resolveSandboxCleanupTarget('test1', root), {
    requestedRef: 'test1',
    branch: 'test1',
    workspace: { mode: 'branch-only' },
    taskState: 'branch-only'
  });
});

test('container labels are parsed without inferring missing identity', () => {
  const keys = { mode: 'p.sandbox.workspace-mode', taskId: 'p.sandbox.task-id' };
  assert.deepEqual(parseSandboxWorkspaceIdentity({
    [keys.mode]: 'task-bound',
    [keys.taskId]: 'TASK-20260809-010203'
  }, keys), { mode: 'task-bound', taskId: 'TASK-20260809-010203' });
  assert.deepEqual(parseSandboxWorkspaceIdentity({ [keys.mode]: 'branch-only' }, keys), {
    mode: 'branch-only'
  });
  assert.deepEqual(parseSandboxWorkspaceIdentity({}, keys), { mode: 'legacy-invalid' });
  assert.equal(
    sameSandboxWorkspaceIdentity(
      { mode: 'task-bound', taskId: 'TASK-20260809-010203', shortId: '8' },
      { mode: 'branch-only' }
    ),
    false
  );
});
