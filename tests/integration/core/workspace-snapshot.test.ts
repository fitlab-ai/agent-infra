import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  captureRepositorySnapshot,
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots
} from '../../../lib/task/workspace-snapshot.ts';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('task-scoped snapshots isolate ignored active tasks while retaining Git-visible changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-snapshot-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'before\n');
  git(root, ['add', '.gitignore', 'source.ts']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskA = 'TASK-20260101-000001';
  const taskB = 'TASK-20260101-000002';
  const taskADir = path.join(root, '.agents', 'workspace', 'active', taskA);
  const taskBDir = path.join(root, '.agents', 'workspace', 'active', taskB);
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'review-code.md'), 'before\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'before\n');

  const before = captureWorkspaceSnapshot(root, taskA);
  fs.writeFileSync(path.join(root, 'source.ts'), 'after\n');
  fs.writeFileSync(path.join(taskADir, 'review-code.md'), 'after\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'after\n');
  const after = captureWorkspaceSnapshot(root, taskA);

  assert.deepEqual(diffWorkspaceSnapshots(root, before, after), [
    '.agents/workspace/active/TASK-20260101-000001/review-code.md',
    'source.ts'
  ]);
});

test('legacy snapshots retain repository-wide active task coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-snapshot-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskADir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  const taskBDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000002');
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'analysis.md'), 'before\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'before\n');

  const before = captureWorkspaceSnapshot(root, null);
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'after\n');
  const after = captureWorkspaceSnapshot(root, null);

  assert.deepEqual(diffWorkspaceSnapshots(root, before, after), [
    '.agents/workspace/active/TASK-20260101-000002/analysis.md'
  ]);
});

test('mixing task-scoped before with legacy after exposes the incompatible tree shape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-snapshot-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskADir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  const taskBDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000002');
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'analysis.md'), 'current task\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'other task\n');

  const taskScopedBefore = captureWorkspaceSnapshot(root, 'TASK-20260101-000001');
  const legacyAfter = captureWorkspaceSnapshot(root, null);

  assert.deepEqual(diffWorkspaceSnapshots(root, taskScopedBefore, legacyAfter), [
    '.agents/workspace/active/TASK-20260101-000002/analysis.md'
  ]);
});

test('repository snapshots ignore lifecycle artifacts while detecting Git-visible changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-repository-snapshot-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'before\n');
  git(root, ['add', '.gitignore', 'source.ts']);
  git(root, ['commit', '-qm', 'baseline']);

  const clean = captureRepositorySnapshot(root);
  assert.equal(clean.headTree, clean.worktreeTree);

  const ignoredDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(ignoredDir, { recursive: true });
  fs.writeFileSync(path.join(ignoredDir, 'task.md'), '# ignored\n');
  assert.equal(captureRepositorySnapshot(root).worktreeTree, clean.headTree);

  fs.writeFileSync(path.join(root, 'source.ts'), 'unstaged\n');
  assert.notEqual(captureRepositorySnapshot(root).worktreeTree, clean.headTree);
  git(root, ['checkout', '--', 'source.ts']);

  fs.writeFileSync(path.join(root, 'source.ts'), 'staged\n');
  git(root, ['add', 'source.ts']);
  assert.notEqual(captureRepositorySnapshot(root).worktreeTree, clean.headTree);
  git(root, ['reset', '--hard', 'HEAD']);

  fs.writeFileSync(path.join(root, 'untracked.ts'), 'untracked\n');
  assert.notEqual(captureRepositorySnapshot(root).worktreeTree, clean.headTree);
});

test('versioned orchestration snapshots combine a linked worktree with task state from another root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-split-snapshot-'));
  const stateRoot = path.join(root, 'state');
  const gitRoot = path.join(root, 'worktree');
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(gitRoot);
  git(gitRoot, ['init', '-q']);
  git(gitRoot, ['config', 'user.name', 'Test']);
  git(gitRoot, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(gitRoot, 'source.ts'), 'before\n');
  git(gitRoot, ['add', 'source.ts']);
  git(gitRoot, ['commit', '-qm', 'baseline']);
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(stateRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), 'before\n');

  const before = captureWorkspaceSnapshot({ gitRoot, stateRoot, taskId });
  fs.writeFileSync(path.join(gitRoot, 'source.ts'), 'after\n');
  fs.writeFileSync(path.join(taskDir, 'task.md'), 'after\n');
  const after = captureWorkspaceSnapshot({ gitRoot, stateRoot, taskId });

  assert.deepEqual(diffWorkspaceSnapshots(gitRoot, before, after), [
    '.agents/workspace/active/TASK-20260101-000001/task.md',
    'source.ts'
  ]);
  assert.throws(
    () => diffWorkspaceSnapshots(gitRoot, captureWorkspaceSnapshot(gitRoot, taskId), after),
    /versions cannot be mixed/
  );
});
