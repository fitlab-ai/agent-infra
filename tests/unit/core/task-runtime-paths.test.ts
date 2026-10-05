import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveTaskRuntimeRoot } from '../../../lib/task/runtime-paths.ts';

function taskDir(root: string, state: string, id = 'TASK-20261006-000001'): string {
  const dir = state === 'archive'
    ? path.join(root, '.agents', 'workspace', 'archive', '2026', '10', '06', id, 'local')
    : path.join(root, '.agents', 'workspace', state, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\n---\n`);
  return dir;
}

test('task runtime root follows the unique task directory in each lifecycle state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-paths-'));
  try {
    const cases: Array<[string, string]> = [
      ['active', 'TASK-20261006-000001'],
      ['blocked', 'TASK-20261006-000002'],
      ['completed', 'TASK-20261006-000003'],
      ['archive', 'TASK-20261006-000004']
    ];
    for (const [state, taskId] of cases) {
      const dir = taskDir(root, state, taskId);
      assert.equal(resolveTaskRuntimeRoot(taskId, { repoRoot: root }), path.join(dir, '.runtime'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task runtime resolution fails closed for missing and duplicated task identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-paths-'));
  try {
    assert.throws(() => resolveTaskRuntimeRoot('TASK-20261006-000001', { repoRoot: root }), /not found/u);
    const taskId = 'TASK-20261006-000002';
    taskDir(root, 'active', taskId);
    taskDir(root, 'completed', taskId);
    assert.throws(() => resolveTaskRuntimeRoot(taskId, { repoRoot: root }), /TASK_RUNTIME_TASK_AMBIGUOUS/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
