import { taskWorkspaceRoot } from '../../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  captureRepositorySnapshot,
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots
} from '../../../lib/task/workspace-snapshot.ts';
import { createTempDir } from '../../helpers.ts';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('task-scoped snapshots isolate ignored active tasks while retaining Git-visible changes', () => {
  const root = createTempDir('orchestration-snapshot-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'task-workspace/\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'before\n');
  git(root, ['add', '.gitignore', 'source.ts']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskA = 'TASK-20260101-000001';
  const taskB = 'TASK-20260101-000002';
  const taskADir = path.join(taskWorkspaceRoot(root),  'active', taskA);
  const taskBDir = path.join(taskWorkspaceRoot(root),  'active', taskB);
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'review-code.md'), 'before\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'before\n');

  const before = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: taskA });
  fs.writeFileSync(path.join(root, 'source.ts'), 'after\n');
  fs.writeFileSync(path.join(taskADir, 'review-code.md'), 'after\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'after\n');
  const after = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: taskA });

  assert.deepEqual(diffWorkspaceSnapshots(root, before, after), [
    'source.ts',
    'task-workspace/active/TASK-20260101-000001/review-code.md'
  ]);
});

test('repository-wide context snapshots retain active task coverage', () => {
  const root = createTempDir('orchestration-snapshot-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'task-workspace/\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskADir = path.join(taskWorkspaceRoot(root),  'active', 'TASK-20260101-000001');
  const taskBDir = path.join(taskWorkspaceRoot(root),  'active', 'TASK-20260101-000002');
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'analysis.md'), 'before\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'before\n');

  const before = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: null });
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'after\n');
  const after = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: null });

  assert.deepEqual(diffWorkspaceSnapshots(root, before, after), [
    'task-workspace/active/TASK-20260101-000002/analysis.md'
  ]);
});

test('task-scoped and repository-wide contexts retain their explicit scope', () => {
  const root = createTempDir('orchestration-snapshot-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'task-workspace/\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskADir = path.join(taskWorkspaceRoot(root),  'active', 'TASK-20260101-000001');
  const taskBDir = path.join(taskWorkspaceRoot(root),  'active', 'TASK-20260101-000002');
  fs.mkdirSync(taskADir, { recursive: true });
  fs.mkdirSync(taskBDir, { recursive: true });
  fs.writeFileSync(path.join(taskADir, 'analysis.md'), 'current task\n');
  fs.writeFileSync(path.join(taskBDir, 'analysis.md'), 'other task\n');

  const taskScopedBefore = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: 'TASK-20260101-000001' });
  const repositoryWideAfter = captureWorkspaceSnapshot({ gitRoot: root, stateRoot: root, taskId: null });

  assert.deepEqual(diffWorkspaceSnapshots(root, taskScopedBefore, repositoryWideAfter), [
    'task-workspace/active/TASK-20260101-000002/analysis.md'
  ]);
});

test('repository snapshots ignore lifecycle artifacts while detecting Git-visible changes', () => {
  const root = createTempDir('orchestration-repository-snapshot-');
  taskWorkspaceRoot(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'task-workspace/\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'before\n');
  git(root, ['add', '.gitignore', 'source.ts', '.agents/.airc.json']);
  git(root, ['commit', '-qm', 'baseline']);

  const clean = captureRepositorySnapshot(root);
  assert.equal(clean.headTree, clean.worktreeTree);

  const ignoredDir = path.join(taskWorkspaceRoot(root),  'active', 'TASK-20260101-000001');
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
  const root = createTempDir('orchestration-split-snapshot-');
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
  const taskDir = path.join(taskWorkspaceRoot(stateRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), 'before\n');

  const before = captureWorkspaceSnapshot({ gitRoot, stateRoot, taskId });
  fs.writeFileSync(path.join(gitRoot, 'source.ts'), 'after\n');
  fs.writeFileSync(path.join(taskDir, 'task.md'), 'after\n');
  const after = captureWorkspaceSnapshot({ gitRoot, stateRoot, taskId });

  assert.deepEqual(diffWorkspaceSnapshots(gitRoot, before, after), [
    'source.ts',
    'task-workspace/active/TASK-20260101-000001/task.md'
  ]);
});
