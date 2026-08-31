import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { resolveTaskContext } from '../../../lib/task/resolve-ref.ts';
import { parseTaskScope } from '../../../lib/task/command-options.ts';
import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-context-'));
  fs.mkdirSync(path.join(repoRoot, '.agents', 'workspace', 'active'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['checkout', '-q', '-b', 'feature/current'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: repoRoot });
  return repoRoot;
}

function task(repoRoot: string, state: string, id: string, branch: string, body = ''): void {
  const dir = path.join(repoRoot, '.agents', 'workspace', state, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), body || `---\nid: ${id}\nbranch: ${branch}\n---\n`);
}

test('resolveTaskContext requires one exact active branch match', () => {
  const repoRoot = fixture();
  task(repoRoot, 'active', 'TASK-20260719-000001', 'feature/current');
  task(repoRoot, 'blocked', 'TASK-20260719-000002', 'feature/current');
  task(repoRoot, 'completed', 'TASK-20260719-000003', 'feature/current');
  const result = resolveTaskContext(undefined, { repoRoot });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.taskId, 'TASK-20260719-000001');
});

test('resolveTaskContext rejects zero, multiple, detached, and damaged active contexts', () => {
  const repoRoot = fixture();
  let result = resolveTaskContext(undefined, { repoRoot });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TASK_CONTEXT_NOT_FOUND');

  task(repoRoot, 'active', 'TASK-20260719-000001', 'feature/current');
  task(repoRoot, 'active', 'TASK-20260719-000002', 'feature/current');
  result = resolveTaskContext(undefined, { repoRoot });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TASK_CONTEXT_AMBIGUOUS');

  fs.rmSync(path.join(repoRoot, '.agents', 'workspace', 'active', 'TASK-20260719-000002'), { recursive: true });
  execFileSync('git', ['checkout', '--detach', '-q'], { cwd: repoRoot });
  result = resolveTaskContext(undefined, { repoRoot });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TASK_CONTEXT_DETACHED_HEAD');

  execFileSync('git', ['checkout', '-q', 'feature/current'], { cwd: repoRoot });
  task(repoRoot, 'active', 'TASK-20260719-000004', 'other', 'not frontmatter\n');
  result = resolveTaskContext(undefined, { repoRoot });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TASK_CONTEXT_UNREADABLE');
});

test('resolveTaskContext delegates explicit refs to existing resolution', () => {
  const repoRoot = fixture();
  task(repoRoot, 'completed', 'TASK-20260719-000003', 'other');
  const result = resolveTaskContext('TASK-20260719-000003', { repoRoot });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.state, 'completed');
});

test('parseTaskScope extracts one task flag and preserves other operands', () => {
  assert.deepEqual(parseTaskScope(['--task', '24', 'reason', 'text']), {
    taskRef: '24', positionals: ['reason', 'text'], explicit: true
  });
  assert.deepEqual(parseTaskScope(['-t', '#24', '--item', '2']), {
    taskRef: '#24', positionals: ['--item', '2'], explicit: true
  });
  assert.throws(() => parseTaskScope(['--task=TASK-20260719-000001']), /use --task <ref> or -t <ref>/);
  assert.throws(() => parseTaskScope(['--task']), /requires a value/);
  assert.throws(() => parseTaskScope(['--task', '--item']), /requires a value/);
  assert.throws(() => parseTaskScope(['-t', '1', '--task', '2']), /duplicate/);
});

test('internal task-context emits a stable read-only envelope', () => {
  const repoRoot = fixture();
  task(repoRoot, 'active', 'TASK-20260719-000001', 'feature/current');
  for (const args of [
    ['task-context', 'resolve'],
    ['task-context', 'resolve', 'TASK-20260719-000001'],
    ['task-context', 'resolve', '--task', 'TASK-20260719-000001'],
    ['task-context', 'resolve', '-t', 'TASK-20260719-000001']
  ]) {
    const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      { status: payload.status, changed: payload.changed, taskId: payload.taskId, taskState: payload.taskState },
      { status: 'resolved', changed: false, taskId: 'TASK-20260719-000001', taskState: 'active' }
    );
  }
  const invalid = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-context', 'resolve', '--task'], {
    cwd: repoRoot, encoding: 'utf8'
  });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'TASK_CONTEXT_PAYLOAD_INVALID');
});
