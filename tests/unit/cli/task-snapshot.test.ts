import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { collectTaskSnapshot } from '../../../lib/task/snapshot.ts';

function fixture(state: 'active' | 'blocked' | 'completed' = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-snapshot-unit-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\r\n'));
  fs.writeFileSync(path.join(taskDir, 'z.md'), 'z');
  fs.mkdirSync(path.join(taskDir, 'a-dir'));
  return { root, taskId, taskDir };
}

test('snapshot renders deterministic git, directory and ten-line tail evidence', () => {
  const f = fixture();
  const result = collectTaskSnapshot(f.taskId, { repoRoot: f.root });
  assert.equal(result.status, 'ready');
  assert.equal(result.taskState, 'active');
  assert.ok(result.evidence);
  assert.match(result.evidence, /^\$ git status -s\n\?\? /m);
  assert.ok(result.evidence.indexOf('d\t-\ta-dir') < result.evidence.indexOf('\ttask.md'));
  assert.doesNotMatch(result.evidence, /line 1\n|line 2\n/);
  assert.match(result.evidence, /line 3\n[\s\S]*line 12$/);
});

test('snapshot makes clean and empty observations explicit', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), '');
  spawnSync('git', ['add', '.'], { cwd: f.root });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: f.root });
  const result = collectTaskSnapshot(f.taskId, { repoRoot: f.root });
  assert.equal(result.status, 'ready');
  assert.match(result.evidence!, /^\$ git status -s\n\(empty\)$/m);
  assert.match(result.evidence!, new RegExp(`\\$ tail .*task\\.md\\n\\(empty\\)$`));
});

test('snapshot returns a stable failure and never exposes partial evidence', () => {
  for (const [code, failure] of [
    ['SNAPSHOT_GIT_FAILED', { gitStatus() { throw new Error('git unavailable'); } }],
    ['SNAPSHOT_DIRECTORY_READ_FAILED', { readDirectory() { throw new Error('directory unavailable'); } }],
    ['SNAPSHOT_TASK_READ_FAILED', { readTask() { throw new Error('task unavailable'); } }]
  ] as const) {
    const f = fixture();
    const before = fs.readFileSync(path.join(f.taskDir, 'task.md'));
    const result = collectTaskSnapshot(f.taskId, { repoRoot: f.root, ...failure });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, code);
    assert.equal(result.evidence, null);
    assert.deepEqual(fs.readFileSync(path.join(f.taskDir, 'task.md')), before);
  }
});

test('snapshot reports the resolved active, blocked and completed workspace identity', () => {
  for (const state of ['active', 'blocked', 'completed'] as const) {
    const f = fixture(state);
    assert.equal(collectTaskSnapshot(f.taskId, { repoRoot: f.root }).taskState, state);
  }
});
