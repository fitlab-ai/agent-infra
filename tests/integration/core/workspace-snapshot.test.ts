import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from '../../../lib/task/workspace-snapshot.ts';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('workspace snapshots include tracked files and ignored active task artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-snapshot-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'before\n');
  git(root, ['add', '.gitignore', 'source.ts']);
  git(root, ['commit', '-qm', 'baseline']);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), 'before\n');

  const before = captureWorkspaceSnapshot(root);
  fs.writeFileSync(path.join(root, 'source.ts'), 'after\n');
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), 'after\n');
  const after = captureWorkspaceSnapshot(root);

  assert.deepEqual(diffWorkspaceSnapshots(root, before, after), [
    '.agents/workspace/active/TASK-20260101-000001/review-code.md',
    'source.ts'
  ]);
});
